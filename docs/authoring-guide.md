# デッキ作成ガイド (AI 向け)

プレゼンテーションのスライドを HTML / CSS / JS で作るためのルールと部品カタログ。
Claude Code (このリポジトリ) からも、MCP サーバー経由でも、このガイドに従って作る。

## 前提

- キャンバスは **1920×1080px 固定** (16:9)。サイズは px で指定してよい (画面に合わせて自動で拡縮される)
- **外部 CDN・外部フォントは使わない** (オフラインでも発表できるように)
- **HTML には「最終状態」を書く。** アニメーションは「最終状態へ向かう演出」として付ける。これで PDF・一覧・ステップ途中の表示でも内容が欠けない (再生には JavaScript が必要)
- デッキは **1 ファイルの HTML** (エンジン・テーマ・ブランド・画像を埋め込み)。そのまま配布できる
- 共通部品で足りないスタイル・動きは、デッキ専用の CSS / JS に書く (MCP: `write_deck` の `css` / `js`。ファイルを直接編集する場合: `jh:deck-style` / `jh:deck-script` ブロック)
- デッキ専用 CSS は常に共通部品・テーマより優先される (カスケードレイヤー)
- 目安: **1 枚 1〜2 分**。15 分なら本編 8〜12 枚 + 表紙・まとめ

## テーマ (全体のトーン)

| テーマ | 雰囲気 | 向いている発表 |
|---|---|---|
| `default` | 白地に青、すっきり | 迷ったらこれ。汎用 |
| `dark` | 濃紺の背景、コードが映える | 技術系の発表 |
| `corporate` | 紺とゴールド、角ばった端正なレイアウト | 報告・提案などフォーマルな場 |
| `pop` | クリーム地にコーラルと黄色、丸み | LT・カジュアルな発表 |
| `mono` | 白黒 + 赤一色、見出しは明朝体 | 文字・メッセージを主役にしたい発表 |

- ユーザーの指定がなければ、内容と聞き手に合わせて選び、選んだ理由を一言伝える
- テーマは色・フォント・表紙やセクション扉の装飾を変える。**部品の書き方はどのテーマでも同じ**
- 色はテーマ変数 (`var(--accent)` など) だけで指定する。直接の色指定をするとテーマを変えたときに崩れる
- テーマは自作できる (MCP: `get_theme_guide` → `create_theme`。詳細は `docs/theme-guide.md`)

## ブランド枠 (名前・ロゴ)

上下の帯に名前・ロゴ・ラベル (例: DRAFT) を入れられる。内容はワークスペースの `brand/brand.json` で一度だけ設定する。

- デッキごとに `brand` で位置を選ぶ: `none` (なし) / `header` (上) / `footer` (下) / `both` (上下)
- 通常スライドに帯が出る。表紙・結び (`.no-chrome`) は右上に小さなロゴ、セクション扉には出ない
- 帯がある場合は本文の上下に自動で余白が足される。スライドの HTML は変える必要がない
- ユーザーが「ロゴを入れて」と言ったら `footer` を基本にする。指定がなければ `none`

## スライドの書き方

デッキは `section.slide` の並び。外枠 (`<html>`、CSS/JS の読み込み、`<div class="deck">`) はテンプレートが用意する。

```html
<section class="slide" id="intro">       <!-- id はデッキ専用 JS のフックや CSS で使う -->
  <h2>スライドタイトル</h2>               <!-- 先頭の h2 はタイトル帯として装飾される -->
  <div class="fill">本文 (残りの高さいっぱい)</div>
  <aside class="notes">発表者ノート (S キーの発表者ビューに出る)</aside>
</section>
```

- スライドは縦方向の flex。`h2` の下に本文を置き、`.fill` で残りの高さを使う
- `.no-chrome` を付けるとページ番号を表示しない (表紙・結び用)
- 切り替え効果: `data-transition="fade | slide | zoom | none"` (スライド単位、またはデッキ全体の既定)
- スライド固有のスタイルはデッキ専用 CSS に `#スライドid .xxx { }` の形で書く

## 部品カタログ

### レイアウト (`section.slide` に付ける)
| クラス | 用途 |
|---|---|
| `layout-title` | 表紙。`h1` + `.subtitle` + `.meta`、上に `.eyebrow` |
| `layout-section` | セクション扉 (グラデーション背景)。`.section-no` + `h2` + `p` |
| `layout-center` | 中央寄せ (一言メッセージ・大きな図) |
| `layout-end` | 結び |
| (なし) | 通常スライド。`h2` + 本文 |

