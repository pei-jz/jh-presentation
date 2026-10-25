// マップ文書 (tools/lib/mapfile.mjs + components/mapdoc.js) のテスト
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { findBrowser } from '../tools/lib/browser.mjs';
import { buildMap, parseMap, rebuildMap, isMapHtml } from '../tools/lib/mapfile.mjs';
import { isDeckHtml } from '../tools/lib/deckfile.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE = path.join(ROOT, 'examples', 'sample-map.html');
const URL_ = pathToFileURL(SAMPLE).href;
let browser, page;

before(async () => {
  browser = await chromium.launch({ executablePath: findBrowser(), headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
  await page.goto(URL_);
  await page.waitForFunction(() => document.documentElement.classList.contains('map-ready'));
});
after(async () => { await browser?.close(); });

const q = (fn, arg) => page.evaluate(fn, arg);
const settle = () => page.evaluate(() => window.Deck.settled(4000));
const level = () => q(() => document.querySelector('.jh-map-stage .dg').getAttribute('data-level'));

test('ファイル形式: 組み立てと解析で、マップのデータ・題名・テーマが保たれる', () => {
  const map = { title: 'T', nodes: [{ id: 'a', label: 'A', detail: '<p>x</p><script>alert(1)</script>' }] };
  const html = buildMap({ title: '題名', theme: 'dark', map }, {});
  assert.ok(isMapHtml(html));
  assert.equal(isDeckHtml(html), false, 'マップ文書はデッキとして扱わない');
  const block = html.split('<!-- jh:map -->')[1].split('<!-- /jh:map -->')[0];
  assert.ok(block.includes(String.raw`alert(1)<\/script>`), '</script は無害化して埋め込む');
  assert.equal(block.match(/<\/script>/g).length, 1, 'データの script を閉じる 1 つだけ');
  const m = parseMap(html);
  assert.equal(m.title, '題名');
  assert.equal(m.theme, 'dark');
  assert.deepEqual(m.map, map);
  assert.equal(m.nodeCount, 1);
  // 作り直しても、JSON の書き方 (文字列) は変わらない
  const again = parseMap(rebuildMap(html, { title: '新しい題名' }, {}));
  assert.equal(again.title, '新しい題名');
  assert.equal(again.mapText, m.mapText);
  assert.throws(() => buildMap({ map: '{ nodes: ' }, {}), /JSON として読めません/);
  assert.throws(() => buildMap({ map: { edges: [] } }, {}), /nodes/);
});

test('目次: すべてのノードが並び、クリックでその階層へ入る。URL に階層が残り、戻るで全体へ戻る', async () => {
  const items = await q(() => [...document.querySelectorAll('.jh-toc-item')].map((b) => b.getAttribute('data-id')));
  const nodes = await q(() => JhMap.api.nodes().length);
  assert.equal(items.length, nodes + 1, '先頭は全体');

  await page.click('.jh-toc-item[data-id="order.api"]');
  await settle();
  assert.equal(await level(), 'order.api');
  assert.equal(await q(() => location.hash), '#/order.api');
  assert.equal(await q(() => document.querySelector('.jh-toc-item.is-current').getAttribute('data-id')), 'order.api');

  await page.goBack();
  await settle();
  assert.equal(await level(), '', 'ブラウザの戻るで全体へ');
});

test('URL を開くと、その階層とノードが表示される (共有できる)', async () => {
  const p2 = await browser.newPage({ viewport: { width: 1440, height: 860 } });
  await p2.goto(URL_ + '#/order/order.mq');
  await p2.waitForFunction(() => document.documentElement.classList.contains('map-ready'));
  await p2.evaluate(() => window.Deck.settled(4000));
  const st = await p2.evaluate(() => ({
    level: document.querySelector('.jh-map-stage .dg').getAttribute('data-level'),
    panel: document.querySelector('.dg-panel-title').textContent,
    links: document.querySelector('.dg-links').textContent,
  }));
  await p2.close();
  assert.equal(st.level, 'order');
  assert.equal(st.panel, '通知キュー');
  assert.ok(st.links.includes('入ってくる (1)') && st.links.includes('出ていく (1)'), '詳細パネルにつながりの一覧が付く');
});

test('検索: 名前・説明で探し、Enter でその部品へ移る', async () => {
  await page.fill('.jh-map-search input', '引当');
  const hits = await q(() => [...document.querySelectorAll('.jh-map-result')].map((b) => b.getAttribute('data-id')));
  assert.ok(hits.includes('order.api.reserve'));
  await page.fill('.jh-map-search input', '在庫の引当');
  await page.press('.jh-map-search input', 'Enter');
  await settle();
  assert.equal(await level(), 'order.api');
  assert.equal(await q(() => JhMap.api.selected()), 'order.api.reserve');
  assert.equal(await q(() => location.hash), '#/order.api/order.api.reserve');
  await page.keyboard.press('Escape'); // 詳細を閉じる
  await page.keyboard.press('Escape'); // 1 つ上へ
  await settle();
  assert.equal(await level(), 'order');
});

test('データで絞り込むと、そのデータが流れる矢印だけが光る', async () => {
  await page.click('.jh-toc-item[data-id=""]');
  await settle();
  await page.selectOption('.jh-map-data', '決済');
  const flowing = await q(() => [...document.querySelectorAll('.jh-map-stage .dg-edge.is-flowing .dg-edge-label')].map((t) => t.textContent));
  assert.deepEqual(flowing, ['決済']);
  await page.selectOption('.jh-map-data', '');
});

test('印刷 (?print): 階層ごとに 1 ページ、Deck.audit() は空', async () => {
  const p2 = await browser.newPage();
  await p2.goto(URL_ + '?print');
  await p2.waitForFunction(() => document.documentElement.classList.contains('map-ready'));
  const titles = await p2.evaluate(() => [...document.querySelectorAll('.jh-print-page h2')].map((h) => h.textContent));
  await p2.close();
  assert.deepEqual(titles, ['EC サイト', 'EC サイト › フロント', 'EC サイト › 注文システム', 'EC サイト › 注文システム › 注文 API', 'EC サイト › 注文システム › 注文 DB',
    'EC サイト › 在庫システム', 'EC サイト › 在庫システム › 在庫 DB']);
  assert.deepEqual(await q(() => window.Deck.audit()), []);
});

test('検査: 1 つの階層のノードが多すぎると density で知らせる', async () => {
  const nodes = Array.from({ length: 14 }, (_, i) => ({ id: 'n' + i, label: 'ノード ' + i }));
  const html = buildMap({ title: 'many', map: { nodes } }, {});
  const file = path.join(ROOT, 'dist', 'test-many.html');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, html);
  const p2 = await browser.newPage({ viewport: { width: 1440, height: 860 } });
  await p2.goto(pathToFileURL(file).href);
  await p2.waitForFunction(() => document.documentElement.classList.contains('map-ready'));
  const types = await p2.evaluate(() => window.Deck.audit().map((i) => i.type));
  await p2.close();
  fs.rmSync(file);
  assert.ok(types.includes('density'));
});

test('詳細パネルのつながり: クリックでその部品へ移る (<base> のある埋め込みでも、フレームが別のページへ移らない)', async () => {
  // エディタのプレビューと同じく、srcdoc の iframe に <base> を付けて読み込む
  const html = fs.readFileSync(SAMPLE, 'utf8').replace(/<head>/i, '<head><base href="https://example.invalid/dir/">');
  const p2 = await browser.newPage({ viewport: { width: 1440, height: 860 } });
  await p2.setContent('<iframe id="f" style="width:1400px;height:820px;border:0" sandbox="allow-scripts"></iframe>');
  await p2.evaluate((src) => { document.getElementById('f').srcdoc = src; }, html);
  const frame = await (await p2.$('#f')).contentFrame();
  await frame.waitForFunction(() => document.documentElement.classList.contains('map-ready'));
  await frame.evaluate(() => { JhMap.api.reveal('order.db'); return window.Deck.settled(4000); });
  await frame.click('.dg-links a[data-dg-go="order.api.confirm"]');
  await frame.evaluate(() => window.Deck.settled(4000));
  const st = await frame.evaluate(() => ({ level: JhMap.api.level(), sel: JhMap.api.selected(), url: location.href }));
  await p2.close();
  assert.equal(st.url, 'about:srcdoc', 'フレームはそのまま');
  assert.equal(st.level, 'order.api');
  assert.equal(st.sel, 'order.api.confirm');
});

test('エディタの iframe の中: ready (kind: map) を送り、F5 は再読み込みせず「発表」としてホストへ渡す', async () => {
  const html = fs.readFileSync(SAMPLE, 'utf8');
  const p2 = await browser.newPage({ viewport: { width: 1440, height: 860 } });
  await p2.setContent('<iframe id="f" style="width:1400px;height:820px;border:0" sandbox="allow-scripts"></iframe>');
  await p2.evaluate((src) => {
    window.got = [];
    window.addEventListener('message', (ev) => { if (ev.data && ev.data.jhdeck) window.got.push(ev.data); });
    document.getElementById('f').srcdoc = src;
  }, html);
  const frame = await (await p2.$('#f')).contentFrame();
  await frame.waitForFunction(() => document.documentElement.classList.contains('map-ready'));
  const prevented = await frame.evaluate(() => {
    const ev = new KeyboardEvent('keydown', { key: 'F5', bubbles: true, cancelable: true });
    document.body.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  await p2.waitForFunction(() => window.got.some((m) => m.type === 'present'));
  // 発表中: 図が使わない Esc は発表の終了をホストに頼む
  await p2.evaluate(() => document.getElementById('f').contentWindow.postMessage({ jhdeck: 2, type: 'present', on: true }, '*'));
  await frame.evaluate(() => new Promise((r) => setTimeout(r, 50)));
  await frame.evaluate(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  await p2.waitForFunction(() => window.got.some((m) => m.type === 'present-exit'));
  const got = await p2.evaluate(() => window.got.map((m) => m.type + (m.kind ? ':' + m.kind : '')));
  await p2.close();
  assert.ok(prevented, 'F5 の既定の動作 (再読み込み) を止める');
  assert.equal(got[0], 'ready:map');
});

test('閲覧の補助: ホイールで拡大するとミニマップが出て、ドラッグは箱のクリックにならない。⤢ で全体に戻る', async () => {
  const p2 = await browser.newPage({ viewport: { width: 1440, height: 860 } });
  await p2.goto(URL_ + '#/order.db');
  await p2.waitForFunction(() => document.documentElement.classList.contains('map-ready'));
  await p2.evaluate(() => window.Deck.settled(4000));
  const width = () => p2.evaluate(() => Number(document.querySelector('.jh-map-stage .dg-svg').getAttribute('viewBox').split(' ')[2]));
  const w0 = await width();
  await p2.mouse.move(900, 450);
  await p2.mouse.wheel(0, -600);
  assert.ok((await width()) < w0 * 0.6, '拡大して見える範囲が狭くなる');
  assert.equal(await p2.evaluate(() => document.querySelector('.dg-minimap').hidden), false);
  const box = await p2.locator('.er-table[data-id="order.db.orders"] .er-title').boundingBox();
  await p2.mouse.move(box.x + 10, box.y + 5);
  await p2.mouse.down();
  await p2.mouse.move(box.x - 150, box.y + 60, { steps: 6 });
  await p2.mouse.up();
  assert.equal(await p2.evaluate(() => JhMap.api.selected()), null, 'ドラッグは選択にならない');
  await p2.click('.dg-zoombtn[title="全体を表示"]');
  await p2.evaluate(() => window.Deck.settled(4000));
  assert.equal(await width(), w0);
  assert.equal(await p2.evaluate(() => document.querySelector('.dg-minimap').hidden), true);
  await p2.close();
});

test('目次: ☰ で目次ごと畳めて状態が残る。三角で枝を開閉でき、今いる階層の枝は自動で開く', async () => {
  const p2 = await browser.newPage({ viewport: { width: 1440, height: 860 } });
  await p2.goto(URL_);
  await p2.waitForFunction(() => document.documentElement.classList.contains('map-ready'));
  const tocWidth = () => p2.evaluate(() => document.querySelector('.jh-map-toc').getBoundingClientRect().width);
  assert.ok((await tocWidth()) > 200);
  await p2.click('.jh-map-toc-toggle');
  await p2.waitForTimeout(300);
  assert.ok((await tocWidth()) < 1, '畳むと図が横いっぱいになる');
  await p2.reload();
  await p2.waitForFunction(() => document.documentElement.classList.contains('map-ready'));
  assert.ok((await tocWidth()) < 1, '畳んだ状態は再読み込みしても残る');
  await p2.click('.jh-map-toc-toggle');
  await p2.waitForTimeout(300);
  assert.ok((await tocWidth()) > 200);

  const visible = (id) => p2.evaluate((i) => !document.querySelector(`.jh-toc-item[data-id="${i}"]`).closest('li').hidden, id);
  const twisty = (id) => p2.locator(`li:has(> .jh-toc-item[data-id="${id}"]) > .jh-toc-twisty`);
  await twisty('order').click();
  assert.equal(await visible('order.api'), false, '枝を閉じると子が隠れる');
  assert.equal(await visible('order.api.check'), false, '孫も隠れる');
  assert.equal(await twisty('order').getAttribute('aria-expanded'), 'false');
  await p2.evaluate(() => JhMap.api.reveal('order.api.check'));
  await p2.evaluate(() => window.Deck.settled(4000));
  assert.equal(await visible('order.api.check'), true, '選んだノードの枝は自動で開く');
  await p2.click('.jh-toc-tool >> text=すべて閉じる');
  assert.equal(await visible('order'), true, '一番上の階層は常に見える');
  assert.equal(await visible('order.api.check'), true, '今いる階層の枝は開いたまま');
  assert.equal(await visible('stock.db.stocks'), false);
  await p2.click('.jh-toc-tool >> text=すべて開く');
  assert.equal(await visible('stock.db.stocks'), true);
  await p2.evaluate(() => localStorage.clear());
  await p2.close();
});

test('目次: ノードが多いと、一番上の階層の箱の子までを開き、深い枝は閉じておく', async () => {
  const nodes = Array.from({ length: 6 }, (_, i) => ({ id: 's' + i, label: 'システム ' + i, children: { nodes:
    Array.from({ length: 4 }, (_, j) => ({ id: `s${i}.m${j}`, label: `機能 ${i}-${j}`, children: { nodes:
      [{ id: `s${i}.m${j}.a`, label: '部品 A' }, { id: `s${i}.m${j}.b`, label: '部品 B' }] } })) } }));
  const file = path.join(ROOT, 'dist', 'test-toc.html');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buildMap({ title: 'toc', map: { nodes } }, {}));
  const p2 = await browser.newPage({ viewport: { width: 1440, height: 860 } });
  await p2.goto(pathToFileURL(file).href);
  await p2.waitForFunction(() => document.documentElement.classList.contains('map-ready'));
  const shown = await p2.evaluate(() => [...document.querySelectorAll('.jh-map-toc li:not([hidden]) .jh-toc-item')].map((b) => b.getAttribute('data-id')));
  await p2.close();
  fs.rmSync(file);
  assert.ok(shown.includes('s0.m0'), '一番上の階層の箱の子は見える');
  assert.ok(!shown.includes('s0.m0.a'), 'それより深い枝は閉じる');
});

test('テーマ: 埋め込んだ候補から選べて、選択が残る (?theme= でも指定できる)', async () => {
  const p2 = await browser.newPage({ viewport: { width: 1440, height: 860 } });
  await p2.goto(URL_);
  await p2.waitForFunction(() => document.documentElement.classList.contains('map-ready'));
  const opts = await p2.evaluate(() => [...document.querySelectorAll('.jh-map-theme option')].map((o) => o.value));
  assert.deepEqual(opts.sort(), ['corporate', 'dark', 'default', 'mono', 'pop']);
  const bg = () => p2.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const light = await bg();
  await p2.selectOption('.jh-map-theme', 'dark');
  assert.equal(await bg(), 'rgb(15, 19, 28)', 'dark の背景');
  await p2.reload();
  await p2.waitForFunction(() => document.documentElement.classList.contains('map-ready'));
  assert.equal(await bg(), 'rgb(15, 19, 28)', '選んだテーマは再読み込みしても残る');
  assert.equal(await p2.inputValue('.jh-map-theme'), 'dark');
  assert.deepEqual(await p2.evaluate(() => window.Deck.audit()), [], 'dark でも検査は空');
  await p2.selectOption('.jh-map-theme', 'default');
  assert.equal(await bg(), light);
  await p2.goto(URL_ + '?theme=pop');
  await p2.waitForFunction(() => document.documentElement.classList.contains('map-ready'));
  assert.equal(await p2.inputValue('.jh-map-theme'), 'pop');
  await p2.evaluate(() => localStorage.clear());
  await p2.close();
});

test('印刷 (通常の画面・Ctrl+P): 印刷の間だけ階層ごとのページになり、終わると元の階層に戻る', async () => {
  const p2 = await browser.newPage({ viewport: { width: 1440, height: 860 } });
  await p2.goto(URL_ + '#/order.api');
  await p2.waitForFunction(() => document.documentElement.classList.contains('map-ready'));
  await p2.evaluate(() => window.Deck.settled(4000));
  const during = await p2.evaluate(() => {
    window.dispatchEvent(new Event('beforeprint'));
    return {
      pages: document.querySelectorAll('.jh-print-page').length,
      hints: [...document.querySelectorAll('.jh-print-page text.dg-hint')].map((t) => t.textContent),
      hash: location.hash,
    };
  });
  assert.equal(during.pages, 7);
  assert.ok(during.hints.length && during.hints.every((t) => t === '中身は後のページ'), '紙では「中身は後のページ」');
  assert.equal(during.hash, '#/order.api', '印刷のための描き直しで URL は変わらない');
  const after_ = await p2.evaluate(() => {
    window.dispatchEvent(new Event('afterprint'));
    return { pages: document.querySelectorAll('.jh-print-page').length, level: JhMap.api.level(), cls: document.body.classList.contains('jh-map-printing') };
  });
  assert.deepEqual(after_, { pages: 0, level: 'order.api', cls: false });
  // PDF (Chrome の印刷) でも階層ごとのページになる
  const pdf = await p2.pdf({ preferCSSPageSize: true });
  assert.ok((pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length >= 7);
  await p2.close();
});

test('階層に入る動き: 動きを減らす設定では、カメラを動かさずに切り替える', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 860 }, reducedMotion: 'reduce' });
  const p2 = await ctx.newPage();
  await p2.goto(URL_);
  await p2.waitForFunction(() => document.documentElement.classList.contains('map-ready'));
  const t = await p2.evaluate(() => {
    document.querySelector('.jh-toc-item[data-id="order"]').click();
    return { level: JhMap.api.level(), leaving: document.querySelector('.jh-map-stage .dg').classList.contains('dg-leaving') };
  });
  await ctx.close();
  assert.deepEqual(t, { level: 'order', leaving: false }, 'カメラが寄るのを待たずに、すぐ中の図に切り替わる');
});

