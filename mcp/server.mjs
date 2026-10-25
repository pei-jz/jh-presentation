#!/usr/bin/env node
// jh-presentation MCP サーバー (stdio)
//
// LLM は接続した AI クライアント側 (Claude Desktop / Claude Code / VS Code など) が担当し、
// このサーバーはデッキの作成・確認・出力の「道具」だけを提供する。API キーは不要。
//
//   npx -y jh-presentation --workspace <設定の置き場所>   (または環境変数 JH_PRESENTATION_HOME)
//
// デッキは 1 ファイルで完結する HTML。保存先は呼び出しごとに次の順で決める:
//   1. ツールの dir 引数
//   2. AI クライアントの作業フォルダ (MCP の roots) の decks/   (--decks-dir / JH_PRESENTATION_DECKS_DIR で名前を変更、
//      マップ文書は maps/ (--maps-dir / JH_PRESENTATION_MAPS_DIR)。
//      --no-roots / JH_PRESENTATION_ROOTS=off で使わない)
//   3. ワークスペース (--workspace。作業フォルダのない Claude Desktop など)
// ブランド・自作テーマ・依頼文テンプレートはワークスペースに置き、どのプロジェクトからも共通で使う
// (プロジェクトに brand/ themes/ があればそちらを優先)。
// 注意: stdout は MCP の通信に使うため、ログは必ず stderr (console.error) に出す。
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  PKG_ROOT, resolveWorkspace, ensureWorkspace, ctxFor, listDecks, createDeck, readDeck, writeDeck,
  replaceSlide, addAsset, listHistory, restoreHistory, saveDeckFile, isBrowserSaved, deckFile, listThemes, assertTheme, saveTheme, readGuide, readThemeGuide,
  brandDir, themesDir, promptsDir, deckPlace, placeOf, listMaps, createMap, readMap, writeMap, readDoc,
  mapOutline, readMapPart, writeMapPart,
} from './workspace.mjs';
import { loadPromptTemplates, renderPrompt } from './prompts.mjs';
import { buildGallery } from '../tools/lib/gallery.mjs';
import { loadBrand, buildDeck, BRAND_POSITIONS, TRANSITIONS } from '../tools/lib/deckfile.mjs';
import { createSaveToken, injectSaveConfig, handleSave } from '../tools/lib/save-endpoint.mjs';
import { launchFullscreen } from '../tools/lib/browser.mjs';
import {
  auditDeck, summarizeAudit, screenshotDeck, exportPdf, extractFromSavedPage, closeBrowser, auditMap, screenshotMap, exportMapPdf,
} from './render.mjs';

const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));
const WS = resolveWorkspace();
const setup = ensureWorkspace(WS);

// プロジェクトの中のデッキのフォルダ名と、AI クライアントの作業フォルダ (roots) を使うか
function option(name, envName) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--' + name);
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  return process.env[envName];
}
const DECKS_SUBDIR = option('decks-dir', 'JH_PRESENTATION_DECKS_DIR') || 'decks';
const MAPS_SUBDIR = option('maps-dir', 'JH_PRESENTATION_MAPS_DIR') || 'maps';
const USE_ROOTS = !process.argv.includes('--no-roots') && !/^(off|false|0|no)$/i.test(process.env.JH_PRESENTATION_ROOTS || '');
const GALLERY_DIR = path.join(os.tmpdir(), 'jh-presentation-gallery');

