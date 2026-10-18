// MCP からマップ文書を扱う: create_map / read_map / write_map と、デッキと共通の道具 (検査・撮影・履歴・PDF・最新化)
//
// 本物の MCP サーバー (mcp/server.mjs) を起動し、MCP クライアントから呼んで確かめる。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jh-map-'));
let client, raw, call, project, name;

before(async () => {
  const workspace = tmp();
  project = tmp();
  client = new Client({ name: 'test', version: '1' }, { capabilities: { roots: {} } });
  client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: pathToFileURL(project).href, name: 'project' }] }));
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'mcp', 'server.mjs'), '--workspace', workspace],
    stderr: 'ignore',
  }));
  raw = (n, a = {}) => client.callTool({ name: n, arguments: a });
  call = async (n, a = {}) => {
    const r = await raw(n, a);
    const body = r.content.find((c) => c.type === 'text').text;
    if (r.isError) throw new Error(body);
    return JSON.parse(body);
  };
});
after(async () => { await client?.close(); });

const goodMap = {
  title: '受注',
  nodes: [
    { id: 'web', label: '画面' },
    { id: 'sys', label: '受注システム', detail: '<p>受注の中身</p>', children: { nodes: [
      { id: 'sys.api', label: 'API' },
      { id: 'sys.db', label: '受注 DB', kind: 'db' },
    ] } },
  ],
  edges: [
    { from: 'web', to: 'sys.api', label: '注文', data: ['注文'] },
    { from: 'sys.api', to: 'sys.db', label: '保存', data: ['注文'] },
  ],
  flows: [{ id: 'f', label: '注文の流れ', path: ['web', 'sys.api', 'sys.db'] }],
};

test('create_map: 作業フォルダの maps/ に、書き方の見本入りで作る。list_decks の maps に出る', async () => {
  const r = await call('create_map', { name: 'order', title: '受注システム' });
  name = r.created.name;
  assert.equal(r.created.kind, 'map');
  assert.equal(path.dirname(r.created.file), path.join(project, 'maps'));
  assert.ok(r.created.nodeCount > 0, '最初のマップが入っている');
  const list = await call('list_decks');
  assert.equal(list.decks.length, 0);
  assert.deepEqual(list.maps.map((m) => m.name), [name]);
  assert.equal(list.mapsFolder, path.join(project, 'maps'));
});

test('write_map: データの誤りは audit の data で返り、直すと ok になる。read_map で読み戻せる', async () => {
  const bad = { ...goodMap, edges: [...goodMap.edges, { from: 'web', to: 'nowhere' }], flows: [{ id: 'g', label: '途切れ', path: ['web', 'sys.db'] }] };
  const r1 = await call('write_map', { name, map: bad });
  assert.equal(r1.audit.ok, false);
  assert.deepEqual(r1.audit.issues.data.map((i) => i.message), [
    '矢印の端のノードがありません: web -> nowhere',
    '流れ「途切れ」の web → sys.db に矢印がありません (edges に書く)',
  ]);

  const r2 = await call('write_map', { name, map: goodMap, title: '受注システム v2' });
  assert.equal(r2.audit.ok, true, JSON.stringify(r2.audit));
  assert.equal(r2.saved.title, '受注システム v2');

  const read = await raw('read_map', { name });
  const info = JSON.parse(read.content[0].text);
  assert.equal(info.revision, r2.revision);
  assert.deepEqual(JSON.parse(read.content[1].text.replace('=== map ===\n', '')), goodMap);

  // 古い revision では書き込めない
  await assert.rejects(call('write_map', { name, title: 'x', revision: r1.revision }), /revision/);
  // JSON として壊れたデータは保存しない
  await assert.rejects(call('write_map', { name, map: '{ "nodes": ' }), /JSON として読めません/);
});

test('デッキの道具をマップに使うと案内し、マップの道具をデッキに使うと案内する', async () => {
  await assert.rejects(call('read_deck', { name }), /read_map/);
  const deck = await call('create_deck', { name: 'talk', title: 'T' });
  await assert.rejects(call('read_map', { name: deck.created.name }), /read_deck/);
  await assert.rejects(call('write_map', { name: deck.created.name, title: 'x' }), /write_deck/);
});

