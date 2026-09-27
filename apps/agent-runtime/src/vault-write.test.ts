// vault-write.test.ts — MCP vault-write containment regressions (M0 WS-D, A03).
//
// Run: node --import tsx --test src/vault-write.test.ts
//
// Proves the agent-facing write tools route through the @skippy/memory
// VaultBroker: obsidian_write_note rejects traversal/absolute/UNC/ADS/junction
// escapes as isError (never throws, never writes outside the vault), refuses to
// clobber an existing note without expected_hash, edits compare-and-swap while
// preserving note identity, and cannot touch append-only notes. The Letta
// archival mirror cannot be steered out of the vault by a hostile board name.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  LettaClient,
  VaultBroker,
  containmentPathGuard,
  dailyNoteRelPath,
  generateDailyNote,
  mirrorArchivalToVault,
  parseNote,
} from '@skippy/memory';

import { handleObsidianWriteNote, handleLettaAppend } from './mcp-handlers.js';
import type { PathGuard } from './tool-policy.js';

// Compile-time proof that the memory containment adapter plugs into WS-C's
// tool-policy hook (`EnforcementHooks.pathGuard`) without a wrapper.
const vaultPathGuard: PathGuard = containmentPathGuard;

process.env.LETTA_DISABLED = '1';

function textOf(r: { content: { type: string; text?: string }[] }): string {
  return r.content.map((c) => c.text ?? '').join('');
}

/** base/{v (vault), vault-evil (prefix-sibling target)}. */
async function sandbox(): Promise<{ base: string; vault: string; evil: string }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'skippy-mcp-vault-'));
  const vault = path.join(base, 'v');
  const evil = path.join(base, 'vault-evil');
  await fs.mkdir(vault);
  await fs.mkdir(evil);
  return { base, vault, evil };
}

const note = (p: string, extra: Record<string, string> = {}) => ({
  path: p,
  title: 'Evil',
  body: 'payload',
  source: 'ref://test',
  ...extra,
});

test('obsidian_write_note rejects ../../evil.md and writes nothing outside the vault', async () => {
  const { base, vault } = await sandbox();
  const r = await handleObsidianWriteNote(vault, note('../../evil.md'));
  assert.equal(r.isError, true);
  assert.match(textOf(r), /traversal/);
  for (const p of [path.resolve(vault, '../../evil.md'), path.resolve(vault, '../evil.md'), path.join(base, 'evil.md')]) {
    await assert.rejects(fs.access(p), `nothing written at ${p}`);
  }
});

test('obsidian_write_note rejects absolute, drive-relative, UNC, device and ADS paths', async () => {
  const { base, vault } = await sandbox();
  const cases = [
    path.join(base, 'evil.md'),
    'C:evil.md',
    '\\\\server\\share\\evil.md',
    '\\\\?\\' + path.join(base, 'evil.md'),
    '\\\\.\\' + path.join(base, 'evil.md'),
    '/tmp/evil.md',
    '20_Topics/x.md:hidden',
    '.obsidian/evil.md',
  ];
  for (const p of cases) {
    const r = await handleObsidianWriteNote(vault, note(p));
    assert.equal(r.isError, true, `${p} -> ${textOf(r)}`);
    assert.match(textOf(r), /Vault path rejected/, p);
  }
  await assert.rejects(fs.access(path.join(base, 'evil.md')));
  assert.deepEqual(await fs.readdir(vault), []);
});

test('obsidian_write_note rejects a junction escape to a prefix-sibling directory', async () => {
  const { vault, evil } = await sandbox();
  fsSync.symlinkSync(evil, path.join(vault, '20_Topics'), 'junction');
  const r = await handleObsidianWriteNote(vault, note('20_Topics/evil.md'));
  assert.equal(r.isError, true);
  assert.match(textOf(r), /escapes_root/);
  assert.deepEqual(await fs.readdir(evil), []);
});

