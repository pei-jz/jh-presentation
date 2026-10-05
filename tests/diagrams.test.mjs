// 図の部品 (components/diagrams.js) のテスト: 見本デッキの各スライドを実際に操作する
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { findBrowser } from '../tools/lib/browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE = pathToFileURL(path.join(ROOT, 'examples', 'sample.html')).href;
let browser, page;

before(async () => {
  browser = await chromium.launch({ executablePath: findBrowser(), headless: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(SAMPLE);
  await page.waitForFunction(() => document.documentElement.classList.contains('deck-ready'));
});
after(async () => { await browser?.close(); });

/** スライド id へ移動し、表示が落ち着くまで待つ */
async function goto(id, step = 0) {
  await page.evaluate(async ([id, step]) => {
    window.Deck.goto(window.Deck.slides.findIndex((s) => s.id === id), step);
    await window.Deck.settled(4000);
  }, [id, step]);
}
const q = (fn, arg) => page.evaluate(fn, arg);

test('関連図: ステップで経路が強調され、ノードのクリックで詳細、Esc で戻る', async () => {
  const steps = await q(() => window.Deck.slides.find((s) => s.id === 'dg-flow')._steps.length);
  assert.equal(steps, 3, 'steps[1..3] が → キーのステップになる');

  await goto('dg-flow', 1);
  const s1 = await q(() => {
    const c = document.querySelector('#dg-flow .dg');
    const focus = [...c.querySelectorAll('.dg-node.is-focus')].map((g) => g.getAttribute('data-id'));
    const flowing = c.querySelectorAll('.dg-edge.is-flowing').length;
    return { focus, flowing, caption: c.querySelector('.dg-caption').textContent, hasFocus: c.classList.contains('has-focus') };
  });
  assert.deepEqual(s1.focus.sort(), ['api', 'user', 'web']);
  assert.equal(s1.flowing, 2);
  assert.ok(s1.caption.includes('利用者が注文を送信'));

  await page.click('#dg-flow .dg-node[data-id="stock"]');
  const opened = await q(() => {
    const p = document.querySelector('#dg-flow .dg-panel');
    return { visible: !p.hidden, title: p.querySelector('.dg-panel-title').textContent };
  });
  assert.deepEqual(opened, { visible: true, title: '在庫サービス' });

  await page.keyboard.press('Escape');
  const closed = await q(() => ({
    panel: document.querySelector('#dg-flow .dg-panel').hidden,
    overview: !!document.querySelector('.deck-overview'),
    caption: document.querySelector('#dg-flow .dg-caption').textContent,
  }));
  assert.deepEqual(closed, { panel: true, overview: false, caption: '① 利用者が注文を送信' }, 'Esc は図を閉じるだけで、一覧は開かない');
});

test('ズームマップ: クリックで中にズームし、中のノードも詳細を出せる。Esc で全体に戻る', async () => {
  await goto('dg-zoom', 0);
  const vb0 = await q(() => document.querySelector('#dg-zoom svg').getAttribute('viewBox'));
  await page.click('#dg-zoom .dg-node[data-id="order"] > .dg-shape');
  await page.evaluate(() => window.Deck.settled(4000));
  const zoomed = await q(() => {
    const svg = document.querySelector('#dg-zoom svg');
    return { vb: svg.getAttribute('viewBox'), open: !!svg.querySelector('.dg-node[data-id="order"].is-open') };
  });
  assert.ok(zoomed.open);
  assert.ok(Number(zoomed.vb.split(' ')[2]) < Number(vb0.split(' ')[2]) * 0.8, 'ズームして表示範囲が狭くなる');

  await page.click('#dg-zoom .dg-node[data-id="o-pay"] .dg-label');
  assert.equal(await q(() => document.querySelector('#dg-zoom .dg-panel-title').textContent), '決済連携');

  await page.keyboard.press('Escape');
  await page.evaluate(() => window.Deck.settled(4000));
  assert.equal(await q(() => document.querySelector('#dg-zoom svg').getAttribute('viewBox')), vb0);

  await goto('dg-zoom', 1); // steps の zoom でも中に入る
  assert.ok(await q(() => !!document.querySelector('#dg-zoom .dg-node[data-id="order"].is-open')));
});

test('ER 図: ステップでテーブルが増え、クリックで関連テーブルと結合キーが光る', async () => {
  await goto('dg-er', 0);
  const hidden0 = await q(() => [...document.querySelectorAll('#dg-er .er-table.is-hidden')].map((g) => g.getAttribute('data-id')).sort());
  assert.deepEqual(hidden0, ['order_items', 'products']);

  await goto('dg-er', 1);
  assert.equal(await q(() => document.querySelectorAll('#dg-er .er-table.is-hidden').length), 0);

  await page.click('#dg-er .er-table[data-id="orders"] .er-title');
  const sel = await q(() => ({
    focus: [...document.querySelectorAll('#dg-er .er-table.is-focus')].map((g) => g.getAttribute('data-id')).sort(),
    keys: [...document.querySelectorAll('#dg-er .er-row.is-key')].map((r) => r.closest('.er-table').getAttribute('data-id') + '.' + r.getAttribute('data-col')).sort(),
    panel: document.querySelector('#dg-er .dg-panel-title').textContent,
  }));
  assert.deepEqual(sel.focus, ['order_items', 'orders', 'users']);
  assert.deepEqual(sel.keys, ['order_items.order_id', 'orders.id', 'orders.user_id', 'users.id']);
  assert.equal(sel.panel, 'orders');
  await page.keyboard.press('Escape');
});

test('シーケンス図: メッセージが 1 本ずつ表示され、現在の 1 本が強調される', async () => {
  assert.equal(await q(() => window.Deck.slides.find((s) => s.id === 'dg-seq')._steps.length), 6);
  await goto('dg-seq', 2);
  const st = await q(() => {
    const msgs = [...document.querySelectorAll('#dg-seq .seq-msg')];
    return {
      visible: msgs.filter((m) => !m.classList.contains('is-hidden')).length,
      current: msgs.findIndex((m) => m.classList.contains('is-current')),
      caption: document.querySelector('#dg-seq .dg-caption').textContent,
    };
  });
  assert.deepEqual(st, { visible: 2, current: 1, caption: 'パスワードは API で保持しない' });
});

test('チャート: 凡例のクリックで系列を切り替え、ホバーで値を表示する', async () => {
  await goto('dg-chart', 0);
  await page.click('#dg-chart .chart-legend-item[data-s="1"]');
  assert.equal(await q(() => document.querySelector('#dg-chart .chart-series[data-s="1"]').classList.contains('is-off')), true);
  await page.click('#dg-chart .chart-legend-item[data-s="1"]');
  assert.equal(await q(() => document.querySelector('#dg-chart .chart-series[data-s="1"]').classList.contains('is-off')), false);

  await page.hover('#dg-chart .chart-series[data-s="0"] .chart-bar[data-p="0"] rect');
  const tip = await q(() => { const t = document.querySelector('#dg-chart .chart-tip'); return { visible: !t.hidden, text: t.textContent }; });
  assert.equal(tip.visible, true);
  assert.ok(tip.text.includes('4月') && tip.text.includes('42'));
});

test('3D 分解図: → キーで分解し、層のクリックで説明を出す', async () => {
  await goto('dg-3d', 0);
  assert.equal(await q(() => document.querySelector('#dg-3d .dg-stack').classList.contains('is-exploded')), false);
  await goto('dg-3d', 1);
  assert.equal(await q(() => document.querySelector('#dg-3d .dg-stack').classList.contains('is-exploded')), true);
  await page.click('#dg-3d .layer3d:nth-child(2)');
  const sel = await q(() => ({
    selected: document.querySelector('#dg-3d .layer3d.is-selected').textContent.trim(),
    panel: document.querySelector('#dg-3d .dg-panel-body').textContent,
  }));
  assert.deepEqual(sel, { selected: 'アプリケーション層', panel: 'ドメインのルールとトランザクション' });
});

test('印刷 (PDF) では全体を静止状態で表示する', async () => {
  const p = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await p.goto(SAMPLE + '?print');
  await p.waitForFunction(() => document.documentElement.classList.contains('deck-ready'));
  const st = await p.evaluate(() => ({
    erHidden: document.querySelectorAll('#dg-er .er-table.is-hidden').length,
    seqHidden: document.querySelectorAll('#dg-seq .seq-msg.is-hidden').length,
    flowing: document.querySelectorAll('#dg-flow .dg-edge.is-flowing').length,
    exploded: document.querySelector('#dg-3d .dg-stack').classList.contains('is-exploded'),
  }));
  await p.close();
  assert.deepEqual(st, { erHidden: 0, seqHidden: 0, flowing: 0, exploded: true });
});

test('ビフォー・アフター: → キーで改善後へスライドし、ドラッグで境界を動かせる', async () => {
  await goto('dg-compare', 0);
  const pos = () => q(() => document.querySelector('#dg-compare .dg-compare').style.getPropertyValue('--pos'));
  assert.equal(await pos(), '100%', 'data-reveal="step" は改善前から始まる');
  await goto('dg-compare', 1);
  assert.equal(await pos(), '0%', '→ キーで改善後へ');

  const box = await page.locator('#dg-compare .dg-compare').boundingBox();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2);
  await page.mouse.up();
  const p = parseFloat(await pos());
  assert.ok(p > 55 && p < 65, `ドラッグした位置 (${p}%)`);
  // ラベルは項目の外にあり、文字編集の対象に混ざらない
  assert.equal(await q(() => document.querySelectorAll('#dg-compare .compare-item .compare-label').length), 0);
});

test('ターミナル再生: → キーでコマンドを 1 つずつ入力して、出力まで表示する', async () => {
  assert.equal(await q(() => window.Deck.slides.find((s) => s.id === 'dg-term')._steps.length), 3);
  await goto('dg-term', 0);
  assert.equal(await q(() => document.querySelectorAll('#dg-term .term-line').length), 0);
  await page.evaluate(async () => { window.Deck.next(); await window.Deck.settled(8000); });
  const s1 = await q(() => [...document.querySelectorAll('#dg-term .term-line')].map((l) => l.textContent));
  assert.deepEqual(s1, ['$ npm run new -- git-flow "Git のブランチ戦略" --theme dark', '作成しました: decks/2026-10-05-git-flow.html']);
  await goto('dg-term', 3); // 直接移動では入力演出なしで全部表示
  assert.equal(await q(() => document.querySelectorAll('#dg-term .term-line.is-cmd').length), 3);
});
