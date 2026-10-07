// 文字編集のテスト
//   node --test tests/   (npm test)
//
// 1. ブラウザ (エンジン) とソース解析 (deck-edit.js) で「編集できる要素」が一致すること
// 2. jh-editor と同じサンドボックス iframe (srcdoc + allow-scripts) で、
//    編集 → postMessage → applyEdit → ソースの該当箇所だけが変わる、まで通ること
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { findBrowser } from '../tools/lib/browser.mjs';
import { buildDeck, loadBrand } from '../tools/lib/deckfile.mjs';
import { buildGallery } from '../tools/lib/gallery.mjs';
import { readThemes } from '../tools/lib/themes.mjs';
import '../engine/deck-edit.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E = globalThis.JhDeckEdit;
const ctx = { themeDirs: [], brandData: loadBrand(path.join(ROOT, 'brand')) };

let browser;
before(async () => { browser = await chromium.launch({ executablePath: findBrowser(), headless: true }); });
after(async () => { await browser?.close(); });

/** 対象デッキ: 見本 + 全テーマのギャラリー (様々な部品を含む) */
function decks() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-edit-test-'));
  const files = [path.join(ROOT, 'examples', 'sample.html')];
  const { dir, themes } = buildGallery(path.join(tmp, 'gallery'), readThemes(path.join(ROOT, 'themes')), ctx);
  themes.forEach((t) => files.push(path.join(dir, t.name + '.html')));
  return files;
}

async function browserEditables(file) {
  const page = await browser.newPage();
  await page.goto(pathToFileURL(file).href);
  await page.waitForFunction(() => document.documentElement.classList.contains('deck-ready'));
  const result = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('[data-jh-edit]').forEach((e) => {
      const [s, i] = e.getAttribute('data-jh-edit').split(':').map(Number);
      (out[s] = out[s] || [])[i] = e._jhSource;
    });
    return { list: out, slides: window.Deck.slides.length };
  });
  await page.close();
  return result;
}

test('ブラウザとソース解析で編集できる要素が一致する', async () => {
  for (const file of decks()) {
    const src = fs.readFileSync(file, 'utf8');
    const fromSource = E.sourceEditables(src).map((list) => list.map((n) => E.normText(src.slice(n.innerStart, n.innerEnd), true)));
    const fromBrowser = await browserEditables(file);
    assert.equal(fromSource.length, fromBrowser.slides, `${path.basename(file)}: スライド数`);
    fromSource.forEach((list, s) => {
      assert.deepEqual(fromBrowser.list[s] || [], list, `${path.basename(file)}: スライド ${s + 1}`);
    });
    assert.ok(fromSource.flat().length > 10, `${path.basename(file)}: 編集できる要素がある`);
  }
});

test('applyEdit は対象の中身だけを書き換え、照合に失敗したら拒否する', () => {
  const src = buildDeck({
    title: 'T',
    slides: `<section class="slide"><h2>見出し &amp; A</h2><ul><li>一つ目</li><li>二つ目<b>強調</b></li></ul>
<pre class="code"><code>&lt;p&gt;対象外&lt;/p&gt;</code></pre><div class="stat-value"><span data-count-to="5">5</span></div></section>
<section class="slide"><p class="callout">注意<br>二行目</p><blockquote class="quote">引用<cite>出典</cite></blockquote></section>`,
  }, ctx);
  const ed = E.sourceEditables(src);
  assert.deepEqual(ed.map((l) => l.length), [3, 2]);

  const r = E.applyEdit(src, { slide: 0, index: 2, html: '2 つ目<b>強調</b>', before: '二つ目強調' });
  assert.equal(r.source.length - src.length, r.insert.length - (r.to - r.from));
  assert.equal(r.source.slice(0, r.from), src.slice(0, r.from));
  assert.equal(r.source.slice(r.from + r.insert.length), src.slice(r.to));
  assert.ok(r.source.includes('<li>2 つ目<b>強調</b></li>'));
  assert.equal(r.insert, '2 つ目<b>強調</b>');

  assert.throws(() => E.applyEdit(src, { slide: 0, index: 2, html: 'x', before: '別の文字' }), /一致しません/);
  assert.throws(() => E.applyEdit(src, { slide: 5, index: 0, html: 'x' }), /スライド/);
  // 危険なものは取り除かれる
  const s2 = E.applyEdit(src, { slide: 1, index: 0, html: '注意<img src=x onerror="alert(1)"><script>x()</script><br>', before: '注意二行目' });
  assert.ok(!/onerror|<script/.test(s2.insert));
});

