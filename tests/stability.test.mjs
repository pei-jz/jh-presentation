// 安定化の回帰テスト (2026-10-02 のレビュー指摘 7 項目)
//   npm test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { findBrowser } from '../tools/lib/browser.mjs';
import { buildDeck, loadBrand, parseDeck } from '../tools/lib/deckfile.mjs';
import { buildGallery } from '../tools/lib/gallery.mjs';
import { readThemes } from '../tools/lib/themes.mjs';
import { resolveServedPath } from '../tools/lib/repo.mjs';
import {
  ensureWorkspace, createDeck, readDeck, writeDeck, replaceSlide, listHistory, restoreHistory,
} from '../mcp/workspace.mjs';
import { auditDeck, closeBrowser } from '../mcp/render.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ctx = { themeDirs: [], brandData: loadBrand(path.join(ROOT, 'brand')) };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-stability-'));
after(async () => { await closeBrowser(); });

function newWorkspace() {
  const ws = fs.mkdtempSync(path.join(tmp, 'ws-'));
  ensureWorkspace(ws);
  return ws;
}

function deckFile(slides, extra = {}) {
  const file = path.join(fs.mkdtempSync(path.join(tmp, 'deck-')), 'd.html');
  fs.writeFileSync(file, buildDeck({ title: 'T', slides, ...extra }, ctx));
  return file;
}

// ---------------------------------------------------------------------------
// 1. 差し替え・構造の検証・競合・履歴
// ---------------------------------------------------------------------------
test('1. replace_slide は class の引用符やスライド内の section に影響されない', () => {
  const ws = newWorkspace();
  const { name } = createDeck(ws, { name: 't1', title: 'T' });
  writeDeck(ws, name, {
    slides: `<section class='slide' id="a"><h2>A</h2></section>
<section class="slide" id="b"><h2>B</h2><section class="inner"><p>内側</p></section><p>続き</p></section>
<section class="slide" id="c"><h2>C</h2></section>`,
  });
  assert.equal(readDeck(ws, name).slideCount, 3);

  let d = replaceSlide(ws, name, 'b', '<section class="slide" id="b"><h2>B2</h2></section>');
  assert.equal(d.slideCount, 3);
  assert.ok(!d.slides.includes('内側') && !d.slides.includes('続き'), 'スライド全体が置き換わる');
  assert.ok(d.slides.includes('<h2>B2</h2>') && d.slides.includes('<h2>C</h2>'));

  d = replaceSlide(ws, name, 1, `<section class='slide' id="a"><h2>A2</h2></section>`);
  assert.ok(d.slides.includes('A2'));

  assert.throws(() => replaceSlide(ws, name, 'c', '<section class="slide"><h2>x</h2></section><p>外</p>'), /1 枚分/);
  assert.throws(() => writeDeck(ws, name, { slides: '<section class="slide" id="x"></section><section class="slide" id="x"></section>' }), /重複/);
  assert.throws(() => writeDeck(ws, name, { slides: '<section class="slide"></section><div>外</div>' }), /外に内容/);
});

test('1. revision が古いと保存しない・履歴から戻せる', () => {
  const ws = newWorkspace();
  const { name } = createDeck(ws, { name: 't2', title: 'T' });
  const r1 = readDeck(ws, name).revision;
  writeDeck(ws, name, { slides: '<section class="slide"><h2>v2</h2></section>' }, { revision: r1 });
  assert.throws(() => writeDeck(ws, name, { slides: '<section class="slide"><h2>v3</h2></section>' }, { revision: r1 }), /revision/);

  const hist = listHistory(ws, name);
  assert.ok(hist.length >= 1);
  const d = restoreHistory(ws, name, hist[0].id);
  assert.ok(!d.slides.includes('v2'), '保存前の版に戻る');
  assert.ok(listHistory(ws, name).length >= 2, '戻す前の版も履歴に残る');
});

// ---------------------------------------------------------------------------
// 2. 検査
// ---------------------------------------------------------------------------
test('2. audit は画像の欠落・文字の重なり・低コントラスト・外部通信を検出する', async () => {
  const file = deckFile(`<section class="slide" id="s">
  <h2>検査</h2>
  <img data-asset="nothing.png" alt="">
  <p style="position:absolute;left:200px;top:400px">重なる文字その一</p>
  <p style="position:absolute;left:210px;top:405px">重なる文字その二</p>
  <p style="color:#eeeeee">薄すぎる文字</p>
  <img src="https://example.com/x.png" alt="">
</section>`);
  const r = await auditDeck(file);
  assert.equal(r.ok, false);
  assert.ok(r.images.some((x) => x.type === 'asset' && x.asset === 'nothing.png'), '欠落した asset');
  assert.ok(r.overlap.length >= 1, '文字の重なり');
  assert.ok(r.contrast.some((x) => x.text.includes('薄すぎる')), 'コントラスト');
  assert.ok(r.externalRequests.some((u) => u.includes('example.com')), '外部通信');
  assert.ok(r.warnings.some((w) => w.includes('asset')), 'エンジンの警告');
});

test('2. 見本デッキと全テーマで誤検出しない', async () => {
  const { dir, themes } = buildGallery(path.join(tmp, 'gallery'), readThemes(path.join(ROOT, 'themes')), ctx);
  const files = [path.join(ROOT, 'examples', 'sample.html'), ...themes.map((t) => path.join(dir, t.name + '.html'))];
  for (const f of files) {
    const r = await auditDeck(f);
    assert.equal(r.ok, true, `${path.basename(f)}: ${JSON.stringify({ o: r.overflow, ov: r.overlap, c: r.contrast, i: r.images, s: r.smallText, e: r.errors, w: r.warnings, x: r.externalRequests })}`);
  }
});