async function openMap(map) {
  const file = path.join(ROOT, 'dist', 'test-layout.html');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buildMap({ title: 'layout', map }, {}));
  const p2 = await browser.newPage({ viewport: { width: 1440, height: 860 } });
  await p2.goto(pathToFileURL(file).href);
  await p2.waitForFunction(() => document.documentElement.classList.contains('map-ready'));
  return { p2, done: async () => { await p2.close(); fs.rmSync(file); } };
}
const col = (n) => Array.from({ length: 5 }, (_, i) => ({ id: n + i, label: n.toUpperCase() + i }));

test('自動配置: 書いた順のままだと矢印が交差するときは、列の中の並びを変えて交差を減らす', async () => {
  const edges = Array.from({ length: 5 }, (_, i) => ({ from: 'a' + i, to: 'b' + (4 - i) })); // 書いた順のままだと全部交差する
  const { p2, done } = await openMap({ nodes: [...col('a'), ...col('b')], edges });
  const y = await p2.evaluate(() => Object.fromEntries([...document.querySelectorAll('.jh-map-stage .dg-node[data-id]')]
    .map((g) => [g.getAttribute('data-id'), g.querySelector('.dg-shape').getBoundingClientRect().top])));
  await done();
  // 2 本の矢印 (a_i → b_4-i) が交差するのは、左の上下と右の上下が逆のとき
  let crossings = 0;
  for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) if ((y['a' + i] - y['a' + j]) * (y['b' + (4 - i)] - y['b' + (4 - j)]) < 0) crossings++;
  assert.equal(crossings, 0);
});

