// ヘッドレスブラウザでデッキを描画する (監査 / スクリーンショット / PDF)
// ブラウザはインストール済みの Chrome / Edge を使う (playwright-core はブラウザを同梱しない)。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { findBrowser } from '../tools/lib/browser.mjs';

const W = 1920, H = 1080;
const IDLE_MS = 60_000;

let browserPromise = null;
let idleTimer = null;

async function getBrowser() {
  clearTimeout(idleTimer);
  if (!browserPromise) {
    const executablePath = findBrowser();
    if (!executablePath) {
      throw new Error('Chrome / Edge が見つかりません。環境変数 CHROME_PATH にブラウザのパスを指定してください。');
    }
    browserPromise = chromium.launch({ executablePath, headless: true }).catch((e) => {
      browserPromise = null;
      throw e;
    });
  }
  return browserPromise;
}

/** 一定時間使われなければブラウザを閉じる */
function scheduleClose() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(closeBrowser, IDLE_MS);
  idleTimer.unref?.();
}

export async function closeBrowser() {
  clearTimeout(idleTimer);
  if (!browserPromise) return;
  const p = browserPromise;
  browserPromise = null;
  try { await (await p).close(); } catch { /* noop */ }
}

async function withPage(options, fn) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: options.scale || 1,
    reducedMotion: options.reducedMotion ? 'reduce' : 'no-preference',
  });
  // デッキはオフラインで完結する前提なので、外部への通信は遮断して記録する
  const external = [];
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (/^(file|data|blob|about):/i.test(url)) return route.continue();
    external.push(url.slice(0, 120));
    return route.abort();
  });
  const page = await context.newPage();
  const log = { errors: [], warnings: [], external };
  page.on('pageerror', (e) => log.errors.push(String(e.message || e)));
  page.on('console', (m) => {
    if (m.type() === 'error') log.errors.push(m.text());
    else if (m.type() === 'warning') log.warnings.push(m.text());
  });
  try {
    return await fn(page, log);
  } finally {
    await context.close();
    scheduleClose();
  }
}

function deckUrl(file, query = '', hash = '') {
  return pathToFileURL(file).href + query + hash;
}

/** 読み込み → 初期化 → フォント・画像・PDF 用の非同期描画の完了まで待つ */
async function load(page, url) {
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => document.documentElement.classList.contains('deck-ready'), null, { timeout: 10_000 });
  await page.evaluate(() => (window.Deck.whenReady ? window.Deck.whenReady() : null));
}

/** 表示が落ち着くまで待つ (切り替え・アニメーション・部品の演出。無限ループするものは待たない) */
async function settle(page, timeout = 8000) {
  await page.evaluate((t) => (window.Deck.settled ? window.Deck.settled(t) : new Promise((r) => setTimeout(r, 1600))), timeout);
}

/**
 * 検査: はみ出し・切れ・文字の重なり・コントラスト・画像・小さすぎる文字・JS エラー/警告・外部通信
 * ok は「検査した項目で問題が見つからなかった」という意味で、見た目の良さまでは保証しない
 */
