#!/usr/bin/env node
// jh-presentation MCP サーバー (stdio)
//
// LLM は接続した AI クライアント側 (Claude Desktop / Claude Code / VS Code など) が担当し、
// このサーバーはデッキの作成・確認・出力の「道具」だけを提供する。API キーは不要。
//
//   npx -y jh-presentation --workspace <デッキの保存先>   (または環境変数 JH_PRESENTATION_HOME)
//
// デッキは 1 ファイルで完結する HTML (<ワークスペース>/<name>.html)。
// 注意: stdout は MCP の通信に使うため、ログは必ず stderr (console.error) に出す。
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  PKG_ROOT, resolveWorkspace, ensureWorkspace, ctxFor, listDecks, createDeck, readDeck, writeDeck,
  replaceSlide, addAsset, listHistory, restoreHistory, saveDeckFile, isBrowserSaved, deckFile, listThemes, assertTheme, saveTheme, readGuide, readThemeGuide,
  brandDir, themesDir, promptsDir,
} from './workspace.mjs';
import { loadPromptTemplates, renderPrompt } from './prompts.mjs';
import { buildGallery } from '../tools/lib/gallery.mjs';
import { loadBrand, buildDeck, BRAND_POSITIONS, TRANSITIONS } from '../tools/lib/deckfile.mjs';
import { createSaveToken, injectSaveConfig, handleSave } from '../tools/lib/save-endpoint.mjs';
import { launchFullscreen } from '../tools/lib/browser.mjs';
import { auditDeck, screenshotDeck, exportPdf, extractFromSavedPage, closeBrowser } from './render.mjs';

const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));
const WS = resolveWorkspace();
const setup = ensureWorkspace(WS);
const GALLERY_DIR = path.join(os.tmpdir(), 'jh-presentation-gallery');

const MCP_WORKFLOW = `
## MCP での作業手順

1. このガイドを読む (get_guide)。
2. 依頼内容 (目的・聞き手・持ち時間) から構成案を作る。曖昧で長い発表なら、構成案をユーザーに確認してから進める。
3. create_deck でデッキを作る (英数字の name と日本語の title)。
   テーマは内容・聞き手に合わせて list_themes から選ぶ。ユーザーが見た目で選びたい場合は open_theme_gallery を使う。
   名前・ロゴの帯を入れる場合は brand を指定する (header / footer / both)。
4. write_deck でスライドを書く。slides には <section class="slide"> の並びだけを渡す (外枠・エンジンはサーバーが埋め込む)。
   デッキ専用のスタイル・動きは css / js に渡す。1 枚だけ直すときは replace_slide を使う。
   画像は add_asset で埋め込み、<img data-asset="名前"> で参照する。
5. audit_deck を実行し、overflow (はみ出し)・smallText (小さすぎる文字)・errors (JS エラー) を直す。
6. screenshot_deck で実際の見た目を確認する (数枚ずつ)。重なり・空きすぎ・詰めすぎ・不自然な折り返しを直す。
   ステップやアニメーションの途中を確認したい場合は step に数値を指定する。
7. 完成したら open_deck でユーザーのブラウザに表示する (発表するときは fullscreen: true)。デッキは 1 ファイルなので、そのまま配布できる。
   PDF が必要なら export_deck。

- 既存デッキの修正は read_deck で現在の内容を読んでから行い、返された revision を write_deck / replace_slide に渡す。
- 書き込みで埋め込みのエンジンは変わらない。最新化 (upgrade_deck) はユーザーが求めたときだけ。
- 失敗したら list_history / restore_history で前の版に戻せる。
- list_decks で broken と出たデッキ (ブラウザの「名前を付けて保存」で壊れたもの) は repair_deck で復旧する。
- ユーザーには「文字の修正は E キー → Ctrl+S で保存。ブラウザの『名前を付けて保存』は使わない」と伝える。
`;

