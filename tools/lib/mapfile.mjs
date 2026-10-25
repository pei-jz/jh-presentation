// マップ文書 (スライドなしで、全体から細部へたどって読む 1 ファイルの HTML) の組み立てと解析
//
// ファイルの構成:
//   <head>   メタ情報 (generator / jh-kind="map" / jh-theme / jh-brand) とタイトル
//   <body>
//     jh:map           ← 編集してよい (マップのデータ。JSON。書き方は .diagram の階層マップと同じ)
//     jh:deck-style    ← 編集してよい (専用 CSS)
//     ===== 自動生成 =====
//     jh:engine-style / jh:theme-style / jh:brand / jh:engine-script
//     ===== 自動生成ここまで =====
//     jh:deck-script   ← 編集してよい (専用 JS)
//
// スライドのエンジン (engine.js) は含めない。表示は components/mapdoc.js (目次・検索・URL・印刷) と
// components/diagrams.js (階層マップの描画) が受け持つ。
import fs from 'node:fs';
import path from 'node:path';
import {
  readPkg, version, escapeHtml, unescapeHtml, safeScript, safeJson, block, getBlock, stripTag, BRAND_POSITIONS,
  BUILTIN_THEMES_DIR, findThemeFile,
} from './deckfile.mjs';
import { readThemes } from './themes.mjs';

export function isMapHtml(html) {
  return /<meta name="generator" content="jh-presentation[^"]*"/.test(html) && /<meta name="jh-kind" content="map"/.test(html);
}

/** マップのデータを JSON の文字列にする (文字列ならそのまま。どちらも JSON として正しいか確かめる) */
function mapText(map) {
  const text = typeof map === 'string' ? map.trim() : JSON.stringify(map || { nodes: [] }, null, 2);
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error('マップのデータが JSON として読めません: ' + e.message); }
  if (!data || !Array.isArray(data.nodes)) throw new Error('マップのデータには nodes (配列) が必要です');
  return text.replace(/<\//g, '<\\/'); // </script で終わらないように
}

function mapStyle() {
  return `<style>\n@layer components {\n${readPkg('components', 'components.css')}\n${readPkg('components', 'diagrams.css')}\n${readPkg('components', 'mapdoc.css')}\n}\n</style>`;
}
/**
 * テーマ: 土台 (default) に加えて、同梱テーマ全部 (と指定の自作テーマ) を候補として埋め込む。
 * 指定のテーマ以外は media="not all" で止めておき、ビューアのテーマ選択で切り替える (mapdoc.js)
 */
function mapThemeStyle(theme, themeDirs) {
  const file = findThemeFile(theme, themeDirs);
  if (theme !== 'default' && !file) throw new Error(`テーマがありません: ${theme}`);
  const list = readThemes(BUILTIN_THEMES_DIR);
  if (!list.some((t) => t.name === theme)) list.push(readThemes(path.dirname(file)).find((t) => t.name === theme));
  const styles = list.map((t) => {
    const css = t.name === 'default' ? '' : `@layer theme {\n${fs.readFileSync(findThemeFile(t.name, themeDirs), 'utf8')}\n}`;
    return `<style data-jh-theme="${escapeHtml(t.name)}" data-label="${escapeHtml(t.label)}"${t.name === theme ? '' : ' media="not all"'}>\n${css}\n</style>`;
  });
  return `<style>\n@layer theme-base {\n${readPkg('themes', 'default.css')}\n}\n</style>\n${styles.join('\n')}`;
}
function mapScript() {
  return `<script>\n${safeScript(readPkg('components', 'mapdoc.js'))}\n${safeScript(readPkg('components', 'diagrams.js'))}\nJhMap.start();\n</script>`;
}

/**
 * @param {object} doc { title, theme, brand, map (オブジェクトか JSON 文字列), css, js }
 * @param {object} ctx { themeDirs, brandData }
 * @param {object} [keep] 引き継ぐ自動生成ブロック { version, engineStyle, engineScript, themeStyle, brand }
 */
