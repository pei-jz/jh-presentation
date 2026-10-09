#!/usr/bin/env node
// デッキを PDF に書き出す (MCP の export_deck と同じ処理。Chrome / Edge を使用)
//   npm run pdf -- <name>   → dist/<name>.pdf (マップ文書なら、階層ごとに 1 ページの A4 横)
// 環境変数 CHROME_PATH でブラウザのパスを指定可能
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { exportPdf, closeBrowser } from '../mcp/render.mjs';
import { isMapHtml } from './lib/mapfile.mjs';
import { findBrowser } from './lib/browser.mjs';
import { ROOT, deckPathOrExit } from './lib/repo.mjs';

const file = deckPathOrExit(process.argv[2], { maps: true });
const out = path.join(ROOT, 'dist', path.basename(file, '.html') + '.pdf');

/** マップ文書: ?print の表示 (階層ごとに 1 ページ) をそのまま PDF にする */
async function exportMapPdf(src, dest) {
  const browser = await chromium.launch({ executablePath: findBrowser(), headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(src).href + '?print');
    await page.waitForFunction(() => document.documentElement.classList.contains('map-ready'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    await page.pdf({ path: dest, preferCSSPageSize: true, printBackground: true });
  } finally {
    await browser.close();
  }
}

try {
  if (isMapHtml(fs.readFileSync(file, 'utf8'))) await exportMapPdf(file, out);
  else await exportPdf(file, out);
  console.log('出力しました: ' + path.relative(ROOT, out).split(path.sep).join('/'));
} catch (e) {
  console.error('PDF の出力に失敗しました: ' + e.message);
  process.exitCode = 1;
} finally {
  await closeBrowser();
}