const MCP_WORKFLOW = `
## MCP での作業手順

1. このガイドを読む (get_guide)。
2. 依頼内容 (目的・聞き手・持ち時間) から構成案を作る。曖昧で長い発表なら、構成案をユーザーに確認してから進める。
3. create_deck でデッキを作る (英数字の name と日本語の title)。
   保存先は、AI クライアントの作業フォルダがあればその中の decks/、なければ既定のワークスペース。
   ユーザーが場所を指定したら、どのデッキのツールにも dir (フォルダ) を渡す (作業フォルダからの相対パスか絶対パス)。
   テーマは内容・聞き手に合わせて list_themes から選ぶ。ユーザーが見た目で選びたい場合は open_theme_gallery を使う。
   名前・ロゴの帯を入れる場合は brand を指定する (header / footer / both)。
4. write_deck でスライドを書く。slides には <section class="slide"> の並びだけを渡す (外枠・エンジンはサーバーが埋め込む)。
   デッキ専用のスタイル・動きは css / js に渡す。1 枚だけ直すときは replace_slide を使う。
   画像は add_asset で埋め込み、<img data-asset="名前"> で参照する。
5. write_deck / replace_slide の戻り値の audit (自動検査の結果) を見る。ok: false なら issues の
   overflow (はみ出し)・overlap (重なり)・smallText (小さすぎる文字)・errors (JS エラー) などを直して書き込み直す。
   audit_deck は、書き込まずに検査し直したいときに使う。
6. screenshot_deck で実際の見た目を確認する (数枚ずつ。画像を見られるモデルの場合)。重なり・空きすぎ・詰めすぎ・不自然な折り返しを直す。
   ステップやアニメーションの途中を確認したい場合は step に数値を指定する。
7. 完成したら open_deck でユーザーのブラウザに表示する (発表するときは fullscreen: true)。デッキは 1 ファイルなので、そのまま配布できる。
   PDF (export_deck) は、ユーザーが PDF を求めたときだけ作る。

- 既存デッキの修正は read_deck で現在の内容を読んでから行い、返された revision を write_deck / replace_slide に渡す。
- 書き込みで埋め込みのエンジンは変わらない。最新化 (upgrade_deck) はユーザーが求めたときだけ。
- 失敗したら list_history / restore_history で前の版に戻せる。
- list_decks で broken と出たデッキ (ブラウザの「名前を付けて保存」で壊れたもの) は repair_deck で復旧する。
- ユーザーには「文字の修正は E キー → Ctrl+S で保存。ブラウザの『名前を付けて保存』は使わない」と伝える。

## マップ文書 (スライドなしで読む資料) の作業手順

大きなシステムの説明書・設計書・システム関連図を「全体から細部へたどって読む資料」にしたいときは、スライドではなくマップ文書を作る
(ユーザーが「マップ」「システムマップ」「スライドでなく資料で」「全体から細部へ」などと言ったとき。発表するならデッキ)。

1. create_map で作る (書き方の見本を兼ねた最初のマップが入る)。保存先は作業フォルダの maps/、なければ既定のワークスペース。
2. write_map の map にマップのデータ (JSON) を渡す。書き方はガイドの「階層マップ」(.diagram) と同じ。
   大きなマップは read_map の outline で目次を見て、node で箱ごとに読み、write_map の node + part で箱ごとに書き換える
   (nodes の children で入れ子、edges は一番細かい部品同士で 1 回だけ、flows でデータの流れ、detail に説明の HTML、tags で検索語)。steps は使わない。
3. write_map の戻り値の audit を見る。data (存在しない id・流れの途切れ)・density (1 階層のノードが 12 個超)・overlap を直して書き込み直す。
4. screenshot_deck で階層ごとの見た目を確認する (levels にノード id。'' は全体。select で部品を選んだ状態)。
5. open_deck でユーザーのブラウザに表示する。PDF (export_deck) は階層ごとに 1 ページ。
- 既存のマップの修正は read_map で読んでから。履歴・最新化・PDF・表示はデッキと同じ道具 (list_history / restore_history / upgrade_deck / export_deck / open_deck) を使う。
`;

