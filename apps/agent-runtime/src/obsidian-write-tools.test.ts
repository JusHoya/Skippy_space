// obsidian-write-tools.test.ts — E3-3 regressions (M0 red team; FR-WIKI-02, FR-SEC-02).
//
// Run: node --import tsx --test src/obsidian-write-tools.test.ts
//
// `obsidian_patch_frontmatter` and `obsidian_append_block` used to send writes
// straight to the Obsidian Local REST API, bypassing the vault broker: no lock,
// no expected-hash check, no append-only type check, no real-path containment,
// no §8.3 validation, and an exact-match protected-key filter the plugin's
// URL-decoding defeats. They now write through the local VaultBroker and never
// touch REST. A fake REST server with a live key proves no request reaches it.

import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  ObsidianRestClient,
  VaultBroker,
  generateDailyNote,
  dailyNoteRelPath,
  makeFrontmatter,
} from '@skippy/memory';

import {
  handleObsidianAppendBlock,
  handleObsidianPatchFrontmatter,
  handleObsidianRead,
  handleObsidianWriteNote,
} from './mcp-handlers.js';

function textOf(r: { content: { type: string; text?: string }[] }): string {
  return r.content.map((c) => c.text ?? '').join('');
}

const restHits: string[] = [];
let server: http.Server;

before(async () => {
  server = http.createServer((req, res) => {
    restHits.push(`${req.method ?? '?'} ${req.url ?? '?'}`);
    res.writeHead(204).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  process.env.OBSIDIAN_API_URL = `http://127.0.0.1:${port}`;
  process.env.OBSIDIAN_API_KEY = 'live-key';
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert.deepEqual(restHits, [], 'no write reached the Obsidian REST API');
});

async function vaultWithNotes(): Promise<{ vault: string; broker: VaultBroker; topicHash: string; dailyRel: string }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'skippy-rest-write-'));
  const vault = path.join(base, 'v');
  await fs.mkdir(vault);
  const broker = new VaultBroker(vault);
  const fm = makeFrontmatter({ title: 'Plasma', type: 'concept', authored_by: 'test', source: 'ref://t' });
  const c = await broker.createNote('20_Topics/plasma.md', fm, 'Body.');
  assert.ok(c.ok);
  const date = new Date(2026, 8, 26);
  await generateDailyNote({ vaultRoot: vault, date });
  return { vault, broker, topicHash: c.hash, dailyRel: dailyNoteRelPath(date) };
}

test('obsidian_append_block refuses a non-append-only topic note', async () => {
  const { vault, broker, topicHash } = await vaultWithNotes();
  const r = await handleObsidianAppendBlock(vault, { path: '20_Topics/plasma.md', markdown: 'pwn' });
  assert.equal(r.isError, true, textOf(r));
  assert.match(textOf(r), /append-only/i);
  assert.equal((await broker.readNote('20_Topics/plasma.md'))?.hash, topicHash);
});

test('obsidian_append_block never creates a note (no frontmatter-less notes)', async () => {
  const { vault } = await vaultWithNotes();
  const r = await handleObsidianAppendBlock(vault, { path: '20_Topics/new.md', markdown: '# no frontmatter' });
  assert.equal(r.isError, true, textOf(r));
  await assert.rejects(fs.access(path.join(vault, '20_Topics', 'new.md')));
});

test('obsidian_append_block appends to a daily note through the broker', async () => {
  const { vault, broker, dailyRel } = await vaultWithNotes();
  const before = await broker.readNote(dailyRel);
  assert.ok(before);
  const r = await handleObsidianAppendBlock(vault, { path: dailyRel, markdown: '- [[board-research]] done' });
  assert.equal(r.isError, undefined, textOf(r));
  const now = await broker.readNote(dailyRel);
  assert.ok(now?.raw.startsWith(before.raw));
  assert.match(now?.raw ?? '', /board-research\]\] done/);
});