const server = new McpServer(
  { name: 'jh-presentation', version: pkg.version },
  {
    instructions:
      'HTML プレゼンテーション (スライド) を作成・確認・出力する道具。デッキは 1 ファイルの HTML として保存される。' +
      'スライドを作る前に必ず get_guide を呼び、ガイドの部品とルールに従って書くこと。' +
      '書いた後は audit_deck と screenshot_deck で確認して直してから、ユーザーに完了を伝える。',
  },
);

// ---------------------------------------------------------------------------
// 共通
// ---------------------------------------------------------------------------
const text = (t) => ({ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) });

function tool(name, config, handler) {
  server.registerTool(name, config, async (args) => {
    try {
      return await handler(args || {});
    } catch (e) {
      console.error(`[${name}]`, e);
      return { isError: true, content: [text(`エラー: ${e.message || e}`)] };
    }
  });
}

function deckInfo(d) {
  return {
    name: d.name, title: d.title, theme: d.theme, brand: d.brand, transition: d.transition, autoFullscreen: d.autoFullscreen,
    slideCount: d.slideCount, file: d.file, url: pathToFileURL(d.file).href,
  };
}

function openInBrowser(target) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', `"${target}"`]]
    : process.platform === 'darwin' ? ['open', [target]]
      : ['xdg-open', [target]];
  spawn(cmd, args, { detached: true, stdio: 'ignore', windowsVerbatimArguments: process.platform === 'win32' }).unref();
}

const deckName = z.string().describe('デッキ名 (list_decks / create_deck が返す name。.html は不要)');
const brandSchema = z.enum(BRAND_POSITIONS).describe('ブランド枠 (名前・ロゴ): none / header (上) / footer (下) / both (上下)');
const transitionSchema = z.enum(TRANSITIONS).describe('スライド切り替え効果');
const autoFullscreenSchema = z.boolean().describe('発表モード: 開いた後の最初の → キー・クリックで全画面にする (既定 false)');

function themeSummary() {
  return listThemes(WS).map((t) => `- ${t.name} (${t.label})${t.custom ? ' [自作]' : ''}: ${t.description}`).join('\n');
}

// ---------------------------------------------------------------------------
// ガイド
// ---------------------------------------------------------------------------
tool('get_guide', {
  title: 'デッキ作成ガイドを読む',
  description: 'スライドの書き方・部品カタログ・デザイン原則・作業手順。スライドを書く前に必ず読むこと。',
  annotations: { readOnlyHint: true },
}, async () => {
  const b = loadBrand(brandDir(WS));
  return {
    content: [text(readGuide() + '\n' + MCP_WORKFLOW +
      `\n## 利用できるテーマ\n\n${themeSummary()}\n` +
      `\n## ブランド設定\n\n名前: ${b.name || '(なし)'} / ラベル: ${b.label || '(なし)'} / ロゴ: ${b.logo ? 'あり' : 'なし'} / 新規デッキの既定: ${b.position}\n` +
      `設定ファイル: ${path.join(brandDir(WS), 'brand.json')}\n` +
      `\nワークスペース: ${WS}\n`)],
  };
});

server.registerResource('guide', 'jh-presentation://guide', {
  title: 'デッキ作成ガイド',
  description: 'スライドの書き方・部品カタログ・デザイン原則',
  mimeType: 'text/markdown',
}, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: readGuide() + '\n' + MCP_WORKFLOW }] }));

// ---------------------------------------------------------------------------
// テーマ
// ---------------------------------------------------------------------------
tool('list_themes', {
  title: 'テーマ一覧',
  description: '利用できるデザインテーマ (同梱 + 自作。名前・表示名・雰囲気の説明・タグ)。内容や聞き手に合うテーマを選ぶときに使う。',
  annotations: { readOnlyHint: true },
}, async () => ({ content: [text({ themes: listThemes(WS), customThemeDir: themesDir(WS) })] }));

