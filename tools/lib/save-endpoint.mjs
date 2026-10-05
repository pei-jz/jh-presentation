// ブラウザで編集した文字を、元のファイルに直接保存するための HTTP エンドポイント
//
// ローカルサーバー (npm run dev / MCP の open_deck) からデッキを配信するときに使う。
//   - 配信する HTML に window.__JH_SAVE__ = { endpoint, file, token } を埋め込む
//   - エンジンは Ctrl+S で POST { file, changes } を送る (changes は deck-edit.js の applyEdit 形式)
//   - サーバーは編集箇所だけを書き換え、履歴を残してから保存する
// トークンはサーバー起動ごとの乱数。配信したページだけが知っているので、他のサイトからは保存できない。
import crypto from 'node:crypto';
import '../../engine/deck-edit.js';

const EditLib = globalThis.JhDeckEdit;
const MAX_BODY = 5 * 1024 * 1024;

export function createSaveToken() {
  return crypto.randomBytes(18).toString('hex');
}

/** 配信する HTML に保存先の情報を埋め込む */
export function injectSaveConfig(html, { endpoint, file, token }) {
  const cfg = JSON.stringify({ endpoint, file, token }).replace(/</g, '\\u003c');
  const tag = `<script>window.__JH_SAVE__=${cfg};</script>`;
  return /<\/body>(?![\s\S]*<\/body>)/i.test(html)
    ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, tag + '</body>')
    : html + tag;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('データが大きすぎます')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function reply(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** 変更の一覧をソースに適用する (1 件でも照合に失敗したら全体を中止) */
export function applyChanges(source, changes) {
  if (!Array.isArray(changes) || !changes.length) throw new Error('変更がありません');
  let out = source;
  for (const c of changes) {
    if (typeof c.slide !== 'number' || typeof c.index !== 'number' || typeof c.html !== 'string') throw new Error('変更の形式が不正です');
    out = EditLib.applyEdit(out, c).source;
  }
  return out;
}

/**
 * POST /__save を処理する
 * @param {object} opts
 * @param {string} opts.token
 * @param {(file:string) => string|null} opts.resolveFile  URL 上のファイル名 → 実ファイルのパス (許可しないなら null)
 * @param {(path:string) => string} opts.read
 * @param {(path:string, oldHtml:string, newHtml:string) => void} opts.write  履歴を残して保存する
 */
export async function handleSave(req, res, { token, resolveFile, read, write }) {
  if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'POST のみ' });
  if (req.headers['x-jh-token'] !== token) return reply(res, 403, { ok: false, error: 'トークンが一致しません (ページを開き直してください)' });
  try {
    const body = JSON.parse(await readBody(req));
    // 編集ルールの版が違うと「何番目の要素か」がずれるので、書き込まずに止める
    if (body.protocol !== EditLib.PROTOCOL) {
      return reply(res, 409, {
        ok: false,
        error: `デッキのエンジンが古いため保存できません (編集ルール v${body.protocol || 1} / 保存側 v${EditLib.PROTOCOL})。` +
          'AI に「upgrade_deck で最新にして」と頼むか npm run upgrade を実行してから、もう一度編集してください',
      });
    }
    const path = resolveFile(String(body.file || ''));
    if (!path) return reply(res, 403, { ok: false, error: '保存できない場所です' });
    const source = read(path);
    if (!EditLib.isDeck(source)) return reply(res, 400, { ok: false, error: 'デッキファイルではありません' });
    const next = applyChanges(source, body.changes);
    write(path, source, next);
    return reply(res, 200, { ok: true, path, changes: body.changes.length });
  } catch (e) {
    return reply(res, 409, { ok: false, error: e.message || String(e) });
  }
}
