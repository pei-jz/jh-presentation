// 階層マップの ER 図: DB の箱の中のテーブル (kind: "table")・列どうしの関連 (relations)・機能 → テーブルの読み書き
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { findBrowser } from '../tools/lib/browser.mjs';
import { buildMap } from '../tools/lib/mapfile.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE = pathToFileURL(path.join(ROOT, 'examples', 'sample-map.html')).href;
let browser, page;

before(async () => {
  browser = await chromium.launch({ executablePath: findBrowser(), headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
  await page.goto(SAMPLE);
  await page.waitForFunction(() => document.documentElement.classList.contains('map-ready'));
});
after(async () => { await browser?.close(); });

const q = (fn, arg) => page.evaluate(fn, arg);
const settle = () => page.evaluate(() => window.Deck.settled(4000));

test('DB の中に入ると、テーブルと列どうしの関連 (外部キー) が描かれ、外の機能は境界ノードになる', async () => {
  await q(() => JhMap.api.reveal('order.db'));
  await settle();
  const st = await q(() => {
    const c = document.querySelector('.jh-map-stage .dg');
    return {
      level: c.getAttribute('data-level'),
      tables: [...c.querySelectorAll('.dg-nodes > .er-table')].map((g) => g.getAttribute('data-id')).sort(),
      rels: c.querySelectorAll('.dg-edges > .er-rel').length,
      cards: c.querySelectorAll('.er-rel .er-card').length,
      boundary: [...c.querySelectorAll('.dg-node.is-boundary')].map((g) => g.getAttribute('data-id')).sort(),
      orderCols: [...c.querySelectorAll('.er-table[data-id="order.db.orders"] .er-row')].map((r) => r.getAttribute('data-col')),
    };
  });
  assert.equal(st.level, 'order.db');
  assert.deepEqual(st.tables, ['order.db.addresses', 'order.db.order_items', 'order.db.orders', 'order.db.users']);
  assert.equal(st.rels, 4, '関連は列ごとに 1 本ずつ (まとめない)');
  assert.equal(st.cards, 8, '両端に多重度の印');
  assert.deepEqual(st.boundary, ['front', 'order.api']);
  assert.deepEqual(st.orderCols, ['id', 'user_id', 'address_id', 'status', 'ordered_at']);
});

test('テーブルを選ぶと、結合に使う列の行が光り、詳細パネルに列の一覧と読み書きする機能・参照が出る', async () => {
  await page.click('.er-table[data-id="order.db.orders"] .er-title');
  const st = await q(() => {
    const c = document.querySelector('.jh-map-stage .dg');
    return {
      keys: [...c.querySelectorAll('.er-row.is-key')].map((r) => r.closest('.dg-node').getAttribute('data-id').split('.').pop() + '.' + r.getAttribute('data-col')).sort(),
      title: c.querySelector('.dg-panel-title').textContent,
      cols: c.querySelectorAll('.dg-panel .er-detail tr').length,
      links: [...c.querySelectorAll('.dg-links h4')].map((h) => h.textContent),
    };
  });
  assert.deepEqual(st.keys, ['addresses.id', 'order_items.order_id', 'orders.address_id', 'orders.id', 'orders.user_id', 'users.id']);
  assert.equal(st.title, 'orders');
  assert.equal(st.cols, 5);
  assert.deepEqual(st.links, ['書き込む機能 (1)', '読む機能 (1)', '参照している (外部キー) (2)', '参照されている (1)', '通る流れ']);
  await page.keyboard.press('Escape');
});

test('上の階層では、機能 → テーブルの読み書きが「機能 → DB」の矢印にまとまる', async () => {
  await q(() => JhMap.api.reveal('order'));
  await settle();
  const toDb = await q(() => {
    const c = document.querySelector('.jh-map-stage .dg');
    // 注文 API の中の 3 本 (確定 → orders / order_items / addresses) と、入力チェック → users
    return [...c.querySelectorAll('.dg-edge')].map((g) => g.querySelector('.dg-edge-count text')?.textContent).filter(Boolean);
  });
  assert.ok(toDb.includes('4'), '注文 API → 注文 DB は 4 本をまとめた 1 本');
});

test('検索は列名でもテーブルを見つける', async () => {
  await page.fill('.jh-map-search input', 'warehouse_id');
  const hits = await q(() => [...document.querySelectorAll('.jh-map-result')].map((b) => b.getAttribute('data-id')));
  assert.deepEqual(hits, ['stock.db.stocks']);
  await page.fill('.jh-map-search input', '');
});

test('関連の誤り (存在しない列) は data で報告し、列が多いテーブルは「ほか N 列」にまとめる', async () => {
  const columns = Array.from({ length: 14 }, (_, i) => (i === 0 ? 'id PK bigint' : `c${i} varchar`));
  const map = {
    nodes: [{ id: 'db', label: 'DB', kind: 'db', children: { nodes: [
      { id: 'db.a', label: 'a', kind: 'table', columns },
      { id: 'db.b', label: 'b', kind: 'table', columns: ['id PK bigint', 'a_id FK bigint'] },
    ], relations: [
      { from: 'db.b.a_id', to: 'db.a.id' },
      { from: 'db.b.nope', to: 'db.a.id' },
    ] } }],
  };
  const file = path.join(os.tmpdir(), 'jh-er-map.html');
  fs.writeFileSync(file, buildMap({ title: 'er', map }, {}));
  const p2 = await browser.newPage({ viewport: { width: 1440, height: 860 } });
  await p2.goto(pathToFileURL(file).href + '#/db');
  await p2.waitForFunction(() => document.documentElement.classList.contains('map-ready'));
  await p2.evaluate(() => window.Deck.settled(4000));
  const st = await p2.evaluate(() => ({
    data: window.Deck.audit().filter((i) => i.type === 'data').map((i) => i.message),
    more: document.querySelector('.er-table[data-id="db.a"] .er-more')?.textContent,
    rows: document.querySelectorAll('.er-table[data-id="db.a"] .er-row').length,
  }));
  await p2.close();
  fs.rmSync(file);
  assert.deepEqual(st.data, ['関連の端のテーブル・列がありません: db.b.nope -> db.a.id (テーブルの id.列名 で書く)']);
  assert.equal(st.rows, 9);
  assert.equal(st.more, 'ほか 5 列');
});
