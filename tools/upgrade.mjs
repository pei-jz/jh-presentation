#!/usr/bin/env node
// デッキに埋め込まれたエンジン・テーマ・ブランドを最新にする
//   npm run upgrade              → decks/*.html すべて
//   npm run upgrade -- <name>    → 指定したデッキだけ
// <head> の meta (jh-theme / jh-brand) を書き換えた後もこれで反映する。
// 旧形式 (decks/<name>/index.html) のデッキがあれば 1 ファイル形式に変換する。
import fs from 'node:fs';
import path from 'node:path';
import { rebuildDeck, migrateFolderDecks } from './lib/deckfile.mjs';
import { ROOT, DECKS_DIR, repoCtx, listRepoDecks, deckPathOrExit } from './lib/repo.mjs';

const ctx = repoCtx();
const migrated = migrateFolderDecks(DECKS_DIR, DECKS_DIR, ctx);
migrated.forEach((n) => console.log(`変換しました (旧形式 → 1 ファイル): decks/${n}/ → decks/${n}.html`));

const name = process.argv[2];
const files = name ? [deckPathOrExit(name)] : [...listRepoDecks().map((d) => d.file), path.join(ROOT, 'examples', 'sample.html')];
for (const file of files) {
  fs.writeFileSync(file, rebuildDeck(fs.readFileSync(file, 'utf8'), {}, ctx, { upgrade: true }));
  console.log('更新しました: ' + path.relative(ROOT, file).replaceAll('\\', '/'));
}
