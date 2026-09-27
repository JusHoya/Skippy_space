// unicode-names.redteam.test.ts — regressions for the M0 NFC/NFD round on
// EC3/EC4 (FR-SEC-02 "case normalization", FR-WIKI-02 identity, FR-WIKI-03
// "every inbox drop is ingested or reported"). Every UN-D* test fails on
// 75b245f; UN-R is a guard that the rules still see normalized forms. Run via:
//   node --import tsx --test src/unicode-names.redteam.test.ts
//
// NTFS stores names as exact UTF-16 code units and never normalizes them, so
// NFC `café.md` (U+00E9) and NFD `café.md` (e + U+0301) are two different
// files that can sit side by side. The tests create REAL pairs on disk.
//
//   D1 an NFD-named inbox drop (or a drop inside an NFD-named folder) is
//      ingested and watched under its exact name, never silently dropped
//   D2 ingest and the broker act on the EXACT named file: no cross-reading or
//      deleting the NFC sibling, NFD notes are readable/updatable, and a create
//      that would mint a visually identical duplicate is refused
//   D3 a hand-written `.ingest-error.json` is never treated as the pipeline's
//      own record (MAC under the per-vault key), so it cannot silence a drop
//   D4 a freeze-file NAME inside `_ingest-errors/` is reported, not trusted
//
// Only APIs that already existed at 75b245f are imported, so a failure there is
// a behavioral failure, not a missing export.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { makeFrontmatter, parseNote } from './frontmatter.js';
import { runIngest } from './jobs/ingest.js';
import { readIngestError, writeIngestError } from './ingest/errors.js';
import { sha256Hex } from './ingest/originals.js';
import { VaultBroker } from './vault-broker.js';
import { VaultPathError } from './vault-path.js';
import { watchInbox } from './vault-watcher.js';

const NFC = 'café';
const NFD = 'café';

const tmpDirs: string[] = [];
after(async () => {
  await Promise.all(
    tmpDirs.map((d) => fs.rm(d, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})),
  );
});

async function makeVault(): Promise<{ vault: string; inbox: string }> {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skippy-unicode-')));
  tmpDirs.push(base);
  const vault = path.join(base, 'vault');
  for (const d of ['00_Inbox', '10_Atomic', '60_Sources']) {
    await fs.mkdir(path.join(vault, d), { recursive: true });
  }
  return { vault, inbox: path.join(vault, '00_Inbox') };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timed out'));
      setTimeout(tick, 25);
    };
    tick();
  });
}

/** Directory entries, exact code units. */
async function entries(dir: string): Promise<string[]> {
  return (await fs.readdir(dir)).sort();
}

/** Assert both spellings exist as two distinct files (the filesystem does not normalize). */
async function assertPair(dir: string, ext: string): Promise<void> {
  const names = await entries(dir);
  assert.ok(names.includes(`${NFC}${ext}`) && names.includes(`${NFD}${ext}`), `NFC+NFD pair on disk: ${JSON.stringify(names)}`);
  const a = await fs.stat(path.join(dir, `${NFC}${ext}`), { bigint: true });
  const b = await fs.stat(path.join(dir, `${NFD}${ext}`), { bigint: true });
  assert.notEqual(a.ino, b.ino, 'two different files');
}

function humanNote(id: string, body: string): string {
  return (
    `---\nid: ${id}\ntitle: t\ncreated_at: 2026-01-01T00:00:00.000Z\nupdated_at: 2026-01-01T00:00:00.000Z\n` +
    `type: concept\nstatus: active\ntags: []\nsource: null\nauthored_by: human\n---\n${body}`
  );
}

const fm = () => makeFrontmatter({ title: 't', type: 'concept', authored_by: 'test', source: null });

function isViolation(violation: string) {
  return (err: unknown) => {
    assert.ok(err instanceof VaultPathError, `expected VaultPathError, got ${String(err)}`);
    assert.equal(err.violation, violation, err.message);
    return true;
  };
}

async function sourceNoteFor(vault: string, sourceNotePath: string): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(sourceNotePath, 'utf8');
  assert.ok(path.dirname(sourceNotePath).endsWith('60_Sources'));
  void vault;
  return parseNote(raw).frontmatter as Record<string, unknown>;
}

// ── D1: NFD drops are ingested under their exact name ────────────────────────