### 配置
- グリッド: `cols-2` `cols-3` `cols-4` `cols-2-1` `cols-1-2`。`stretch` で高さを揃える、`middle` で `.fill` 内の上下中央、`gap-sm` で間隔を狭める
- `fill` (残りの高さ全部) / `center` (上下左右中央の flex) / `v-center` (上下中央の flex 縦並び) / `mt-auto`
- 余白: `mt-1`〜`mt-4`、`mb-1`〜`mb-3`
- 文字: `muted` `accent` `accent-2` `accent-3` `danger` `success` `big` `huge` `bold` `small` `text-center` `nowrap`

### 部品
| 部品 | 書き方 |
|---|---|
| カード | `<div class="card"><h3>..</h3>..</div>`、強調 `card is-accent`、控えめ `is-dim`、アイコン `.icon` |
| コールアウト | `<div class="callout">..</div>`、`is-warn` `is-danger` `is-success` |
| バッジ | `<span class="badge">NEW</span>`、`is-2` `is-3` `is-outline` |
| キー | `<span class="kbd">Ctrl</span>` |
| 引用 | `<blockquote class="quote">..<cite>出典</cite></blockquote>` |
| 数値 | `<div class="stat"><div class="stat-value"><span data-count-to="120">120</span><span class="unit">%</span></div><div class="stat-label">説明</div></div>` |
| 表 | `<table class="table">`、強調行 `tr.is-accent` |
| フロー | `<div class="flow"><div>手順1</div><div>手順2</div></div>` (横並びの箱と矢印) |
| タイムライン | `<ol class="timeline"><li class="is-done"><div class="when">..</div><div class="what">..</div><div class="desc">..</div></li></ol>` |
| ボタン | `<button class="btn" type="button">`、`is-ghost` (インタラクティブなデモ用) |
| 画像 | `<img data-asset="名前" class="img-fit" alt="...">`。画像はデッキに埋め込み (MCP: `add_asset`)、`src` ではなく `data-asset` で参照する。`img-fit` (収める) / `img-cover` (埋める)、影付き枠 `frame` |

### コード
```html
<div class="code-title">app.ts</div>
<pre class="code numbered"><code class="hl" data-lang="ts" data-emph="2-3|5" data-mark="7">
  ここにコード (HTML 内のインデントは自動で除去される)
</code></pre>
```
- `data-lang`: js ts cs java go rust py bash sql json
- **`<` `>` `&` は `&lt;` `&gt;` `&amp;` にエスケープする**
- `data-emph="2-3|5"`: → キーで 2〜3 行目、次に 5 行目を順に強調 (ステップになる)
- `data-emph-labels="a|b"`: 強調グループにラベルを付け、`data-step="a"` の他要素 (説明文) と同時に出す
- `data-mark="7"`: 常に強調する行。`numbered` で行番号。小さめは `code is-sm`
- 目安: 1 枚 **15 行以内**、1 行 60 文字程度まで

### 図 (自由に描く場合)
- 図は **インライン SVG** で描く (`viewBox` を指定、色は `var(--accent)` などのテーマ変数を使う)
- 線を描くアニメーション: 図形または `<g>` に `class="anim-draw"`
- 段階的に組み上げるなら `<g class="step">` で囲む
- **関連図・ER 図・シーケンス図・グラフ・レイヤー構造は、下の「図の部品」を優先する** (配置・動き・クリック・印刷が揃っている)

## 図の部品 (データを書くだけで動く)

要素の中に `<script type="application/json">` でデータを書く。描画・自動配置・動き・クリック・PDF での静止表示は部品が行う。
大きさは親の大きさに合わせる (`.fill` の中に置くと残りの高さいっぱい。単独なら高さ 680px)。見本: `examples/sample.html` の「動く図の部品」。

共通のルール:
- `steps` の **`steps[0]` が最初の表示**、`steps[1]` 以降が → キーで進むたびの表示 (エンジンのステップと連動)
- クリックで詳細パネル (`detail` に HTML を書ける)。Esc か背景クリックで元に戻る
- `note` は図の左下の説明バーに出る (話の要点を一言で)
- 色はテーマに合わせて自動で決まる。JSON に色は書かない
- 図の中の文字は文字編集 (E キー) の対象外。直すときは JSON を書き換える

