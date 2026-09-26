// vault-broker.test.ts — FR-WIKI-02 / FR-SEC-02 broker regressions (M0 WS-D, A03).
//
// Run: node --import tsx --test src/vault-broker.test.ts
//
// Over a temp vault: containment on every operation (traversal, absolute and
// junction escapes write nothing outside), create-never-clobbers, the
// compare-and-swap conflict flow (including an external edit), identity and
// unknown-key preservation, append-only enforcement in both directions, hardlink
// refusal on append, lock contention, and the daily-note generator on the broker.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { lock } from 'proper-lockfile';

import {
  AppendOnlyViolationError,
  NoteIdentityError,
  VaultBroker,
  hashContent,
} from './vault-broker.js';
import { VaultPathError } from './vault-path.js';
import { makeFrontmatter, parseNote, validateFrontmatter } from './frontmatter.js';
import { generateDailyNote, dailyNoteRelPath } from './daily.js';
import { WikilinkViolationError } from './atomic.js';

async function sandbox(): Promise<{ base: string; vault: string; evil: string }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'skippy-broker-'));
  const vault = path.join(base, 'v');
  const evil = path.join(base, 'vault-evil');
  await fs.mkdir(vault);
  await fs.mkdir(evil);
  return { base, vault, evil };
}

function concept(extra: Record<string, unknown> = {}) {
  return makeFrontmatter({
    title: 'Plasma',
    type: 'concept',
    authored_by: 'test',
    source: 'ref://t',
    extra,
  });
}

async function listFiles(dir: string): Promise<string[]> {
  return (await fs.readdir(dir, { recursive: true })).map(String);
}

// ── Containment on write ─────────────────────────────────────────────────────

test('createNote rejects traversal and absolute paths and writes nothing outside', async () => {
  const { base, vault } = await sandbox();
  const b = new VaultBroker(vault);
  for (const bad of [
    '../evil.md',
    '../../evil.md',
    path.join(base, 'evil.md'), // absolute on this host
    'C:evil.md',
    '\\\\?\\' + path.join(base, 'evil.md'),
    'note.md:ads',
  ]) {
    await assert.rejects(b.createNote(bad, concept(), 'x'), VaultPathError, bad);
  }
  await assert.rejects(fs.access(path.join(base, 'evil.md')));
});

test('createNote through an escaping junction is rejected; the target dir stays empty', async () => {
  const { vault, evil } = await sandbox();
  fsSync.symlinkSync(evil, path.join(vault, '20_Topics'), 'junction');
  const b = new VaultBroker(vault);
  await assert.rejects(
    b.createNote('20_Topics/plasma.md', concept(), 'x'),
    (e: unknown) => e instanceof VaultPathError && e.violation === 'escapes_root',
  );
  await assert.rejects(
    b.createNote('20_Topics/sub/new.md', concept(), 'x'),
    (e: unknown) => e instanceof VaultPathError && e.violation === 'escapes_root',
  );
  assert.deepEqual(await listFiles(evil), []);
});

test('appendNote/updateNote reject the same escapes', async () => {
  const { vault, evil } = await sandbox();
  fsSync.symlinkSync(evil, path.join(vault, '50_Agents'), 'junction');
  await fs.writeFile(path.join(evil, 'agent_log.md'), '---\ntype: agent_log\n---\n');
  const b = new VaultBroker(vault);
  await assert.rejects(b.appendNote('50_Agents/agent_log.md', 'pwn'), VaultPathError);
  await assert.rejects(b.updateNote('../vault-evil/agent_log.md', 'h', () => ({ body: 'x' })), VaultPathError);
  assert.equal(await fs.readFile(path.join(evil, 'agent_log.md'), 'utf8'), '---\ntype: agent_log\n---\n');
});

// ── create ───────────────────────────────────────────────────────────────────

test('createNote writes a valid note under a new subdir and never clobbers', async () => {
  const { vault } = await sandbox();
  const b = new VaultBroker(vault);
  const first = await b.createNote('30_Projects/new/deeper/p.md', concept(), '# P\n');
  assert.equal(first.ok, true);
  const abs = path.join(vault, '30_Projects', 'new', 'deeper', 'p.md');
  const raw = await fs.readFile(abs);
  assert.equal(first.ok && first.hash, hashContent(raw));
  assert.equal(first.ok && first.absPath, abs);
  assert.ok(validateFrontmatter(parseNote(raw.toString('utf8')).frontmatter).ok);

  const second = await b.createNote('30_Projects\\new\\deeper\\p.md', concept(), 'CLOBBER');
  assert.equal(second.ok, false);
  assert.equal(!second.ok && second.reason, 'exists');
  assert.equal(!second.ok && second.currentHash, hashContent(raw));
  assert.deepEqual(await fs.readFile(abs), raw, 'existing note untouched');
});