test('UN-D1a: runIngest ingests an NFD-named drop (exact name), and a drop inside an NFD-named folder', async () => {
  const { vault, inbox } = await makeVault();
  const drop = path.join(inbox, `${NFD}.md`);
  await fs.writeFile(drop, '# NFD only\nbody\n');
  const r = await runIngest({ vaultRoot: vault, sourcePath: drop });
  assert.equal(r.body, '# NFD only\nbody\n');
  assert.deepEqual(await entries(inbox), [], 'the NFD drop was removed after preservation');
  const front = await sourceNoteFor(vault, r.sourceNotePath);
  assert.equal(front['source'], `file://${NFD}.md`, 'provenance names the exact file');

  await fs.mkdir(path.join(inbox, NFD), { recursive: true });
  const nested = path.join(inbox, NFD, 'inner.md');
  await fs.writeFile(nested, '# nested in NFD folder\n');
  const r2 = await runIngest({ vaultRoot: vault, sourcePath: nested });
  assert.equal(r2.body, '# nested in NFD folder\n');
  assert.deepEqual(await entries(path.join(inbox, NFD)), []);
});

test('UN-D1b: the watcher dispatches NFD drops (startup scan, NFD folder, live) under their exact names', async () => {
  const { vault, inbox } = await makeVault();
  await fs.writeFile(path.join(inbox, `${NFD}.md`), '# scan NFD\n');
  await fs.mkdir(path.join(inbox, NFD));
  await fs.writeFile(path.join(inbox, NFD, 'deep.md'), '# in NFD folder\n');
  const files: string[] = [];
  const rejected: string[] = [];
  const w = watchInbox({
    vaultRoot: vault,
    onFile: (p) => files.push(path.relative(inbox, p).replace(/\\/g, '/')),
    onRejected: (p, reason) => rejected.push(`${reason} ${path.relative(inbox, p)}`),
    onUnsupported: (p) => rejected.push(`unsupported ${p}`),
  });
  try {
    await waitFor(() => files.length >= 2, 4000).catch(() => {});
    await sleep(300);
    await fs.writeFile(path.join(inbox, `live-${NFD}.md`), '# live NFD\n');
    await waitFor(() => files.length >= 3, 4000).catch(() => {});
  } finally {
    await w.close();
  }
  assert.deepEqual(
    [...files].sort(),
    [`${NFD}.md`, `${NFD}/deep.md`, `live-${NFD}.md`].sort(),
    `exact NFD names reach onFile (got ${JSON.stringify(files)})`,
  );
  assert.deepEqual(rejected, []);
});

// ── D2: exact-file identity with real NFC/NFD pairs ──────────────────────────

test('UN-D2a: with an NFC/NFD drop pair side by side, runIngest reads, labels and removes ONLY the named file', async () => {
  const { vault, inbox } = await makeVault();
  await fs.writeFile(path.join(inbox, `${NFC}.md`), '# NFC version\nnfc body\n');
  await fs.writeFile(path.join(inbox, `${NFD}.md`), '# NFD version\nnfd body\n');
  await assertPair(inbox, '.md');

  const rd = await runIngest({ vaultRoot: vault, sourcePath: path.join(inbox, `${NFD}.md`) });
  assert.equal(rd.body, '# NFD version\nnfd body\n', 'the NFD file was read, not its NFC sibling');
  assert.deepEqual(await entries(inbox), [`${NFC}.md`], 'only the NFD file was removed');
  assert.equal(await fs.readFile(path.join(inbox, `${NFC}.md`), 'utf8'), '# NFC version\nnfc body\n');
  assert.equal((await sourceNoteFor(vault, rd.sourceNotePath))['source'], `file://${NFD}.md`);

  const rc = await runIngest({ vaultRoot: vault, sourcePath: path.join(inbox, `${NFC}.md`) });
  assert.equal(rc.body, '# NFC version\nnfc body\n');
  assert.equal((await sourceNoteFor(vault, rc.sourceNotePath))['source'], `file://${NFC}.md`);
  assert.notEqual(rc.sourceId, rd.sourceId);
  assert.deepEqual(await entries(inbox), []);
});