### 関連図・ズームマップ (`.diagram`)
```html
<div class="diagram"><script type="application/json">
{
  "zoom": false,                       // true: ノードのクリックでそこへズーム (ズームマップ)
  "direction": "LR",                   // LR (左→右) / TB (上→下)。座標を書かなければ自動配置
  "nodes": [
    { "id": "web", "label": "Web 画面", "sub": "React", "detail": "<p>説明</p>" },
    { "id": "api", "label": "注文 API", "accent": true },
    { "id": "db",  "label": "注文 DB", "kind": "db" },          // kind: db / user / queue / ext (外部・破線)
    { "id": "sys", "label": "注文システム", "sub": "クリックで中身を見る",
      "children": { "nodes": [ … ], "edges": [ … ] } }          // 入れ子の詳細図 (クリック / steps の zoom で中に入る)
  ],
  "edges": [
    { "from": "web", "to": "api", "label": "POST /orders", "flow": true },   // flow: 線上を点が流れる
    { "from": "api", "to": "db", "style": "dashed" }                          // curve: true で曲線、both: true で両矢印
  ],
  "groups": [{ "label": "バックエンド", "nodes": ["api", "db"] }],          // 枠で囲む
  "steps": [
    { "note": "全体像" },
    { "focus": ["web", "api"], "flow": ["web->api"], "note": "① 注文を送信" },  // focus 以外は薄く、flow の線に点を流す
    { "zoom": "sys", "select": "api", "note": "中身を見る" }                   // zoom: そのノードへズーム、select: 詳細パネルを開く
  ]
}
</script></div>
```
- 1 枚に置くノードは **12 個程度まで**。多いときは `children` で入れ子にするか、スライドを分ける
- 入れ子の中身は全体表示では薄く小さく見え、ズームすると読める大きさになる

### ER 図 (`.er-diagram`)
```html
<div class="er-diagram"><script type="application/json">
{
  "tables": [
    { "name": "users",  "detail": "会員", "columns": ["id PK bigint", "name varchar", "email varchar"] },
    { "name": "orders", "columns": ["id PK bigint", "user_id FK bigint", { "name": "status", "type": "varchar" }] }
  ],
  "relations": [{ "from": "orders.user_id", "to": "users.id", "card": "N:1" }],   // card: N:1 / 1:1 / N:M
  "steps": [{ "show": ["users", "orders"], "note": "…" }, { "show": ["order_items"] }]   // show は累積で増える
}
</script></div>
```
- 列は `"名前 PK|FK 型"` の文字列か `{ name, type, pk, fk }`。参照される側 (PK) が左に来るよう自動配置
- テーブルのクリックで、関連テーブルと結合キーの行が光る。1 枚に **6 テーブル程度まで**

### シーケンス図 (`.seq-diagram`)
```html
<div class="seq-diagram"><script type="application/json">
{
  "participants": ["ブラウザ", "API", "DB"],
  "messages": [
    { "from": "ブラウザ", "to": "API", "label": "ログイン", "note": "説明バーに出る一言" },
    { "from": "API", "to": "DB", "label": "照会" },
    { "from": "DB", "to": "API", "label": "結果", "type": "return" }     // type: sync (既定) / async / return。from = to で自己呼び出し
  ],
  "initial": 0                                                            // 最初から表示しておくメッセージ数
}
</script></div>
```
- メッセージが **1 本ずつ → キーのステップ**になる (`"steps": false` で全部を最初から表示)。**8 本程度まで**

### グラフ (`.chart`)
```html
<div class="chart"><script type="application/json">
{
  "type": "bar",                       // bar / hbar (横棒) / line / pie / donut
  "labels": ["4月", "5月", "6月"],
  "series": [{ "name": "手作業", "data": [42, 40, 38] }, { "name": "自動化", "data": [5, 9, 15] }],
  "unit": "件",
  "stacked": false,                    // 積み上げ (bar / hbar)
  "steps": "series"                    // 省略可。series: 系列を 1 つずつ、points: 項目を 1 つずつ表示
}
</script></div>
```
- 表示時に伸びる・描かれるアニメーション。凡例のクリックで系列を切り替え、ホバーで値を表示
- pie / donut は最初の系列だけを使う。**数値は与えられた事実だけを使い、創作しない**

### 3D 分解図 (`.stack3d`)
```html
<div class="stack3d" data-explode="step">          <!-- data-explode="step": → キーで分解 (省略時は表示時に分解) -->
  <div class="layer3d" data-detail="画面と入力チェック">プレゼンテーション層</div>   <!-- 先頭が一番上 -->
  <div class="layer3d" data-detail="ドメインのルール">アプリケーション層</div>
  <div class="layer3d">インフラ層</div>
</div>
```
- 層は HTML なので文字編集 (E キー) で直せる。クリックで `data-detail` を表示、ドラッグで回転。**6 層程度まで**

