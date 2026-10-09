// リポジトリ内で使う共通設定 (decks/ のデッキ・同梱ブランド・同梱テーマ)
import fs from 'node:fs';
import path from 'node:path';
import { PKG_ROOT, BUILTIN_THEMES_DIR, loadBrand, isDeckHtml } from './deckfile.mjs';
import { isMapHtml } from './mapfile.mjs';
import { readThemes } from './themes.mjs';

export const ROOT = PKG_ROOT;
export const DECKS_DIR = path.join(ROOT, 'decks');
export const MAPS_DIR = path.join(ROOT, 'maps');

/** プレビューサーバーで配信してよいフォルダ */
export const SERVED_DIRS = ['decks', 'maps', 'gallery', 'examples'];

/**
 * URL のパスを ROOT/<SERVED_DIRS>/ の内側のファイルパスに変換する。外側・隠しファイルなら null
 * (文字列の前方一致ではなく path.relative で境界を確認する)
 */
export function resolveServedPath(pathname, root = ROOT) {
  const file = path.resolve(root, '.' + path.posix.normalize('/' + String(pathname)));
  const rel = path.relative(root, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const segs = rel.split(path.sep);
  if (!SERVED_DIRS.includes(segs[0]) || segs.some((s) => s.startsWith('.'))) return null;
  return file;
}

export const repoCtx = () =>({ themeDirs: [], brandData: loadBrand(path.join(ROOT, 'brand')) });
export const repoThemes = () => readThemes(BUILTIN_THEMES_DIR);

/** decks/<name>.html のパス (存在しなければエラー終了)。maps: true なら maps/<name>.html も探す */
export function deckPathOrExit(name, { maps = false } = {}) {
  if (!name) {
    console.error('デッキ名を指定してください (decks/' + (maps ? ' か maps/' : '') + ' 内のファイル名。.html は省略可)');
    process.exit(1);
  }
  const base = name.replace(/\.html$/i, '') + '.html';
  const file = path.join(DECKS_DIR, base);
  if (fs.existsSync(file)) return file;
  if (maps && fs.existsSync(path.join(MAPS_DIR, base))) return path.join(MAPS_DIR, base);
  console.error('見つかりません: ' + path.relative(ROOT, file) + (maps ? ' / ' + path.relative(ROOT, path.join(MAPS_DIR, base)) : ''));
  process.exit(1);
}

export function listRepoDecks() {
  if (!fs.existsSync(DECKS_DIR)) return [];
  return fs.readdirSync(DECKS_DIR)
    .filter((f) => f.endsWith('.html'))
    .map((f) => ({ name: f.replace(/\.html$/, ''), file: path.join(DECKS_DIR, f) }))
    .filter((d) => isDeckHtml(fs.readFileSync(d.file, 'utf8')));
}

export function listRepoMaps() {
  if (!fs.existsSync(MAPS_DIR)) return [];
  return fs.readdirSync(MAPS_DIR)
    .filter((f) => f.endsWith('.html'))
    .map((f) => ({ name: f.replace(/\.html$/, ''), file: path.join(MAPS_DIR, f) }))
    .filter((d) => isMapHtml(fs.readFileSync(d.file, 'utf8')));
}