test('UN-D2b: unsupported NFC/NFD drop pair: each keeps its own file and its own sidecar', async () => {
  const { vault, inbox } = await makeVault();
  await fs.writeFile(path.join(inbox, `${NFC}.xyz`), 'nfc');
  await fs.writeFile(path.join(inbox, `${NFD}.xyz`), 'nfd');
  await assertPair(inbox, '.xyz');
  for (const n of [NFC, NFD]) {
    await assert.rejects(runIngest({ vaultRoot: vault, sourcePath: path.join(inbox, `${n}.xyz`) }));
  }
  const names = await entries(inbox);
  for (const n of [NFC, NFD]) {
    assert.ok(names.includes(`${n}.xyz`), `${JSON.stringify(n)} drop intact`);
    assert.ok(names.includes(`${n}.xyz.ingest-error.json`), `${JSON.stringify(n)} has its own sidecar: ${JSON.stringify(names)}`);
    const rec = await readIngestError(vault, path.join(inbox, `${n}.xyz`));
    assert.equal(rec?.contentSha256, sha256Hex(Buffer.from(n === NFC ? 'nfc' : 'nfd')));
  }
});

test('UN-D2c: broker reads and updates each note of an NFC/NFD pair by its exact name; lock keys stay per file', async () => {
  const { vault } = await makeVault();
  const dir = path.join(vault, '10_Atomic');
  await fs.writeFile(path.join(dir, `${NFC}.md`), humanNote('01J000000000000000000000NC', 'nfc body\n'));
  await fs.writeFile(path.join(dir, `${NFD}.md`), humanNote('01J000000000000000000000ND', 'nfd body\n'));
  await assertPair(dir, '.md');
  const broker = new VaultBroker(vault);

  const sc = await broker.readNote(`10_Atomic/${NFC}.md`);
  const sd = await broker.readNote(`10_Atomic/${NFD}.md`);
  assert.equal(sc?.body, 'nfc body\n');
  assert.equal(sd?.body, 'nfd body\n', 'the NFD note is readable by its own name');
  assert.equal(sd?.path, `10_Atomic/${NFD}.md`, 'the reported path keeps the exact spelling');

  // Concurrent CAS updates of both: distinct files, so distinct locks; both succeed.
  const [uc, ud] = await Promise.all([
    broker.updateNote(`10_Atomic/${NFC}.md`, sc!.hash, () => ({ body: 'nfc edited\n' })),
    broker.updateNote(`10_Atomic/${NFD}.md`, sd!.hash, () => ({ body: 'nfd edited\n' })),
  ]);
  assert.ok(uc.ok && ud.ok, `${JSON.stringify(uc)} ${JSON.stringify(ud)}`);
  assert.equal(parseNote(await fs.readFile(path.join(dir, `${NFC}.md`), 'utf8')).body, 'nfc edited\n');
  assert.equal(parseNote(await fs.readFile(path.join(dir, `${NFD}.md`), 'utf8')).body, 'nfd edited\n');
  assert.equal(
    parseNote(await fs.readFile(path.join(dir, `${NFD}.md`), 'utf8')).frontmatter['id'],
    '01J000000000000000000000ND',
    'identity preserved',
  );
  assert.deepEqual(await entries(dir), [`${NFC}.md`, `${NFD}.md`].sort(), 'no third file, no leftover lock');

  // createNote on either existing name is `exists`, never a new file.
  for (const n of [NFC, NFD]) {
    const c = await broker.createNote(`10_Atomic/${n}.md`, fm(), 'x\n');
    assert.equal(c.ok, false);
    assert.equal(!c.ok && c.reason, 'exists');
  }
});

test('UN-D2d: an NFD-only human note is read/updated by name; an NFC create next to it is refused, not duplicated', async () => {
  const { vault } = await makeVault();
  const dir = path.join(vault, '10_Atomic');
  await fs.writeFile(path.join(dir, `${NFD}.md`), humanNote('01J00000000000000000000NFD', 'human NFD note\n'));
  const broker = new VaultBroker(vault);

  const snap = await broker.readNote(`10_Atomic/${NFD}.md`);
  assert.equal(snap?.body, 'human NFD note\n');
  assert.equal(await broker.readNote(`10_Atomic/${NFC}.md`), null, 'the NFC spelling is a different (absent) file');

  const up = await broker.updateNote(`10_Atomic/${NFD}.md`, snap!.hash, () => ({ frontmatter: { status: 'draft' } }));
  assert.ok(up.ok, JSON.stringify(up));
  assert.equal(parseNote(await fs.readFile(path.join(dir, `${NFD}.md`), 'utf8')).frontmatter['status'], 'draft');

  await assert.rejects(broker.createNote(`10_Atomic/${NFC}.md`, fm(), 'dup\n'), isViolation('normalization_collision'));
  const c = await broker.createNote(`10_Atomic/${NFD}.md`, fm(), 'dup\n');
  assert.equal(!c.ok && c.reason, 'exists');
  assert.deepEqual(await entries(dir), [`${NFD}.md`], 'no visually identical duplicate was created');
});

