#!/usr/bin/env node
// ローカルプレビューサーバー (依存なし)
//   npm run dev            → http://localhost:4000
//   - decks/*.html の一覧、/gallery/ でテーマギャラリー
//   - デッキはファイルの内容のまま配信する (エンジンを変更したら npm run upgrade で埋め込み直す)
//   - 自分の PC (127.0.0.1) からだけ接続でき、配信するのは decks/ と gallery/ の中だけ
//   - ファイル保存で自動リロード (URL ハッシュでスライド位置は維持される)
//   - デッキ上で E キー → 文字を編集 → Ctrl+S で、decks/ の元のファイルに直接保存できる (保存前の版は decks/.history/)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { buildGallery } from './lib/gallery.mjs';
import { parseDeck, isDeckHtml } from './lib/deckfile.mjs';
import { ROOT, DECKS_DIR, repoCtx, repoThemes, listRepoDecks, resolveServedPath } from './lib/repo.mjs';
import { createSaveToken, injectSaveConfig, handleSave } from './lib/save-endpoint.mjs';
import { saveDeckFile } from '../mcp/workspace.mjs';

const PORT = Number(process.env.PORT || process.argv[2] || 4000);
const HOST = '127.0.0.1';
const SAVE_TOKEN = createSaveToken();
const GALLERY_DIR = path.join(ROOT, 'gallery');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
  '.md': 'text/markdown; charset=utf-8',
};

// ---- テーマギャラリー ----------------------------------------------------
function rebuildGallery() {
  try { buildGallery(GALLERY_DIR, repoThemes(), repoCtx()); } catch (e) { console.error('[gallery]', e.message); }
}
rebuildGallery();

// ---- ライブリロード ------------------------------------------------------
const clients = new Set();
let timer = null;
fs.watch(ROOT, { recursive: true }, (_ev, file) => {
  if (!file || /(^|[\\/])(node_modules|\.git|dist|gallery)([\\/]|$)/.test(file)) return;
  if (/^(themes|engine|components|brand|tools[\\/]lib)[\\/]/.test(file)) rebuildGallery();
  clearTimeout(timer);
  timer = setTimeout(() => {
    for (const res of clients) res.write('data: reload\n\n');
  }, 150);
});

// iframe 内 (発表者ビュー・ギャラリーのプレビュー) は親ページのリロードに任せる
// (接続数がブラウザの同時接続上限 6 を超えないように)
const RELOAD_SNIPPET = `<script>(function(){if(window.top!==window)return;var es=new EventSource('/__reload');es.onmessage=function(){location.reload()};})();</script>`;

// ---- デッキ一覧ページ -----------------------------------------------------
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function indexPage() {
  const rows = listRepoDecks()
    .map((d) => ({ ...d, info: parseDeck(fs.readFileSync(d.file, 'utf8')) }))
    .sort((a, b) => b.name.localeCompare(a.name))
    .map((d) => `
    <li>
      <a class="title" href="/decks/${encodeURIComponent(d.name)}.html">${esc(d.info.title)}</a>
      <span class="name">${esc(d.name)}.html</span>
      <span class="meta">${esc(d.info.theme)} / ${d.info.slideCount} 枚${d.info.brand !== 'none' ? ' / ブランド: ' + esc(d.info.brand) : ''}</span>
      <span class="links"><a href="/decks/${encodeURIComponent(d.name)}.html?print" target="_blank">印刷用</a></span>
    </li>`).join('');
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>Decks</title>
<style>
  body{margin:0;padding:48px;font-family:"BIZ UDPGothic","Yu Gothic UI",Meiryo,sans-serif;background:#f4f6fa;color:#1a1f2b}
  h1{margin:0 0 8px;font-size:28px}
  ul{list-style:none;margin:16px 0 0;padding:0;max-width:1080px}
  li{display:flex;align-items:baseline;gap:16px;padding:16px 20px;margin-bottom:8px;background:#fff;border-radius:10px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
  .title{font-size:20px;font-weight:700;color:#2563eb;text-decoration:none}
  .name{color:#6b7280;font-family:Consolas,monospace;font-size:14px}
  .meta{color:#6b7280;font-size:13px}
  .links{margin-left:auto;font-size:14px}.links a{color:#6b7280}
  p{color:#6b7280}
</style></head><body>
<h1>Decks</h1>
<p><a href="/gallery/">テーマギャラリー</a>　/　<a href="/examples/sample.html">機能の見本</a>　/　スライド表示中に <b>?</b> キーで操作一覧、<b>S</b> で発表者ビュー</p>
${rows ? `<ul>${rows}</ul>` : '<p>decks/ にデッキがありません。<code>npm run new -- my-talk "タイトル"</code> で作成できます。</p>'}
${RELOAD_SNIPPET}
</body></html>`;
}

// ---- サーバー -----------------------------------------------------------
function send(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === '/__reload') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (pathname === '/' || pathname === '/index.html') return send(res, 200, MIME['.html'], indexPage());
  // ブラウザで編集した文字を decks/ のファイルに直接保存する (E キー → Ctrl+S)
  if (pathname === '/__save') {
    return handleSave(req, res, {
      token: SAVE_TOKEN,
      resolveFile: (f) => {
        const p = resolveServedPath(f);
        return p && path.dirname(p) === DECKS_DIR && p.endsWith('.html') && fs.existsSync(p) ? p : null;
      },
      read: (p) => fs.readFileSync(p, 'utf8'),
      write: (p, oldHtml, newHtml) => saveDeckFile(DECKS_DIR, path.basename(p, '.html'), p, oldHtml, newHtml),
    });
  }

  let file = resolveServedPath(pathname);
  if (!file) return send(res, 403, 'text/plain; charset=utf-8', 'Forbidden');
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
    if (!pathname.endsWith('/')) {
      res.writeHead(301, { Location: pathname + '/' + url.search });
      return res.end();
    }
    file = path.join(file, 'index.html');
  }

  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'text/plain; charset=utf-8', 'Not found: ' + pathname);
    const ext = path.extname(file).toLowerCase();
    if (ext !== '.html') return send(res, 200, MIME[ext] || 'application/octet-stream', data);
    let html = data.toString('utf8');
    if (path.dirname(file) === DECKS_DIR && isDeckHtml(html)) {
      html = injectSaveConfig(html, { endpoint: '/__save', file: pathname, token: SAVE_TOKEN });
    }
    if (!url.searchParams.has('print')) html = html.replace(/<\/body>(?![\s\S]*<\/body>)/i, RELOAD_SNIPPET + '</body>');
    send(res, 200, MIME['.html'], html);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Deck server: http://localhost:${PORT}\n`);
});