const server = new McpServer(
  { name: 'jh-presentation', version: pkg.version },
  {
    instructions:
      'プレゼンテーション資料 (スライド・発表資料・LT・報告資料) を HTML で作成・確認・出力する道具。' +
      'プレゼン資料やスライドの作成を頼まれたら、自分で HTML を書かずにこのサーバーの道具を使う。デッキは 1 ファイルの HTML として保存される。' +
      'スライドを作る前に必ず get_guide を呼び、ガイドの部品とルールに従って書くこと (図・比較・数値は部品を使い、箱や矢印を自作しない)。' +
      'write_deck / replace_slide の戻り値に自動検査の結果 (audit) が入るので、問題があれば直してから、ユーザーに完了を伝える。' +
      'PDF はユーザーが求めたときだけ作る。' +
      'スライドではなく、大きなシステムの関連図を全体から細部へたどって読む資料 (マップ文書) は create_map / write_map で作る。',
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

/** AI クライアントの作業フォルダ (MCP の roots の最初の file: フォルダ)。なければ null */
async function clientRoot() {
  if (!USE_ROOTS) return null;
  const caps = server.server.getClientCapabilities && server.server.getClientCapabilities();
  if (!caps || !caps.roots) return null;
  try {
    const { roots } = await server.server.listRoots(undefined, { timeout: 3000 });
    const first = (roots || []).find((r) => /^file:/i.test(r.uri));
    return first ? fileURLToPath(first.uri) : null;
  } catch (e) {
    console.error('[jh-presentation] roots を取得できません', e.message || e);
    return null;
  }
}

const expandHome = (p) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
const isInside = (child, parent) => {
  const rel = path.relative(parent, child);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
};

/**
 * デッキの保存先。dir 引数 → 作業フォルダの decks/ → ワークスペース の順。
 * @returns {Promise<string | object>} workspace.mjs のデッキの関数に渡す「場所」
 */
async function placeFor(dir) {
  const root = await clientRoot();
  if (dir) {
    const abs = path.resolve(root || WS, expandHome(dir));
    return deckPlace({ dir: abs, settings: WS, project: root && isInside(abs, root) ? root : null });
  }
  if (root) return deckPlace({ dir: path.join(root, DECKS_SUBDIR), settings: WS, project: root });
  return WS;
}

/** マップ文書の保存先。dir 引数 → 作業フォルダの maps/ → ワークスペース の順 */
async function mapPlaceFor(dir) {
  if (dir) return placeFor(dir);
  const root = await clientRoot();
  if (root) return deckPlace({ dir: path.join(root, MAPS_SUBDIR), settings: WS, project: root });
  return WS;
}

/** デッキかマップ文書を名前で探す (デッキの場所 → マップの場所)。@returns {{ P, doc }} */
async function findDoc(dir, name) {
  const places = [await placeFor(dir)];
  if (!dir) places.push(await mapPlaceFor());
  for (const P of places) {
    if (fs.existsSync(deckFile(P, name))) return { P, doc: readDoc(P, name) };
  }
  throw new Error(`デッキ・マップ文書が見つかりません: ${name} (list_decks で一覧を確認してください)`);
}

function mapInfo(m) {
  return { kind: 'map', name: m.name, title: m.title, theme: m.theme, brand: m.brand, nodeCount: m.nodeCount, file: m.file, url: pathToFileURL(m.file).href };
}
const docInfo = (d) => (d.kind === 'map' ? mapInfo(d) : deckInfo(d));

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
const docName = z.string().describe('デッキかマップ文書の名前 (list_decks が返す name。.html は不要)');
const mapName = z.string().describe('マップ文書の名前 (list_decks の maps / create_map が返す name。.html は不要)');
const dirSchema = z.string().optional().describe(
  'デッキのフォルダ (省略時: AI クライアントの作業フォルダの decks/、作業フォルダがなければ既定のワークスペース)。' +
  '作業フォルダからの相対パスか絶対パス。ユーザーが保存先を指定したときだけ渡す');
const brandSchema = z.enum(BRAND_POSITIONS).describe('ブランド枠 (名前・ロゴ): none / header (上) / footer (下) / both (上下)');
const transitionSchema = z.enum(TRANSITIONS).describe('スライド切り替え効果');
const autoFullscreenSchema = z.boolean().describe('発表モード: 開いた後の最初の → キー・クリックで全画面にする (既定 false)');

function themeSummary() {
  return listThemes(WS).map((t) => `- ${t.name} (${t.label})${t.custom ? ' [自作]' : ''}: ${t.description}`).join('\n');
}

// ---------------------------------------------------------------------------
// ガイド
// ---------------------------------------------------------------------------
// このセッションでガイドを渡したか。読まずに create_deck を呼んだ場合は、create_deck の戻り値にガイドを添える
// (道具を一部しか渡さないクライアントや、手順を飛ばしがちなモデルでも、ガイドに沿って書けるように)
let guideSent = false;

function guideText() {
  guideSent = true;
  const b = loadBrand(brandDir(WS));
  return readGuide() + '\n' + MCP_WORKFLOW +
    `\n## 利用できるテーマ\n\n${themeSummary()}\n` +
    `\n## ブランド設定\n\n名前: ${b.name || '(なし)'} / ラベル: ${b.label || '(なし)'} / ロゴ: ${b.logo ? 'あり' : 'なし'} / 新規デッキの既定: ${b.position}\n` +
    `設定ファイル: ${path.join(brandDir(WS), 'brand.json')}\n` +
    `\nワークスペース: ${WS}\n`;
}

tool('get_guide', {
  title: 'デッキ作成ガイドを読む',
  description: 'プレゼンテーション資料 (スライド・発表資料) の書き方・部品カタログ・良い例・デザイン原則・作業手順。スライドを書く前に必ず読むこと。',
  annotations: { readOnlyHint: true },
}, async () => ({ content: [text(guideText())] }));

server.registerResource('guide', 'jh-presentation://guide', {
  title: 'デッキ作成ガイド',
  description: 'スライドの書き方・部品カタログ・デザイン原則',
  mimeType: 'text/markdown',
}, async (uri) => {
  guideSent = true;
  return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: readGuide() + '\n' + MCP_WORKFLOW }] };
});

// ---------------------------------------------------------------------------
// テーマ
// ---------------------------------------------------------------------------
tool('list_themes', {
  title: 'テーマ一覧',
  description: '利用できるデザインテーマ (同梱 + 自作。名前・表示名・雰囲気の説明・タグ)。内容や聞き手に合うテーマを選ぶときに使う。',
  annotations: { readOnlyHint: true },
}, async () => ({ content: [text({ themes: listThemes(await placeFor()), customThemeDir: themesDir(WS) })] }));

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
  description: '作成済みのプレゼンテーション資料 (スライド・デッキ) とマップ文書の一覧 (新しい順)。保存先のフォルダも返す。',
  inputSchema: { dir: dirSchema },
  annotations: { readOnlyHint: true },
}, async ({ dir }) => {
  const P = await placeFor(dir);
  const M = dir ? P : await mapPlaceFor();
  const result = { folder: placeOf(P).dir, settings: WS, decks: listDecks(P), mapsFolder: placeOf(M).dir, maps: listMaps(M) };
  if (setup.migrated.length) result.migrated = `旧形式から 1 ファイル形式に変換したデッキ: ${setup.migrated.join(', ')}`;
  if (setup.legacy.length) {
    result.legacyFolders = `旧形式のフォルダが残っています (${setup.legacy.join(', ')})。変換済みなので、ユーザーが不要なら削除してよい`;
  }
  return { content: [text(result)] };
});

