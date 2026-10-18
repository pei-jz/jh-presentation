// ワークスペース (設定とデッキの保存先) とデッキの読み書き
//
// <ワークスペース>/        設定 (どのプロジェクトからも共通で使う)。デッキの既定の保存先も兼ねる
//   2026-10-02-xxx.html   デッキ (1 ファイルで完結。エンジン・テーマ・ブランド・画像を埋め込み)
//   brand/                名前・ロゴ (brand.json)。最初は同梱のサンプルがコピーされる
//   themes/               自作テーマ (*.css)
//   prompts/              チーム・個人の依頼文テンプレート (*.md)
//
// デッキの保存先は呼び出しごとに変えられる (AI クライアントの作業フォルダの decks/ など)。
// そのときデッキの関数には文字列の代わりに「場所」{ dir, themeDirs, brandDir } を渡す (deckPlace)。
// プロジェクトに brand/ や themes/ があればそちらを優先し、なければワークスペースのものを使う。
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { readThemes } from '../tools/lib/themes.mjs';
import {
  PKG_ROOT, BUILTIN_THEMES_DIR, SAMPLE_BRAND_DIR, buildDeck, parseDeck, rebuildDeck, isDeckHtml,
  loadBrand, migrateFolderDecks, fileToDataUri, findThemeFile,
} from '../tools/lib/deckfile.mjs';
import { buildMap, parseMap, rebuildMap, isMapHtml, starterMap } from '../tools/lib/mapfile.mjs';
import '../engine/deck-edit.js';

const slideRanges = (html) => globalThis.JhDeckEdit.slideRanges(html);

export { PKG_ROOT };

/** --workspace <dir> / --workspace=<dir> / 環境変数 JH_PRESENTATION_HOME / ~/jh-presentation */
export function resolveWorkspace(argv = process.argv.slice(2), env = process.env) {
  let dir = null;
  argv.forEach((a, i) => {
    if (a === '--workspace' && argv[i + 1]) dir = argv[i + 1];
    else if (a.startsWith('--workspace=')) dir = a.slice('--workspace='.length);
  });
  dir = dir || env.JH_PRESENTATION_HOME || path.join(os.homedir(), 'jh-presentation');
  if (dir.startsWith('~')) dir = path.join(os.homedir(), dir.slice(1));
  return path.resolve(dir);
}

export const brandDir = (ws) => path.join(ws, 'brand');
export const themesDir = (ws) => path.join(ws, 'themes');
export const promptsDir = (ws) => path.join(ws, 'prompts');

/**
 * デッキの置き場所。ワークスペース (文字列) ならその中、場所 (deckPlace の戻り値) ならそのとおり。
 * @returns {{ dir: string, themeDirs: string[], brandDir: string }}
 */
export function placeOf(ws) {
  if (typeof ws === 'string') return { dir: ws, themeDirs: [themesDir(ws)], brandDir: brandDir(ws) };
  return ws;
}

/**
 * プロジェクトのフォルダにデッキを置くときの場所。
 *   dir      デッキを置くフォルダ
 *   settings 共通の設定 (ワークスペース)
 *   project  プロジェクトのフォルダ (なければ null)。brand/ themes/ があれば設定より優先する
 */
export function deckPlace({ dir, settings, project = null }) {
  const themeDirs = [];
  if (project && fs.existsSync(themesDir(project))) themeDirs.push(themesDir(project));
  themeDirs.push(themesDir(settings));
  const projectBrand = project && fs.existsSync(path.join(brandDir(project), 'brand.json'));
  return { dir: path.resolve(dir), themeDirs, brandDir: projectBrand ? brandDir(project) : brandDir(settings), project };
}

/** ワークスペースを用意し、旧形式 (decks/<name>/) のデッキがあれば 1 ファイル形式に移行する */
export function ensureWorkspace(ws) {
  fs.mkdirSync(ws, { recursive: true });
  if (!fs.existsSync(path.join(brandDir(ws), 'brand.json'))) {
    fs.cpSync(SAMPLE_BRAND_DIR, brandDir(ws), { recursive: true });
  }
  for (const [dir, readme] of [[themesDir(ws), 'themes-README.md'], [promptsDir(ws), 'README.md']]) {
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, 'README.md');
    const src = readme === 'README.md' ? path.join(PKG_ROOT, 'prompts', 'README.md') : path.join(PKG_ROOT, 'docs', 'theme-guide.md');
    if (!fs.existsSync(dest) && fs.existsSync(src)) fs.copyFileSync(src, dest);
  }
  const migrated = migrateFolderDecks(path.join(ws, 'decks'), ws, ctxFor(ws));
  const legacy = ['engine', 'components', 'decks', 'gallery'].filter((d) => fs.existsSync(path.join(ws, d)));
  return { migrated, legacy };
}