export async function auditDeck(deckFile) {
  return withPage({ reducedMotion: true }, async (page, log) => {
    await load(page, deckUrl(deckFile));
    const result = await page.evaluate(() => {
      const slides = window.Deck.slides;
      const smallText = [];
      // 表示中でないスライドも検査できるように、検査中は全スライドを visible にする (engine.css の deck-auditing)
      document.body.classList.add('deck-auditing');
      slides.forEach((s, i) => {
        s.querySelectorAll('*').forEach((e) => {
          if (e.closest('aside.notes, .allow-small')) return;
          const own = Array.prototype.some.call(e.childNodes, (n) => n.nodeType === 3 && n.textContent.trim());
          if (!own) return;
          const cs = getComputedStyle(e);
          if (cs.visibility === 'hidden' || cs.display === 'none') return;
          let fs = parseFloat(cs.fontSize);
          let min = e.closest('pre, code') ? 22 : 26;
          // SVG 内の文字は viewBox で拡縮されるので、画面上の実際の大きさ (キャンバス上の px) で判定する
          const svg = e.closest('svg');
          if (svg && e.tagName.toLowerCase() !== 'svg') {
            const m = e.getScreenCTM && e.getScreenCTM();
            const stage = document.querySelector('.deck-stage');
            const stageScale = stage ? stage.getBoundingClientRect().width / 1920 : 1;
            if (m) fs = fs * Math.hypot(m.a, m.b) / (stageScale || 1);
            min = 20;
          }
          if (fs < min) smallText.push({ slide: i + 1, fontSizePx: Math.round(fs * 10) / 10, text: e.textContent.trim().slice(0, 30) });
        });
      });
      const issues = window.Deck.audit();
      const pick = (...types) => issues.filter((x) => types.includes(x.type));
      return {
        slideCount: slides.length,
        stepsPerSlide: slides.map((s) => s._steps.length),
        overflow: pick('overflow', 'clipped'),
        overlap: pick('overlap'),
        contrast: pick('contrast'),
        images: pick('asset', 'image'),
        smallText: smallText.slice(0, 30),
      };
    });
    const warnings = log.warnings.filter((w) => w.startsWith('[deck]'));
    const found = result.overflow.length + result.overlap.length + result.contrast.length + result.images.length +
      result.smallText.length + log.errors.length + warnings.length + log.external.length;
    return {
      ok: found === 0,
      ...result,
      errors: log.errors,
      warnings,
      externalRequests: log.external,
    };
  });
}

/**
 * スライドを JPEG で撮影する
 * @param {number[]} slides 1 始まりのスライド番号
 * @param {'final'|number} step 'final' = 全ステップ表示・アニメ完了後 (印刷レイアウトで撮影)
 *                              数値 = そのステップ数まで表示した状態 (通常表示で撮影)
 */
export async function screenshotDeck(deckFile, { slides, step = 'final', scale = 0.5, quality = 75 }) {
  if (step === 'final') {
    return withPage({ scale }, async (page, log) => {
      await load(page, deckUrl(deckFile, '?print'));
      const total = await page.locator('section.slide').count();
      const targets = (slides && slides.length ? slides : Array.from({ length: total }, (_, i) => i + 1))
        .filter((n) => n >= 1 && n <= total);
      const images = [];
      for (const n of targets) {
        const buf = await page.locator('section.slide').nth(n - 1).screenshot({ type: 'jpeg', quality });
        images.push({ slide: n, data: buf.toString('base64') });
      }
      return { total, images, errors: log.errors };
    });
  }
  return withPage({ scale }, async (page, log) => {
    await load(page, deckUrl(deckFile));
    const total = await page.evaluate(() => window.Deck.slides.length);
    const targets = (slides && slides.length ? slides : [1]).filter((n) => n >= 1 && n <= total);
    const images = [];
    for (const n of targets) {
      await page.evaluate(([i, s]) => window.Deck.goto(i, s), [n - 1, Number(step)]);
      await settle(page);
      const buf = await page.screenshot({ type: 'jpeg', quality });
      images.push({ slide: n, data: buf.toString('base64') });
    }
    return { total, images, errors: log.errors };
  });
}

/**
 * ブラウザの「名前を付けて保存」(Ctrl+S) で表示中の状態のまま保存されたデッキから、元の内容を取り出す。
 * 表示時にエンジン・部品が加えた変更 (クラス・属性・コードの色分け・数値の途中経過など) を取り除く。
 * DOMParser で解析するだけなので、デッキのスクリプトは実行されない。
 * @returns {{ title, theme, brand, transition, slides, css, js, assets, notes: string[] }}
 */
