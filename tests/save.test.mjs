// 保存まわりのテスト
//   - Ctrl+S でブラウザ標準の保存 (表示中の状態を書き出してデッキを壊す) が走らない
//   - ローカルサーバー経由で開いたデッキは、Ctrl+S で元のファイルに直接保存される
//   - ブラウザ保存で壊れたファイルを復旧できる
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { findBrowser } from '../tools/lib/browser.mjs';
import { buildDeck, loadBrand, parseDeck } from '../tools/lib/deckfile.mjs';
import { extractFromSavedPage, closeBrowser } from '../mcp/render.mjs';
import '../engine/deck-edit.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E = globalThis.JhDeckEdit;
const ctx = { themeDirs: [], brandData: loadBrand(path.join(ROOT, 'brand')) };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-save-'));

const SLIDES = `<section class="slide layout-title no-chrome" id="cover"><h1 class="anim-fade-up">保存テスト</h1><div class="subtitle">サブ</div></section>
<section class="slide" id="body"><h2>本文</h2>
  <ul class="anim-stagger"><li class="step">一つ目</li><li class="step">二つ目</li></ul>
  <div class="stat"><div class="stat-value"><span data-count-to="1200">1,200</span></div><div class="stat-label">件数</div></div>
  <pre class="code"><code class="hl" data-lang="js" data-emph="1|2">
    const a = 1 &lt; 2;
    console.log(a);
  </code></pre>
  <svg viewBox="0 0 100 20"><path class="anim-draw" d="M0 10 H100" stroke="black"></path></svg>
</section>`;

let browser;
before(async () => { browser = await chromium.launch({ executablePath: findBrowser(), headless: true }); });
after(async () => { await browser?.close(); await closeBrowser(); });

