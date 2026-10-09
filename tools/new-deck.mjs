#!/usr/bin/env node
// 新しいデッキを作成する (1 ファイル形式)
//   npm run new -- <name> ["タイトル"] [--theme <テーマ>] [--brand none|header|footer|both] [--fullscreen]
//   → decks/YYYY-MM-DD-<name>.html
//   npm run new -- <name> ["タイトル"] --kind map   → maps/YYYY-MM-DD-<name>.html (マップ文書)
import fs from 'node:fs';
import path from 'node:path';
import { buildDeck, BRAND_POSITIONS, escapeHtml } from './lib/deckfile.mjs';
import { buildMap } from './lib/mapfile.mjs';
import { ROOT, DECKS_DIR, MAPS_DIR, repoCtx, repoThemes } from './lib/repo.mjs';

const argv = process.argv.slice(2);
function option(flag, def) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv.splice(i, 2)[1] : def;
}
const autoFullscreen = argv.includes('--fullscreen') && !!argv.splice(argv.indexOf('--fullscreen'), 1);
const theme = option('--theme', 'default');
const kind = option('--kind', 'deck');
const ctx = repoCtx();
const brand = option('--brand', ctx.brandData.position);
const [name, title] = argv;

if (!name) {
  console.error('使い方: npm run new -- <name> ["タイトル"] [--theme <テーマ>] [--brand none|header|footer|both] [--fullscreen] [--kind deck|map]');
  process.exit(1);
}
if (!/^[\w.-]+$/.test(name)) {
  console.error('name は英数字・ハイフン・アンダースコアのみ使えます: ' + name);
  process.exit(1);
}
const themes = repoThemes().map((t) => t.name);
if (!themes.includes(theme)) {
  console.error(`テーマがありません: ${theme} (${themes.join(', ')})`);
  process.exit(1);
}
if (!['deck', 'map'].includes(kind)) {
  console.error('--kind は deck / map のいずれかです');
  process.exit(1);
}
if (!BRAND_POSITIONS.includes(brand)) {
  console.error(`--brand は ${BRAND_POSITIONS.join(' / ')} のいずれかです`);
  process.exit(1);
}

const d = new Date();
const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const base = /^\d{4}-\d{2}-\d{2}-/.test(name) ? name : `${date}-${name}`;
const dir = kind === 'map' ? MAPS_DIR : DECKS_DIR;
const file = path.join(dir, base + '.html');
if (fs.existsSync(file)) {
  console.error('すでに存在します: ' + path.relative(ROOT, file));
  process.exit(1);
}

if (kind === 'map') {
  // 書き方の見本を兼ねた最初のマップ (全体 → システムの中 → 機能、データの流れ 1 本)
  const map = {
    title: title || name,
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
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, buildMap({ title: title || name, theme, brand, map }, ctx));
  console.log('作成しました: ' + path.relative(ROOT, file).replaceAll('\\', '/'));
  process.exit(0);
}

const t = escapeHtml(title || name);
const slides = `<section class="slide layout-title no-chrome" id="cover">
  <h1 class="anim-fade-up">${t}</h1>
  <div class="subtitle anim-fade-up" style="--delay:.15s">サブタイトル</div>
  <div class="meta anim-fade" style="--delay:.4s">${date.replaceAll('-', '/')}　発表者名</div>
  <aside class="notes"><p>表紙。自己紹介と今日のゴールを話す。</p></aside>
</section>

<section class="slide" id="agenda">
  <h2>アジェンダ</h2>
  <ol>
    <li class="step fade-up">項目 1</li>
    <li class="step fade-up">項目 2</li>
    <li class="step fade-up">項目 3</li>
  </ol>
</section>

<section class="slide layout-end no-chrome" id="end">
  <h1 class="anim-zoom">ありがとうございました</h1>
  <p class="muted anim-fade" style="--delay:.3s">質問・フィードバックはお気軽に</p>
</section>`;

fs.mkdirSync(DECKS_DIR, { recursive: true });
fs.writeFileSync(file, buildDeck({ title: title || name, theme, brand, autoFullscreen, slides }, ctx));
console.log('作成しました: ' + path.relative(ROOT, file).replaceAll('\\', '/'));