function galleryThemes(names) {
  const all = listThemes(WS);
  return names && names.length ? all.filter((t) => names.includes(t.name)) : all;
}

tool('open_theme_gallery', {
  title: 'テーマギャラリーを開く',
  description:
    '全テーマの見本スライドを並べたページを生成し、ユーザーのブラウザで開く。' +
    'ユーザーが「テーマを見たい」「どんなデザインがある?」と言ったときに使う (実際に動く見本を見て選べる)。',
}, async () => {
  const { index, themes } = buildGallery(GALLERY_DIR, galleryThemes(), ctxFor(WS));
  openInBrowser(index);
  return {
    content: [text({
      opened: pathToFileURL(index).href,
      themes: themes.map((t) => ({ name: t.name, label: t.label })),
      tip: 'ユーザーに、使いたいテーマ名を伝えてもらう',
    })],
  };
});

tool('preview_themes', {
  title: 'テーマを画像で比較',
  description:
    '各テーマの見本スライドを画像で返す (AI がテーマを見比べる用。テーマ作成後の確認にも使う)。' +
    'slide: 1=表紙 2=セクション扉 3=カード 4=数値 5=コード 6=結び',
  inputSchema: {
    themes: z.array(z.string()).optional().describe('対象のテーマ名 (省略時は全テーマ)'),
    slides: z.array(z.number().int().min(1).max(6)).max(6).optional().describe('見本スライドの番号 (既定 [1])'),
  },
  annotations: { readOnlyHint: true },
}, async ({ themes, slides }) => {
  (themes || []).forEach((t) => assertTheme(WS, t));
  const { dir, themes: targets } = buildGallery(GALLERY_DIR, galleryThemes(themes), ctxFor(WS));
  const content = [];
  for (const t of targets) {
    const r = await screenshotDeck(path.join(dir, t.name + '.html'), { slides: slides || [1], scale: 0.3 });
    content.push(text(`${t.name} (${t.label}): ${t.description}`));
    for (const img of r.images) content.push({ type: 'image', data: img.data, mimeType: 'image/jpeg' });
    if (r.errors.length) content.push(text({ errors: r.errors }));
  }
  return { content };
});

tool('get_theme_guide', {
  title: 'テーマ作成ガイドを読む',
  description: '新しいテーマを作るためのガイド (変数の一覧・装飾の上書き方法・確認手順)。create_theme の前に読む。',
  annotations: { readOnlyHint: true },
}, async () => ({ content: [text(readThemeGuide())] }));

tool('create_theme', {
  title: 'テーマを作成・更新',
  description:
    '自作テーマを保存する (同名の自作テーマは上書き)。css は default テーマに重ねる CSS (:root の変数上書き + 必要な装飾)。' +
    '保存後は preview_themes で全見本スライドを確認して調整すること。get_theme_guide を先に読む。',
  inputSchema: {
    name: z.string().describe('テーマ名 (英小文字・数字・ハイフン。例: acme-blue)'),
    label: z.string().describe('表示名 (例: ACME ブルー)'),
    description: z.string().describe('雰囲気と向いている発表 (1 文)'),
    tags: z.array(z.string()).optional().describe('タグ (例: ["落ち着いた", "フォーマル"])'),
    css: z.string().describe('テーマの CSS'),
  },
}, async (args) => {
  const file = saveTheme(WS, args);
  return { content: [text({ saved: file, next: `preview_themes で themes: ["${args.name}"], slides: [1,2,3,4,5,6] を確認する` })] };
});

// ---------------------------------------------------------------------------
// 依頼文テンプレート (prompts/*.md → MCP プロンプト)
// ---------------------------------------------------------------------------
const promptTemplates = loadPromptTemplates([path.join(PKG_ROOT, 'prompts'), promptsDir(WS)]);