tool('create_deck', {
  title: 'デッキを作成',
  description:
    'プレゼンテーション資料 (スライド・発表資料・LT・報告資料) を新しく作る。1 ファイルの HTML (デッキ) で、名前は YYYY-MM-DD-<name>。' +
    '表紙 1 枚だけの状態で作られるので、続けて write_deck で中身を書く。',
  inputSchema: {
    name: z.string().regex(/^[\w.-]+$/).describe('英数字・ハイフンの短い名前 (例: git-branch-strategy)'),
    title: z.string().describe('発表タイトル (日本語可)'),
    theme: z.string().optional().describe(
      'テーマ名 (既定: default)。同梱: default (汎用) / dark (技術系) / corporate (報告・提案) / pop (LT・カジュアル) / mono (メッセージ重視)。' +
      '自作テーマを含む一覧は list_themes'),
    transition: transitionSchema.optional(),
    brand: brandSchema.optional(),
    autoFullscreen: autoFullscreenSchema.optional(),
    dir: dirSchema,
  },
}, async ({ name, title, theme, transition, brand, autoFullscreen, dir }) => {
  const P = await placeFor(dir);
  const { name: created } = createDeck(P, { name, title, theme, transition, brand, autoFullscreen });
  const content = [text({ created: deckInfo(readDeck(P, created)), next: 'write_deck でスライドを書いてください' })];
  if (!guideSent) {
    content.push(text('まだデッキ作成ガイド (get_guide) を読んでいないので、ここに添付します。スライドはこのガイドの部品とルールに従って書いてください。\n\n' + guideText()));
  }
  return { content };
});

tool('read_deck', {
  title: 'デッキを読む',
  description:
    'プレゼンテーション資料 (スライド・デッキ) の編集可能な部分 (スライド HTML・デッキ専用 CSS / JS・設定・埋め込み画像名) と revision を返す。修正前に必ず読むこと。' +
    'write_deck / replace_slide に revision を渡すと、読んだ後に他で変更されていた場合に上書きを防げる。',
  inputSchema: { name: deckName, dir: dirSchema },
  annotations: { readOnlyHint: true },
}, async ({ name, dir }) => {
  const { doc: d } = await findDoc(dir, name);
  if (d.kind === 'map') throw new Error(`${name} はマップ文書です。read_map / write_map を使ってください`);
  return {
    content: [
      text({ ...deckInfo(d), revision: d.revision, assets: d.assetNames, engineVersion: d.version, latestVersion: pkg.version }),
      text('=== slides ===\n' + d.slides),
      text('=== css ===\n' + d.css),
      text('=== js ===\n' + d.js),
    ],
  };
});

const AFTER_WRITE = 'audit が ok: false なら issues を直して書き込み直す。ok: true なら screenshot_deck で見た目を確認する (画像を見られる場合)';

/** 書き込み後の自動検査。ブラウザがない環境などで検査できなくても、書き込み自体は成功として返す */
async function autoAudit(file) {
  try {
    return summarizeAudit(await auditDeck(file));
  } catch (e) {
    console.error('[auto-audit]', e);
    return { skipped: `自動検査を実行できませんでした: ${e.message || e}` };
  }
}

const revisionSchema = z.string().optional().describe('read_deck が返した revision (指定すると、他で変更されていた場合は保存しない)');

tool('write_deck', {
  title: 'デッキを書き込む',
  description:
    'プレゼンテーション資料 (デッキ) のスライドを書き込む。指定した項目だけ置き換え、省略した項目はそのまま残る。' +
    'slides は <section class="slide">...</section> の並び (全スライド分。id の重複やスライド外の要素はエラー)。' +
    '埋め込まれたエンジン・テーマ・ブランドは変わらない (theme を変えた場合はテーマだけ入れ替わる。最新化は upgrade_deck)。' +
    '保存前の内容は履歴に残る (list_history / restore_history)。' +
    '書き込み後に自動でレイアウトを検査し、結果を audit に返す (ok: false なら issues を直して書き込み直す)。',
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
    dir: dirSchema,
  },
}, async ({ name, revision, dir, ...fields }) => {
  const d = writeDeck(await placeFor(dir), name, fields, { revision });
  return { content: [text({ saved: deckInfo(d), revision: d.revision, audit: await autoAudit(d.file), next: AFTER_WRITE })] };
});

