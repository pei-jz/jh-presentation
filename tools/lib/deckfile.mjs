// デッキファイル (1 ファイルで完結する HTML) の組み立てと解析
//
// ファイルの構成:
//   <head>   メタ情報 (generator / jh-theme / jh-brand) とタイトル
//   <body>
//     <div class="deck"> jh:slides </div>       ← 編集してよい (スライド)
//     jh:deck-style                             ← 編集してよい (デッキ専用 CSS)
//     ===== 自動生成 =====
//     jh:engine-style / jh:theme-style / jh:brand / jh:assets / jh:engine-script
//     ===== 自動生成ここまで =====
//     jh:deck-script                            ← 編集してよい (デッキ専用 JS。エンジンの後に実行)
//
// CSS はカスケードレイヤー (engine < theme-base < components < theme) に入れるので、
// レイヤーに入らないデッキ専用 CSS は、ファイル内の位置に関係なく常に優先される。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../../engine/deck-edit.js'; // globalThis.JhDeckEdit (位置を保つ HTML 解析)

const EditLib = globalThis.JhDeckEdit;

export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const BUILTIN_THEMES_DIR = path.join(PKG_ROOT, 'themes');
export const SAMPLE_BRAND_DIR = path.join(PKG_ROOT, 'brand');
export const BRAND_POSITIONS = ['none', 'header', 'footer', 'both'];
export const TRANSITIONS = ['fade', 'slide', 'zoom', 'none'];

const readPkg = (...p) => fs.readFileSync(path.join(PKG_ROOT, ...p), 'utf8');
const version = () => JSON.parse(readPkg('package.json')).version;

export function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function unescapeHtml(s) {
  return String(s).replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[e]));
}
/** <script> 内に埋め込むために </script を無害化 */
const safeScript = (s) => s.replace(/<\/script/gi, '<\\/script');
const safeJson = (o) => JSON.stringify(o).replace(/<\//g, '<\\/');

// ---------------------------------------------------------------------------
// テーマ
// ---------------------------------------------------------------------------
/** テーマ CSS のパス。同梱テーマが優先 (同名の自作テーマは使われない) */
export function findThemeFile(name, themeDirs = []) {
  if (!/^[\w-]+$/.test(name)) return null;
  for (const dir of [BUILTIN_THEMES_DIR, ...themeDirs]) {
    const f = path.join(dir, name + '.css');
    if (fs.existsSync(f)) return f;
  }
  return null;
}

function themeCss(name, themeDirs) {
  const base = `@layer theme-base {\n${readPkg('themes', 'default.css')}\n}`;
  if (!name || name === 'default') return base;
  const f = findThemeFile(name, themeDirs);
  if (!f) throw new Error(`テーマがありません: ${name}`);
  return `${base}\n@layer theme {\n${fs.readFileSync(f, 'utf8')}\n}`;
}

// ---------------------------------------------------------------------------
// ブランド (名前・ロゴ)
// ---------------------------------------------------------------------------
const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm',
};
export function fileToDataUri(file) {
  const type = MIME[path.extname(file).toLowerCase()];
  if (!type) throw new Error(`埋め込めないファイル形式です: ${path.basename(file)} (${Object.keys(MIME).join(' ')})`);
  return `data:${type};base64,${fs.readFileSync(file).toString('base64')}`;
}

/** brand/brand.json を読む。無ければ同梱サンプル。 @returns {{name,label,logo,position}} */
export function loadBrand(brandDir) {
  const dir = brandDir && fs.existsSync(path.join(brandDir, 'brand.json')) ? brandDir : SAMPLE_BRAND_DIR;
  const conf = JSON.parse(fs.readFileSync(path.join(dir, 'brand.json'), 'utf8'));
  const logoFile = conf.logo ? path.join(dir, conf.logo) : null;
  return {
    name: conf.name || '',
    label: conf.label || '',
    logo: logoFile && fs.existsSync(logoFile) ? fileToDataUri(logoFile) : '',
    position: BRAND_POSITIONS.includes(conf.position) ? conf.position : 'none',
    dir,
  };
}

// ---------------------------------------------------------------------------
// 組み立て
// ---------------------------------------------------------------------------
const block = (name, inner) => `<!-- jh:${name} -->\n${inner}\n<!-- /jh:${name} -->`;

function engineStyle() {
  // @page は @layer の中に書けないので <head> 側に置く
  const engine = readPkg('engine', 'engine.css').replace(/@page\s*\{[^}]*\}\s*/g, '');
  return `<style>\n@layer engine {\n${engine}\n}\n@layer components {\n${readPkg('components', 'components.css')}\n${readPkg('components', 'diagrams.css')}\n}\n</style>`;
}

/**
 * @param {object} deck { title, theme, transition, brand, slides, css, js, assets }
 * @param {object} ctx  { themeDirs: string[], brandData: {name,label,logo} | null }
 * @param {object} [keep] 既存ファイルから引き継ぐ自動生成ブロック (省略時は現在のエンジン等で生成)
 *                        { version, engineStyle, engineScript, themeStyle, brand }
 */
