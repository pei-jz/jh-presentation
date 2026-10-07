# 文字編集プロトコル (jh-presentation ⇔ ホスト)

jh-presentation のデッキ (1 ファイルの HTML) を、ホストアプリ (jh-editor など) のプレビュー上で
**文字だけ直接編集**し、その結果をソースに書き戻すための取り決め。プロトコル番号 (編集ルールの版): **2**

## 編集できる要素のルール (v2: 構造で判定)

スライドの中を上から順に見て、次の条件を満たす要素を **いちばん外側の単位で** 1 つの編集対象にする (その中にはもう入らない)。

1. 文字を含む
2. 中身が **行内要素だけ** (`b` `strong` `em` `i` `span` `a` `code` `br` `small` `sup` `sub` `mark` `kbd` など)
3. 自分も中身も編集対象外ではない: `pre` `svg` `aside` (ノート) `button` `textarea` `canvas` `video` `iframe` など、
   `data-count-to` / `data-typewriter` を持つ要素、`class="no-edit"` の要素

| 例 | 編集対象 |
|---|---|
| `<div class="layer"><b>人間の判定</b><span>意図との一致</span></div>` | div 全体 (太字と説明をまとめて) |
| `<p>実行は <code>npm run dev</code> です</p>` | p 全体 |
| `<div class="card"><h3>…</h3><ul><li>…</li></ul></div>` | h3 と各 li (card は中にブロック要素があるので入っていく) |
| `<div><div class="no">1</div>ばらの文字</div>` | 「1」だけ。ブロック要素と並んだ「ばらの文字」は編集できない |

版が違うデッキとホスト / 保存サーバーの組み合わせでは「何番目の要素か」がずれるので、保存サーバーは版が一致しない保存を拒否する
(メッセージの `protocol` / `jhdeck` で版を確認する)。古いデッキは `upgrade_deck` / `npm run upgrade` で最新にする。

## 操作 (デッキ側)

| 操作 | 内容 |
|---|---|
| E キー | 編集モードの切り替え |
| **枠をダブルクリック** | 編集モードでなくても、その枠をすぐ編集 (クリック位置にカーソル) |
| Enter / Shift+Enter | 確定 / 改行 |
| Esc | 枠の中: 編集を取り消して枠から出る。枠の外: 編集モードを終了 |
| 編集バーの「保存」「✕ 終了」 | 保存 (Ctrl+S と同じ) / 編集モードを終了 |

## 全体像

```
┌──────── ホスト (jh-editor) ────────┐        ┌──── デッキ (iframe srcdoc, sandbox="allow-scripts") ────┐
│ ソース (CodeMirror)                 │        │ エンジン                                                  │
│                                     │ ready  │  - 編集できる要素に印 (スライド番号:順番)                 │
│  isDeck(source) なら連携を有効化    │◀───────│  - E キー / edit メッセージで編集モード                  │
│                                     │ goto   │                                                           │
│  再読み込み後に元の位置へ戻す       │───────▶│                                                           │
│                                     │ edit   │                                                           │
│  [スライド編集] ボタン              │───────▶│  文字をクリックして編集 → Enter / フォーカス外れで確定   │
│                                     │ change │                                                           │
│  JhDeckEdit.applyEdit(source, …)    │◀───────│  { slide, index, html, before }                          │
│  → 該当範囲だけ CodeMirror で置換   │        │                                                           │
│    (このときはプレビューを再読込しない) │ save   │                                                           │
│  Ctrl+S (iframe 内) → 保存          │◀───────│  iframe にフォーカスがある間の Ctrl+S                     │
└─────────────────────────────────────┘        └───────────────────────────────────────────────────────────┘
```

- 編集できるのは **文字 (と中の太字・改行などのインライン要素) だけ**。レイアウト・図・コードは対象外
- 要素は **スライド番号 (0 始まり) + スライド内の順番 (0 始まり)** で特定する。判定ルールはデッキとホストで共通の
  `engine/deck-edit.js` に 1 つだけある (同じファイルを使うので食い違わない)
- ソースは DOM を作り直さず、**編集した要素の中身の範囲だけ**を差し替える。他の部分は 1 文字も変わらない

## デッキの判定

```js
JhDeckEdit.isDeck(source)   // <meta name="generator" content="jh-presentation …"> があれば true
```