### ビフォー・アフター (`.compare`)
```html
<div class="compare" data-before="改善前" data-after="改善後" data-reveal="step">
  <div>…改善前 (コード・画像・カードなど何でも)…</div>
  <div>…改善後…</div>
</div>
```
- 2 つを重ねて表示し、境界をドラッグして比べる。`data-reveal="step"` で改善前から始まり、→ キーで改善後へスライド
  (省略時は `data-position="50"` の位置。0〜100)
- 中身は HTML なので文字編集 (E キー) で直せる。PDF・一覧では左右に並べて表示する (中身は少し縮小される)
- 横に長いコードは `code is-sm` にする。2 つの中身はできるだけ同じ大きさ・位置にすると比べやすい

### ターミナル再生 (`.terminal`)
```html
<div class="terminal"><script type="application/json">
{
  "title": "bash",
  "prompt": "$",                                  // 行ごとに { "cmd": "...", "prompt": "PS C:\\>" } で変えられる
  "lines": [
    { "cmd": "npm test" },
    { "out": "# pass 29", "type": "ok" },           // type: ok (緑) / err (赤) / warn (黄) / dim (薄い)
    { "out": "# fail 0", "type": "ok" }
  ],
  "speed": 35                                     // 1 文字の入力間隔 (ms)
}
</script></div>
```
- コマンド 1 つ (と続く出力) が → キーの 1 ステップ。1 文字ずつ入力してから出力を表示する (`"steps": false` で最初から全部表示、`"initial": n` で最初の n 個を表示しておく)
- 出力は実際の実行結果をそのまま使う (創作しない)。**全体で 14 行程度まで** (超えると古い行から見えなくなる)

## 良い例 (迷ったらこの形で書く)

どのテーマでも崩れないことを確認済みの書き方。内容を差し替えて使う。

### 流れ・手順 (矢印にラベルがある) → 関連図の部品
```html
<section class="slide" id="git-areas">
  <h2>変更は 3 つの場所を順に移動する</h2>
  <div class="fill">
    <div class="diagram"><script type="application/json">
    {
      "direction": "LR",
      "nodes": [
        { "id": "work", "label": "作業ディレクトリ", "sub": "編集する場所" },
        { "id": "stage", "label": "ステージング", "sub": "コミットの候補" },
        { "id": "repo", "label": "リポジトリ", "sub": "履歴の保存先", "accent": true }
      ],
      "edges": [
        { "from": "work", "to": "stage", "label": "git add", "flow": true },
        { "from": "stage", "to": "repo", "label": "git commit", "flow": true }
      ],
      "steps": [
        { "note": "変更は左から右へ進む" },
        { "focus": ["work", "stage"], "flow": ["work->stage"], "note": "① git add で選ぶ" },
        { "focus": ["stage", "repo"], "flow": ["stage->repo"], "note": "② git commit で記録する" }
      ]
    }
    </script></div>
  </div>
  <aside class="notes">add は「選ぶ」、commit は「記録する」。</aside>
</section>
```

### 比較 → カード 2 枚 + 結論の一言
```html
<section class="slide" id="merge-vs-rebase">
  <h2>自分のブランチは rebase、共有ブランチは merge</h2>
  <div class="fill v-center">
    <div class="cols-2 stretch">
      <div class="card step fade-up">
        <h3>merge</h3>
        <p>枝分かれの履歴がそのまま残る</p>
        <p class="muted">共有ブランチでも安全に使える</p>
      </div>
      <div class="card is-accent step fade-up">
        <h3>rebase</h3>
        <p>履歴が 1 本の線になって読みやすい</p>
        <p class="muted">push 済みのブランチには使わない</p>
      </div>
    </div>
    <div class="callout mt-3 step fade-up"><p>迷ったら「まだ誰とも共有していないか」で決める</p></div>
  </div>
</section>
```