/** デッキの組み立てに必要な情報 (自作テーマの場所・ブランド) */
export function ctxFor(ws) {
  const p = placeOf(ws);
  return { themeDirs: p.themeDirs, brandData: loadBrand(p.brandDir) };
}

export function deckFile(ws, name) {
  const base = String(name).replace(/\.html$/i, '');
  if (!/^[\w.-]+$/.test(base) || base.startsWith('.')) throw new Error('デッキ名が不正です: ' + name);
  return path.join(placeOf(ws).dir, base + '.html');
}

function readDeckHtml(ws, name) {
  const file = deckFile(ws, name);
  if (!fs.existsSync(file)) throw new Error(`デッキが見つかりません: ${name} (list_decks で一覧を確認してください)`);
  return { file, html: fs.readFileSync(file, 'utf8') };
}

function today(sep = '-') {
  const d = new Date();
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join(sep);
}

function initialSlides(title, date) {
  return `<section class="slide layout-title no-chrome" id="cover">
  <h1 class="anim-fade-up">${title.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</h1>
  <div class="subtitle anim-fade-up" style="--delay:.15s">サブタイトル</div>
  <div class="meta anim-fade" style="--delay:.4s">${date}</div>
</section>`;
}

// ---------------------------------------------------------------------------
// テーマ
// ---------------------------------------------------------------------------
/** 同梱テーマ + 自作テーマ (同梱と同名の自作テーマは無視) */
export function listThemes(ws) {
  const builtin = readThemes(BUILTIN_THEMES_DIR).map((t) => ({ ...t, custom: false }));
  const names = new Set(builtin.map((t) => t.name));
  // 自作テーマはプロジェクト → ワークスペースの順 (同じ名前なら先に見つかった方)
  const custom = [];
  placeOf(ws).themeDirs.forEach((dir) => {
    readThemes(dir).forEach((t) => {
      if (names.has(t.name)) return;
      names.add(t.name);
      custom.push({ ...t, custom: true });
    });
  });
  return [...builtin, ...custom];
}
export const themeNames = (ws) => listThemes(ws).map((t) => t.name);

export function assertTheme(ws, theme) {
  if (theme && !findThemeFile(theme, placeOf(ws).themeDirs)) {
    throw new Error(`テーマがありません: ${theme} (利用できるテーマ: ${themeNames(ws).join(', ')})`);
  }
}

/** 自作テーマを保存する */
export function saveTheme(ws, { name, label, description, tags = [], css }) {
  if (!/^[a-z0-9][\w-]*$/.test(name)) throw new Error('テーマ名は英小文字・数字・ハイフンで指定してください: ' + name);
  if (fs.existsSync(path.join(BUILTIN_THEMES_DIR, name + '.css'))) throw new Error(`同梱テーマと同じ名前は使えません: ${name}`);
  const body = css.replace(/^\s*\/\*[\s\S]*?@theme[\s\S]*?\*\/\s*/, ''); // 先頭のメタ情報コメントは作り直す
  const header = `/* @theme ${name}\n * @label ${label}\n * @description ${description}\n * @tags ${tags.join(', ')}\n */\n\n`;
  fs.mkdirSync(themesDir(ws), { recursive: true });
  const file = path.join(themesDir(ws), name + '.css');
  fs.writeFileSync(file, header + body.trim() + '\n');
  return file;
}

// ---------------------------------------------------------------------------
// デッキ
// ---------------------------------------------------------------------------
export function listDecks(ws) {
  const dir = placeOf(ws).dir;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.html'))
    .map((f) => {
      const file = path.join(dir, f);
      const html = fs.readFileSync(file, 'utf8');
      if (!isDeckHtml(html)) return null;
      const d = parseDeck(html);
      const item = { name: f.replace(/\.html$/, ''), title: d.title, theme: d.theme, brand: d.brand, slides: d.slideCount, updated: fs.statSync(file).mtime.toISOString() };
      // ブラウザの「名前を付けて保存」で壊れたファイル → repair_deck で復旧できる
      if (isBrowserSaved(html)) item.broken = 'ブラウザの保存機能で保存されて壊れています。repair_deck で復旧できます';
      return item;
    })
    .filter(Boolean)
    .sort((a, b) => b.updated.localeCompare(a.updated));
}