デッキはスクリプトがないと動かない。ホストのプレビューでスクリプトが無効なら、
「スライドの表示・編集にはスクリプトの有効化が必要です」と案内する。

## メッセージ

すべて `window.postMessage`。どちらの方向も `jhdeck: 1` を必ず含む。
iframe は opaque origin (sandbox で allow-same-origin なし) なので `targetOrigin` は `'*'`、
受信側は **`event.source` で相手を確認する** (ホスト: `event.source === iframe.contentWindow`、デッキ: `event.source === window.parent`)。

### デッキ → ホスト

| type | 内容 | タイミング |
|---|---|---|
| `ready` | `{ version, title, slides, editables: number[], index, step }` | 初期化完了時 (読み込みのたび) |
| `state` | `{ index, step }` | スライド・ステップが変わるたび |
| `edit-mode` | `{ on }` | デッキ内で E キーにより編集モードが切り替わったとき |
| `change` | `{ slide, index, html, before, text }` | 編集の確定時 (Enter / フォーカスが外れた / 入力が 0.6 秒止まった) |
| `save` | `{}` | iframe 内で Ctrl+S が押されたとき |
| `undo` / `redo` | `{}` | 枠の編集中でないときの Ctrl+Z / Ctrl+Y (Ctrl+Shift+Z)。ホストの履歴で戻す・やり直す |
| `present` | `{}` | iframe 内で F5 が押されたとき (ホストに発表 = 全画面表示を頼む) |
| `presenter` | `{}` | iframe 内で S が押されたとき (別ウィンドウの発表者ビューは開けないので、ホストに発表者向けの表示を頼む) |
| `present-exit` | `{}` | ホストが発表中 (`present {on:true}` を受けた後) に、枠の外で Esc が押されたとき |

- `change.html` … 要素の新しい中身 (innerHTML)。`script` / イベント属性などは除去済み
- `change.before` … **ホストのソースにあるはずの現在の文字** (空白を圧縮したテキスト)。照合に使う
- `ready.editables` … スライドごとの編集できる要素の数。ソース側の数と違えば連携しない (安全策)

### ホスト → デッキ

| type | 内容 | 用途 |
|---|---|---|
| `edit` | `{ on: boolean }` | 編集モードの切り替え (ホストのボタン) |
| `goto` | `{ index, step }` | プレビュー再読み込み後に元の位置へ戻す |
| `next` / `prev` | `{}` | 次へ / 前へ (ステップ単位。ホストの発表者表示のボタンなど) |
| `error` | `{ message }` | 反映できなかったことをデッキ上に表示する |
| `saved` | `{}` | 保存完了をデッキ上に表示する。編集モードなら終了する |
| `present` | `{ on: boolean }` | 発表 (全画面) 表示の開始・終了を知らせる (発表中の Esc を `present-exit` にする) |

表示だけの枠 (ホストの発表者表示の「次のスライド」など) は、srcdoc の `<head>` の先頭に
`<script>window.__JH_DECK_MODE__ = 'embed'</script>` を入れて読み込む。この枠は `goto` だけを受け付ける。

ホストから最初のメッセージを受け取った時点で、デッキは「ホストあり」として動く
(Ctrl+S をホストに渡す、バッジに「保存はエディタで」と出す)。

iframe の中では、F5 / Ctrl+R によるブラウザの再読み込みを常に止める (iframe 内で押すと、ホストのページ全体が読み込み直されるため)。
保存できたら (ホストなし: 書き込みの成功時、ホストあり: `saved` の受信時) 編集モードは自動で終了する。

## ソースへの反映

```js
import './vendor/deck-edit.js';           // jh-presentation の engine/deck-edit.js をコピー
const E = globalThis.JhDeckEdit;

const r = E.applyEdit(source, change);    // 照合に失敗すると例外
// r = { source: 新しい全文, from, to, insert }  → エディタには from〜to を insert で置換する
```

`applyEdit` が例外を投げるのは次の場合。ホストは `error` を返し、プレビューを再読み込みする。
- 指定のスライド・要素が見つからない
- `before` とソースの文字が一致しない (ソース側が別途書き換えられた、など)

連携開始時の安全確認:
```js
const counts = E.sourceEditables(source).map((l) => l.length);
// ready.editables と counts が一致しなければ、編集ボタンを無効にする
```