test('Ctrl+S は編集していなくてもブラウザ標準の保存を止める', async () => {
  const file = path.join(tmp, 'k.html');
  fs.writeFileSync(file, buildDeck({ title: 'K', slides: SLIDES }, ctx));
  const page = await browser.newPage();
  await page.goto(pathToFileURL(file).href);
  await page.waitForFunction(() => document.documentElement.classList.contains('deck-ready'));
  const prevented = await page.evaluate(() => {
    const ev = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  await page.close();
  assert.equal(prevented, true);
});

test('ブラウザ保存で壊れたファイルから元の内容を復旧できる', async () => {
  const file = path.join(tmp, 'b.html');
  const original = buildDeck({ title: 'B', theme: 'mono', slides: SLIDES, css: '#body h2 { color: red; }', js: "Deck.onSlide('body', {});" }, ctx);
  fs.writeFileSync(file, original);
  // 表示 → 編集モード → 途中のステップ、の状態で「名前を付けて保存」したものを再現
  const page = await browser.newPage();
  await page.goto(pathToFileURL(file).href + '#2.1');
  await page.waitForFunction(() => document.documentElement.classList.contains('deck-ready'));
  await page.keyboard.press('e');
  const snapshot = '<!-- saved from url=(0020)file:///C:/x/b.html -->\n' + await page.content();
  await page.close();

  const parts = await extractFromSavedPage(snapshot);
  const repaired = buildDeck(parts, ctx);
  const a = parseDeck(original), b = parseDeck(repaired);
  assert.equal(b.slideCount, a.slideCount);
  assert.equal(b.theme, 'mono');
  assert.equal(b.css, a.css);
  assert.equal(b.js, a.js);
  // 編集できる要素の文字が一致
  const texts = (src) => E.sourceEditables(src).map((l) => l.map((n) => E.normText(src.slice(n.innerStart, n.innerEnd), true)));
  assert.deepEqual(texts(repaired), texts(original));
  // 表示時に付いたものが残っていない
  for (const junk of ['data-jh-edit', 'contenteditable', 'aria-hidden', 'class="line', ' active', 'visible', 'pathLength', '--i:']) {
    assert.ok(!b.slides.includes(junk), `残っている: ${junk}`);
  }
  assert.ok(b.slides.includes('const a = 1 &lt; 2;'), 'コードは元のテキストに戻る');
  assert.ok(b.slides.includes('<span data-count-to="1200">1,200</span>'), '数値は最終値');
});

test('ローカルサーバー経由で開くと、Ctrl+S で元のファイルに直接保存される', async () => {
  const name = `zz-save-test-${process.pid}`;
  const file = path.join(ROOT, 'decks', name + '.html');
  const histDir = path.join(ROOT, 'decks', '.history', name);
  fs.mkdirSync(path.dirname(file), { recursive: true }); // 新しくクローンした環境には decks/ がない
  fs.writeFileSync(file, buildDeck({ title: 'S', slides: SLIDES }, ctx));
  const port = 4790 + (process.pid % 100);
  const server = spawn(process.execPath, [path.join(ROOT, 'tools', 'serve.mjs'), String(port)], { stdio: 'pipe' });
  try {
    await new Promise((resolve, reject) => {
      server.stdout.on('data', (d) => { if (String(d).includes('Deck server')) resolve(); });
      server.on('exit', () => reject(new Error('サーバーが起動しませんでした')));
      setTimeout(() => reject(new Error('サーバーの起動待ちがタイムアウト')), 10000);
    });
    // トークンなしの保存は拒否
    const denied = await fetch(`http://127.0.0.1:${port}/__save`, { method: 'POST', body: '{}' });
    assert.equal(denied.status, 403);

    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/decks/${name}.html#2`);
    await page.waitForFunction(() => document.documentElement.classList.contains('deck-ready'));
    assert.ok(await page.evaluate(() => !!window.__JH_SAVE__), '保存先が埋め込まれている');
    await page.keyboard.press('e');
    await page.locator('[data-jh-edit="1:0"]').click();
    // End キーは macOS では行末へ移動しないので、カーソルを末尾に置く
    await page.evaluate(() => {
      const r = document.createRange();
      r.selectNodeContents(document.activeElement);
      r.collapse(false);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
    });
    await page.keyboard.type('（直接保存）');
    await page.keyboard.press('Enter');
    await page.keyboard.press('ControlOrMeta+s');
    await page.waitForFunction(() => (document.querySelector('.deck-toast') || {}).textContent?.includes('保存しました'), null, { timeout: 5000 })
      .catch(async (e) => { throw new Error(e.message + ' / toast: ' + await page.evaluate(() => document.querySelector('.deck-toast')?.textContent)); });
    // 編集ルールの版が違う (古いエンジンの) デッキからの保存は拒否する
    const cfg = await page.evaluate(() => window.__JH_SAVE__);
    const old = await fetch(`http://127.0.0.1:${port}/__save`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-JH-Token': cfg.token },
      body: JSON.stringify({ file: cfg.file, protocol: 1, changes: [{ slide: 1, index: 0, html: 'x', before: '本文（直接保存）' }] }),
    });
    assert.equal(old.status, 409);
    assert.match((await old.json()).error, /upgrade/);
    await page.close();

    const saved = fs.readFileSync(file, 'utf8');
    assert.ok(saved.includes('<h2>本文（直接保存）</h2>'), 'ファイルに反映');
    assert.equal(parseDeck(saved).slideCount, 2);
    assert.ok(fs.existsSync(histDir) && fs.readdirSync(histDir).length === 1, '保存前の版が履歴に残る');
  } finally {
    server.kill();
    fs.rmSync(file, { force: true });
    fs.rmSync(histDir, { recursive: true, force: true });
  }
});

test('デッキには埋め込んだエンジン・部品・テーマのライセンス表記が入る', () => {
  const html = buildDeck({ title: 'L', slides: SLIDES }, ctx);
  for (const s of ['released under the MIT License', 'Copyright (c) 2026 pei-jz', 'Permission is hereby granted']) {
    assert.ok(html.includes(s), s);
  }
  assert.equal(parseDeck(html).slideCount, 2);
});
