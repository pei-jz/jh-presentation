// 全画面のテスト
//   A. open_deck の fullscreen: Chrome / Edge を全画面のアプリウィンドウで起動する引数
//   B. 発表モード: 最初の操作で全画面 (data-auto-fullscreen / ?fullscreen)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { findBrowser, fullscreenArgs } from '../tools/lib/browser.mjs';
import { buildDeck, parseDeck, rebuildDeck, loadBrand } from '../tools/lib/deckfile.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ctx = { themeDirs: [], brandData: loadBrand(path.join(ROOT, 'brand')) };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-fs-'));
const SLIDES = '<section class="slide"><h2>1</h2></section><section class="slide"><h2>2</h2></section><section class="slide"><h2>3</h2></section>';

let browser;
before(async () => { browser = await chromium.launch({ executablePath: findBrowser(), headless: true }); });
after(async () => { await browser?.close(); });

test('A. 全画面で起動する引数 (アプリウィンドウ + 全画面 + 発表用プロファイル、キオスクは使わない)', () => {
  const args = fullscreenArgs('http://127.0.0.1:1234/a.html', 'C:/tmp/profile');
  assert.ok(args.includes('--app=http://127.0.0.1:1234/a.html'));
  assert.ok(args.includes('--start-fullscreen'));
  assert.ok(args.includes('--user-data-dir=C:/tmp/profile'));
  assert.ok(!args.some((a) => a.startsWith('--kiosk')));
});

test('B. 発表モードの設定はデッキに保存され、書き込みでも維持される', () => {
  const on = buildDeck({ title: 'F', slides: SLIDES, autoFullscreen: true }, ctx);
  assert.equal(parseDeck(on).autoFullscreen, true);
  assert.equal(parseDeck(rebuildDeck(on, { title: '変更' }, ctx)).autoFullscreen, true);
  assert.equal(parseDeck(rebuildDeck(on, { autoFullscreen: false }, ctx)).autoFullscreen, false);
  assert.equal(parseDeck(buildDeck({ title: 'F', slides: SLIDES }, ctx)).autoFullscreen, false);
});

/** requestFullscreen の呼び出しを記録するページを開く (画面より小さいウィンドウ = 全画面ではない状態) */
async function open(deckOpts, query = '') {
  const file = path.join(tmp, `d-${Math.random().toString(36).slice(2)}.html`);
  fs.writeFileSync(file, buildDeck({ title: 'F', slides: SLIDES, ...deckOpts }, ctx));
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, screen: { width: 1920, height: 1080 } });
  await context.addInitScript(() => {
    window.__fs = 0;
    Element.prototype.requestFullscreen = function () { window.__fs++; return Promise.resolve(); };
  });
  const page = await context.newPage();
  await page.goto(pathToFileURL(file).href + query);
  await page.waitForFunction(() => document.documentElement.classList.contains('deck-ready'));
  return { page, context };
}

test('B. 発表モードでは最初の → キーで 1 回だけ全画面にする', async () => {
  const { page, context } = await open({ autoFullscreen: true });
  assert.equal(await page.evaluate(() => window.__fs), 0, '開いただけでは全画面にしない');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => [window.__fs, window.Deck.index].join()), '1,1', '最初の操作で全画面 + スライドも進む');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => window.__fs), 1, '2 回目以降は全画面にしない');
  await context.close();
});

test('B. 最初のクリックでも全画面になり、設定がなければ何もしない', async () => {
  let { page, context } = await open({ autoFullscreen: true });
  await page.mouse.click(640, 360);
  assert.equal(await page.evaluate(() => window.__fs), 1);
  await context.close();

  ({ page, context } = await open({}));
  await page.keyboard.press('ArrowRight');
  await page.mouse.click(640, 360);
  assert.equal(await page.evaluate(() => window.__fs), 0);
  await context.close();
});

test('B. URL に ?fullscreen を付けると、その回だけ発表モードになる', async () => {
  const { page, context } = await open({}, '?fullscreen');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => window.__fs), 1);
  await context.close();
});
