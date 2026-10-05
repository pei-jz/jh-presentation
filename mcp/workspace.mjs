// ワークスペース (デッキの保存先) とデッキの読み書き
//
// <ワークスペース>/
//   2026-10-02-xxx.html   デッキ (1 ファイルで完結。エンジン・テーマ・ブランド・画像を埋め込み)
//   brand/                名前・ロゴ (brand.json)。最初は同梱のサンプルがコピーされる
//   themes/               自作テーマ (*.css)
//   prompts/              チーム・個人の依頼文テンプレート (*.md)
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { readThemes } from '../tools/lib/themes.mjs';
import {
  PKG_ROOT, BUILTIN_THEMES_DIR, SAMPLE_BRAND_DIR, buildDeck, parseDeck, rebuildDeck, isDeckHtml,
  loadBrand, migrateFolderDecks, fileToDataUri, findThemeFile,
} from '../tools/lib/deckfile.mjs';
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
  return { themeDirs: [themesDir(ws)], brandData: loadBrand(brandDir(ws)) };
}

export function deckFile(ws, name) {
  const base = String(name).replace(/\.html$/i, '');
  if (!/^[\w.-]+$/.test(base) || base.startsWith('.')) throw new Error('デッキ名が不正です: ' + name);
  return path.join(ws, base + '.html');
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
  const custom = readThemes(themesDir(ws)).filter((t) => !names.has(t.name)).map((t) => ({ ...t, custom: true }));
  return [...builtin, ...custom];
}
export const themeNames = (ws) => listThemes(ws).map((t) => t.name);

export function assertTheme(ws, theme) {
  if (theme && !findThemeFile(theme, [themesDir(ws)])) {
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
  if (!fs.existsSync(ws)) return [];
  return fs.readdirSync(ws)
    .filter((f) => f.endsWith('.html'))
    .map((f) => {
      const file = path.join(ws, f);
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
export const historyDir = (ws, name) => path.join(ws, '.history', path.basename(deckFile(ws, name), '.html'));

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
  return readDeck(ws, name);
}

export function readGuide() {
  return fs.readFileSync(path.join(PKG_ROOT, 'docs', 'authoring-guide.md'), 'utf8');
}
export function readThemeGuide() {
  return fs.readFileSync(path.join(PKG_ROOT, 'docs', 'theme-guide.md'), 'utf8');
}
