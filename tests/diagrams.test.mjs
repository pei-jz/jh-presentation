// 図の部品 (components/diagrams.js) のテスト: 見本デッキの各スライドを実際に操作する
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
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

test('階層マップ: 深い矢印は上の階層で集約され、中に入ると外のつながりが端に出る。パンくず・Backspace で戻る', async () => {
  const view = () => q(() => {
    const c = document.querySelector('#dg-drill .dg');
    return {
      level: c.getAttribute('data-level'),
      nodes: [...c.querySelectorAll('.dg-nodes > .dg-node')].map((g) => g.getAttribute('data-id') + (g.classList.contains('is-boundary') ? '*' : '')).sort(),
      edges: [...c.querySelectorAll('.dg-edges > .dg-edge')].map((g) => g.querySelector('.dg-edge-label')?.textContent || '').sort(),
      crumbs: c.querySelector('.dg-crumbs').hidden ? '' : c.querySelector('.dg-crumbs').textContent,
    };
  });
  const settle = () => page.evaluate(() => window.Deck.settled(4000));

  await goto('dg-drill', 0);
  assert.deepEqual(await view(), {
    level: '', crumbs: '',
    nodes: ['order', 'payext', 'stock', 'user', 'web'],
    edges: ['', '引当', '決済', '注文'], // 注文 API の中の矢印が「注文システム → 在庫システム」などにまとまる
  });

  await page.click('#dg-drill .dg-node[data-id="order"]');
  await settle();
  const inside = await view();
  assert.equal(inside.level, 'order');
  assert.equal(inside.crumbs, 'EC サイト›注文システム');
  assert.deepEqual(inside.nodes, ['order.api', 'order.db', 'order.mq', 'order.pay', 'payext*', 'stock*', 'web*'], '外のつながりは境界ノード (*) になる');

  // 集約していない 1 本の矢印のクリックで、元の矢印の一覧
  await page.evaluate(() => {
    const g = [...document.querySelectorAll('#dg-drill .dg-edge')].find((e) => e.querySelector('.dg-edge-label')?.textContent === '引当');
    g.querySelector('.dg-edge-hit').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  assert.equal(await q(() => document.querySelector('#dg-drill .dg-panel-title').textContent), '注文 API → 在庫システム');
  assert.ok((await q(() => document.querySelector('#dg-drill .dg-panel-body').textContent)).includes('在庫の引当 → 在庫 API'));
  await page.keyboard.press('Escape');
  assert.equal(await q(() => document.querySelector('#dg-drill .dg-panel').hidden), true, 'Esc は先にパネルを閉じる');

  await page.click('#dg-drill .dg-node[data-id="order.api"]');
  await settle();
  assert.equal((await view()).crumbs, 'EC サイト›注文システム›注文 API');

  await page.click('#dg-drill .dg-crumb >> text=EC サイト');
  await settle();
  assert.equal((await view()).level, '', 'パンくずで全体へ戻る');

  // steps の at で深い階層へ入り、Backspace で 1 つ上へ (スライドは戻らない)
  await goto('dg-drill', 2);
  await settle();
  const deep = await view();
  assert.equal(deep.level, 'order.api');
  assert.deepEqual(deep.nodes, ['order.api.check', 'order.api.reserve', 'order.api.save', 'order.db*', 'order.mq*', 'order.pay*', 'stock*', 'web*']);
  assert.equal(await q(() => document.querySelectorAll('#dg-drill .dg-edge.is-flowing').length), 1);
  await page.keyboard.press('Backspace');
  await settle();
  assert.deepEqual(await q(() => [window.Deck.slides[window.Deck.index].id, document.querySelector('#dg-drill .dg').getAttribute('data-level')]), ['dg-drill', 'order']);

  // 境界ノードのクリックで、そのノードが見える階層へ移る
  await page.click('#dg-drill .dg-node[data-id="stock"]');
  await settle();
  assert.equal((await view()).level, '');
});

test('データの流れ: 階層をまたいで強調され、▶ で 1 区間ずつ追うと階層を自動で移る', async () => {
  const settle = () => page.evaluate(() => window.Deck.settled(4000));
  const state = () => q(() => {
    const c = document.querySelector('#dg-drill .dg');
    const lab = (g) => g.querySelector('.dg-edge-label')?.textContent || '';
    return {
      level: c.getAttribute('data-level'),
      flowing: [...c.querySelectorAll('.dg-edge.is-flowing')].map(lab).sort(),
      current: [...c.querySelectorAll('.dg-edge.is-current')].map(lab),
      reversed: [...c.querySelectorAll('.dg-edge.is-flowing')].filter((g) => g.querySelector('animateMotion').getAttribute('keyPoints') === '1;0').map(lab),
      caption: c.querySelector('.dg-caption').hidden ? '' : c.querySelector('.dg-caption').textContent,
    };
  });

  // steps の flow + upto: 5 区間目 (在庫 API → 在庫の引当 = 戻り) が見える階層へ自動で入る
  await goto('dg-drill', 3);
  await settle();
  const st = await state();
  assert.equal(st.level, 'order.api');
  assert.deepEqual(st.current, ['引当']);
  assert.deepEqual(st.reversed, ['引当'], '戻りのデータは点が逆向きに流れる');

  // 全体で「流れ」ボタンから選ぶと、集約した矢印に沿って流れ全体が光る
  await goto('dg-drill', 0);
  await settle();
  await page.click('#dg-drill .dg-flow-pick');
  await page.click('#dg-drill .dg-flowmenu-item[data-flow="order"]');
  const all = await state();
  assert.deepEqual(all.flowing, ['', '引当', '注文']);
  assert.equal(all.caption, '注文の流れ: 画面から DB に保存されるまで');

  // ▶ を 3 回: 3 区間目 (入力チェック → 在庫の引当) は注文 API の中で見える
  for (let i = 0; i < 3; i++) { await page.click('#dg-drill .dg-flow-next'); await settle(); }
  const third = await state();
  assert.equal(third.level, 'order.api');
  assert.equal(third.caption, '注文の流れ 3/7');
  assert.equal(third.current.length, 1);

  // ▶ で次の区間 (在庫 API へ) → 送り手の階層のまま、境界の在庫システムへの矢印が「今」になる
  await page.click('#dg-drill .dg-flow-next');
  await settle();
  assert.deepEqual((await state()).current, ['引当']);

  // Esc は流れの強調を先にやめる (階層はそのまま)
  await page.keyboard.press('Escape');
  const stopped = await state();
  assert.equal(stopped.level, 'order.api');
  assert.equal(await q(() => document.querySelector('#dg-drill .dg-flowui').classList.contains('is-on')), false);
});

test('図のデータの誤り (流れの途切れ・存在しない id) は Deck.audit() の data で報告する', async () => {
  assert.deepEqual(await q(() => window.Deck.audit().filter((i) => i.type === 'data')), [], '見本デッキにはデータの誤りがない');

  // 誤りのある図を 1 枚足したデッキを開く
  const bad = '<section class="slide" id="bad"><div class="diagram"><script type="application/json">' + JSON.stringify({
    nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }],
    edges: [{ from: 'a', to: 'zz' }, { from: 'a', to: 'b' }],
    flows: [{ id: 'f', label: '流れ', path: ['a', 'b', 'c'] }],
  }) + '</script></div></section>';
  const file = path.join(os.tmpdir(), 'jh-diagram-bad.html');
  fs.writeFileSync(file, fs.readFileSync(fileURLToPath(SAMPLE), 'utf8').replace('<!-- jh:slides -->', '<!-- jh:slides -->' + bad));
  const p2 = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await p2.goto(pathToFileURL(file).href);
  await p2.waitForFunction(() => document.documentElement.classList.contains('deck-ready'));
  const issues = await p2.evaluate(() => window.Deck.audit().filter((i) => i.type === 'data').map((i) => [i.slide, i.message]));
  await p2.close();
  assert.deepEqual(issues, [
    [1, '矢印の端のノードがありません: a -> zz'],
    [1, '流れ「流れ」の b → c に矢印がありません (edges に書く)'],
  ]);
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

test('状態遷移図: ボタンで遷移し、中に状態を持つ状態へは中の初期状態に入る。外側の遷移は中からも使える', async () => {
  const sim = () => q(() => document.querySelector('#dg-state .dg').jhDiagram.simState());
  await goto('dg-state', 0);
  assert.deepEqual(await sim(), { cur: 'cart', events: ['注文する'], history: [] });
  assert.ok(await q(() => !!document.querySelector('#dg-state .dg-state-start')), '初期状態に黒丸');
  assert.equal(await q(() => document.querySelectorAll('#dg-state .dg-state-final').length), 2, '終了状態は二重枠');

  await page.click('#dg-state .dg-sim-btn >> text=注文する');
  await page.evaluate(() => window.Deck.settled(4000));
  const s1 = await sim();
  assert.equal(s1.cur, 'ordered.unpaid');
  assert.deepEqual(s1.events.sort(), ['取り消す', '支払う']);
  assert.equal(await q(() => document.querySelector('#dg-state .dg').getAttribute('data-level')), 'ordered');
  assert.ok(await q(() => document.querySelector('#dg-state .dg-node[data-id="ordered.unpaid"]').classList.contains('is-current')));

  await page.click('#dg-state .dg-sim-btn >> text=取り消す');
  await page.evaluate(() => window.Deck.settled(4000));
  const s2 = await sim();
  assert.equal(s2.cur, 'canceled');
  assert.deepEqual(s2.events, []);
  assert.equal(await q(() => document.querySelector('#dg-state .dg-sim-end').textContent), '終了');

  await goto('dg-state', 1); // steps の state でその状態から始める
  assert.equal((await sim()).cur, 'ordered.paid');
});

test('状態遷移図の検査: 初期状態がない・到達できない・行き止まりの状態を data で報告する', async () => {
  const check = async (data) => {
    const bad = '<section class="slide"><div class="diagram"><script type="application/json">' + JSON.stringify(data) + '</script></div></section>';
    const file = path.join(os.tmpdir(), 'jh-state-bad.html');
    fs.writeFileSync(file, fs.readFileSync(fileURLToPath(SAMPLE), 'utf8').replace('<!-- jh:slides -->', '<!-- jh:slides -->' + bad));
    const p2 = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await p2.goto(pathToFileURL(file).href);
    await p2.waitForFunction(() => document.documentElement.classList.contains('deck-ready'));
    const issues = await p2.evaluate(() => window.Deck.audit().filter((i) => i.type === 'data' && i.slide === 1).map((i) => i.message));
    await p2.close();
    return issues;
  };
  assert.deepEqual(await check({ nodes: [{ id: 'a', label: 'A', kind: 'state' }] }), ['初期状態 (initial: true) がありません']);
  assert.deepEqual(await check({
    nodes: [
      { id: 'a', label: 'A', kind: 'state', initial: true },
      { id: 'b', label: 'B', kind: 'state' },
      { id: 'c', label: 'C', kind: 'state', final: true },
      { id: 'x', label: 'X', kind: 'state', final: true },
    ],
    edges: [{ from: 'a', to: 'b', label: 'go' }, { from: 'x', to: 'c', label: 'z' }],
  }), ['出ていく遷移がない状態があります (終了状態なら final: true): B (b)', '到達できない状態があります: C (c)', '到達できない状態があります: X (x)']);
});