tool('replace_slide', {
  title: 'スライドを 1 枚差し替え',
  description:
    'プレゼンテーション資料 (デッキ) のスライドを 1 枚だけ置き換える。target は 1 始まりの番号、またはスライドの id (id での指定を推奨)。' +
    '書き込み後に自動でレイアウトを検査し、結果を audit に返す。',
  inputSchema: {
    name: deckName,
    target: z.union([z.number().int().min(1), z.string()]).describe('スライド番号 (1 始まり) または id'),
    slide: z.string().describe('新しい <section class="slide">...</section> (1 枚分)'),
    revision: revisionSchema,
    dir: dirSchema,
  },
}, async ({ name, target, slide, revision, dir }) => {
  const d = replaceSlide(await placeFor(dir), name, target, slide, { revision });
  return { content: [text({ saved: deckInfo(d), revision: d.revision, audit: await autoAudit(d.file), next: AFTER_WRITE })] };
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
    dir: dirSchema,
  },
}, async ({ name, file, as, dir }) => {
  const key = addAsset(await placeFor(dir), name, file, as);
  return { content: [text({ asset: key, usage: `<img data-asset="${key}" alt="">` })] };
});

// ---------------------------------------------------------------------------
// マップ文書の作成・読み書き
// ---------------------------------------------------------------------------
const mapSchema = z.union([z.string(), z.record(z.string(), z.any())]).describe(
  'マップのデータ (JSON のオブジェクトか文字列)。書き方はガイドの「階層マップ」と同じ: ' +
  '{ title, direction, nodes: [{ id, label, sub, kind, accent, detail (HTML), tags, children: { nodes, edges } }], ' +
  'edges: [{ from, to, label, data: [...], type: "async" }], flows: [{ id, label, note, path: [id | { id, note }] }] }');

async function autoAuditMap(file) {
  try {
    return summarizeAudit(await auditMap(file));
  } catch (e) {
    console.error('[auto-audit]', e);
    return { skipped: `自動検査を実行できませんでした: ${e.message || e}` };
  }
}
const AFTER_WRITE_MAP = 'audit が ok: false なら issues (data / density / overlap など) を直して書き込み直す。ok: true なら screenshot_deck で階層ごとの見た目を確認する (画像を見られる場合)';

tool('create_map', {
  title: 'マップ文書を作成',
  description:
    'マップ文書を新しく作る: スライドではなく、大きなシステムの関連図・説明書を「全体 → 細部」とたどって読む 1 ファイルの HTML 資料 ' +
    '(目次・検索・データでの絞り込み・URL での共有・階層ごとの印刷付き)。名前は YYYY-MM-DD-<name>。' +
    'map を省略すると、書き方の見本を兼ねた最初のマップが入るので、続けて write_map で中身を書く。',
  inputSchema: {
    name: z.string().regex(/^[\w.-]+$/).describe('英数字・ハイフンの短い名前 (例: order-system)'),
    title: z.string().describe('資料のタイトル (日本語可)'),
    theme: z.string().optional().describe('テーマ名 (既定: default)。一覧は list_themes'),
    brand: brandSchema.optional(),
    map: mapSchema.optional(),
    dir: dirSchema,
  },
}, async ({ name, title, theme, brand, map, dir }) => {
  const P = await mapPlaceFor(dir);
  const { name: created } = createMap(P, { name, title, theme, brand, map });
  const m = readMap(P, created);
  const content = [text({ created: mapInfo(m), next: 'write_map でマップのデータを書いてください (書き方はガイドの「階層マップ」)' })];
  if (!guideSent) {
    content.push(text('まだガイド (get_guide) を読んでいないので、ここに添付します。マップのデータは「階層マップ」の書き方に従ってください。\n\n' + guideText()));
  }
  return { content };
});

tool('read_map', {
  title: 'マップ文書を読む',
  description:
    'マップ文書の編集可能な部分 (マップのデータ (JSON)・専用 CSS / JS・設定) と revision を返す。修正前に必ず読むこと。' +
    'write_map に revision を渡すと、読んだ後に他で変更されていた場合に上書きを防げる。' +
    '大きなマップ (ノードが数十を超える) は、outline: true で目次 (id・名前・種類・中の数) だけを読み、' +
    'node に箱の id を渡してその箱 (children ごと) と、外からつながる矢印・関連・流れ (context) だけを読む。',
  inputSchema: {
    name: mapName,
    outline: z.boolean().optional().describe('true: マップのデータの代わりに目次だけを返す'),
    node: z.string().optional().describe('このノード (children ごと) だけを返す'),
    dir: dirSchema,
  },
  annotations: { readOnlyHint: true },
}, async ({ name, outline, node, dir }) => {
  const { P, doc: m } = await findDoc(dir, name);
  if (m.kind !== 'map') throw new Error(`${name} はデッキです (read_deck を使ってください)`);
  const head = { ...mapInfo(m), revision: m.revision, engineVersion: m.version, latestVersion: pkg.version };
  if (node != null) {
    const r = readMapPart(P, name, node);
    return {
      content: [
        text({ ...head, node, path: r.path, next: 'write_map に node と part (このノードの JSON 全体) を渡すと、この箱だけを置き換えられる' }),
        text('=== part ===\n' + JSON.stringify(r.part, null, 2)),
        text('=== context (外に書かれていて中につながるもの。読むだけ) ===\n' + JSON.stringify(r.context, null, 2)),
      ],
    };
  }
  if (outline) {
    if (!m.map) throw new Error('マップのデータが JSON として読めません。outline なしで全体を読んで直してください');
    return { content: [text(head), text('=== outline ===\n' + JSON.stringify(mapOutline(m.map), null, 2))] };
  }
  return {
    content: [
      text({ ...mapInfo(m), revision: m.revision, engineVersion: m.version, latestVersion: pkg.version }),
      text('=== map ===\n' + m.mapText),
      text('=== css ===\n' + m.css),
      text('=== js ===\n' + m.js),
    ],
  };
});

