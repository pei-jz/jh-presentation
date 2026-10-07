// デッキの保存先: dir 引数 → AI クライアントの作業フォルダ (MCP の roots) の decks/ → ワークスペース
//
// 本物の MCP サーバー (mcp/server.mjs) を起動し、MCP クライアントから呼んで確かめる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jh-ws-'));

/** MCP サーバーを起動してつなぐ。root を渡すと、クライアントの作業フォルダとして伝える */
async function connect({ workspace, root = null, args = [] }) {
  const client = new Client({ name: 'test', version: '1' }, { capabilities: root ? { roots: {} } : {} });
  if (root) client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: pathToFileURL(root).href, name: 'project' }] }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'mcp', 'server.mjs'), '--workspace', workspace, ...args],
    stderr: 'ignore',
  });
  await client.connect(transport);
  const call = async (name, a = {}) => {
    const r = await client.callTool({ name, arguments: a });
    const body = r.content.find((c) => c.type === 'text').text;
    if (r.isError) throw new Error(body);
    return JSON.parse(body);
  };
  return { client, call };
}

test('作業フォルダ (roots) があれば、その中の decks/ にデッキを作る', async () => {
  const workspace = tmp();
  const project = tmp();
  const { client, call } = await connect({ workspace, root: project });
  try {
    const r = await call('create_deck', { name: 'talk', title: 'T' });
    assert.equal(path.dirname(r.created.file), path.join(project, 'decks'));
    const list = await call('list_decks');
    assert.equal(list.folder, path.join(project, 'decks'));
    assert.equal(list.decks.length, 1);
    // 書き込み・読み込みも同じ場所
    await call('write_deck', { name: r.created.name, title: 'T2' });
    assert.equal((await call('list_decks')).decks[0].title, 'T2');
    // 設定 (ブランドなど) はワークスペースのまま
    assert.ok(fs.existsSync(path.join(workspace, 'brand', 'brand.json')));
    assert.ok(!fs.existsSync(path.join(project, 'brand')));
  } finally {
    await client.close();
  }
});

test('dir を渡せばそのフォルダ (作業フォルダからの相対パスも可)', async () => {
  const workspace = tmp();
  const project = tmp();
  const { client, call } = await connect({ workspace, root: project });
  try {
    const r = await call('create_deck', { name: 'talk', title: 'T', dir: 'slides/2026' });
    assert.equal(path.dirname(r.created.file), path.join(project, 'slides', '2026'));
    assert.equal((await call('list_decks', { dir: 'slides/2026' })).decks.length, 1);
    assert.equal((await call('list_decks')).decks.length, 0); // 既定の decks/ には無い
  } finally {
    await client.close();
  }
});

test('作業フォルダがないクライアント (Claude Desktop など) では、これまでどおりワークスペースに作る', async () => {
  const workspace = tmp();
  const { client, call } = await connect({ workspace });
  try {
    const r = await call('create_deck', { name: 'talk', title: 'T' });
    assert.equal(path.dirname(r.created.file), workspace);
  } finally {
    await client.close();
  }
});

test('--no-roots ならワークスペース、--decks-dir でフォルダ名を変えられる', async () => {
  const workspace = tmp();
  const project = tmp();
  let c = await connect({ workspace, root: project, args: ['--no-roots'] });
  try {
    const r = await c.call('create_deck', { name: 'a', title: 'A' });
    assert.equal(path.dirname(r.created.file), workspace);
  } finally {
    await c.client.close();
  }
  c = await connect({ workspace, root: project, args: ['--decks-dir', 'slides'] });
  try {
    const r = await c.call('create_deck', { name: 'b', title: 'B' });
    assert.equal(path.dirname(r.created.file), path.join(project, 'slides'));
  } finally {
    await c.client.close();
  }
});

test('プロジェクトに brand/ があれば、そのブランドを使う', async () => {
  const workspace = tmp();
  const project = tmp();
  fs.mkdirSync(path.join(project, 'brand'), { recursive: true });
  fs.writeFileSync(path.join(project, 'brand', 'brand.json'), JSON.stringify({ name: 'Project Co', position: 'footer' }));
  const { client, call } = await connect({ workspace, root: project });
  try {
    const r = await call('create_deck', { name: 'talk', title: 'T', brand: 'footer' });
    const html = fs.readFileSync(r.created.file, 'utf8');
    assert.ok(html.includes('Project Co'), 'プロジェクトのブランド名が埋め込まれる');
  } finally {
    await client.close();
  }
});