### 数値 → `stat` を横に並べる
```html
<section class="slide" id="result">
  <h2>自動化でレビュー待ちが半分になった</h2>
  <div class="fill cols-3 middle">
    <div class="stat anim-fade-up"><div class="stat-value"><span data-count-to="52">52</span><span class="unit">%</span></div><div class="stat-label">レビュー待ち時間の削減</div></div>
    <div class="stat anim-fade-up" style="--delay:.15s"><div class="stat-value"><span data-count-to="3">3</span><span class="unit">倍</span></div><div class="stat-label">1 日のマージ数</div></div>
    <div class="stat anim-fade-up" style="--delay:.3s"><div class="stat-value"><span data-count-to="0">0</span><span class="unit">件</span></div><div class="stat-label">リリース後の障害</div></div>
  </div>
</section>
```

### コードと説明 → `data-emph-labels` で説明と同時に強調
```html
<section class="slide" id="code">
  <h2>設定 2 行で履歴が散らからない</h2>
  <div class="fill cols-2 middle">
    <div>
      <div class="code-title">.gitconfig</div>
      <pre class="code numbered"><code class="hl" data-lang="bash" data-emph="2|4" data-emph-labels="a|b">
        [pull]
          rebase = true
        [fetch]
          prune = true
      </code></pre>
    </div>
    <div class="v-center">
      <div class="callout step" data-step="a"><b>pull で rebase</b><br><span>余計なマージコミットを作らない</span></div>
      <div class="callout step mt-2" data-step="b"><b>消えた枝を掃除</b><br><span>リモートで消えた枝を手元でも消す</span></div>
    </div>
  </div>
</section>
```

### 崩れやすい書き方 (使わない)

| 避ける | 代わりに |
|---|---|
| `div` と CSS で箱と矢印を自作する (`position: absolute`、矢印の文字や疑似要素) | 矢印にラベルがあれば `.diagram`、なければ `.flow` |
| カード・箱に固定の `height` を付ける (中身が少ないと下が空き、多いとはみ出す) | 高さは書かない。揃えるなら `cols-2 stretch` |
| `style` 属性で色・文字サイズ・余白を細かく指定する | テーマ変数とクラス (`muted` `big` `mt-2` など)。必要ならデッキ専用 CSS |
| 1 枚に文章を詰め込む・カードに長文を入れる | 1 枚 1 メッセージ。カードの中は 1〜2 行の短文を 2〜3 個 |
| ブロック要素の横にむき出しの文字を置く (`<div><b>見出し</b>説明</div>` で説明が見出しに続いてしまう) | `<b>見出し</b><br><span>説明</span>` や `<h3>` + `<p>` |

## ステップ (→ キーで段階表示)

- 要素に `class="step"` を付けると、→ キーで 1 つずつ表示される (DOM の順)
- 表示方法: `step fade-up` / `step fade-left` / `step zoom-in` / (なし=フェード)
- `step emph`: 常に表示しておき、そのステップの間だけ強調
- `step dim-after`: 次のステップに進むと薄くなる (今どこの話か示す)
- 同時に表示: 同じ `data-step="ラベル"` を付ける。**スライド内の全ステップが数値ラベルなら数値順**、それ以外は最初に出てくる DOM 順
- 前のスライドに戻ると、全ステップ表示済みの状態になる

## アニメーション

- `anim-fade-up` `anim-fade-down` `anim-fade-left` `anim-fade-right` `anim-fade` `anim-zoom` `anim-pop` `anim-blur` `anim-draw`
- スライド表示時に再生される。`.step` と組み合わせるとそのステップの表示時に再生
- 遅延・長さ: `style="--delay:.3s; --dur:1s"`
- 子要素を順番に: 親に `anim-stagger` (間隔は `--stagger:.12s`)
- 数値カウントアップ: `data-count-to="1200"` (中身には最終値 `1,200` を書く)。`data-duration` `data-count-from` `data-sep="false"`
- タイプライター: `data-typewriter` (`data-speed` ms/文字)
- 1 枚に 3 種類以上の動きを混ぜない (統一感がなくなる)

### 演出レベル

依頼に「動きを多めに」「控えめに」などの指定があれば従う。指定がなければ **標準**。

| レベル | 内容 |
|---|---|
| 控えめ | 表紙・扉だけ入場アニメーション。本文はステップ表示のみ (報告・フォーマルな場向け) |
| 標準 | 各スライドの主要要素に入場アニメーション (`anim-fade-up` など)。箇条書き・比較・図はステップで段階表示。数値はカウントアップ |
| 多め | 全スライドに入場アニメーション + `anim-stagger` で順番に登場。図は `anim-draw` と `<g class="step">` で組み上げ、1 枚以上はインタラクティブなデモや動く図 (デッキ専用 JS) を入れる。切り替えは `slide` や `zoom` も使う |

