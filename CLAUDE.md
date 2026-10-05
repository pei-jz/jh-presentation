# jh-presentation — AI が作る HTML プレゼンテーション

プレゼンテーションのスライドを **HTML / CSS / JS** で作るプロジェクト。
スライドは人ではなく **AI (あなた) が作成・修正する** 前提。ユーザーは日本語で内容を依頼し、ブラウザで確認して修正を指示する。

スライドの書き方・部品カタログ・デザイン原則は次のガイドに従う (MCP サーバーとも共通):
@docs/authoring-guide.md

## 構成

```
engine/       共通エンジン (スライド送り・拡縮・ステップ・発表者ビュー・印刷・ブランド枠)。依存なし
components/   部品ライブラリ (レイアウト・カード・コード・図・アニメーション・ブランド枠の見た目)
themes/       同梱テーマ (default / dark / corporate / pop / mono)
brand/        ブランド設定 (名前・ロゴ) のサンプル。brand.json + ロゴ
decks/        デッキ (1 ファイルの HTML)
examples/     sample.html (機能一覧の見本)
docs/         AI 向けガイド (authoring-guide.md / theme-guide.md)
prompts/      依頼文テンプレート (技術解説・LT・進捗報告など。MCP のプロンプトとして登録される)
mcp/          MCP サーバー (npx で起動。他の AI クライアントから同じ道具を使う)
tools/        serve (プレビュー) / new-deck / upgrade / pdf / gallery、lib/deckfile.mjs (デッキの組み立て・解析)
```

## デッキファイルの形式 (1 ファイルで完結)

デッキ `decks/<name>.html` にはエンジン・テーマ・ブランド・画像がすべて埋め込まれている。

```
<head>  <meta name="jh-theme" content="..."> / <meta name="jh-brand" content="none|header|footer|both"> / <title>
<!-- jh:slides -->        … スライド (編集してよい)
<!-- jh:deck-style -->    … デッキ専用 CSS (編集してよい)
===== 自動生成 =====      … エンジン・テーマ・ブランド・画像 (編集しない。数万文字あるので読まない)
<!-- jh:deck-script -->   … デッキ専用 JS (編集してよい。ファイルの末尾)
```

- **ファイル全体を読まない。** `jh:slides` と `jh:deck-style` はファイル先頭付近にある。`jh:deck-script` は末尾にあるので、Grep で行番号を調べてから読む
- テーマ・ブランド位置を変えるときは `<head>` の meta を書き換え、`npm run upgrade -- <name>` で埋め込みを作り直す
- 発表モード (最初の操作で全画面) は `<div class="deck">` に `data-auto-fullscreen="true"` を付ける
- 画像は `<img data-asset="名前">` で参照する。埋め込みは MCP の `add_asset` を使うか、ユーザーに確認する

## このリポジトリでのルール

1. **デッキの作業では `decks/<name>.html` の編集可能な範囲だけを変更する。** `engine/` `components/` `themes/` `docs/` `mcp/` `tools/` は共通部分なので、ユーザーが明示的に頼んだ場合だけ変更する。
   ユーザーが「技術解説を」「進捗報告を」のように依頼したら、`prompts/` の該当テンプレートの構成・方針に沿って作る。
2. 新しいデッキは `npm run new -- <英数字名> "タイトル" [--theme <テーマ>] [--brand footer]` で作る (`decks/YYYY-MM-DD-<名前>.html`)。
3. 機能の見本は `examples/sample.html` (構成図の SVG、コードと説明の連動、インタラクティブなデモなど)。
4. 共通部品・テーマを変更したら、`docs/authoring-guide.md` の部品カタログ・テーマ表 (テーマなら `docs/theme-guide.md` も) を更新する。
   テーマ・エンジンを変更したら、テーマギャラリー (`/gallery/`) で全テーマを並べて確認し、全テーマで `Deck.audit()` が空になることを確かめる。
   変更後は `npm run upgrade` で `decks/` のデッキに最新のエンジンを埋め込んでから確認する (デッキは埋め込まれたエンジンで動く。内容の修正だけではエンジンは更新されない)。
5. 作成・修正したら **必ず「確認手順」を実行する**。

## 作業の流れ (依頼を受けたら)

1. 内容を把握する: 目的・聞き手・持ち時間・伝えたいこと。不明でも妥当な想定で進め、想定は最後に伝える。
2. 構成案 (スライドごとのタイトルと要点) を作る。長い発表や方向性が曖昧なときは、構成案の時点でユーザーに確認する。
3. `npm run new` でデッキを作り、スライドを書く。
4. 確認手順を実行し、崩れを直してから完了報告する。

## 確認手順 (作成・修正後に必ず実行)

1. プレビューサーバーを起動する: `.claude/launch.json` の `decks` (`npm run dev` → http://localhost:4000)
2. `http://localhost:4000/decks/<name>.html` を開き、ブラウザのコンソールで **`Deck.audit()`** を実行する
   - 戻り値が空配列 `[]` なら「検査した項目では問題なし」。要素があれば `type` (overflow / clipped / overlap / contrast / asset / image) ごとに直す
   - 意図的なはみ出し・重なり・低コントラストは `allow-overflow` / `allow-overlap` / `allow-low-contrast` クラスで除外する
   - 検査は見た目の良し悪しまでは判定しない。必ず 3 のスクリーンショット確認と組み合わせる
3. 各スライドを `Deck.goto(i, Infinity)` (全ステップ表示) にしてスクリーンショットで目視確認する
   - 文字の折り返しの不自然さ、重なり、空きすぎ・詰めすぎ、コントラスト
4. コンソールにエラーが出ていないか確認する
5. PDF 配布する場合は `?print` を付けて表示し、アニメーションなしでも内容が揃っているか確認する

## コマンド

```
npm run dev                         プレビュー (http://localhost:4000、保存で自動リロード、/gallery/ でテーマギャラリー)
npm run new -- <name> "タイトル" [--theme <テーマ>] [--brand none|header|footer|both] [--fullscreen]
npm run upgrade [-- <name>]         デッキに最新のエンジン・テーマ・ブランドを埋め込む (旧形式のフォルダデッキも変換)
npm run pdf -- <name>               dist/<name>.pdf に出力 (Chrome / Edge を使用)
npm run gallery                     テーマギャラリーを生成 (npm run dev 中は自動)
npm run mcp                         MCP サーバーを起動 (ワークスペース: .workspace/)
npm run repair -- <name>            ブラウザの「名前を付けて保存」で壊れたデッキを復旧
npm test                            テスト (node --test。tests/*.test.mjs を自動で探す)
```