test('UN-D2e: a new note under an NFC folder is refused when an NFD folder of that name exists', async () => {
  const { vault } = await makeVault();
  await fs.mkdir(path.join(vault, '10_Atomic', NFD));
  const broker = new VaultBroker(vault);
  await assert.rejects(broker.createNote(`10_Atomic/${NFC}/n.md`, fm(), 'x\n'), isViolation('normalization_collision'));
  assert.deepEqual(await entries(path.join(vault, '10_Atomic')), [NFD]);
  const ok = await broker.createNote(`10_Atomic/${NFD}/n.md`, fm(), 'x\n');
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.deepEqual(await entries(path.join(vault, '10_Atomic', NFD)), ['n.md']);
});

test('UN-D2f: concurrent creates of the NFC and NFD spelling of one new name yield exactly one note', async () => {
  const { vault } = await makeVault();
  const broker = new VaultBroker(vault);
  const results = await Promise.allSettled([
    broker.createNote(`10_Atomic/${NFC}.md`, fm(), 'a\n'),
    broker.createNote(`10_Atomic/${NFD}.md`, fm(), 'b\n'),
  ]);
  const show = JSON.stringify(results.map((r) => (r.status === 'fulfilled' ? r.value : String(r.reason))));
  const winners = results.filter((r) => r.status === 'fulfilled' && r.value.ok);
  assert.equal(winners.length, 1, show);
  // The loser named a DIFFERENT (absent) file, so it is refused as a
  // look-alike duplicate -- not silently redirected onto the winner's file.
  const loser = results.find((r) => !(r.status === 'fulfilled' && r.value.ok))!;
  assert.equal(loser.status, 'rejected', show);
  isViolation('normalization_collision')((loser as PromiseRejectedResult).reason);
  const names = await entries(path.join(vault, '10_Atomic'));
  assert.equal(names.length, 1, JSON.stringify(names));
  const winnerPath = (winners[0] as PromiseFulfilledResult<{ path: string }>).value.path;
  assert.equal(`10_Atomic/${names[0]}`, winnerPath, 'the created file is spelled exactly as the winner named it');
});

test('UN-R (guard, passes before and after): rules still evaluate normalized forms of exact-byte segments', async () => {
  const { vault } = await makeVault();
  const broker = new VaultBroker(vault);
  // U+212A KELVIN SIGN is NFC-equivalent to "K": `x.locK` is a `.lock` segment to the rules.
  await assert.rejects(broker.createNote('10_Atomic/x.locK/y.md', fm(), 'x\n'), isViolation('lock_segment'));
  // Fullwidth look-alikes of control names are still refused.
  await assert.rejects(broker.createNote('．obsidian/x.md', fm(), 'x\n'), isViolation('lookalike'));
});

// ── D3: sidecar ownership is authenticated, not inferred from content ───────