test('createNote enforces §8.3 frontmatter and the wikilink guard before I/O', async () => {
  const { vault } = await sandbox();
  const b = new VaultBroker(vault);
  await assert.rejects(b.createNote('a.md', { title: 'no id' }, 'x'), /invalid frontmatter/);
  await assert.rejects(b.createNote('b.md', concept(), 'see [x](./x.md)'), WikilinkViolationError);
  assert.deepEqual(await listFiles(vault), []);
});

// ── update (compare-and-swap + preservation) ─────────────────────────────────

test('updateNote with a stale hash is a conflict and changes nothing', async () => {
  const { vault } = await sandbox();
  const b = new VaultBroker(vault);
  await b.createNote('20_Topics/p.md', concept(), '# P\n');
  const before = await b.readNote('20_Topics/p.md');
  assert.ok(before);
  const res = await b.updateNote('20_Topics/p.md', 'f'.repeat(64), () => ({ body: 'NEW' }));
  assert.equal(res.ok, false);
  assert.equal(!res.ok && res.reason, 'conflict');
  assert.equal(!res.ok && res.currentHash, before.hash);
  assert.equal(!res.ok && res.current, before.raw);
  assert.equal((await b.readNote('20_Topics/p.md'))?.hash, before.hash);
});

test('an external edit after the read produces a conflict (rebase flow)', async () => {
  const { vault } = await sandbox();
  const b = new VaultBroker(vault);
  await b.createNote('20_Topics/p.md', concept(), '# P\n');
  const snap = await b.readNote('20_Topics/p.md');
  assert.ok(snap);
  // Obsidian (or a human) edits the file without our lock.
  await fs.writeFile(path.join(vault, '20_Topics', 'p.md'), snap.raw + '\nhuman edit\n');
  const res = await b.updateNote('20_Topics/p.md', snap.hash, () => ({ body: 'agent body' }));
  assert.equal(!res.ok && res.reason, 'conflict');
  assert.match(!res.ok ? (res.current ?? '') : '', /human edit/);

  // Rebase: re-read, re-apply on top of the human edit, and retry.
  const fresh = await b.readNote('20_Topics/p.md');
  assert.ok(fresh);
  const retry = await b.updateNote('20_Topics/p.md', fresh.hash, (cur) => ({
    body: `${cur.body}agent addition\n`,
  }));
  assert.equal(retry.ok, true);
  const after = await fs.readFile(path.join(vault, '20_Topics', 'p.md'), 'utf8');
  assert.match(after, /human edit/);
  assert.match(after, /agent addition/);
});

test('updateNote preserves id, created_at, unknown keys and the body', async () => {
  const { vault } = await sandbox();
  let clock = new Date('2030-01-01T00:00:00.000Z');
  const b = new VaultBroker(vault, { now: () => clock });
  const fm = concept({ schema_version: 2, rollup: { week: '2026-W39', ids: ['a', 'b'] } });
  await b.createNote('20_Topics/p.md', fm, '# P\n\nAuthored by a human.\n');
  const snap = await b.readNote('20_Topics/p.md');
  assert.ok(snap);

  // Frontmatter-only patch: body must survive byte-for-byte.
  const r1 = await b.updateNote('20_Topics/p.md', snap.hash, () => ({
    frontmatter: { title: 'Plasma (renamed)', status: 'canonical', tags: ['physics'] },
  }));
  assert.equal(r1.ok, true);
  const after1 = await b.readNote('20_Topics/p.md');
  assert.ok(after1);
  assert.equal(after1.frontmatter['id'], fm.id);
  assert.equal(after1.frontmatter['created_at'], fm.created_at);
  assert.equal(after1.frontmatter['updated_at'], '2030-01-01T00:00:00.000Z');
  assert.equal(after1.frontmatter['title'], 'Plasma (renamed)');
  assert.equal(after1.frontmatter['schema_version'], 2);
  assert.deepEqual(after1.frontmatter['rollup'], { week: '2026-W39', ids: ['a', 'b'] });
  assert.equal(after1.body, snap.body);

  // Body patch: frontmatter identity still preserved; undefined patch values ignored.
  clock = new Date('2030-01-02T00:00:00.000Z');
  const r2 = await b.updateNote('20_Topics/p.md', after1.hash, (cur) => ({
    frontmatter: { id: cur.frontmatter['id'], source: undefined },
    body: `${cur.body}More.\n`,
  }));
  assert.equal(r2.ok, true);
  const after2 = await b.readNote('20_Topics/p.md');
  assert.ok(after2);
  assert.equal(after2.frontmatter['id'], fm.id);
  assert.equal(after2.frontmatter['source'], 'ref://t');
  assert.equal(after2.frontmatter['created_at'], fm.created_at);
  assert.match(after2.body, /Authored by a human\.\nMore\.\n$/);

  // A mutator returning null writes nothing.
  const r3 = await b.updateNote('20_Topics/p.md', after2.hash, () => null);
  assert.equal(r3.ok && r3.changed, false);
  assert.equal((await b.readNote('20_Topics/p.md'))?.hash, after2.hash);
});

