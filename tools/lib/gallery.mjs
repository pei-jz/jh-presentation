// テーマギャラリーを生成する
//   <outDir>/index.html      全テーマを並べた一覧 (実際に動くプレビュー)
//   <outDir>/<theme>.html    各テーマで見本スライドを表示するデッキ (1 ファイル形式)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDeck } from './deckfile.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * @param {string} out 出力先
 * @param {{name,label,description,tags}[]} themes 表示するテーマ
 * @param {object} ctx buildDeck に渡す { themeDirs, brandData }
 */
export function buildGallery(out, themes, ctx) {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const showcase = fs.readFileSync(path.join(HERE, 'showcase.html'), 'utf8');
  const slideCount = (showcase.match(/<section\b/g) || []).length;

  for (const t of themes) {
    const slides = showcase
      .replaceAll('{{LABEL}}', esc(t.label))
      .replaceAll('{{DESCRIPTION}}', esc(t.description))
      .replaceAll('{{NAME}}', esc(t.name));
    // ブランド枠 (下) を付けて、名前・ロゴの見え方も確認できるようにする
    fs.writeFileSync(path.join(out, t.name + '.html'),
      buildDeck({ title: `${t.label} (${t.name})`, theme: t.name, brand: 'footer', slides }, ctx));
  }

  const cards = themes.map((t) => `
    <article class="card" data-theme="${esc(t.name)}">
      <div class="frame"><iframe src="${esc(t.name)}.html?embed#1.9" title="${esc(t.label)}" loading="lazy"></iframe></div>
      <div class="info">
        <div class="head"><h2>${esc(t.label)}</h2><code>${esc(t.name)}</code></div>
        <p>${esc(t.description)}</p>
        <div class="tags">${t.tags.map((g) => `<span>${esc(g)}</span>`).join('')}</div>
        <div class="ctrl">
          <button type="button" data-act="prev" aria-label="前へ">◀</button>
          <span class="pos">1 / ${slideCount}</span>
          <button type="button" data-act="next" aria-label="次へ">▶</button>
          <a href="${esc(t.name)}.html" target="_blank">全画面で見る ↗</a>
        </div>
      </div>
    </article>`).join('');

  const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>テーマギャラリー</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px 40px 64px; font-family: "BIZ UDPGothic", "Yu Gothic UI", Meiryo, sans-serif; background: #14171e; color: #e5e7eb; }
  header { display: flex; align-items: baseline; gap: 24px; flex-wrap: wrap; margin-bottom: 24px; }
  h1 { margin: 0; font-size: 26px; }
  header p { margin: 0; color: #9ca3af; font-size: 14px; }
  header label { margin-left: auto; font-size: 14px; color: #9ca3af; cursor: pointer; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(520px, 1fr)); gap: 28px; }
  .card { background: #1d212b; border-radius: 12px; overflow: hidden; box-shadow: 0 8px 24px rgba(0,0,0,.3); }
  .frame { position: relative; aspect-ratio: 16 / 9; background: #000; }
  .frame iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; pointer-events: none; }
  .info { padding: 16px 20px 18px; }
  .head { display: flex; align-items: baseline; gap: 12px; }
  h2 { margin: 0; font-size: 20px; }
  code { padding: 2px 8px; border-radius: 6px; background: #2a3040; color: #93c5fd; font-size: 14px; }
  .info p { margin: 8px 0 10px; color: #c3c8d2; font-size: 14px; line-height: 1.6; }
  .tags { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
  .tags span { padding: 2px 10px; border-radius: 999px; background: #2a3040; color: #aab2c0; font-size: 12px; }
  .ctrl { display: flex; align-items: center; gap: 10px; font-size: 14px; }
  .ctrl button { width: 34px; height: 30px; border: 0; border-radius: 6px; background: #2a3040; color: #e5e7eb; cursor: pointer; }
  .ctrl button:hover { background: #374056; }
  .ctrl .pos { min-width: 52px; text-align: center; color: #9ca3af; font-variant-numeric: tabular-nums; }
  .ctrl a { margin-left: auto; color: #93c5fd; text-decoration: none; }
</style>
</head>
<body>
<header>
  <h1>テーマギャラリー</h1>
  <p>同じ見本スライドを各テーマで表示しています (下の帯はブランド枠の表示例)。使いたいテーマ名を AI に伝えてください (例:「corporate で作って」)。</p>
  <label><input type="checkbox" id="auto" checked> 自動で切り替える</label>
</header>
<main class="grid">${cards}
</main>
<script>
(function () {
  var TOTAL = ${slideCount};
  var cards = Array.prototype.slice.call(document.querySelectorAll('.card'));
  var state = cards.map(function () { return 1; });
  function show(i, n) {
    state[i] = ((n - 1 + TOTAL) % TOTAL) + 1;
    var card = cards[i], frame = card.querySelector('iframe');
    frame.src = frame.src.split('#')[0] + '#' + state[i] + '.9';
    card.querySelector('.pos').textContent = state[i] + ' / ' + TOTAL;
  }
  cards.forEach(function (card, i) {
    card.querySelector('[data-act=prev]').addEventListener('click', function () { show(i, state[i] - 1); });
    card.querySelector('[data-act=next]').addEventListener('click', function () { show(i, state[i] + 1); });
  });
  setInterval(function () {
    if (!document.getElementById('auto').checked) return;
    cards.forEach(function (_, i) { show(i, state[i] + 1); });
  }, 4000);
})();
</script>
</body>
</html>
`;
  const index = path.join(out, 'index.html');
  fs.writeFileSync(index, html);
  return { dir: out, index, themes };
}