tool('write_map', {
  title: 'マップ文書を書き込む',
  description:
    'マップ文書のデータを書き込む。指定した項目だけ置き換え、省略した項目はそのまま残る。map は全体を渡す。' +
    '大きなマップの一部だけを直すときは、map の代わりに node (箱の id) と part (その箱の JSON 全体。children ごと。id は同じ) を渡す。' +
    '埋め込まれたビューア・テーマ・ブランドは変わらない (最新化は upgrade_deck)。保存前の内容は履歴に残る (list_history / restore_history)。' +
    '書き込み後に自動で検査し、結果を audit に返す (ok: false なら issues を直して書き込み直す)。',
  inputSchema: {
    name: mapName,
    map: mapSchema.optional(),
    node: z.string().optional().describe('一部だけ置き換えるときの箱の id (part と一緒に渡す)'),
    part: z.union([z.string(), z.record(z.string(), z.any())]).optional().describe('node の箱の JSON 全体 (children・その中の edges / relations ごと)'),
    css: z.string().optional().describe('専用 CSS の全内容'),
    js: z.string().optional().describe('専用 JS の全内容'),
    title: z.string().optional().describe('タイトル'),
    theme: z.string().optional().describe('テーマ名'),
    brand: brandSchema.optional(),
    revision: revisionSchema,
    dir: dirSchema,
  },
}, async ({ name, revision, dir, node, part, ...fields }) => {
  const { P } = await findDoc(dir, name);
  if ((node == null) !== (part == null)) throw new Error('一部だけ置き換えるときは node と part を両方渡してください');
  if (node != null && fields.map !== undefined) throw new Error('map (全体) と node / part (一部) は同時に渡せません');
  let m;
  if (node != null) {
    m = writeMapPart(P, name, node, part, { revision });
    const rest = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    if (Object.keys(rest).length) m = writeMap(P, name, rest);
  } else {
    m = writeMap(P, name, fields, { revision });
  }
  return { content: [text({ saved: mapInfo(m), revision: m.revision, audit: await autoAuditMap(m.file), next: AFTER_WRITE_MAP })] };
});

tool('upgrade_deck', {
  title: 'デッキを最新版に更新',
  description:
    'デッキ・マップ文書に埋め込まれたエンジン・テーマ・ブランド設定を最新にする (内容は変わらないが、見た目が変わる場合がある)。' +
    'ユーザーが最新化を求めたとき、またはブランド設定 (brand.json) を変えたときだけ使う。name 省略時は全デッキ・全マップ文書。',
  inputSchema: { name: docName.optional(), dir: dirSchema },
}, async ({ name, dir }) => {
  const targets = [];
  if (name) {
    const { P, doc } = await findDoc(dir, name);
    targets.push({ P, name: doc.name, kind: doc.kind });
  } else {
    const P = await placeFor(dir), M = dir ? P : await mapPlaceFor();
    listDecks(P).forEach((d) => targets.push({ P, name: d.name }));
    listMaps(M).forEach((m) => targets.push({ P: M, name: m.name, kind: 'map' }));
  }
  targets.forEach((t) => (t.kind === 'map' ? writeMap : writeDeck)(t.P, t.name, {}, { upgrade: true }));
  return { content: [text({ upgraded: targets.map((t) => t.name), version: pkg.version, next: 'audit_deck と screenshot_deck で見た目を確認してください' })] };
});

tool('list_history', {
  title: '保存履歴',
  description: 'デッキ・マップ文書の保存履歴 (書き込み前の版。新しい順、最大 20 件)。',
  inputSchema: { name: docName, dir: dirSchema },
  annotations: { readOnlyHint: true },
}, async ({ name, dir }) => ({ content: [text({ history: listHistory((await findDoc(dir, name)).P, name) })] }));

tool('restore_history', {
  title: '履歴の版に戻す',
  description: '保存履歴の版にデッキ・マップ文書を戻す (戻す前の内容も履歴に残るので、やり直しできる)。',
  inputSchema: { name: docName, id: z.string().describe('list_history の id'), dir: dirSchema },
}, async ({ name, id, dir }) => {
  const d = restoreHistory((await findDoc(dir, name)).P, name, id);
  return { content: [text({ restored: docInfo(d), revision: d.revision })] };
});

