#!/usr/bin/env node
// デッキに埋め込まれたエンジン・テーマ・ブランドを最新にする
//   npm run upgrade              → decks/*.html と maps/*.html すべて (と examples/ の見本)
//   npm run upgrade -- <name>    → 指定したデッキだけ
// <head> の meta (jh-theme / jh-brand) を書き換えた後もこれで反映する。
// 旧形式 (decks/<name>/index.html) のデッキがあれば 1 ファイル形式に変換する。
import fs from 'node:fs';
import path from 'node:path';
import { rebuildDeck, migrateFolderDecks } from './lib/deckfile.mjs';
import { rebuildMap, isMapHtml } from './lib/mapfile.mjs';
import { ROOT, DECKS_DIR, repoCtx, listRepoDecks, listRepoMaps, deckPathOrExit } from './lib/repo.mjs';

const ctx = repoCtx();
const migrated = migrateFolderDecks(DECKS_DIR, DECKS_DIR, ctx);
migrated.forEach((n) => console.log(`変換しました (旧形式 → 1 ファイル): decks/${n}/ → decks/${n}.html`));

const name = process.argv[2];
const files = name
  ? [deckPathOrExit(name, { maps: true })]
  : [...listRepoDecks(), ...listRepoMaps()].map((d) => d.file).concat(['sample.html', 'sample-map.html'].map((f) => path.join(ROOT, 'examples', f)).filter((f) => fs.existsSync(f)));
for (const file of files) {
  const html = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, isMapHtml(html) ? rebuildMap(html, {}, ctx, { upgrade: true }) : rebuildDeck(html, {}, ctx, { upgrade: true }));
  console.log('更新しました: ' + path.relative(ROOT, file).replaceAll('\\', '/'));
}