test('updateNote refuses to change id or created_at', async () => {
  const { vault } = await sandbox();
  const b = new VaultBroker(vault);
  await b.createNote('p.md', concept(), 'x');
  const snap = await b.readNote('p.md');
  assert.ok(snap);
  await assert.rejects(
    b.updateNote('p.md', snap.hash, () => ({ frontmatter: { id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' } })),
    NoteIdentityError,
  );
  await assert.rejects(
    b.updateNote('p.md', snap.hash, () => ({ frontmatter: { created_at: '1999-01-01T00:00:00Z' } })),
    NoteIdentityError,
  );
  assert.equal((await b.readNote('p.md'))?.hash, snap.hash);
});

test('updateNote on a missing note is not_found (never an implicit create)', async () => {
  const { vault } = await sandbox();
  const res = await new VaultBroker(vault).updateNote('nope.md', 'h', () => ({ body: 'x' }));
  assert.equal(!res.ok && res.reason, 'not_found');
  assert.deepEqual(await listFiles(vault), []);
});

// ── append-only ──────────────────────────────────────────────────────────────

function agentLogFm() {
  return makeFrontmatter({
    title: 'research — agent log',
    type: 'agent_log',
    status: 'active',
    authored_by: 'board.research',
    source: 'gen://test',
  });
}

test('appendNote creates with a header once, then only appends (prefix preserved)', async () => {
  const { vault } = await sandbox();
  const b = new VaultBroker(vault);
  const rel = '50_Agents/research/agent_log.md';
  const init = { frontmatter: agentLogFm(), body: '# log\n' };
  const r1 = await b.appendNote(rel, '## one', { init });
  assert.equal(r1.ok && r1.created, true);
  const abs = path.join(vault, '50_Agents', 'research', 'agent_log.md');
  const afterOne = await fs.readFile(abs, 'utf8');

  const r2 = await b.appendNote(rel, '## two', { init });
  assert.equal(r2.ok && r2.created, false);
  const afterTwo = await fs.readFile(abs, 'utf8');
  assert.ok(afterTwo.startsWith(afterOne), 'existing bytes are never rewritten');
  assert.equal(afterTwo.slice(afterOne.length), '\n## two\n');
  assert.equal(r2.ok && r2.hash, hashContent(afterTwo));

  const noInit = await b.appendNote('50_Agents/x/agent_log.md', 'hi');
  assert.equal(!noInit.ok && noInit.reason, 'not_found');
});

test('general update cannot bypass append-only notes', async () => {
  const { vault } = await sandbox();
  const b = new VaultBroker(vault);
  const rel = '50_Agents/research/agent_log.md';
  await b.appendNote(rel, '## one', { init: { frontmatter: agentLogFm(), body: '# log\n' } });
  const snap = await b.readNote(rel);
  assert.ok(snap);
  await assert.rejects(b.updateNote(rel, snap.hash, () => ({ body: 'rewritten' })), AppendOnlyViolationError);

  // Nor can a normal note be converted into an append-only type.
  await b.createNote('p.md', concept(), 'x');
  const p = await b.readNote('p.md');
  assert.ok(p);
  await assert.rejects(
    b.updateNote('p.md', p.hash, () => ({ frontmatter: { type: 'daily' } })),
    AppendOnlyViolationError,
  );
  // And appendNote refuses non-append-only notes and non-append-only init headers.
  await assert.rejects(b.appendNote('p.md', 'more'), AppendOnlyViolationError);
  await assert.rejects(
    b.appendNote('q.md', 'x', { init: { frontmatter: concept(), body: '' } }),
    AppendOnlyViolationError,
  );
  assert.equal((await b.readNote(rel))?.hash, snap.hash);
});

test('appendNote refuses a hardlinked log (cannot append through to an outside file)', async () => {
  const { vault, evil } = await sandbox();
  const outside = path.join(evil, 'victim.md');
  const header = '---\nid: 01ARZ3NDEKTSV4RRFFQ69G5FAV\ntype: agent_log\n---\n';
  await fs.writeFile(outside, header);
  await fs.mkdir(path.join(vault, '50_Agents'));
  fsSync.linkSync(outside, path.join(vault, '50_Agents', 'agent_log.md'));
  const b = new VaultBroker(vault);
  await assert.rejects(b.appendNote('50_Agents/agent_log.md', 'pwn'), AppendOnlyViolationError);
  assert.equal(await fs.readFile(outside, 'utf8'), header);
});

// ── locking ──────────────────────────────────────────────────────────────────

test('a held lock yields `locked` instead of a write', async () => {
  const { vault } = await sandbox();
  const b = new VaultBroker(vault, { lockRetries: 0 });
  await b.createNote('20_Topics/p.md', concept(), 'x');
  const snap = await b.readNote('20_Topics/p.md');
  assert.ok(snap);
  const real = path.join(await fs.realpath(path.join(vault, '20_Topics')), 'p.md');
  const release = await lock(real, { realpath: false });
  try {
    const res = await b.updateNote('20_Topics/p.md', snap.hash, () => ({ body: 'y' }));
    assert.equal(!res.ok && res.reason, 'locked');
  } finally {
    await release();
  }
  assert.equal((await b.readNote('20_Topics/p.md'))?.hash, snap.hash);
});

// ── daily notes on the broker ────────────────────────────────────────────────

test('generateDailyNote creates once via the broker and the note is append-only', async () => {
  const { vault } = await sandbox();
  const date = new Date(2026, 8, 26);
  const first = await generateDailyNote({ vaultRoot: vault, date });
  assert.equal(first.created, true);
  assert.equal(first.path, path.join(vault, '40_Daily', '2026-09-26.md'));
  const raw = await fs.readFile(first.path, 'utf8');
  const v = validateFrontmatter(parseNote(raw).frontmatter);
  assert.ok(v.ok, v.ok ? '' : v.errors.join('; '));
  assert.equal(v.ok && v.value.type, 'daily');
  assert.match(raw, /\[\[board-devops\]\]/);

  const second = await generateDailyNote({ vaultRoot: vault, date });
  assert.equal(second.created, false);
  assert.equal(await fs.readFile(first.path, 'utf8'), raw);

  const b = new VaultBroker(vault);
  const rel = dailyNoteRelPath(date);
  const snap = await b.readNote(rel);
  assert.ok(snap);
  await assert.rejects(b.updateNote(rel, snap.hash, () => ({ body: 'x' })), AppendOnlyViolationError);
  const app = await b.appendNote(rel, '- [[board-research]] shipped');
  assert.equal(app.ok, true);
  assert.ok((await fs.readFile(first.path, 'utf8')).startsWith(raw));
});

test('hand-written notes with unquoted YAML timestamps keep their created_at', async () => {
  const { vault } = await sandbox();
  const raw = [
    '---',
    'id: 01HZX900AADAXXYTEMPXATE010',
    'title: Hand written',
    'created_at: 2026-05-14T00:00:00Z',
    'updated_at: 2026-05-14T00:00:00Z',
    'type: concept',
    'status: active',
    'authored_by: human',
    'custom_key: keep me',
    '---',
    '',
    'Body by a human.',
    '',
  ].join('\n');
  await fs.writeFile(path.join(vault, 'h.md'), raw);
  const b = new VaultBroker(vault);
  const snap = await b.readNote('h.md');
  assert.ok(snap);
  const res = await b.updateNote('h.md', snap.hash, () => ({ frontmatter: { status: 'canonical' } }));
  assert.equal(res.ok, true, JSON.stringify(res));
  const after = await b.readNote('h.md');
  assert.ok(after);
  assert.equal(Date.parse(String(after.frontmatter['created_at'])), Date.parse('2026-05-14T00:00:00Z'));
  assert.equal(after.frontmatter['id'], '01HZX900AADAXXYTEMPXATE010');
  assert.equal(after.frontmatter['custom_key'], 'keep me');
  assert.match(after.body, /Body by a human\./);
});