export function createDeck(ws, { name, title, theme = 'default', transition = 'fade', brand, autoFullscreen = false }) {
  assertTheme(ws, theme);
  const base = /^\d{4}-\d{2}-\d{2}-/.test(name) ? name : `${today()}-${name}`;
  const file = deckFile(ws, base);
  if (fs.existsSync(file)) throw new Error('すでに存在します: ' + base);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const ctx = ctxFor(ws);
  fs.writeFileSync(file, buildDeck({
    title, theme, transition, brand: brand || ctx.brandData.position, autoFullscreen,
    slides: initialSlides(title, today('/')),
  }, ctx));
  return { name: base, file };
}

/** ブラウザの「名前を付けて保存」で、表示中の状態のまま保存されたファイルか */
export function isBrowserSaved(html) {
  return /<!-- saved from url=/.test(html) || /<div class="deck-stage"/.test(html);
}

/** ファイル内容から求めるリビジョン (競合検知用) */
export function revisionOf(html) {
  return crypto.createHash('sha256').update(html).digest('hex').slice(0, 12);
}

const HISTORY_KEEP = 20;
export const historyDir = (ws, name) => path.join(placeOf(ws).dir, '.history', path.basename(deckFile(ws, name), '.html'));

/**
 * デッキを安全に保存する
 *   - revision を指定した場合、読んだ後に他から変更されていたら保存しない (競合検知)
 *   - 保存前の内容を .history/<name>/ に残す (直近 20 件)
 *   - 一時ファイルに書いてから置き換える (書き込み途中で壊れないように)
 */
export function saveDeckFile(ws, name, file, oldHtml, newHtml) {
  if (oldHtml != null && oldHtml !== newHtml) {
    const dir = historyDir(ws, name);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(dir, `${stamp}.html`), oldHtml);
    const old = fs.readdirSync(dir).filter((f) => f.endsWith('.html')).sort();
    old.slice(0, Math.max(0, old.length - HISTORY_KEEP)).forEach((f) => fs.rmSync(path.join(dir, f), { force: true }));
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, newHtml);
  fs.renameSync(tmp, file);
}

function checkRevision(html, revision, name) {
  if (revision && revision !== revisionOf(html)) {
    throw new Error(`デッキ ${name} は読み込んだ後に変更されています (revision 不一致)。read_deck で読み直してから修正してください`);
  }
}

export function readDeck(ws, name) {
  const { file, html } = readDeckHtml(ws, name);
  if (isMapHtml(html)) throw new Error(`${name} はマップ文書です。read_map / write_map を使ってください`);
  const d = parseDeck(html);
  return { name: path.basename(file, '.html'), file, revision: revisionOf(html), ...d, assetNames: Object.keys(d.assets) };
}

/**
 * 指定した項目だけ更新する。
 * 埋め込まれたエンジン・テーマ・ブランドはそのまま (テーマを変えた場合だけテーマを入れ替える)。
 * 最新にするのは upgrade: true のとき (upgrade_deck) だけ。
 */
export function writeDeck(ws, name, fields = {}, { revision, upgrade = false } = {}) {
  if (fields.theme) assertTheme(ws, fields.theme);
  const { file, html } = readDeckHtml(ws, name);
  checkRevision(html, revision, name);
  saveDeckFile(ws, name, file, html, rebuildDeck(html, fields, ctxFor(ws), { upgrade }));
  return readDeck(ws, name);
}

/** 1 枚だけ差し替える。target は 1 始まりの番号か、スライドの id */
export function replaceSlide(ws, name, target, sectionHtml, opts = {}) {
  const deck = readDeck(ws, name);
  const ranges = slideRanges(deck.slides);
  let hit;
  if (/^\d+$/.test(String(target))) hit = ranges[Number(target) - 1];
  else {
    const same = ranges.filter((r) => r.id === String(target));
    if (same.length > 1) throw new Error(`id が重複しています: ${target}`);
    hit = same[0];
  }
  if (!hit) throw new Error(`スライドが見つかりません: ${target} (全 ${ranges.length} 枚)`);
  const replacement = sectionHtml.trim();
  const inner = slideRanges(replacement);
  if (inner.length !== 1 || inner[0].start !== 0 || inner[0].end !== replacement.length) {
    throw new Error('slide には <section class="slide">…</section> を 1 枚分だけ渡してください');
  }
  const slides = deck.slides.slice(0, hit.start) + replacement + deck.slides.slice(hit.end);
  return writeDeck(ws, name, { slides }, opts);
}

