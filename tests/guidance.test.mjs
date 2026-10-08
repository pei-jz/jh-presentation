// MCP の「手順を飛ばしがちなモデル」向けの補助: ガイドの添付と、書き込み後の自動検査
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { summarizeAudit } from '../mcp/render.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

async function connect() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-guide-'));
  const client = new Client({ name: 'test', version: '1' }, { capabilities: {} });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'mcp', 'server.mjs'), '--workspace', workspace],
    stderr: 'ignore',
  }));
  const call = async (name, a = {}) => {
    const r = await client.callTool({ name, arguments: a });
    const texts = r.content.filter((c) => c.type === 'text').map((c) => c.text);
    if (r.isError) throw new Error(texts[0]);
    return { body: JSON.parse(texts[0]), extra: texts.slice(1) };
  };
  return { client, call };
}

test('get_guide を読まずに create_deck を呼ぶと、ガイドが添えられる (読んだ後は添えない)', async () => {
  const { client, call } = await connect();
  try {
    const first = await call('create_deck', { name: 'a', title: 'A' });
    assert.equal(first.extra.length, 1);
    assert.match(first.extra[0], /部品カタログ/);
    assert.match(first.extra[0], /良い例/);
    const second = await call('create_deck', { name: 'b', title: 'B' });
    assert.equal(second.extra.length, 0);
  } finally {
    await client.close();
  }
});

test('道具の説明にプレゼン資料を表す言葉が入っている (言葉で道具を選ぶクライアント向け)', async () => {
  const { client } = await connect();
  try {
    const { tools } = await client.listTools();
    for (const name of ['get_guide', 'create_deck', 'write_deck', 'replace_slide']) {
      const t = tools.find((x) => x.name === name);
      assert.match(t.description, /プレゼンテーション資料/, name);
    }
    assert.match(client.getInstructions(), /プレゼン/);
  } finally {
    await client.close();
  }
});

test('write_deck / replace_slide は書き込み後の検査結果を audit に返す', async (t) => {
  const { client, call } = await connect();
  try {
    const { body: created } = await call('create_deck', { name: 'c', title: 'C' });
    const name = created.created.name;
    const good = await call('write_deck', { name, slides: '<section class="slide" id="s1"><h2>見出し</h2><p>本文</p></section>' });
    if (good.body.audit.skipped) return t.skip(good.body.audit.skipped);
    assert.equal(good.body.audit.ok, true);
    const longText = '長い文章が入りすぎたカード。'.repeat(80);
    const bad = await call('replace_slide', {
      name, target: 's1', slide: `<section class="slide" id="s1"><h2>見出し</h2><div class="card" style="height:200px"><p>${longText}</p></div></section>`,
    });
    assert.equal(bad.body.audit.ok, false);
    assert.ok(bad.body.audit.issues.overflow, JSON.stringify(bad.body.audit));
  } finally {
    await client.close();
  }
});

test('summarizeAudit: 問題がなければ 1 行、あれば種類ごとに最大 10 件', () => {
  assert.deepEqual(Object.keys(summarizeAudit({ ok: true })), ['ok', 'message']);
  const many = Array.from({ length: 12 }, (_, i) => ({ slide: i + 1 }));
  const s = summarizeAudit({ ok: false, overflow: many, overlap: [], errors: ['boom'] });
  assert.equal(s.ok, false);
  assert.equal(s.issues.overflow.length, 11);
  assert.equal(s.issues.overflow[10], 'ほか 2 件');
  assert.deepEqual(s.issues.errors, ['boom']);
  assert.equal(s.issues.overlap, undefined);
});
