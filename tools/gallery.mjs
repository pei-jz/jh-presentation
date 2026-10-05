#!/usr/bin/env node
// テーマギャラリーを生成する
//   npm run gallery   → gallery/index.html (npm run dev 中は自動生成。http://localhost:4000/gallery/)
import path from 'node:path';
import { buildGallery } from './lib/gallery.mjs';
import { ROOT, repoCtx, repoThemes } from './lib/repo.mjs';

const { index, themes } = buildGallery(path.join(ROOT, 'gallery'), repoThemes(), repoCtx());
console.log(`生成しました: ${path.relative(ROOT, index).replaceAll('\\', '/')} (${themes.map((t) => t.name).join(', ')})`);