test('obsidian_write_note never clobbers; edits need expected_hash and preserve identity', async () => {
  const { vault } = await sandbox();
  const created = await handleObsidianWriteNote(vault, {
    path: '20_Topics/alpha.md',
    title: 'Alpha',
    body: 'First body with [[beta]].',
    source: 'ref://test',
  });
  assert.notEqual(created.isError, true, textOf(created));
  const broker = new VaultBroker(vault);
  const v1 = await broker.readNote('20_Topics/alpha.md');
  assert.ok(v1);

  // Blind overwrite is refused, and the note is untouched.
  const blind = await handleObsidianWriteNote(vault, {
    path: '20_Topics/alpha.md',
    title: 'Alpha',
    body: 'CLOBBER',
  });
  assert.equal(blind.isError, true);
  assert.match(textOf(blind), /already exists/);
  assert.equal((await broker.readNote('20_Topics/alpha.md'))?.hash, v1.hash);

  // A stale hash is a conflict.
  const stale = await handleObsidianWriteNote(vault, {
    path: '20_Topics/alpha.md',
    title: 'Alpha',
    body: 'stale edit',
    expected_hash: '0'.repeat(64),
  });
  assert.equal(stale.isError, true);
  assert.match(textOf(stale), /conflict/);

  // The right hash edits in place; id and created_at survive.
  const edit = await handleObsidianWriteNote(vault, {
    path: '20_Topics/alpha.md',
    title: 'Alpha v2',
    body: 'Second body.',
    expected_hash: v1.hash,
  });
  assert.notEqual(edit.isError, true, textOf(edit));
  const v2 = await broker.readNote('20_Topics/alpha.md');
  assert.ok(v2);
  assert.equal(v2.frontmatter['id'], v1.frontmatter['id']);
  assert.equal(v2.frontmatter['created_at'], v1.frontmatter['created_at']);
  assert.equal(v2.frontmatter['title'], 'Alpha v2');
  assert.equal(v2.frontmatter['source'], 'ref://test');
  assert.match(parseNote(v2.raw).body, /Second body\./);
});

test('obsidian_write_note cannot write append-only notes', async () => {
  const { vault } = await sandbox();
  for (const type of ['agent_log', 'daily']) {
    const r = await handleObsidianWriteNote(vault, note(`50_Agents/x/${type}.md`, { type }));
    assert.equal(r.isError, true);
    assert.match(textOf(r), /append-only/);
  }
  // Nor overwrite an existing agent log via expected_hash.
  const client = new LettaClient();
  await handleLettaAppend(client, 'bd', 'research', vault, { text: 'entry' });
  const log = await new VaultBroker(vault).readNote('50_Agents/research/agent_log.md');
  assert.ok(log);
  const r = await handleObsidianWriteNote(vault, {
    path: '50_Agents/research/agent_log.md',
    title: 'x',
    body: 'rewritten',
    expected_hash: log.hash,
  });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /Append-only/i);
  assert.equal((await new VaultBroker(vault).readNote('50_Agents/research/agent_log.md'))?.hash, log.hash);
});

test('letta_append_archival cannot escape the vault through the board name', async () => {
  const { base, vault } = await sandbox();
  const client = new LettaClient();
  const r = await handleLettaAppend(client, 'bd', '../../escape', vault, { text: 'x' });
  // Letta is disabled AND the mirror refused the path -> hard error, nothing written.
  assert.equal(r.isError, true, textOf(r));
  assert.match(textOf(r), /vault mirror failed/);
  await assert.rejects(fs.access(path.join(base, 'escape')));
  await assert.rejects(fs.access(path.resolve(vault, '..', '..', 'escape')));
});

test('containmentPathGuard satisfies tool-policy PathGuard and rejects a junction escape', async () => {
  const { vault, evil } = await sandbox();
  fsSync.symlinkSync(evil, path.join(vault, 'j'), 'junction');
  assert.deepEqual(await vaultPathGuard('notes/a.md', [vault], vault), { ok: true });
  const r = await vaultPathGuard('j/a.md', [vault], vault);
  assert.equal(r.ok, false);
});

// M0 red-team round 2, N4 (FR-WIKI-02): the tool cannot squat the append-only
// daily / agent_log paths with a general note (which would then be overwritable
// with expected_hash and make the daily generator / archival mirror fail).
test('RT2-N4: obsidian_write_note cannot squat a daily or agent_log path', async () => {
  const { vault } = await sandbox();
  const tomorrow = new Date(Date.now() + 86_400_000);
  const rel = dailyNoteRelPath(tomorrow);
  const daily = await handleObsidianWriteNote(vault, { path: rel, title: 'fake daily', body: 'overwritable' });
  assert.equal(daily.isError, true, textOf(daily));
  assert.match(textOf(daily), /append-only|reserved/i);
  assert.equal(await fs.access(path.join(vault, ...rel.split('/'))).then(() => true, () => false), false);
  assert.equal((await generateDailyNote({ vaultRoot: vault, date: tomorrow })).created, true);

  const log = await handleObsidianWriteNote(vault, {
    path: '50_Agents/research/agent_log.md',
    title: 'x',
    body: 'squat',
  });
  assert.equal(log.isError, true, textOf(log));
  const m = await mirrorArchivalToVault({ board: 'research', text: 'memory', vaultRoot: vault });
  assert.equal(m.ok, true, m.error);
});