/** 画像などをデッキに埋め込む。スライドからは <img data-asset="名前"> で参照する */
export function addAsset(ws, name, filePath, assetName) {
  if (!fs.existsSync(filePath)) throw new Error('ファイルが見つかりません: ' + filePath);
  const deck = readDeck(ws, name);
  const key = (assetName || path.basename(filePath)).replace(/[^\w.-]/g, '_');
  const assets = { ...deck.assets, [key]: fileToDataUri(filePath) };
  writeDeck(ws, name, { assets });
  return key;
}

/** 保存履歴の一覧 (新しい順) */
export function listHistory(ws, name) {
  const dir = historyDir(ws, name);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.html')).sort().reverse()
    .map((f) => ({ id: f.replace(/\.html$/, ''), size: fs.statSync(path.join(dir, f)).size }));
}

/** 履歴の版に戻す (戻す前の内容も履歴に残る) */
export function restoreHistory(ws, name, id) {
  const { file, html } = readDeckHtml(ws, name);
  const src = path.join(historyDir(ws, name), path.basename(id).replace(/\.html$/, '') + '.html');
  if (!fs.existsSync(src)) throw new Error('履歴が見つかりません: ' + id);
  saveDeckFile(ws, name, file, html, fs.readFileSync(src, 'utf8'));
  return readDoc(ws, name);
}

// ---------------------------------------------------------------------------
// マップ文書 (スライドなしで読む資料。jh:map ブロックの JSON。保存・履歴の仕組みはデッキと同じ)
// ---------------------------------------------------------------------------
export function listMaps(ws) {
  const dir = placeOf(ws).dir;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.html'))
    .map((f) => {
      const file = path.join(dir, f);
      const html = fs.readFileSync(file, 'utf8');
      if (!isMapHtml(html)) return null;
      const m = parseMap(html);
      return { name: f.replace(/\.html$/, ''), kind: 'map', title: m.title, theme: m.theme, brand: m.brand, nodes: m.nodeCount, updated: fs.statSync(file).mtime.toISOString() };
    })
    .filter(Boolean)
    .sort((a, b) => b.updated.localeCompare(a.updated));
}

export function createMap(ws, { name, title, theme = 'default', brand, map }) {
  assertTheme(ws, theme);
  const base = /^\d{4}-\d{2}-\d{2}-/.test(name) ? name : `${today()}-${name}`;
  const file = deckFile(ws, base);
  if (fs.existsSync(file)) throw new Error('すでに存在します: ' + base);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const ctx = ctxFor(ws);
  fs.writeFileSync(file, buildMap({ title, theme, brand: brand || 'none', map: map || starterMap(title) }, ctx));
  return { name: base, file };
}

export function readMap(ws, name) {
  const { file, html } = readDeckHtml(ws, name);
  if (!isMapHtml(html)) throw new Error(`${name} はマップ文書ではありません (デッキは read_deck / write_deck)`);
  return { name: path.basename(file, '.html'), kind: 'map', file, revision: revisionOf(html), ...parseMap(html) };
}

/** 指定した項目だけ更新する (map はオブジェクトか JSON 文字列。埋め込みの扱いは writeDeck と同じ) */
export function writeMap(ws, name, fields = {}, { revision, upgrade = false } = {}) {
  if (fields.theme) assertTheme(ws, fields.theme);
  const { file, html } = readDeckHtml(ws, name);
  if (!isMapHtml(html)) throw new Error(`${name} はマップ文書ではありません (デッキは write_deck)`);
  checkRevision(html, revision, name);
  saveDeckFile(ws, name, file, html, rebuildMap(html, fields, ctxFor(ws), { upgrade }));
  return readMap(ws, name);
}