## jh-editor での実装手順 (目安)

対象: `src/modules/views/CodeMirrorView.js` の HTML プレビュー (`_renderEditor` / `_refreshHtmlPreview`)。

1. **ライブラリの取り込み**: `engine/deck-edit.js` を `src/vendor/jh-deck-edit.js` にコピーし、`import` する
   (ファイルは classic script 兼用で、読み込むと `globalThis.JhDeckEdit` が定義される)
2. **判定**: `_renderEditor` でプレビューを作るとき `JhDeckEdit.isDeck(内容)` を確認し、デッキならプレビュー見出し
   (`pvHead`) に **[スライド編集]** トグルを追加する。スクリプトが無効なら案内を出す
3. **受信**: `window.addEventListener('message', …)` で `event.source === this._htmlFrame.contentWindow` のものだけ処理する
   (ビューを閉じるときに解除する)
   - `ready`: 件数を照合 → 前回の `state` があれば `goto` を送る → 編集トグルが ON なら `edit {on:true}` を送る
   - `state`: `this.file._deckState = { index, step }` に保存 (再読み込み後の復元用)
   - `edit-mode`: トグルボタンの表示を合わせる
   - `change`: `applyEdit` → CodeMirror に `{ from, to, insert }` を dispatch。**このときだけ** 400ms 後の
     プレビュー再描画 (`_htmlPvTimer`) を行わないようにフラグを立てる (再描画すると編集中の位置・フォーカスが失われる)。
     例外なら `error` を送り、プレビューを再描画する
   - `save`: 通常の保存処理を呼び、`saved` を送る
4. **再描画後の復元**: `_refreshHtmlPreview` で srcdoc を差し替えると 1 枚目に戻るので、`ready` を受けたら
   保存しておいた `_deckState` で `goto` を送る (3 の `ready` 処理)
5. **ソースを直接編集した場合**: 従来どおり 400ms 後に再描画される。`ready` → `goto` で位置は保たれる

注意:
- `allow-same-origin` は付けない (既存の方針どおり)。postMessage だけで完結する
- 1 回の `change` は 1 要素分。連続した編集はそれぞれ `before` で照合されるので、順番どおりに適用すること
- Undo はエディタ側の履歴で戻せる (戻した後はプレビューが再描画され、デッキも元に戻る)

## ホストなしで開いた場合の保存

E キーで編集モードになり、Ctrl+S で保存する。**Ctrl+S は常にエンジンが受け取り、ブラウザ標準の「名前を付けて保存」は走らない**
(標準の保存は表示中の状態を書き出すため、デッキが壊れる)。保存先は開き方で決まる:

| 開き方 | 保存のしかた |
|---|---|
| ローカルサーバー経由 (MCP の `open_deck` / `npm run dev`) | サーバーが **元のファイルに直接** 書き込む (ダイアログなし)。保存前の版は `.history/` に残る |
| file:// で直接開いた | ブラウザの制約で自分のパスに書けないため、初回だけ **このファイルを選ぶ** ダイアログが出る。選んだファイルは記憶され、次回から選び直し不要 (書き込み許可の確認だけ) |

ローカルサーバーは配信する HTML に `window.__JH_SAVE__ = { endpoint, file, token }` を埋め込み、
エンジンは `POST endpoint` (ヘッダー `X-JH-Token`、本文 `{ file, changes }`) で変更を送る。サーバーは `applyEdit` と同じ照合をして書き込む
(`tools/lib/save-endpoint.mjs`)。

ブラウザの「名前を付けて保存」で壊れたファイルは、開くと赤い警告が出る。MCP の `repair_deck` か `npm run repair -- <name>` で復旧できる。

## AI がスライドを書くときの注意

- 文字は要素で囲む。**ブロック要素 (div・p など) と同じ箱の中に、むき出しの文字を並べない** (その文字は編集できない)
  - NG: `<div><div class="no">1</div>説明の文字</div>` → OK: `<div><div class="no">1</div><p>説明の文字</p></div>`
- 1 つのまとまり (見出し + 説明など) を行内要素 (`b` `span`) で組むと、まとめて編集できる
- 編集させたくない要素には `class="no-edit"`
- `pre` / `svg` / `aside` (ノート) / `button` / `data-count-to` / `data-typewriter` の中は編集対象外