test('混み合う矢印: ラベルは箱・他のラベルと重ならない位置に置き、置けないものは隠して触れたときに出す', async () => {
  const edges = [];
  for (let i = 0; i < 5; i++) for (let k = 0; k < 5; k++) edges.push({ from: 'a' + i, to: 'b' + ((i + k * 2) % 5), label: '少し長めのラベル ' + i + '-' + k });
  const { p2, done } = await openMap({ nodes: [...col('a'), ...col('b')], edges });
  const st = await p2.evaluate(() => ({
    labels: document.querySelectorAll('.jh-map-stage .dg-edge-label').length,
    crowded: document.querySelectorAll('.jh-map-stage .dg-edge-label.is-crowded').length,
    issues: window.Deck.audit(),
  }));
  if (st.crowded) {
    st.shownOnHover = await p2.evaluate(() => { // 強調 (流れ・クリック) したときに出る
      const t = document.querySelector('.jh-map-stage .dg-edge-label.is-crowded');
      t.closest('.dg-edge').classList.add('is-focus');
      return getComputedStyle(t).display !== 'none';
    });
  }
  await done();
  assert.equal(st.labels, 25);
  assert.deepEqual(st.issues, [], 'ラベル同士・箱と重ならない');
  assert.ok(st.crowded > 0, '混み合うときは一部のラベルを隠す');
  assert.ok(st.shownOnHover, '隠したラベルは強調すると出る');
});