// ---- 大きなマップの一部だけを読み書きする (AI が一度に扱う量を減らす) ----
function mapData(m) {
  if (!m.map) throw new Error('マップのデータが JSON として読めません。read_map で全体を読んで直してください');
  return m.map;
}
/** id のノードと、そこまでの道 (祖先のノード) を探す */
function findNode(nodes, id, trail = []) {
  for (const n of nodes || []) {
    if (String(n.id) === id) return { node: n, list: nodes, trail };
    const hit = n.children && findNode(n.children.nodes, id, [...trail, n]);
    if (hit) return hit;
  }
  return null;
}
function idsIn(node, out = new Set()) {
  out.add(String(node.id));
  ((node.children && node.children.nodes) || []).forEach((c) => idsIn(c, out));
  return out;
}
const tableOf = (ref) => String(ref).slice(0, String(ref).lastIndexOf('.'));

/** マップの目次: id・名前・種類・中の数だけの木 (detail・列・矢印は含めない) */
export function mapOutline(map) {
  const walk = (nodes) => (nodes || []).map((n) => {
    const item = { id: n.id, label: n.label };
    if (n.kind) item.kind = n.kind;
    if (n.columns) item.columns = n.columns.length;
    const kids = n.children && n.children.nodes;
    if (kids && kids.length) {
      item.edges = (n.children.edges || []).length + (n.children.relations || []).length;
      item.children = walk(kids);
    }
    return item;
  });
  return { title: map.title, nodes: walk(map.nodes), edges: (map.edges || []).length, flows: (map.flows || []).map((f) => ({ id: f.id, label: f.label })) };
}

/**
 * 1 つのノード (children ごと) を読む。context には、そのノードの外に書かれていて中の部品につながる矢印・関連・流れを入れる
 * (読むだけ。書き換えるときは、外に書かれたものは map 全体か、それが書かれている箱の node で直す)
 */
export function readMapPart(ws, name, id) {
  const m = readMap(ws, name), map = mapData(m);
  const hit = findNode(map.nodes, String(id));
  if (!hit) throw new Error(`ノードが見つかりません: ${id} (read_map の outline で id を確かめてください)`);
  const inside = idsIn(hit.node);
  const touches = (a, b) => inside.has(a) !== inside.has(b) || (inside.has(a) && inside.has(b));
  const context = { edges: [], relations: [], flows: [] };
  (function walk(box, within) {
    (box.edges || []).forEach((e) => { if (!within && touches(String(e.from), String(e.to))) context.edges.push(e); });
    (box.relations || []).forEach((r) => { if (!within && touches(tableOf(r.from), tableOf(r.to))) context.relations.push(r); });
    (box.nodes || []).forEach((n) => { if (n.children) walk(n.children, within || n === hit.node); });
  })(map, false);
  (map.flows || []).forEach((f) => {
    if ((f.path || []).some((p) => inside.has(String(typeof p === 'object' && p ? p.id : p)))) context.flows.push(f);
  });
  return { ...m, part: hit.node, path: hit.trail.map((n) => n.id), context };
}

/** 1 つのノードを part (children ごと) で置き換える。part.id は同じ id にする */
export function writeMapPart(ws, name, id, part, opts = {}) {
  const m = readMap(ws, name), map = mapData(m);
  if (opts.revision && opts.revision !== m.revision) {
    throw new Error(`マップ文書 ${name} は読み込んだ後に変更されています (revision 不一致)。read_map で読み直してから修正してください`);
  }
  const obj = typeof part === 'string' ? JSON.parse(part) : part;
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('part にはノード 1 つ分のオブジェクトを渡してください');
  if (String(obj.id) !== String(id)) throw new Error(`part の id (${obj.id}) が node (${id}) と違います。id を変えるときは map 全体を書き込んでください`);
  const hit = findNode(map.nodes, String(id));
  if (!hit) throw new Error(`ノードが見つかりません: ${id}`);
  hit.list[hit.list.indexOf(hit.node)] = obj;
  return writeMap(ws, name, { map }, { revision: opts.revision });
}

/** デッキかマップ文書かを見て読む */
export function readDoc(ws, name) {
  const { html } = readDeckHtml(ws, name);
  return isMapHtml(html) ? readMap(ws, name) : readDeck(ws, name);
}

export function readGuide() {
  return fs.readFileSync(path.join(PKG_ROOT, 'docs', 'authoring-guide.md'), 'utf8');
}
export function readThemeGuide() {
  return fs.readFileSync(path.join(PKG_ROOT, 'docs', 'theme-guide.md'), 'utf8');
}
