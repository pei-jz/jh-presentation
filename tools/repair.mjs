#!/usr/bin/env node
// ブラウザの「名前を付けて保存」で壊れたデッキを復旧する
//   npm run repair -- <name | ファイルのパス>
// 壊れたファイルは同じフォルダの .history/<name>/ に残る。
import fs from 'node:fs';
import path from 'node:path';
import { buildDeck, loadBrand } from './lib/deckfile.mjs';
import { DECKS_DIR } from './lib/repo.mjs';
import { extractFromSavedPage, closeBrowser } from '../mcp/render.mjs';
import { isBrowserSaved, saveDeckFile } from '../mcp/workspace.mjs';

const arg = process.argv[2];
if (!arg) {
  console.error('使い方: npm run repair -- <name | ファイルのパス>');
  process.exit(1);
}
const file = fs.existsSync(arg) ? path.resolve(arg) : path.join(DECKS_DIR, arg.replace(/\.html$/i, '') + '.html');
if (!fs.existsSync(file)) {
  console.error('見つかりません: ' + file);
  process.exit(1);
}

const html = fs.readFileSync(file, 'utf8');
if (!isBrowserSaved(html)) {
  console.log('このファイルはブラウザ保存で壊れた形跡がありません (復旧は不要です)');
  process.exit(0);
}
try {
  const dir = path.dirname(file);
  const ctx = { themeDirs: [path.join(dir, 'themes')], brandData: loadBrand(path.join(dir, 'brand')) };
  const parts = await extractFromSavedPage(html);
  saveDeckFile(dir, path.basename(file, '.html'), file, html, buildDeck(parts, ctx));
  console.log(`復旧しました: ${file} (${parts.slides.match(/<section\b/g)?.length || 0} 枚)`);
  parts.notes.forEach((n) => console.log('注意: ' + n));
  console.log(`壊れたファイルは ${path.join(dir, '.history', path.basename(file, '.html'))} に残っています`);
} catch (e) {
  console.error('復旧できませんでした: ' + e.message);
  process.exitCode = 1;
} finally {
  await closeBrowser();
}