// ---------------------------------------------------------------------------
// 確認
// ---------------------------------------------------------------------------
tool('audit_deck', {
  title: 'レイアウトを検査',
  description:
    'ヘッドレスブラウザでプレゼンテーション資料 (スライド・デッキ) を開き、次の項目を検査する: はみ出し・切れ・余白への食い込み (overflow。area: margin は本文がスライドの余白に入り込んでいる)、' +
      '文字の重なり・ページ番号との重なり (overlap)、タイトルの 2 行への折り返し (wrap)、' +
    'コントラスト不足 (contrast)、画像の欠落・読み込み失敗 (images)、小さすぎる文字 (smallText)、JS エラー (errors)、' +
    'エンジンの警告 (warnings)、外部への通信 (externalRequests。オフラインで動かなくなるので不可)。' +
    'ok: true は「検査した項目で問題が見つからなかった」という意味で、見た目の良し悪しは screenshot_deck で確認すること。' +
    '意図的な重なり・はみ出し・折り返しは .allow-overlap / .allow-overflow / .allow-wrap で除外できる。' +
    'write_deck / replace_slide は書き込み後に同じ検査を自動で行うので、これは書き込まずに検査し直したいときに使う。' +
    'マップ文書も検査できる (データの誤り data・1 階層のノード数 density・全階層の文字の重なり overlap・JS エラーなど)。',
  inputSchema: { name: docName, dir: dirSchema },
  annotations: { readOnlyHint: true },
}, async ({ name, dir }) => {
  const { doc } = await findDoc(dir, name);
  const r = doc.kind === 'map' ? await auditMap(doc.file) : await auditDeck(doc.file);
  return { content: [text(r)] };
});