test('screenshot_deck: マップ文書は階層ごと、select で部品を選んだ状態を撮る', async () => {
  const r = await raw('screenshot_deck', { name, levels: ['', 'sys'] });
  const labels = r.content.filter((c) => c.type === 'text').map((c) => c.text);
  assert.deepEqual(labels, ['受注', '受注 › 受注システム']);
  assert.equal(r.content.filter((c) => c.type === 'image').length, 2);

  const s = await raw('screenshot_deck', { name, select: 'sys.db' });
  assert.equal(s.content[0].text, '受注 › 受注システム › 受注 DB');
  assert.equal(s.content[1].type, 'image');
});

test('audit_deck・list_history・restore_history・export_deck・upgrade_deck はマップにも使える', async () => {
  const a = await call('audit_deck', { name });
  assert.equal(a.kind, 'map');
  assert.equal(a.ok, true);
  assert.deepEqual(a.levels.map((l) => l.id), ['', 'sys']);

  const h = await call('list_history', { name });
  assert.ok(h.history.length >= 2);
  const restored = await call('restore_history', { name, id: h.history[h.history.length - 1].id }); // 最初の版 (作成直後)
  assert.equal(restored.restored.kind, 'map');
  assert.equal(restored.restored.title, '受注システム');

  const pdf = await call('export_deck', { name });
  assert.ok(fs.existsSync(pdf.exported) && fs.statSync(pdf.exported).size > 1000);

  const up = await call('upgrade_deck', {});
  assert.ok(up.upgraded.includes(name), 'マップ文書も最新化する');
});

test('大きなマップの一部だけ: outline で目次、node で箱ごとに読み、node + part で箱ごとに置き換える', async () => {
  await call('write_map', { name, map: goodMap });
  const ol = await raw('read_map', { name, outline: true });
  const outline = JSON.parse(ol.content[1].text.replace('=== outline ===\n', ''));
  assert.deepEqual(outline.nodes.map((n) => n.id), ['web', 'sys']);
  assert.deepEqual(outline.nodes[1].children.map((n) => n.id), ['sys.api', 'sys.db']);
  assert.equal(outline.nodes[1].detail, undefined, '目次には detail を含めない');

  const part = await raw('read_map', { name, node: 'sys' });
  const head = JSON.parse(part.content[0].text);
  const node = JSON.parse(part.content[1].text.replace('=== part ===\n', ''));
  const ctx = JSON.parse(part.content[2].text.replace(/^=== context[^\n]*\n/, ''));
  assert.equal(node.id, 'sys');
  assert.equal(ctx.edges.length, 2, '外 (全体の edges) に書かれた、中につながる矢印');
  assert.deepEqual(ctx.flows.map((f) => f.id), ['f']);

  node.children.nodes.push({ id: 'sys.mq', label: '通知キュー', kind: 'queue' });
  node.children.edges = [{ from: 'sys.api', to: 'sys.mq', label: '通知' }];
  const w = await call('write_map', { name, node: 'sys', part: node, revision: head.revision });
  assert.equal(w.audit.ok, true, JSON.stringify(w.audit));
  const full = await raw('read_map', { name });
  const map = JSON.parse(full.content[1].text.replace('=== map ===\n', ''));
  assert.deepEqual(map.nodes[1].children.nodes.map((n) => n.id), ['sys.api', 'sys.db', 'sys.mq']);
  assert.deepEqual(map.nodes[0], goodMap.nodes[0], '他の箱はそのまま');
  assert.deepEqual(map.edges, goodMap.edges);

  await assert.rejects(call('write_map', { name, node: 'sys', part: { id: 'other', label: 'x' } }), /id/);
  await assert.rejects(call('write_map', { name, node: 'nope', part: { id: 'nope' } }), /見つかりません/);
  await assert.rejects(call('write_map', { name, node: 'sys' }), /node と part/);
  await assert.rejects(call('write_map', { name, node: 'sys', part: node, revision: head.revision }), /revision/);
});
