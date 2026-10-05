#!/usr/bin/env node
// デッキを PDF に書き出す (MCP の export_deck と同じ処理。Chrome / Edge を使用)
//   npm run pdf -- <name>   → dist/<name>.pdf
// 環境変数 CHROME_PATH でブラウザのパスを指定可能
import path from 'node:path';
import { exportPdf, closeBrowser } from '../mcp/render.mjs';
import { ROOT, deckPathOrExit } from './lib/repo.mjs';

const file = deckPathOrExit(process.argv[2]);
const out = path.join(ROOT, 'dist', path.basename(file, '.html') + '.pdf');
try {
  await exportPdf(file, out);
  console.log('出力しました: ' + path.relative(ROOT, out).split(path.sep).join('/'));
} catch (e) {
  console.error('PDF の出力に失敗しました: ' + e.message);
  process.exitCode = 1;
} finally {
  await closeBrowser();
}