test('自動配置: 1 つの箱に多くの箱がつながる形 (親テーブルと子テーブル 9 つ) は、縦 1 列ではなく複数列に折り返す', async () => {
  const tables = Array.from({ length: 10 }, (_, i) => ({ id: 'db.t' + i, label: 't' + i, kind: 'table', columns: ['id PK bigint', ...(i ? ['parent_id FK bigint'] : []), 'name varchar'] }));
  const relations = tables.slice(1).map((t) => ({ from: t.id + '.parent_id', to: 'db.t0.id', card: 'N:1' }));
  const { p2, done } = await openMap({ nodes: [{ id: 'db', label: 'DB', kind: 'db', children: { nodes: tables, relations } }], drill: true });
  const st = await p2.evaluate(async () => {
    JhMap.api.reveal('db');
    await window.Deck.settled(4000);
    const xs = new Set([...document.querySelectorAll('.jh-map-stage .er-table[data-id^="db.t"]')].filter((g) => g.getAttribute('data-id') !== 'db.t0')
      .map((g) => g.querySelector('.dg-shape').getAttribute('x')));
    const box = document.querySelector('.jh-map-stage .dg-nodes').getBBox();
    return { columns: xs.size, ratio: box.height / box.width, issues: window.Deck.audit() };
  });
  await done();
  assert.ok(st.columns >= 2, '子テーブルが複数列に並ぶ (' + st.columns + ' 列)');
  assert.ok(st.ratio < 1.2, '細長くならない (縦 / 横 = ' + st.ratio.toFixed(2) + ')');
  assert.deepEqual(st.issues, []);
});