tool('screenshot_deck', {
  title: 'スライドを撮影',
  description:
    'プレゼンテーション資料のスライドの見た目を画像で返す。slides 省略時は全スライド (枚数が多い場合は数枚ずつ指定するとよい)。' +
    'step 省略時は全ステップ表示・アニメーション完了後の最終状態。数値を指定するとそのステップ数まで表示した状態。' +
    'マップ文書は階層ごとに撮る (levels にノード id の配列。\'\' は全体。省略時は全階層 (最大 12)。select でその部品を選んで詳細パネルを開いた状態)。',
  inputSchema: {
    name: docName,
    slides: z.array(z.number().int().min(1)).max(12).optional().describe('スライド番号 (1 始まり) の配列。最大 12 枚'),
    step: z.number().int().min(0).optional().describe('表示するステップ数 (省略時は最終状態)'),
    levels: z.array(z.string()).max(12).optional().describe('マップ文書: 撮る階層 (中身のあるノードの id。\'\' は全体)'),
    select: z.string().optional().describe('マップ文書: 選んで詳細パネルを開く部品の id'),
    scale: z.number().min(0.2).max(1).optional().describe('画像の縮尺 (既定: デッキ 0.5 = 960x540、マップ文書 0.75 = 960x600)'),
    dir: dirSchema,
  },
  annotations: { readOnlyHint: true },
}, async ({ name, slides, step, levels, select, scale, dir }) => {
  const { doc } = await findDoc(dir, name);
  if (doc.kind === 'map') {
    const r = await screenshotMap(doc.file, { levels, select, scale: scale || 0.75 });
    const content = [];
    for (const img of r.images) {
      content.push(text(img.label));
      content.push({ type: 'image', data: img.data, mimeType: 'image/jpeg' });
    }
    if (r.errors.length) content.push(text({ errors: r.errors }));
    if (!r.images.length) content.push(text({ message: '撮影対象がありません', levels: r.levels }));
    return { content };
  }
  const r = await screenshotDeck(doc.file, { slides, step: step == null ? 'final' : step, scale: scale || 0.5 });
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
//   127.0.0.1 のランダムなポートで、open_deck で開いたデッキだけを配信する。MCP サーバーの終了とともに止まる
// ---------------------------------------------------------------------------
let deckServer = null;
// 配信してよいデッキのフォルダ (open_deck で開いたもの)。URL は /<番号>/<デッキ>.html
const servedDirs = [];
function servedUrlPath(file) {
  const dir = path.dirname(file);
  let i = servedDirs.indexOf(dir);
  if (i < 0) i = servedDirs.push(dir) - 1;
  return `/${i}/${path.basename(file)}`;
}
async function ensureDeckServer() {
  if (deckServer) return deckServer;
  const token = createSaveToken();
  const fileForUrl = (p) => {
    const m = /^\/(\d+)\/([\w.-]+\.html)$/.exec(p);
    if (!m || !servedDirs[Number(m[1])]) return null;
    try { const f = deckFile(servedDirs[Number(m[1])], m[2]); return fs.existsSync(f) ? f : null; } catch { return null; }
  };
  const srv = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    if (p === '/__save') {
      return handleSave(req, res, {
        token,
        resolveFile: fileForUrl,
        read: (f) => fs.readFileSync(f, 'utf8'),
        write: (f, oldHtml, newHtml) => saveDeckFile(path.dirname(f), path.basename(f, '.html'), f, oldHtml, newHtml),
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
    'ユーザーの既定のブラウザでプレゼンテーション資料 (スライド・デッキ) を開く (発表・確認用。完成したら開いて見せる)。ローカルサーバー経由で開くので、' +
    'ユーザーは E キーで文字を直して Ctrl+S で元のファイルに直接保存できる。' +
    'fullscreen: true にすると Chrome / Edge を全画面 (タブ・アドレスバーなし) で起動する。ユーザーが「発表する」「全画面で開いて」と言ったときに使う。' +
    'マップ文書も開ける (level にノード id を渡すと、その階層を開く)。',
  inputSchema: {
    name: docName,
    level: z.string().optional().describe('マップ文書: 開く階層・部品のノード id'),
    fullscreen: z.boolean().optional().describe('全画面の専用ウィンドウで開く (発表用。F11 / Esc で解除)'),
    dir: dirSchema,
  },
}, async ({ name, fullscreen, level, dir }) => {
  const { doc: d } = await findDoc(dir, name);
  let url;
  try {
    const { port } = await ensureDeckServer();
    url = `http://127.0.0.1:${port}${servedUrlPath(d.file)}`;
  } catch (e) {
    console.error('[open_deck] ローカル配信を開始できないため file:// で開きます', e);
    url = pathToFileURL(d.file).href;
  }
  if (d.kind === 'map' && level) url += '#/' + encodeURIComponent(level);
  let mode = 'browser';
  if (fullscreen && launchFullscreen(url)) mode = 'fullscreen';
  else openInBrowser(url);
  return {
    content: [text({
      opened: url,
      mode,
      note: fullscreen && mode !== 'fullscreen' ? 'Chrome / Edge が見つからないため通常のブラウザで開きました。F キーで全画面にできます' : undefined,
      tips: d.kind === 'map'
        ? '左の目次・上の検索で部品へ移る。箱のクリックで中へ、パンくず・Esc で上へ。URL を渡すと同じ場所が開く'
        : '? キーで操作一覧、S で発表者ビュー、F で全画面 (F11 / Esc で解除)、E か枠のダブルクリックで文字を編集して Ctrl+S で保存 (ブラウザの「名前を付けて保存」は使わない)',
    })],
  };
});

tool('repair_deck', {
  title: '壊れたデッキを復旧',
  description:
    'ブラウザの「名前を付けて保存」で表示中の状態のまま保存されて壊れたデッキを、元の形式に復旧する (list_decks で broken と出るもの)。' +
    '壊れたファイルは履歴に残る。復旧後は audit_deck と screenshot_deck で確認する。',
  inputSchema: { name: deckName, dir: dirSchema },
}, async ({ name, dir }) => {
  const P = await placeFor(dir);
  const file = deckFile(P, name);
  if (!fs.existsSync(file)) throw new Error('デッキが見つかりません: ' + name);
  const html = fs.readFileSync(file, 'utf8');
  if (!isBrowserSaved(html)) throw new Error('このデッキはブラウザ保存で壊れた形跡がありません (復旧は不要です)');
  const parts = await extractFromSavedPage(html);
  saveDeckFile(P, name, file, html, buildDeck(parts, ctxFor(P)));
  const d = readDeck(P, name);
  return { content: [text({ repaired: deckInfo(d), notes: parts.notes, next: 'audit_deck と screenshot_deck で確認してください' })] };
});

tool('export_deck', {
  title: 'PDF に出力',
  description:
    'デッキを 16:9 の PDF に出力する (アニメーションなし、全ステップ表示)。ユーザーが PDF を求めたときだけ使う' +
    ' (HTML のデッキファイル自体がそのまま配布・発表できるので、頼まれていなければ作らない)。' +
    'マップ文書は階層ごとに 1 ページ (図 + その階層の部品の説明。A4 横)。',
  inputSchema: { name: docName, dir: dirSchema },
}, async ({ name, dir }) => {
  const { doc: d } = await findDoc(dir, name);
  const out = d.file.replace(/\.html$/i, '.pdf');
  if (d.kind === 'map') await exportMapPdf(d.file, out);
  else await exportPdf(d.file, out);
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
console.error(`[jh-presentation] MCP server v${pkg.version} ready. workspace: ${WS} / decks: ${USE_ROOTS ? `<作業フォルダ>/${DECKS_SUBDIR} (なければワークスペース)` : 'ワークスペース'}`);
if (setup.migrated.length) console.error(`[jh-presentation] 旧形式から変換: ${setup.migrated.join(', ')}`);