export function buildMap(doc, ctx = {}, keep = {}) {
  const theme = doc.theme || 'default';
  const brand = BRAND_POSITIONS.includes(doc.brand) ? doc.brand : 'none';
  const b = ctx.brandData || {};
  const gen = {
    version: keep.version || version(),
    engineStyle: keep.engineStyle || mapStyle(),
    themeStyle: keep.themeStyle || mapThemeStyle(theme, ctx.themeDirs),
    brand: keep.brand || `<script type="application/json" id="jh-brand">${safeJson({ name: b.name || '', label: b.label || '', logo: b.logo || '' })}</script>`,
    engineScript: keep.engineScript || mapScript(),
  };
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="jh-presentation ${gen.version}">
<meta name="jh-kind" content="map">
<meta name="jh-theme" content="${escapeHtml(theme)}">
<meta name="jh-brand" content="${brand}">
<title>${escapeHtml(doc.title || 'Untitled')}</title>
<style>@layer engine, theme-base, components, theme; html:not(.map-ready) body { visibility: hidden; } @page { size: A4 landscape; margin: 12mm; }</style>
</head>
<body class="jh-mapdoc" data-brand="${brand}">
<!--
  jh-presentation マップ文書 (このファイル 1 つで完結)
  編集してよいのは jh:map (JSON) / jh:deck-style / jh:deck-script の中だけ。
  「自動生成」の範囲はツールが作り直すので編集しない (テーマ・ブランドは <head> の meta で指定)。
-->
${block('map', `<script type="application/json" id="jh-map-data">\n${mapText(doc.map)}\n</script>`)}

${block('deck-style', `<style>\n${(doc.css || '').trim()}\n</style>`)}

<!-- ===================== 自動生成 (編集しない) ===================== -->
<!--
  The viewer, components and themes embedded below are part of jh-presentation
  (https://github.com/pei-jz/jh-presentation), released under the MIT License.
  The map data, style and script above/below belong to the document author.
  Copyright (c) 2026 pei-jz
-->
${block('engine-style', gen.engineStyle)}
${block('theme-style', gen.themeStyle)}
${block('brand', gen.brand)}
${block('engine-script', gen.engineScript)}
<!-- ===================== 自動生成ここまで ===================== -->

${block('deck-script', `<script>\n${safeScript((doc.js || '').trim())}\n</script>`)}
</body>
</html>
`;
}

const meta = (html, name) => ((html.match(new RegExp(`<meta name="${name}" content="([^"]*)"`)) || [])[1]);

export function parseMap(html) {
  if (!isMapHtml(html)) throw new Error('jh-presentation のマップ文書ではありません');
  const text = stripTag(getBlock(html, 'map'), 'script').trim().replace(/<\\\//g, '</');
  let map = null;
  try { map = JSON.parse(text); } catch { /* 壊れていても文字列は返す */ }
  const count = (nodes) => (nodes || []).reduce((n, x) => n + 1 + count(x.children && x.children.nodes), 0);
  return {
    kind: 'map',
    version: (meta(html, 'generator') || '').replace('jh-presentation', '').trim(),
    title: unescapeHtml(((html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '').trim()),
    theme: meta(html, 'jh-theme') || 'default',
    brand: meta(html, 'jh-brand') || 'none',
    mapText: text,
    map,
    nodeCount: map ? count(map.nodes) : 0,
    css: stripTag(getBlock(html, 'deck-style'), 'style'),
    js: stripTag(getBlock(html, 'deck-script'), 'script'),
  };
}

/** 指定した項目だけ差し替えて作り直す (deckfile の rebuildDeck と同じ考え方) */
export function rebuildMap(html, fields = {}, ctx = {}, { upgrade = false } = {}) {
  const cur = parseMap(html);
  const next = { ...cur, map: cur.mapText };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) next[k] = v;
  if (upgrade) return buildMap(next, ctx);
  const raw = (name) => getBlock(html, name);
  return buildMap(next, ctx, {
    version: cur.version,
    engineStyle: raw('engine-style'),
    engineScript: raw('engine-script'),
    themeStyle: next.theme === cur.theme ? raw('theme-style') : null,
    brand: raw('brand'),
  });
}

/** 書き方の見本を兼ねた最初のマップ (全体 → システムの中 → 機能、データの流れ 1 本) */
export function starterMap(title) {
  return {
    title,
    nodes: [
      { id: 'user', label: '利用者', kind: 'user' },
      { id: 'web', label: '画面', sub: 'Web / アプリ', detail: '<p>利用者が操作する画面。</p>' },
      { id: 'core', label: '業務システム', accent: true, detail: '<p>このシステムの説明を書く。</p>',
        children: { nodes: [
          { id: 'core.api', label: 'API', detail: '<p>画面からの要求を受け付ける。</p>' },
          { id: 'core.logic', label: '業務ロジック' },
          { id: 'core.db', label: '業務 DB', kind: 'db' },
        ] } },
      { id: 'ext', label: '外部サービス', kind: 'ext' },
    ],
    edges: [
      { from: 'user', to: 'web' },
      { from: 'web', to: 'core.api', label: '要求', data: ['申請'] },
      { from: 'core.api', to: 'core.logic' },
      { from: 'core.logic', to: 'core.db', label: '保存', data: ['申請'] },
      { from: 'core.logic', to: 'ext', label: '連携', type: 'async' },
    ],
    flows: [
      { id: 'main', label: '申請の流れ', path: ['user', 'web', 'core.api', 'core.logic', { id: 'core.db', note: '申請を保存' }] },
    ],
  };
}