for (const t of promptTemplates) {
  const argsSchema = {};
  for (const a of t.args) {
    argsSchema[a.name] = a.required ? z.string().describe(a.description) : z.string().optional().describe(a.description);
  }
  server.registerPrompt(t.name, { title: t.title, description: t.description, argsSchema }, (values) => ({
    messages: [{ role: 'user', content: { type: 'text', text: renderPrompt(t, values || {}) } }],
  }));
}

tool('list_templates', {
  title: '依頼文テンプレート一覧',
  description:
    '用意されている依頼文テンプレート (技術解説・LT・進捗報告など) の一覧と本文。' +
    'クライアントのプロンプトメニューを使えない場合や、ユーザーが「どんな型がある?」と聞いたときに使い、' +
    '選ばれたテンプレートの本文に沿って作成を進める。',
  annotations: { readOnlyHint: true },
}, async () => ({
  content: [text({
    templates: promptTemplates.map((t) => ({ name: t.name, title: t.title, description: t.description, args: t.args, body: t.body })),
    custom: `独自のテンプレートは ${promptsDir(WS)} に Markdown で追加できる (サーバー再起動で反映)`,
  })],
}));

// ---------------------------------------------------------------------------
// デッキの作成・読み書き
// ---------------------------------------------------------------------------
tool('list_decks', {
  title: 'デッキ一覧',
  description: 'ワークスペースにあるデッキの一覧 (新しい順)。',
  annotations: { readOnlyHint: true },
}, async () => {
  const result = { workspace: WS, decks: listDecks(WS) };
  if (setup.migrated.length) result.migrated = `旧形式から 1 ファイル形式に変換したデッキ: ${setup.migrated.join(', ')}`;
  if (setup.legacy.length) {
    result.legacyFolders = `旧形式のフォルダが残っています (${setup.legacy.join(', ')})。変換済みなので、ユーザーが不要なら削除してよい`;
  }
  return { content: [text(result)] };
});

tool('create_deck', {
  title: 'デッキを作成',
  description: '新しいデッキ (1 ファイルの HTML) を作る。名前は YYYY-MM-DD-<name>。表紙 1 枚だけの状態で作られるので、続けて write_deck で中身を書く。',
  inputSchema: {
    name: z.string().regex(/^[\w.-]+$/).describe('英数字・ハイフンの短い名前 (例: git-branch-strategy)'),
    title: z.string().describe('発表タイトル (日本語可)'),
    theme: z.string().optional().describe('テーマ名 (既定: default)。list_themes で一覧と雰囲気を確認できる'),
    transition: transitionSchema.optional(),
    brand: brandSchema.optional(),
    autoFullscreen: autoFullscreenSchema.optional(),
  },
}, async ({ name, title, theme, transition, brand, autoFullscreen }) => {
  const { name: created } = createDeck(WS, { name, title, theme, transition, brand, autoFullscreen });
  return { content: [text({ created: deckInfo(readDeck(WS, created)), next: 'write_deck でスライドを書いてください' })] };
});

tool('read_deck', {
  title: 'デッキを読む',
  description:
    'デッキの編集可能な部分 (スライド HTML・デッキ専用 CSS / JS・設定・埋め込み画像名) と revision を返す。修正前に必ず読むこと。' +
    'write_deck / replace_slide に revision を渡すと、読んだ後に他で変更されていた場合に上書きを防げる。',
  inputSchema: { name: deckName },
  annotations: { readOnlyHint: true },
}, async ({ name }) => {
  const d = readDeck(WS, name);
  return {
    content: [
      text({ ...deckInfo(d), revision: d.revision, assets: d.assetNames, engineVersion: d.version, latestVersion: pkg.version }),
      text('=== slides ===\n' + d.slides),
      text('=== css ===\n' + d.css),
      text('=== js ===\n' + d.js),
    ],
  };
});

const revisionSchema = z.string().optional().describe('read_deck が返した revision (指定すると、他で変更されていた場合は保存しない)');

