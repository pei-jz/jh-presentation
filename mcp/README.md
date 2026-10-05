# jh-presentation MCP サーバー

AI クライアント (Claude Desktop / Claude Code / VS Code など) から、HTML プレゼンの作成・確認・出力を行うための MCP サーバー。
**LLM はクライアント側のものを使う**ので、API キーは不要。

## 必要なもの

- Node.js 20 以上
- Chrome または Edge (スクリーンショット・検査・PDF 出力に使用。別の場所にある場合は環境変数 `CHROME_PATH`)

## ワークスペース (デッキの保存先)

優先順: `--workspace <dir>` 引数 → 環境変数 `JH_PRESENTATION_HOME` → `~/jh-presentation`

```
<workspace>/
  2026-10-02-xxx.html   デッキ (1 ファイルで完結。そのまま配布・発表できる)
  2026-10-02-xxx.pdf    export_deck の出力
  brand/                名前・ロゴ (brand.json + ロゴ画像)。最初はサンプルがコピーされる
  themes/               自作テーマ (create_theme で保存される)
  prompts/              チーム・個人の依頼文テンプレート
  .history/<name>/      保存履歴 (書き込み前の版。最大 20 件)
```

- 書き込みは一時ファイル経由で置き換える (途中で失敗してもファイルが壊れない)
- `read_deck` が返す `revision` を書き込み時に渡すと、読んだ後に他で変更されていた場合は保存しない
- 検査・撮影・PDF 出力のブラウザは外部への通信を遮断する (外部参照は `audit_deck` で報告される)

旧形式 (`decks/<name>/index.html`) のデッキは、起動時に自動で 1 ファイル形式に変換される (元のフォルダは残る)。

## 提供する道具

| 分類 | 道具 | 内容 |
|---|---|---|
| ガイド | `get_guide` | スライドの書き方・部品・演出レベル・ブランド・作業手順 (AI が最初に読む) |
| テーマ | `list_themes` | テーマ一覧 (同梱 + 自作。雰囲気の説明・タグ付き) |
| | `open_theme_gallery` | 全テーマの見本をユーザーのブラウザで開く (実際に動く見本で選べる) |
| | `preview_themes` | テーマの見本を画像で返す (AI の見比べ・自作テーマの確認用) |
| | `get_theme_guide` / `create_theme` | テーマ作成ガイド / 自作テーマの保存 |
| テンプレート | `list_templates` | 依頼文テンプレートの一覧と本文 |
| デッキ | `list_decks` / `read_deck` | 一覧・内容の読み込み |
| | `create_deck` / `write_deck` / `replace_slide` | 作成・書き込み・1 枚だけ差し替え (テーマ・ブランド位置も指定可) |
| | `add_asset` | 画像・動画をデッキに埋め込む (`<img data-asset="名前">` で参照) |
| | `upgrade_deck` | 埋め込まれたエンジン・テーマ・ブランドを最新にする (書き込みでは変わらない。明示的に実行したときだけ) |
| | `list_history` / `restore_history` | 保存履歴 (書き込み前の版を最大 20 件) / 前の版に戻す |
| 確認 | `audit_deck` | はみ出し・切れ・文字の重なり・コントラスト・画像の欠落・小さすぎる文字・JS エラー/警告・外部通信を検出 (ok は「検査した項目で問題なし」) |
| | `screenshot_deck` | スライドを画像にして AI に返す (AI が見て直せる) |
| 出力 | `open_deck` / `export_deck` | ブラウザで開く (ローカルサーバー経由。E キーで文字を直して Ctrl+S で元のファイルに直接保存できる。`fullscreen: true` で全画面のアプリウィンドウで起動) / PDF に出力 |
| 復旧 | `repair_deck` | ブラウザの「名前を付けて保存」で壊れたデッキを元に戻す (`list_decks` で broken と出るもの) |

## 依頼文テンプレート (プロンプト)

`prompts/*.md` が MCP のプロンプトとして登録され、クライアントのメニューから選べる。
どのテンプレートも **演出レベル** (控えめ / 標準 / 多め) と **ブランド枠** (なし / 上 / 下 / 上下) を指定できる。

| 名前 | 内容 | 既定の演出 / ブランド |
|---|---|---|
| `general` | 汎用 (テーマ・時間・聞き手を指定) | 標準 / brand.json の既定 |
| `tech-talk` | 技術解説 (図解・コード・ステップ多め) | 多め / 下 |
| `lightning-talk` | LT (1 枚 1 メッセージ) | 多め / なし |
| `progress-report` | 進捗報告 (結論先出し・数字と課題) | 控えめ / 下 |
| `tech-proposal` | 技術選定・提案 (比較表と根拠) | 標準 / 下 |

チームや個人のテンプレートは **ワークスペースの `prompts/`** に Markdown で追加する (同名なら上書き、サーバー再起動で反映)。
書き方は [prompts/README.md](../prompts/README.md)。

## 名前・ロゴ

`<workspace>/brand/brand.json` を編集し、ロゴ画像を同じフォルダに置く ([brand/README.md](../brand/README.md))。
既存のデッキに反映するには `upgrade_deck` を実行する (AI に「ブランドを最新にして」と頼めばよい)。

## テーマを増やす

AI に頼むだけでよい (例:「コーポレートカラー #0b4f9c で落ち着いたテーマを作って」)。
AI が `get_theme_guide` → `create_theme` → `preview_themes` で作成・確認し、`<workspace>/themes/` に保存する。
手で作る場合は [docs/theme-guide.md](../docs/theme-guide.md) を参照して CSS を置く。

## 起動方法 (npx)

| 配布方法 | 指定 | 備考 |
|---|---|---|
| **npm (推奨)** | `npx -y jh-presentation` | 公開版。バージョンを固定するなら `jh-presentation@0.5.2` |
| GitHub | `npx -y github:pei-jz/jh-presentation` | 最新の main。起動のたびに取得し直すことがあり遅い |
| ローカルのリポジトリ | `node C:/path/to/jh-presentation/mcp/server.mjs` | 開発用。起動が速く、手元の変更がすぐ反映される |
| 固定インストール | `npm install -g jh-presentation` → `jh-presentation` | 起動が速い。更新は手動 |

### Claude Desktop

設定 → 開発者 → 「構成を編集」で `claude_desktop_config.json` を開く。

```json
{
  "mcpServers": {
    "jh-presentation": {
      "command": "npx",
      "args": ["-y", "jh-presentation", "--workspace", "C:/Users/<you>/Documents/decks"]
    }
  }
}
```

- 初回はダウンロードに時間がかかるので、先にターミナルで同じコマンドを 1 回実行しておくと確実
- Windows で `npx` が見つからない場合は `"command": "cmd"`, `"args": ["/c", "npx", "-y", ...]`
- 設定後は Claude Desktop をタスクトレイから「終了」して再起動
- ログ: `%APPDATA%\Claude\logs\mcp-server-jh-presentation.log`

### Claude Code

```bash
claude mcp add jh-presentation -- npx -y jh-presentation --workspace C:/Users/<you>/Documents/decks
```

### VS Code (`.vscode/mcp.json`)

```json
{
  "servers": {
    "jh-presentation": {
      "command": "npx",
      "args": ["-y", "jh-presentation", "--workspace", "${userHome}/Documents/decks"]
    }
  }
}
```

## 開発

```bash
npm run mcp           # .workspace/ をワークスペースとして起動 (stdio)
npm run mcp:inspect   # MCP Inspector で道具を手動実行して確認
```

stdout は MCP の通信に使うため、ログは必ず `console.error` に出すこと。