test('UN-D3a: a hand-written, correctly shaped sidecar neither silences its drop nor passes as ours', async () => {
  const { vault, inbox } = await makeVault();
  const userBytes = Buffer.from('# user doc\nimportant\n');
  await fs.writeFile(path.join(inbox, 'notes.md'), userBytes);
  await fs.writeFile(
    path.join(inbox, 'notes.md.ingest-error.json'),
    JSON.stringify({
      kind: 'skippy.ingest-error',
      inboxRel: 'notes.md',
      sourcePath: path.join(inbox, 'notes.md'),
      reason: 'unsupported-format',
      detail: 'forged',
      extension: '.md',
      at: new Date().toISOString(),
      contentSha256: sha256Hex(userBytes),
      mac: 'f'.repeat(64),
    }),
  );
  // A pipeline-written record (real writer) for another drop, then tampered.
  await fs.writeFile(path.join(inbox, 'other.md'), '# other\n');
  const legit = await writeIngestError(vault, path.join(inbox, 'other.md'), 'invalid-encoding', 'x', '.md', 'a'.repeat(64));
  const rec = JSON.parse(await fs.readFile(legit, 'utf8')) as Record<string, unknown>;
  rec['contentSha256'] = sha256Hex(Buffer.from('# other\n'));
  await fs.writeFile(legit, JSON.stringify(rec));

  assert.equal(await readIngestError(vault, path.join(inbox, 'notes.md')), null, 'a forged record is not returned');
  const files: string[] = [];
  const reports: string[] = [];
  const w = watchInbox({
    vaultRoot: vault,
    onFile: (p) => files.push(path.basename(p)),
    onRejected: (p, reason) => reports.push(`${reason} ${path.basename(p)}`),
  });
  try {
    await waitFor(() => files.length >= 2 && reports.length >= 2, 4000).catch(() => {});
    await sleep(200);
  } finally {
    await w.close();
  }
  assert.deepEqual([...files].sort(), ['notes.md', 'other.md'], `forged/tampered records suppress nothing (got ${JSON.stringify(files)})`);
  assert.ok(reports.includes('reserved-name notes.md.ingest-error.json'), JSON.stringify(reports));
  assert.ok(reports.includes('reserved-name other.md.ingest-error.json'), JSON.stringify(reports));
});

test('UN-D3b: the pipeline’s own records are authenticated with a per-vault key under .skippy/ and stay silent', async () => {
  const { vault, inbox } = await makeVault();
  const bad = path.join(inbox, 'bad.md');
  const bytes = Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]);
  await fs.writeFile(bad, bytes);
  const sidecar = await writeIngestError(vault, bad, 'invalid-encoding', 'bad utf-8', '.md', sha256Hex(bytes));
  const key = (await fs.readFile(path.join(vault, '.skippy', 'ingest-sidecar.key'), 'utf8')).trim();
  assert.match(key, /^[0-9a-f]{64}$/);
  const rec = JSON.parse(await fs.readFile(sidecar, 'utf8')) as Record<string, unknown>;
  assert.match(String(rec['mac']), /^[0-9a-f]{64}$/);
  assert.equal((await readIngestError(vault, bad))?.contentSha256, sha256Hex(bytes));

  const files: string[] = [];
  const reports: string[] = [];
  const w = watchInbox({
    vaultRoot: vault,
    onFile: (p) => files.push(path.basename(p)),
    onRejected: (p, reason) => reports.push(`${reason} ${path.basename(p)}`),
  });
  try {
    await sleep(700);
  } finally {
    await w.close();
  }
  assert.deepEqual(files, [], 'the recorded failing content is not re-enqueued');
  assert.deepEqual(reports, [], 'the own sidecar is not reported');
});

// ── D4: freeze-file names inside _ingest-errors/ prove nothing ──────────────

test('UN-D4: a freeze-named user file inside _ingest-errors/ is reported (startup scan and live)', async () => {
  const { vault, inbox } = await makeVault();
  const errDir = path.join(inbox, '_ingest-errors');
  await fs.mkdir(errDir, { recursive: true });
  const scanName = `.${randomBytes(16).toString('hex')}.hidden-user.md.ingest-tmp`;
  await fs.writeFile(path.join(errDir, scanName), 'USER FILE IN ERRORS DIR WITH FREEZE NAME\n');
  const reports: string[] = [];
  const w = watchInbox({
    vaultRoot: vault,
    onFile: () => {},
    onRejected: (p, reason) => reports.push(`${reason} ${path.basename(p)}`),
  });
  const liveName = `.${randomBytes(16).toString('hex')}.live-user.md.ingest-tmp`;
  try {
    await waitFor(() => reports.length >= 1, 3000).catch(() => {});
    await sleep(300);
    await fs.writeFile(path.join(errDir, liveName), 'LIVE USER FILE\n');
    await waitFor(() => reports.length >= 2, 4000).catch(() => {});
  } finally {
    await w.close();
  }
  assert.ok(reports.includes(`internal-folder ${scanName}`), JSON.stringify(reports));
  assert.ok(reports.includes(`internal-folder ${liveName}`), JSON.stringify(reports));
  assert.ok((await entries(errDir)).includes(scanName), 'the file itself is never touched');
});