どのレベルでも、動きは「注目してほしい順番」を示すために使う。意味のない回転・点滅はしない。

## スライドごとの JS (デッキ専用 JS)

```js
Deck.onSlide('slide-id', {
  enter(el) { const t = setInterval(tick, 100); return () => clearInterval(t); }, // 返した関数は離脱時に実行
  step(el, n) { },   // スライドに入ったとき (enter の直後) とステップ変化時 (n = 表示済みステップ数)
  leave(el) { },
  print(el) { },     // PDF 出力時。静的な最終状態を描く (canvas など)
});
```
- タイマー・アニメーションループは **必ず enter の戻り値で後片付けする**
- **enter は初期化、step は「n から表示を決める」処理** に分ける。step は入り方 (順送り・戻る・`#3.2` への直接移動) に関係なく呼ばれるので、前の状態に依存せず n だけで表示を決める (何度呼ばれても同じ結果になるように書く)
- print が Promise を返すと、PDF 出力・撮影はその完了を待つ
- 自作の非同期演出は `Deck.track(promise)` で登録すると、撮影時に完了を待つ
- 一覧・PDF でも見えるよう、DOM の初期描画は読み込み時に行う
- その他の API: `Deck.next()` `Deck.prev()` `Deck.goto(index, step)` `Deck.index` `Deck.step` `Deck.onChange(fn)` `Deck.mode` (`main` / `presenter` / `embed` / `print`)
- DOM イベント: スライド要素で `deck:enter` `deck:leave` `deck:step` が発火する

## デザインの原則

- **1 スライド 1 メッセージ。** タイトルは「主張」にする (例:「売上推移」より「売上は 3 年で 2 倍」)
- 文字サイズの下限: 本文 **36px 以上**、補足 **28px 以上**、コード 24px 以上 (会議室の後ろからでも読めるように)
- 箇条書きは **5 項目・各 1〜2 行まで**。超えるならスライドを分ける
- 余白を怖がらない。詰め込まずに分割する
- 色はテーマ変数だけを使う (`--accent` `--accent-2` `--accent-3` `--fg` `--muted` `--surface` `--border` など)。直接の色指定は避ける
- 図・コード・デモ・数値など **HTML ならではの表現** を積極的に使う。文字だけのスライドが続かないようにする
- 発表者ノート (`aside.notes`) に話す内容の要点を書く

## ユーザーによる文字編集

ユーザーはデッキを開いて **枠のダブルクリック (または E キー) で文字を直接直し、Ctrl+S で保存できる** (jh-editor のプレビューからも可)。ブラウザの「名前を付けて保存」はデッキを壊すので使わないよう案内する。
編集できるのは「文字と行内要素 (`b` `span` `code` `br` など) だけを含む要素」で、いちばん外側の単位でまとめて編集される。編集しやすいように:
- 文字は要素で囲む。**ブロック要素と同じ箱の中に、むき出しの文字を並べない** (NG: `<div><div class="no">1</div>説明</div>` → OK: `<div><div class="no">1</div><p>説明</p></div>`)
- 見出し + 説明のような 1 つのまとまりは `<div><b>見出し</b><span>説明</span></div>` のように組むと、まとめて編集できる
- 編集させたくない要素には `class="no-edit"`。コードブロック・図 (SVG)・ノート・カウントアップの数値は対象外
- 詳細は `docs/edit-protocol.md`

## 発表中の操作 (ユーザー向け)

→ / Space: 次へ、←: 前へ、S: 発表者ビュー (ノート・次スライド・タイマー。発表者ビュー側でもキー・クリック・ボタンで操作でき、発表画面がついてくる)、E: 文字の編集モード、O: 一覧、F: 全画面、B: ブラックアウト、数字+Enter: ジャンプ、?: ヘルプ
URL の `#5.2` は「5 枚目のステップ 2」。リロードしても位置が保たれる。

### 全画面で発表する

- ブラウザの制約で、開いた瞬間に JS で全画面にはできない
- MCP: ユーザーが「発表する」「全画面で開いて」と言ったら `open_deck` に `fullscreen: true` (Chrome / Edge を全画面のアプリウィンドウで起動。F11 / Esc で解除)
- 発表モード: デッキの `autoFullscreen` (MCP の `create_deck` / `write_deck`、`<div class="deck" data-auto-fullscreen="true">`) を有効にすると、開いた後の最初の → キー・クリックで全画面になる。URL に `?fullscreen` を付けるとその回だけ有効