// ---------------------------------------------------------------------------
// 3. 途中ステップへの直接移動 / 5. 描画完了の待機
// ---------------------------------------------------------------------------
async function openPage(file, hash = '') {
  const browser = await chromium.launch({ executablePath: findBrowser(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(pathToFileURL(file).href + hash);
  await page.waitForFunction(() => document.documentElement.classList.contains('deck-ready'));
  return { browser, page };
}

test('3. #2.2 で直接入っても step フックの表示がステップと一致する', async () => {
  const file = deckFile(`<section class="slide"><h2>1</h2></section>
<section class="slide" id="st"><h2>2</h2><p class="out">0</p><p class="step">a</p><p class="step">b</p></section>`, {
    js: "Deck.onSlide('st', { step(el, n) { el.querySelector('.out').textContent = String(n); } });",
  });
  const { browser, page } = await openPage(file, '#2.2');
  const shown = await page.evaluate(() => [window.Deck.step, document.querySelector('#st .out').textContent]);
  await browser.close();
  assert.deepEqual(shown, [2, '2']);
});

test('5. settled はタイプライターなどの演出の完了まで待つ', async () => {
  const text = 'これはタイプライターで表示される長めの文章です';
  const file = deckFile(`<section class="slide"><h2>1</h2></section>
<section class="slide"><h2>2</h2><p data-typewriter data-speed="40">${text}</p></section>`);
  const { browser, page } = await openPage(file);
  const result = await page.evaluate(async () => {
    window.Deck.goto(1, 0);
    const p = document.querySelectorAll('[data-typewriter]')[0];
    const early = p.textContent.length;
    await window.Deck.settled(8000);
    return { early, final: p.textContent };
  });
  await browser.close();
  assert.ok(result.early < text.length, '開始直後は途中');
  assert.equal(result.final, text, 'settled の後は全文');
});

// ---------------------------------------------------------------------------
// 4. 書き込みではエンジンを入れ替えない
// ---------------------------------------------------------------------------
test('4. write_deck は埋め込みエンジンを維持し、upgrade のときだけ入れ替える', () => {
  const ws = newWorkspace();
  const { name, file } = createDeck(ws, { name: 't4', title: 'T', theme: 'pop' });
  // 「古いエンジン」を模して目印を入れる
  const marked = fs.readFileSync(file, 'utf8')
    .replace('<!-- jh:engine-script -->\n<script>', '<!-- jh:engine-script -->\n<script>/*OLD-ENGINE*/')
    .replace('<!-- jh:theme-style -->\n<style>', '<!-- jh:theme-style -->\n<style>/*OLD-THEME*/')
    .replace(/content="jh-presentation [^"]+"/, 'content="jh-presentation 0.0.1"');
  fs.writeFileSync(file, marked);

  writeDeck(ws, name, { slides: '<section class="slide"><h2>変更</h2></section>' });
  let html = fs.readFileSync(file, 'utf8');
  assert.ok(html.includes('/*OLD-ENGINE*/') && html.includes('/*OLD-THEME*/'), '内容の修正ではエンジン・テーマを維持');
  assert.equal(parseDeck(html).version, '0.0.1');

  writeDeck(ws, name, { theme: 'mono' });
  html = fs.readFileSync(file, 'utf8');
  assert.ok(html.includes('/*OLD-ENGINE*/') && !html.includes('/*OLD-THEME*/'), 'テーマ変更ではテーマだけ入れ替える');

  writeDeck(ws, name, {}, { upgrade: true });
  html = fs.readFileSync(file, 'utf8');
  assert.ok(!html.includes('/*OLD-ENGINE*/'), 'upgrade で最新に');
  assert.notEqual(parseDeck(html).version, '0.0.1');
});

// ---------------------------------------------------------------------------
// 7. プレビューサーバーの配信範囲
// ---------------------------------------------------------------------------
test('7. プレビューサーバーは decks/ と gallery/ の内側だけを配信する', () => {
  const root = path.join(tmp, 'root');
  assert.equal(resolveServedPath('/decks/a.html', root), path.join(root, 'decks', 'a.html'));
  assert.equal(resolveServedPath('/gallery/index.html', root), path.join(root, 'gallery', 'index.html'));
  for (const bad of ['/package.json', '/.git/config', '/decks/../package.json', '/decks/%2e%2e/x', '/decks/.history/x.html', '/node_modules/x.js', '/decks-evil/x.html']) {
    assert.equal(resolveServedPath(decodeURIComponent(bad), root), null, bad);
  }
});

// ---------------------------------------------------------------------------
// 6. ドキュメントが現行の形式と一致する
// ---------------------------------------------------------------------------
test('6. ガイド・README に旧形式の説明が残っていない', () => {
  const docs = ['CLAUDE.md', 'README.md', 'mcp/README.md', 'docs/authoring-guide.md', 'docs/theme-guide.md']
    .map((f) => [f, fs.readFileSync(path.join(ROOT, f), 'utf8')]);
  for (const [f, s] of docs) {
    // 「旧形式からの移行」を説明する行は対象外
    const current = s.split('\n').filter((line) => !line.includes('旧形式')).join('\n');
    const stale = current.match(/npm run bundle|deck\.css|deck\.js\b|decks\/<name>\/index\.html|JS なしでも/);
    assert.equal(stale, null, `${f} に旧形式の記述: ${stale && stale[0]}`);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const [f, s] of docs) {
    for (const m of s.matchAll(/npm run ([\w:-]+)/g)) assert.ok(pkg.scripts[m[1]], `${f}: npm run ${m[1]} が package.json にない`);
  }
});
