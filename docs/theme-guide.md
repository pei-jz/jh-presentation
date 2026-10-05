# テーマ作成ガイド

テーマは **default テーマに重ねる CSS** です。色やフォントの変数を上書きし、必要なら表紙・セクション扉などの装飾を変えます。
部品の書き方はテーマに関係なく同じなので、テーマを変えてもスライドの中身は書き直す必要がありません。

## 置き場所

- MCP: `<ワークスペース>/themes/<名前>.css` (`create_theme` で保存すると自動でここに入る)
- リポジトリ: `themes/<名前>.css` (同梱テーマになる)
- 同梱テーマ (default / dark / corporate / pop / mono) と同じ名前は使えない

## ファイルの形

```css
/* @theme acme-blue
 * @label ACME ブルー
 * @description ブランドカラーの青を基調にした落ち着いたデザイン。提案向け
 * @tags 落ち着いた, フォーマル, 提案
 */

:root {
  --accent: #0b4f9c;
  --accent-2: #00a0b0;
  --accent-3: #f2a900;
  --accent-soft: rgba(11, 79, 156, .08);
}

/* 必要なら装飾も上書きする */
.layout-section { background: var(--accent); }
```

先頭コメントの `@theme` `@label` `@description` `@tags` は一覧・ギャラリーに表示され、AI がテーマを選ぶ手がかりになる。

## 変数一覧 (`:root`)

| 変数 | 用途 | default の値 |
|---|---|---|
| `--bg` | スライドの背景 | `#ffffff` |
| `--fg` | 本文の文字色 | `#1a1f2b` |
| `--muted` | 補足・ページ番号の文字色 | `#6b7280` |
| `--surface` / `--surface-2` | カード・インラインコードの背景 | `#f4f6fa` / `#e9edf5` |
| `--border` | 枠線・区切り線 | `#d9dee8` |
| `--accent` | メインの強調色 (見出しの線・強調文字・ボタン・数値) | `#2563eb` |
| `--accent-2` | 2 番目の色 (グラデーション・補助) | `#0ea5a4` |
| `--accent-3` | 3 番目の色 (注意・ハイライト) | `#f59e0b` |
| `--accent-soft` | 強調色の薄い背景 (`is-accent` カード・コールアウト) | accent の 10% |
| `--on-accent` | 強調色の上に置く文字色 (セクション扉・バッジ) | `#ffffff` |
| `--danger` / `--success` | 警告・成功 | 赤 / 緑 |
| `--emph-bg` | ステップ強調 (`step emph`) の背景 | 黄色の半透明 |
| `--code-bg` / `--code-fg` | コードブロック | 濃紺 / 白 |
| `--tok-k` `--tok-s` `--tok-n` `--tok-c` `--tok-f` | コードの色分け (キーワード・文字列・数値・コメント・関数) | |
| `--font-sans` | 本文フォント | BIZ UDPGothic など |
| `--font-heading` | 見出しフォント (明朝にすると上品になる) | `--font-sans` |
| `--font-mono` | コードのフォント | Cascadia Code など |
| `--radius` | 角丸 (カード・コード) | `16px` |
| `--pad-x` / `--pad-y` | スライドの左右・上下の余白 | `120px` / `96px` |

フォントは OS 標準のものだけを使う (外部フォントは読み込まない)。

## よく上書きする装飾

| セレクタ | 内容 |
|---|---|
| `.slide > h2:first-child` と `::after` | 通常スライドのタイトル帯 (下線と短いアクセント線) |
| `.layout-title` と `::before` | 表紙の背景・左の縦線 |
| `.layout-section` | セクション扉の背景 (既定はグラデーション) |
| `.layout-end` | 結びの背景 |
| `.card` / `.callout` / `.badge` / `.btn` | 部品の形 |
| `.deck-brand` / `.deck-brand-cover` / `.deck-brand-label` | ブランド枠 (名前・ロゴ) の色・表紙ロゴの位置 |
| `.deck-brand-holder.on-layout-end .deck-brand` | 背景が暗いスライド上のブランド文字色 |

同梱テーマ (`themes/corporate.css` `pop.css` `mono.css`) が装飾の上書き例になる。

## ルール

- **コントラストを確保する**: `--fg` と `--bg`、`--on-accent` と `--accent` は十分に差をつける
- 背景を暗くするテーマでは `--surface` `--border` `--code-bg` も暗い色に合わせる
- レイアウト (余白・文字サイズの大きな変更) より、色と装飾で個性を出す。部品のはみ出しの原因になる
- ブランドカラーがある場合は `--accent` に入れ、`--accent-2` `--accent-3` はそれに合う色を選ぶ

## 確認手順

1. `preview_themes` で `themes: ["<名前>"]`, `slides: [1,2,3,4,5,6]` を撮影し、全見本スライドを確認する
   (1=表紙 2=セクション扉 3=カード 4=数値 5=コード 6=結び。下の帯はブランド枠の表示例)
2. 文字の読みやすさ・色のバランス・ブランド枠の見え方を確認して調整する
3. ユーザーには `open_theme_gallery` で他のテーマと並べて見てもらう
