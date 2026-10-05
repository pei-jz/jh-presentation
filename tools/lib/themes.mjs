// テーマ一覧 (themes/*.css の先頭コメントにある @theme / @label / @description / @tags を読む)
import fs from 'node:fs';
import path from 'node:path';

/** @returns {{ name: string, label: string, description: string, tags: string[] }[]} */
export function readThemes(themesDir) {
  if (!fs.existsSync(themesDir)) return [];
  const list = fs.readdirSync(themesDir)
    .filter((f) => f.endsWith('.css') && !f.startsWith('_'))
    .map((f) => {
      const css = fs.readFileSync(path.join(themesDir, f), 'utf8');
      const head = (css.match(/^\s*\/\*([\s\S]*?)\*\//) || [])[1] || '';
      const tag = (k) => ((head.match(new RegExp(`@${k}\\s+(.+)`)) || [])[1] || '').trim();
      const name = f.replace(/\.css$/, '');
      return {
        name,
        label: tag('label') || name,
        description: tag('description'),
        tags: tag('tags') ? tag('tags').split(/[,、]\s*/).filter(Boolean) : [],
      };
    });
  // default を先頭に
  return list.sort((a, b) => (a.name === 'default' ? -1 : b.name === 'default' ? 1 : a.name.localeCompare(b.name)));
}