tool('write_deck', {
  title: 'デッキを書き込む',
  description:
    'デッキの内容を書き込む。指定した項目だけ置き換え、省略した項目はそのまま残る。' +
    'slides は <section class="slide">...</section> の並び (全スライド分。id の重複やスライド外の要素はエラー)。' +
    '埋め込まれたエンジン・テーマ・ブランドは変わらない (theme を変えた場合はテーマだけ入れ替わる。最新化は upgrade_deck)。' +
    '保存前の内容は履歴に残る (list_history / restore_history)。',
  inputSchema: {
    name: deckName,
    slides: z.string().optional().describe('全スライドの HTML (<section class="slide"> の並び)'),
    css: z.string().optional().describe('デッキ専用 CSS の全内容'),
    js: z.string().optional().describe('デッキ専用 JS の全内容 (Deck.onSlide など)'),
    title: z.string().optional().describe('タイトル'),
    theme: z.string().optional().describe('テーマ名'),
    transition: transitionSchema.optional(),
    brand: brandSchema.optional(),
    autoFullscreen: autoFullscreenSchema.optional(),
    revision: revisionSchema,
  },
}, async ({ name, revision, ...fields }) => {
  const d = writeDeck(WS, name, fields, { revision });
  return { content: [text({ saved: deckInfo(d), revision: d.revision, next: 'audit_deck と screenshot_deck で確認してください' })] };
});

tool('replace_slide', {
  title: 'スライドを 1 枚差し替え',
  description: '指定したスライド 1 枚を置き換える。target は 1 始まりの番号、またはスライドの id (id での指定を推奨)。',
  inputSchema: {
    name: deckName,
    target: z.union([z.number().int().min(1), z.string()]).describe('スライド番号 (1 始まり) または id'),
    slide: z.string().describe('新しい <section class="slide">...</section> (1 枚分)'),
    revision: revisionSchema,
  },
}, async ({ name, target, slide, revision }) => {
  const d = replaceSlide(WS, name, target, slide, { revision });
  return { content: [text({ saved: deckInfo(d), revision: d.revision })] };
});

tool('add_asset', {
  title: '画像を埋め込む',
  description:
    'ローカルの画像・動画ファイルをデッキに埋め込む (png / jpg / gif / webp / svg / mp4 / webm)。' +
    'スライドからは <img data-asset="返された名前" alt="..."> で参照する (src は書かない)。',
  inputSchema: {
    name: deckName,
    file: z.string().describe('埋め込むファイルの絶対パス'),
    as: z.string().optional().describe('参照名 (省略時はファイル名)'),
  },
}, async ({ name, file, as }) => {
  const key = addAsset(WS, name, file, as);
  return { content: [text({ asset: key, usage: `<img data-asset="${key}" alt="">` })] };
});

tool('upgrade_deck', {
  title: 'デッキを最新版に更新',
  description:
    'デッキに埋め込まれたエンジン・テーマ・ブランド設定を最新にする (スライドの内容は変わらないが、見た目が変わる場合がある)。' +
    'ユーザーが最新化を求めたとき、またはブランド設定 (brand.json) を変えたときだけ使う。name 省略時は全デッキ。',
  inputSchema: { name: deckName.optional() },
}, async ({ name }) => {
  const names = name ? [name] : listDecks(WS).map((d) => d.name);
  names.forEach((n) => writeDeck(WS, n, {}, { upgrade: true }));
  return { content: [text({ upgraded: names, version: pkg.version, next: 'audit_deck と screenshot_deck で見た目を確認してください' })] };
});

tool('list_history', {
  title: '保存履歴',
  description: 'デッキの保存履歴 (書き込み前の版。新しい順、最大 20 件)。',
  inputSchema: { name: deckName },
  annotations: { readOnlyHint: true },
}, async ({ name }) => ({ content: [text({ history: listHistory(WS, name) })] }));