export function buildDeck(deck, ctx = {}, keep = {}) {
  const theme = deck.theme || 'default';
  const transition = TRANSITIONS.includes(deck.transition) ? deck.transition : 'fade';
  const brand = BRAND_POSITIONS.includes(deck.brand) ? deck.brand : 'none';
  const b = ctx.brandData || {};
  const assets = deck.assets || {};
  validateSlides(deck.slides || '');
  const gen = {
    version: keep.version || version(),
    engineStyle: keep.engineStyle || engineStyle(),
    themeStyle: keep.themeStyle || `<style>\n${themeCss(theme, ctx.themeDirs)}\n</style>`,
    brand: keep.brand || `<script type="application/json" id="jh-brand">${safeJson({ name: b.name || '', label: b.label || '', logo: b.logo || '' })}</script>`,
    engineScript: keep.engineScript || `<script>\n${safeScript(readPkg('engine', 'deck-edit.js'))}\n${safeScript(readPkg('engine', 'engine.js'))}\n${safeScript(readPkg('components', 'components.js'))}\n${safeScript(readPkg('components', 'diagrams.js'))}\n</script>`,
  };
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="jh-presentation ${gen.version}">
<meta name="jh-theme" content="${escapeHtml(theme)}">
<meta name="jh-brand" content="${brand}">
<title>${escapeHtml(deck.title || 'Untitled')}</title>
<style>@layer engine, theme-base, components, theme; @page { size: 1920px 1080px; margin: 0; } html:not(.deck-ready) .deck { visibility: hidden; }</style>
</head>
<body>
<!--
  jh-presentation デッキ (このファイル 1 つで完結)
  編集してよいのは jh:slides / jh:deck-style / jh:deck-script の中だけ。
  「自動生成」の範囲はツールが作り直すので編集しない (テーマ・ブランドは <head> の meta で指定)。
-->
<div class="deck" data-transition="${transition}" data-brand="${brand}"${deck.autoFullscreen ? ' data-auto-fullscreen="true"' : ''}>
${block('slides', (deck.slides || '').trim())}
</div>

${block('deck-style', `<style>\n${(deck.css || '').trim()}\n</style>`)}

<!-- ===================== 自動生成 (編集しない) ===================== -->
<!--
  The engine, components and themes embedded below are part of jh-presentation
  (https://github.com/pei-jz/jh-presentation), released under the MIT License.
  The slides, deck style and deck script above/below belong to the deck author.

  Copyright (c) 2026 pei-jz

  Permission is hereby granted, free of charge, to any person obtaining a copy
  of this software and associated documentation files (the "Software"), to deal
  in the Software without restriction, including without limitation the rights
  to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
  copies of the Software, and to permit persons to whom the Software is
  furnished to do so, subject to the following conditions:

  The above copyright notice and this permission notice shall be included in all
  copies or substantial portions of the Software.

  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
  SOFTWARE.
-->
${block('engine-style', gen.engineStyle)}
${block('theme-style', gen.themeStyle)}
${block('brand', gen.brand)}
${block('assets', `<script type="application/json" id="jh-assets">${safeJson(assets)}</script>`)}
${block('engine-script', gen.engineScript)}
<!-- ===================== 自動生成ここまで ===================== -->

${block('deck-script', `<script>\n${safeScript((deck.js || '').trim())}\n</script>`)}
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------
function getBlock(html, name) {
  const m = html.match(new RegExp(`<!-- jh:${name} -->\\n?([\\s\\S]*?)\\n?<!-- /jh:${name} -->`));
  return m ? m[1] : null;
}
function stripTag(inner, tag) {
  if (inner == null) return '';
  return inner.replace(new RegExp(`^\\s*<${tag}[^>]*>\\n?`), '').replace(new RegExp(`\\n?</${tag}>\\s*$`), '');
}
const meta = (html, name) => ((html.match(new RegExp(`<meta name="${name}" content="([^"]*)"`)) || [])[1]);

export function isDeckHtml(html) {
  return /<meta name="generator" content="jh-presentation[^"]*"/.test(html);
}

export function parseDeck(html) {
  if (!isDeckHtml(html)) throw new Error('jh-presentation のデッキファイルではありません');
  let assets = {};
  try { assets = JSON.parse(stripTag(getBlock(html, 'assets'), 'script') || '{}'); } catch { /* 壊れていたら空 */ }
  const slides = getBlock(html, 'slides') || '';
  // 設定はデッキ本体の <div class="deck"> タグからだけ読む (埋め込みエンジンのコメント等に同じ文字列がある)
  const deckTag = (html.match(/<div class="deck"[^>]*>/) || [''])[0];
  return {
    version: (meta(html, 'generator') || '').replace('jh-presentation', '').trim(),
    title: unescapeHtml(((html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '').trim()),
    theme: meta(html, 'jh-theme') || 'default',
    brand: meta(html, 'jh-brand') || 'none',
    transition: (deckTag.match(/data-transition="([^"]*)"/) || [])[1] || 'fade',
    autoFullscreen: /data-auto-fullscreen="true"/.test(deckTag),
    slides,
    slideCount: countSlides(slides),
    css: stripTag(getBlock(html, 'deck-style'), 'style'),
    js: stripTag(getBlock(html, 'deck-script'), 'script'),
    assets,
  };
}

export function countSlides(slidesHtml) {
  return EditLib.slideRanges(slidesHtml).length;
}

/**
 * スライド HTML の構造を確認する (壊れた状態で保存しないため)
 *   - 最上位は <section class="slide"> の並び (間にあってよいのは空白とコメントだけ)
 *   - スライドの id は重複しない
 */
export function validateSlides(slidesHtml) {
  const ranges = EditLib.slideRanges(slidesHtml);
  let rest = '', pos = 0;
  for (const r of ranges) { rest += slidesHtml.slice(pos, r.start); pos = r.end; }
  rest += slidesHtml.slice(pos);
  const stray = rest.replace(/<!--[\s\S]*?-->/g, '').trim();
  if (stray) throw new Error(`スライド (<section class="slide">) の外に内容があります: ${stray.slice(0, 60)}`);
  const ids = ranges.map((r) => r.id).filter(Boolean);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw new Error(`スライドの id が重複しています: ${dup}`);
  return ranges;
}

/**
 * 指定した項目だけ差し替えて作り直す。
 * 通常はエンジン・テーマ・ブランドの埋め込みを**そのまま引き継ぐ** (内容の修正で見た目が変わらないように)。
 *   - テーマを変更した場合だけ、テーマを現在の CSS で埋め込み直す
 *   - upgrade: true のときは、エンジン・テーマ・ブランドをすべて最新にする
 */
export function rebuildDeck(html, fields = {}, ctx = {}, { upgrade = false } = {}) {
  const cur = parseDeck(html);
  const next = { ...cur };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) next[k] = v;
  if (upgrade) return buildDeck(next, ctx);
  const raw = (name) => getBlock(html, name);
  return buildDeck(next, ctx, {
    version: cur.version,
    engineStyle: raw('engine-style'),
    engineScript: raw('engine-script'),
    themeStyle: next.theme === cur.theme ? raw('theme-style') : null,
    brand: raw('brand'),
  });
}

// ---------------------------------------------------------------------------
// 旧形式 (decks/<name>/index.html + deck.css + deck.js) からの移行
// ---------------------------------------------------------------------------
export function convertFolderDeck(dir) {
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const read = (f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8') : '');
  const s = html.indexOf('<!-- slides:start -->'), e = html.indexOf('<!-- slides:end -->');
  let slides = s >= 0 && e > s
    ? html.slice(s + '<!-- slides:start -->'.length, e)
    : ((html.match(/<div class="deck"[^>]*>([\s\S]*)<\/div>\s*<script/) || [])[1] || '');
  // フォルダ内の画像は assets に取り込み、data-asset 参照に変える
  const assets = {};
  slides = slides.replace(/<(img|source|video)\b([^>]*?)\ssrc="([^"]+)"/gi, (m, tag, pre, src) => {
    if (/^(https?:|data:|\/\/)/i.test(src)) return m;
    const file = path.join(dir, src);
    if (!fs.existsSync(file)) return m;
    const name = path.basename(src);
    assets[name] = fileToDataUri(file);
    return `<${tag}${pre} data-asset="${name}"`;
  });
  const themes = [...html.matchAll(/themes\/([\w-]+)\.css/g)].map((m) => m[1]).filter((t) => t !== 'default');
  return {
    title: unescapeHtml(((html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || path.basename(dir)).trim()),
    theme: themes[0] || 'default',
    transition: (html.match(/<div class="deck"[^>]*data-transition="([^"]*)"/) || [])[1] || 'fade',
    brand: 'none',
    slides: slides.trim(),
    css: read('deck.css').trim(),
    js: read('deck.js').trim(),
    assets,
  };
}

/** srcDir 内の旧形式フォルダデッキを outDir/<name>.html に変換する (既にあればスキップ) */
export function migrateFolderDecks(srcDir, outDir, ctx) {
  if (!fs.existsSync(srcDir)) return [];
  const done = [];
  for (const d of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith('_')) continue;
    const dir = path.join(srcDir, d.name);
    const index = path.join(dir, 'index.html');
    if (!fs.existsSync(index)) continue;
    // 旧形式のデッキ (共通エンジンを相対パスで参照し、.deck を持つもの) だけを対象にする
    const src = fs.readFileSync(index, 'utf8');
    if (!/engine\/engine\.js/.test(src) || !/<div class="deck"/.test(src)) continue;
    const out = path.join(outDir, d.name + '.html');
    if (fs.existsSync(out)) continue;
    try {
      fs.writeFileSync(out, buildDeck(convertFolderDeck(dir), ctx));
      done.push(d.name);
    } catch (e) {
      console.error(`[migrate] ${d.name} を変換できませんでした: ${e.message}`);
    }
  }
  return done;
}