export async function extractFromSavedPage(html) {
  return withPage({}, async (page) => {
    await page.goto('about:blank');
    return page.evaluate((src) => {
      const notes = [];
      const doc = new DOMParser().parseFromString(src, 'text/html');
      const meta = (n) => (doc.querySelector(`meta[name="${n}"]`) || {}).content;
      const deck = doc.querySelector('.deck');
      if (!deck) throw new Error('.deck が見つかりません');
      const transition = deck.getAttribute('data-transition') || 'fade';
      const sections = Array.from(deck.querySelectorAll('section.slide')).filter((s) => !s.parentElement.closest('section.slide'));
      const RUNTIME_CLASSES = ['active', 'past', 'future', 'visible', 'current', 'is-typing'];
      const fmt = (v, dec, sep) => { let s = Number(v).toFixed(dec); if (!sep) return s; const p = s.split('.'); p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ','); return p.join('.'); };

      const slides = sections.map((sec) => {
        const s = sec.cloneNode(true);
        // スライド自体にエンジンが付けた属性
        ['aria-hidden', 'data-index'].forEach((a) => s.removeAttribute(a));
        if (s.getAttribute('data-transition') === transition) s.removeAttribute('data-transition');
        // 編集モード・ステップ・状態のクラスと属性
        [s, ...s.querySelectorAll('*')].forEach((e) => {
          RUNTIME_CLASSES.forEach((c) => e.classList && e.classList.remove(c));
          if (e.getAttribute('class') === '') e.removeAttribute('class');
          ['contenteditable', 'data-jh-edit', 'spellcheck'].forEach((a) => e.removeAttribute(a));
          const st = e.getAttribute && e.getAttribute('style');
          if (st && /--i\s*:/.test(st)) {
            const rest = st.replace(/--i\s*:\s*\d+;?\s*/g, '').trim();
            if (rest) e.setAttribute('style', rest); else e.removeAttribute('style');
          }
        });
        s.querySelectorAll('.deck-print-pageno, .deck-brand-holder').forEach((e) => e.remove());
        // anim-draw の pathLength は部品が付ける
        s.querySelectorAll('.anim-draw, .anim-draw *').forEach((e) => { if (e.getAttribute('pathLength') === '1') e.removeAttribute('pathLength'); });
        // コードの色分け (行ごとの span) を元のテキストに戻す
        s.querySelectorAll('code.hl').forEach((code) => {
          const lines = code.querySelectorAll(':scope > .line');
          if (!lines.length) return;
          code.textContent = '\n' + Array.from(lines).map((l) => (l.textContent === ' ' ? '' : l.textContent)).join('\n') + '\n';
        });
        // カウントアップは最終値に、タイプライターは (途中なら) そのまま
        s.querySelectorAll('[data-count-to]').forEach((e) => {
          const to = e.getAttribute('data-count-to');
          e.textContent = fmt(to, (String(to).split('.')[1] || '').length, e.getAttribute('data-sep') !== 'false');
        });
        if (s.querySelector('[data-typewriter]')) notes.push('タイプライターの文字は保存時点の表示のまま復元しています (途中で保存された場合は欠けている可能性があります)');
        return s.outerHTML;
      });

      const blockText = (name, tag) => {
        const m = src.match(new RegExp(`<!-- jh:${name} -->([\\s\\S]*?)<!-- /jh:${name} -->`));
        if (!m) return '';
        const d = new DOMParser().parseFromString(`<div>${m[1]}</div>`, 'text/html');
        const el = d.querySelector(tag);
        return el ? el.textContent.trim() : '';
      };
      let assets = {};
      try { assets = JSON.parse(blockText('assets', 'script') || '{}'); } catch { notes.push('埋め込み画像の情報を読めませんでした'); }
      return {
        title: (doc.querySelector('title') || {}).textContent || '',
        theme: meta('jh-theme') || 'default',
        brand: meta('jh-brand') || 'none',
        transition,
        slides: slides.join('\n\n'),
        css: blockText('deck-style', 'style'),
        js: blockText('deck-script', 'script'),
        assets,
        notes: [...new Set(notes)],
      };
    }, html);
  });
}

/** ブラウザ保存で壊れたファイルかどうか */
export function isBrowserSavedPage(html) {
  return /<!-- saved from url=/.test(html) || /<div class="deck-stage"/.test(html) || /<html[^>]*class="[^"]*deck-ready/.test(html);
}

/** PDF 出力 (CLI の npm run pdf と MCP の export_deck で共通) */
export async function exportPdf(deckFile, outFile) {
  return withPage({}, async (page) => {
    await load(page, deckUrl(deckFile, '?print'));
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    await page.pdf({ path: outFile, preferCSSPageSize: true, printBackground: true });
    return outFile;
  });
}