tool('restore_history', {
  title: '履歴の版に戻す',
  description: '保存履歴の版にデッキを戻す (戻す前の内容も履歴に残るので、やり直しできる)。',
  inputSchema: { name: deckName, id: z.string().describe('list_history の id') },
}, async ({ name, id }) => {
  const d = restoreHistory(WS, name, id);
  return { content: [text({ restored: deckInfo(d), revision: d.revision })] };
});

// ---------------------------------------------------------------------------
// 確認
// ---------------------------------------------------------------------------
tool('audit_deck', {
  title: 'レイアウトを検査',
  description:
    'ヘッドレスブラウザでデッキを開き、次の項目を検査する: はみ出し・切れ (overflow)、文字の重なり (overlap)、' +
    'コントラスト不足 (contrast)、画像の欠落・読み込み失敗 (images)、小さすぎる文字 (smallText)、JS エラー (errors)、' +
    'エンジンの警告 (warnings)、外部への通信 (externalRequests。オフラインで動かなくなるので不可)。' +
    'ok: true は「検査した項目で問題が見つからなかった」という意味で、見た目の良し悪しは screenshot_deck で確認すること。' +
    '意図的な重なり・はみ出しは .allow-overlap / .allow-overflow で除外できる。',
  inputSchema: { name: deckName },
  annotations: { readOnlyHint: true },
}, async ({ name }) => {
  const r = await auditDeck(readDeck(WS, name).file);
  return { content: [text(r)] };
});

tool('screenshot_deck', {
  title: 'スライドを撮影',
  description:
    'スライドの見た目を画像で返す。slides 省略時は全スライド (枚数が多い場合は数枚ずつ指定するとよい)。' +
    'step 省略時は全ステップ表示・アニメーション完了後の最終状態。数値を指定するとそのステップ数まで表示した状態。',
  inputSchema: {
    name: deckName,
    slides: z.array(z.number().int().min(1)).max(12).optional().describe('スライド番号 (1 始まり) の配列。最大 12 枚'),
    step: z.number().int().min(0).optional().describe('表示するステップ数 (省略時は最終状態)'),
    scale: z.number().min(0.2).max(1).optional().describe('画像の縮尺 (既定 0.5 = 960x540)'),
  },
  annotations: { readOnlyHint: true },
}, async ({ name, slides, step, scale }) => {
  const r = await screenshotDeck(readDeck(WS, name).file, { slides, step: step == null ? 'final' : step, scale: scale || 0.5 });
  const content = [];
  for (const img of r.images) {
    content.push(text(`スライド ${img.slide} / ${r.total}`));
    content.push({ type: 'image', data: img.data, mimeType: 'image/jpeg' });
  }
  if (r.errors.length) content.push(text({ errors: r.errors }));
  if (!r.images.length) content.push(text(`撮影対象がありません (全 ${r.total} 枚)`));
  return { content };
});

// ---------------------------------------------------------------------------
// 表示・出力
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// ローカル配信 (open_deck 用): ブラウザで編集した文字を Ctrl+S で元のファイルに直接保存できるようにする
//   127.0.0.1 のランダムなポートで、ワークスペース直下のデッキだけを配信する。MCP サーバーの終了とともに止まる
// ---------------------------------------------------------------------------
let deckServer = null;
async function ensureDeckServer() {
  if (deckServer) return deckServer;
  const token = createSaveToken();
  const fileForUrl = (p) => {
    const m = /^\/([\w.-]+\.html)$/.exec(p);
    if (!m) return null;
    try { const f = deckFile(WS, m[1]); return fs.existsSync(f) ? f : null; } catch { return null; }
  };
  const srv = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    if (p === '/__save') {
      return handleSave(req, res, {
        token,
        resolveFile: fileForUrl,
        read: (f) => fs.readFileSync(f, 'utf8'),
        write: (f, oldHtml, newHtml) => saveDeckFile(WS, path.basename(f, '.html'), f, oldHtml, newHtml),
      });
    }
    const file = fileForUrl(p);
    if (!file || req.method !== 'GET') { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
    const html = injectSaveConfig(fs.readFileSync(file, 'utf8'), { endpoint: '/__save', file: p, token });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  });
  await new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(0, '127.0.0.1', resolve); });
  srv.unref();
  deckServer = { port: srv.address().port };
  return deckServer;
}