test('サンドボックス iframe (jh-editor と同じ条件) で編集が反映される', async () => {
  let src = fs.readFileSync(path.join(ROOT, 'examples', 'sample.html'), 'utf8');
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html><body style="margin:0">
    <iframe id="pv" sandbox="allow-scripts" style="width:1280px;height:720px;border:0"></iframe>
    <script>
      window.msgs = [];
      window.addEventListener('message', (e) => {
        if (e.source !== document.getElementById('pv').contentWindow || !e.data || !e.data.jhdeck) return;
        window.msgs.push(e.data);
        if (e.data.type === 'ready') e.source.postMessage({ jhdeck: 1, type: 'goto', index: 3, step: 9 }, '*');
      });
    </script></body></html>`);
  await page.evaluate((html) => { document.getElementById('pv').srcdoc = html; }, src);
  await page.waitForFunction(() => window.msgs.some((m) => m.type === 'ready'));
  const ready = await page.evaluate(() => window.msgs.find((m) => m.type === 'ready'));
  assert.equal(ready.slides, E.slideRanges(src.slice(src.indexOf('<!-- jh:slides -->'))).length);
  assert.deepEqual(ready.editables, E.sourceEditables(src).map((l) => l.length));

  // goto が効いて state が届く
  await page.waitForFunction(() => window.msgs.some((m) => m.type === 'state' && m.index === 3));

  // 編集モードにして、比較スライドの最初の見出しを書き換える
  await page.evaluate(() => document.getElementById('pv').contentWindow.postMessage({ jhdeck: 1, type: 'edit', on: true }, '*'));
  const frame = page.frameLocator('#pv');
  const target = frame.locator('[data-jh-edit="3:0"]');
  await target.click();
  await page.keyboard.press('End');
  await page.keyboard.type('（改訂）');
  await page.keyboard.press('Enter'); // 確定
  await page.waitForFunction(() => window.msgs.some((m) => m.type === 'change'));
  const change = await page.evaluate(() => window.msgs.find((m) => m.type === 'change'));
  assert.equal(change.slide, 3);
  assert.equal(change.index, 0);
  assert.equal(change.before, 'PowerPoint と HTML を比べると');

  const r = E.applyEdit(src, change);
  assert.ok(r.source.includes('<h2>PowerPoint と HTML を比べると（改訂）</h2>'));
  assert.equal(r.source.replace('（改訂）', ''), src, '変更箇所以外は 1 文字も変わらない');
  src = r.source;

  // 続けて同じ要素をもう一度編集しても照合が通る
  await target.click();
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.msgs.filter((m) => m.type === 'change').length >= 2);
  const change2 = await page.evaluate(() => window.msgs.filter((m) => m.type === 'change')[1]);
  assert.ok(E.applyEdit(src, change2).source.includes('比べると（改訂）!</h2>'));

  // Ctrl+S はホストに保存を依頼する
  await target.click();
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => window.msgs.some((m) => m.type === 'save'));

  // ホストが保存を終えたら (saved)、編集モードを自動で終える
  const post = (m) => page.evaluate((msg) => document.getElementById('pv').contentWindow.postMessage(msg, '*'), m);
  await post({ jhdeck: 1, type: 'saved' });
  await page.waitForFunction(() => window.msgs.some((m) => m.type === 'edit-mode' && m.on === false));
  assert.equal(await frame.locator('body.deck-editing').count(), 0);

  // F5 は再読み込みせず「発表」をホストに頼む。枠の外の Ctrl+Z / Ctrl+Y は元に戻す / やり直す
  await frame.locator('.deck-stage').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('F5');
  await page.waitForFunction(() => window.msgs.some((m) => m.type === 'present'));
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+y');
  await page.waitForFunction(() => window.msgs.some((m) => m.type === 'undo') && window.msgs.some((m) => m.type === 'redo'));
  // 発表中の Esc は、発表の終了をホストに頼む
  await post({ jhdeck: 1, type: 'present', on: true });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.msgs.some((m) => m.type === 'present-exit'));
  await page.close();
});

test('構造ルール: 文字と行内要素だけの要素を、いちばん外側の単位で編集対象にする', () => {
  const src = buildDeck({
    title: 'R',
    slides: `<section class="slide">
  <h2>見出し</h2>
  <div class="pyramid"><div class="layer"><b>人間の判定</b><span>意図との一致</span></div></div>
  <div class="kind">考え方</div>
  <p>実行は <code>npm run dev</code> です</p>
  <div class="card"><h3>カード</h3><ul><li>項目 <span class="kbd">A</span></li></ul></div>
  <div class="flow-item"><div class="flow-no">1</div>ばらの文字</div>
  <div class="stat-value"><span data-count-to="5">5</span><span class="unit">%</span></div>
  <pre class="code"><code>コード</code></pre>
  <svg viewBox="0 0 10 10"><text>図の文字</text></svg>
  <div class="no-edit"><p>編集させない</p></div>
  <div><img alt="" src="data:,"></div>
  <aside class="notes"><p>ノート</p></aside>
</section>`,
  }, ctx);
  const texts = E.sourceEditables(src)[0].map((n) => E.normText(src.slice(n.innerStart, n.innerEnd), true));
  assert.deepEqual(texts, ['見出し', '人間の判定意図との一致', '考え方', '実行は npm run dev です', 'カード', '項目 A', '1', '%']);
});

async function openDeck(slides) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jh-ui-')), 'u.html');
  fs.writeFileSync(file, buildDeck({ title: 'U', slides }, ctx));
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(pathToFileURL(file).href);
  await page.waitForFunction(() => document.documentElement.classList.contains('deck-ready'));
  return page;
}

test('ダブルクリックでその枠を編集でき、✕ 終了ボタンと Esc で編集モードを抜けられる', async () => {
  const page = await openDeck('<section class="slide"><h2>タイトル</h2><div class="layer"><b>太字</b><span>説明</span></div></section>');
  const layer = page.locator('[data-jh-edit="0:1"]');
  await layer.dblclick();
  const state = await page.evaluate(() => ({
    editing: document.body.classList.contains('deck-editing'),
    focused: document.activeElement && document.activeElement.getAttribute('data-jh-edit'),
    badge: !document.querySelector('.deck-edit-badge').hidden,
  }));
  assert.deepEqual(state, { editing: true, focused: '0:1', badge: true });

  // 編集すると「未保存」と保存ボタンが出る
  await page.keyboard.type('追記');
  await page.keyboard.press('Enter');
  const dirty = await page.evaluate(() => ({
    state: document.querySelector('.deck-edit-state').textContent,
    save: !document.querySelector('[data-act="save"]').hidden,
  }));
  assert.ok(dirty.state.includes('未保存') && dirty.save);

  await page.click('[data-act="exit"]');
  assert.equal(await page.evaluate(() => document.body.classList.contains('deck-editing')), false, '✕ 終了で抜ける');

  await layer.dblclick();
  await page.keyboard.press('Escape'); // 1 回目: 枠の編集を取り消して枠から出る
  await page.keyboard.press('Escape'); // 2 回目: 編集モードを終了
  const after = await page.evaluate(() => ({ editing: document.body.classList.contains('deck-editing'), overview: !!document.querySelector('.deck-overview') }));
  assert.deepEqual(after, { editing: false, overview: false });
  await page.close();
});

test('発表者ビューからも操作でき、発表画面がついてくる', async () => {
  const page = await openDeck(['A', 'B', 'C'].map((t) => `<section class="slide"><h2>${t}</h2><aside class="notes"><p>ノート${t}</p></aside></section>`).join('\n'));
  const [pv] = await Promise.all([page.waitForEvent('popup'), page.keyboard.press('s')]);
  await pv.waitForFunction(() => document.documentElement.classList.contains('deck-ready') && !!document.querySelector('.pv'));
  const mainIndex = () => page.evaluate(() => window.Deck.index);

  // キー操作 (発表者ビューで)
  await pv.keyboard.press('ArrowRight');
  await page.waitForFunction(() => window.Deck.index === 1);
  assert.equal(await pv.locator('.pv-notes-body').innerText(), 'ノートB');

  // 今のスライドのクリック・ボタンでも進む / 戻る
  await pv.click('.pv-current .pv-frame');
  await page.waitForFunction(() => window.Deck.index === 2);
  await pv.click('[data-nav="prev"]');
  await page.waitForFunction(() => window.Deck.index === 1);
  assert.equal(await mainIndex(), 1);
  await pv.close();
  await page.close();
});

test('srcdoc のホストは window.__JH_DECK_MODE__ で表示だけのモードにして、goto で位置を決められる', async () => {
  const src = buildDeck({ title: 'E', slides: ['A', 'B', 'C'].map((t) => `<section class="slide"><h2>${t}</h2></section>`).join('\n') }, ctx);
  const page = await browser.newPage();
  await page.setContent('<iframe id="pv" sandbox="allow-scripts" style="width:640px;height:360px;border:0"></iframe>');
  await page.evaluate((html) => {
    document.getElementById('pv').srcdoc = html.replace('<head>', '<head><script>window.__JH_DECK_MODE__ = "embed"</script>');
  }, src);
  const frame = page.frameLocator('#pv');
  await frame.locator('html.deck-ready').waitFor({ state: 'attached' });
  await page.evaluate(() => document.getElementById('pv').contentWindow.postMessage({ jhdeck: 1, type: 'goto', index: 2, step: 0 }, '*'));
  await frame.locator('section.slide.active h2', { hasText: 'C' }).waitFor({ state: 'attached' });
  assert.equal(await frame.locator('body.deck-mode-embed').count(), 1);
  await page.close();
});