test('obsidian_patch_frontmatter refuses append-only (daily) notes', async () => {
  const { vault, broker, dailyRel } = await vaultWithNotes();
  const d = await broker.readNote(dailyRel);
  assert.ok(d);
  const r = await handleObsidianPatchFrontmatter(vault, {
    path: dailyRel,
    key: 'status',
    value: 'archived',
    expected_hash: d.hash,
  });
  assert.equal(r.isError, true, textOf(r));
  assert.equal((await broker.readNote(dailyRel))?.hash, d.hash);
});

test('obsidian_patch_frontmatter refuses protected keys in any spelling or encoding', async () => {
  const { vault, broker, topicHash } = await vaultWithNotes();
  for (const key of ['id', 'ID', '%69d', 'created%5Fat', '%74ype', 'Type', 'created_at']) {
    const r = await handleObsidianPatchFrontmatter(vault, {
      path: '20_Topics/plasma.md',
      key,
      value: 'x',
      expected_hash: topicHash,
    });
    assert.equal(r.isError, true, `${key}: ${textOf(r)}`);
  }
  assert.equal((await broker.readNote('20_Topics/plasma.md'))?.hash, topicHash);
});

test('obsidian_patch_frontmatter requires a matching expected_hash', async () => {
  const { vault, broker, topicHash } = await vaultWithNotes();
  const missing = await handleObsidianPatchFrontmatter(vault, {
    path: '20_Topics/plasma.md',
    key: 'status',
    value: 'canonical',
  });
  assert.equal(missing.isError, true);
  assert.match(textOf(missing), /expected_hash/);
  const stale = await handleObsidianPatchFrontmatter(vault, {
    path: '20_Topics/plasma.md',
    key: 'status',
    value: 'canonical',
    expected_hash: '0'.repeat(64),
  });
  assert.equal(stale.isError, true);
  assert.match(textOf(stale), /conflict/);
  assert.equal((await broker.readNote('20_Topics/plasma.md'))?.hash, topicHash);

  const ok = await handleObsidianPatchFrontmatter(vault, {
    path: '20_Topics/plasma.md',
    key: 'status',
    value: 'canonical',
    expected_hash: topicHash,
  });
  assert.equal(ok.isError, undefined, textOf(ok));
  assert.equal((await broker.readNote('20_Topics/plasma.md'))?.frontmatter['status'], 'canonical');
});

test('obsidian_read_note reads the local vault and prints the expected_hash', async () => {
  const { vault, topicHash } = await vaultWithNotes();
  const r = await handleObsidianRead(new ObsidianRestClient(), { path: '20_Topics/plasma.md' }, vault);
  assert.equal(r.isError, undefined, textOf(r));
  assert.ok(textOf(r).startsWith(`sha256: ${topicHash}\n\n---`));
  const hidden = await handleObsidianRead(new ObsidianRestClient(), { path: 'OBSIDI~1/workspace.md' }, vault);
  assert.equal(hidden.isError, true);
});

test('REST-backed write tools refuse 8.3 short-name and hidden paths', async () => {
  const { vault } = await vaultWithNotes();
  await fs.mkdir(path.join(vault, '.obsidian'));
  for (const p of ['OBSIDI~1/x.md', '.obsidian/x.md', '../x.md']) {
    const a = await handleObsidianAppendBlock(vault, { path: p, markdown: 'x' });
    assert.equal(a.isError, true, p);
    const f = await handleObsidianPatchFrontmatter(vault, {
      path: p,
      key: 'status',
      value: 'active',
      expected_hash: '0'.repeat(64),
    });
    assert.equal(f.isError, true, p);
    const w = await handleObsidianWriteNote(vault, { path: p, title: 'T', body: 'b', source: 'ref://t' });
    assert.equal(w.isError, true, p);
  }
  assert.deepEqual(await fs.readdir(path.join(vault, '.obsidian')), []);
});