tool('open_deck', {
  title: 'ブラウザで開く',
  description:
    'ユーザーの既定のブラウザでデッキを開く (発表・確認用)。ローカルサーバー経由で開くので、' +
    'ユーザーは E キーで文字を直して Ctrl+S で元のファイルに直接保存できる。' +
    'fullscreen: true にすると Chrome / Edge を全画面 (タブ・アドレスバーなし) で起動する。ユーザーが「発表する」「全画面で開いて」と言ったときに使う。',
  inputSchema: {
    name: deckName,
    fullscreen: z.boolean().optional().describe('全画面の専用ウィンドウで開く (発表用。F11 / Esc で解除)'),
  },
}, async ({ name, fullscreen }) => {
  const d = readDeck(WS, name);
  let url;
  try {
    const { port } = await ensureDeckServer();
    url = `http://127.0.0.1:${port}/${path.basename(d.file)}`;
  } catch (e) {
    console.error('[open_deck] ローカル配信を開始できないため file:// で開きます', e);
    url = pathToFileURL(d.file).href;
  }
  let mode = 'browser';
  if (fullscreen && launchFullscreen(url)) mode = 'fullscreen';
  else openInBrowser(url);
  return {
    content: [text({
      opened: url,
      mode,
      note: fullscreen && mode !== 'fullscreen' ? 'Chrome / Edge が見つからないため通常のブラウザで開きました。F キーで全画面にできます' : undefined,
      tips: '? キーで操作一覧、S で発表者ビュー、F で全画面 (F11 / Esc で解除)、E か枠のダブルクリックで文字を編集して Ctrl+S で保存 (ブラウザの「名前を付けて保存」は使わない)',
    })],
  };
});

tool('repair_deck', {
  title: '壊れたデッキを復旧',
  description:
    'ブラウザの「名前を付けて保存」で表示中の状態のまま保存されて壊れたデッキを、元の形式に復旧する (list_decks で broken と出るもの)。' +
    '壊れたファイルは履歴に残る。復旧後は audit_deck と screenshot_deck で確認する。',
  inputSchema: { name: deckName },
}, async ({ name }) => {
  const file = deckFile(WS, name);
  if (!fs.existsSync(file)) throw new Error('デッキが見つかりません: ' + name);
  const html = fs.readFileSync(file, 'utf8');
  if (!isBrowserSaved(html)) throw new Error('このデッキはブラウザ保存で壊れた形跡がありません (復旧は不要です)');
  const parts = await extractFromSavedPage(html);
  saveDeckFile(WS, name, file, html, buildDeck(parts, ctxFor(WS)));
  const d = readDeck(WS, name);
  return { content: [text({ repaired: deckInfo(d), notes: parts.notes, next: 'audit_deck と screenshot_deck で確認してください' })] };
});

tool('export_deck', {
  title: 'PDF に出力',
  description: 'デッキを 16:9 の PDF に出力する (アニメーションなし、全ステップ表示)。HTML はデッキファイル自体がそのまま配布できる。',
  inputSchema: { name: deckName },
}, async ({ name }) => {
  const d = readDeck(WS, name);
  const out = d.file.replace(/\.html$/i, '.pdf');
  await exportPdf(d.file, out);
  return { content: [text({ exported: out, html: d.file })] };
});

// ---------------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------------
async function shutdown() {
  await closeBrowser();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdin.on('close', shutdown);

await server.connect(new StdioServerTransport());
console.error(`[jh-presentation] MCP server v${pkg.version} ready. workspace: ${WS}`);
if (setup.migrated.length) console.error(`[jh-presentation] 旧形式から変換: ${setup.migrated.join(', ')}`);
