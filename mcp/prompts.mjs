// 依頼文テンプレート (prompts/*.md) の読み込み
//
// パッケージ同梱の prompts/ と、ワークスペースの prompts/ を読む (同じファイル名ならワークスペース側が優先)。
// 形式:
//   ---
//   title: 技術解説
//   description: 技術を解説する発表向け
//   args:
//     topic: 発表テーマ
//     minutes: 持ち時間 (分) (任意)
//   ---
//   本文。{{topic}} で引数を埋め込む。{{minutes|30}} で未指定時の既定値。
// 説明に「(任意)」を含む引数は省略可能。
import fs from 'node:fs';
import path from 'node:path';

function parseFrontmatter(src) {
  const m = src.replace(/^﻿/, '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, args: [], body: src };
  const meta = {}, args = [];
  let inArgs = false;
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const top = line.match(/^(\w+):\s*(.*)$/);
    if (top) {
      inArgs = top[1] === 'args' && !top[2];
      if (!inArgs) meta[top[1]] = top[2].trim();
      continue;
    }
    const arg = inArgs && line.match(/^\s+(\w+):\s*(.*)$/);
    if (arg) {
      const description = arg[2].trim();
      args.push({ name: arg[1], description, required: !/[(（]任意/.test(description) });
    }
  }
  return { meta, args, body: m[2] };
}

/** @returns {{ name, title, description, args: {name, description, required}[], body, source }[]} */
export function loadPromptTemplates(dirs) {
  const byName = new Map();
  for (const dir of dirs) {
    if (!dir || !fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md') || f.startsWith('_') || f.toLowerCase() === 'readme.md') continue;
      const name = f.replace(/\.md$/, '');
      if (!/^[\w-]+$/.test(name)) continue;
      const file = path.join(dir, f);
      const { meta, args, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
      byName.set(name, { name, title: meta.title || name, description: meta.description || '', args, body: body.trim(), source: file });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function renderPrompt(template, values) {
  return template.body.replace(/\{\{\s*(\w+)\s*(?:\|([^}]*))?\}\}/g, (_, key, def) => {
    const v = values[key];
    return v != null && String(v).trim() !== '' ? String(v) : (def != null ? def.trim() : '');
  });
}
