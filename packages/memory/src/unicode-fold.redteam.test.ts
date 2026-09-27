// unicode-fold.redteam.test.ts — regressions for the M0 Unicode case-fold
// round on EC3/EC4 (FR-SEC-02 "case normalization", FR-WIKI-02 identity,
// FR-WIKI-03 authenticated ingest-error records; PRD OQ-21). Every UF-* test
// except the UF-G guards fails on b3e9af0. Run via:
//   node --import tsx --test src/unicode-fold.redteam.test.ts
//
// NTFS compares names with its own upcase table, which is NOT JavaScript's
// `toLowerCase`: `K` (U+212A KELVIN SIGN) and `K`, `Å` (U+212B) and `Å`,
// `Ω` (U+2126) and `Ω`, `İ` and `i̇`, `ẞ` and `ß`, Georgian Mtavruli and
// Mkhedruli, Cherokee upper/lower are DISTINCT files on NTFS, yet JS folds
// them together (and `ı`/`i` are distinct to both). The tests create REAL
// pairs side by side where the file system allows it.
//
//   1 a create is refused (`normalization_collision`) when ANY existing sibling
//     has the same conservative skeleton (`foldKey`) but different bytes, at
//     file and directory level, including look-alikes of board folders and of
//     the reserved `40_Daily`
//   2 an ingest-error sidecar authenticates ONLY at its exact location: a
//     genuine record copied to a JS-case-fold alias is not ours
//   3 the `_ingest-errors/` fallback record is keyed on the EXACT inbox path,
//     so two distinct drops never share one record
//   4 the sidecar MAC key is never created or read behind a `.skippy` junction
//
// Only APIs that already existed at b3e9af0 are imported, so a failure there
// is a behavioral failure, not a missing export.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { makeFrontmatter, parseNote } from './frontmatter.js';
import {
  fallbackIngestErrorPath,
  isOwnIngestErrorSidecar,
  readIngestError,
  recordIngestRejection,
  writeIngestError,
} from './ingest/errors.js';
import { sha256Hex } from './ingest/originals.js';
import { VaultBroker } from './vault-broker.js';
import {
  VaultPathError,
  assertNoNormalizationSibling,
  ensureContainedParentDir,
  foldKey,
  resolveContained,
} from './vault-path.js';
import { watchInbox } from './vault-watcher.js';

const tmpDirs: string[] = [];
after(async () => {
  await Promise.all(
    tmpDirs.map((d) => fs.rm(d, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})),
  );
});

async function makeVault(extra: string[] = []): Promise<{ vault: string; inbox: string }> {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skippy-fold-')));
  tmpDirs.push(base);
  const vault = path.join(base, 'vault');
  for (const d of ['00_Inbox', '10_Atomic', '20_Topics', '50_Agents', '60_Sources', ...extra]) {
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

const esc = (s: string) =>
  [...s].map((c) => (c.codePointAt(0)! > 127 ? `<U+${c.codePointAt(0)!.toString(16).toUpperCase()}>` : c)).join('');

async function entries(dir: string): Promise<string[]> {
  return (await fs.readdir(dir)).sort();
}

/** Whether the file system keeps `a` and `b` as two distinct entries (NTFS: per its upcase table). */
async function fsKeepsDistinct(dir: string, a: string, b: string): Promise<boolean> {
  const probe = path.join(dir, `.probe-${a}`);
  await fs.writeFile(probe, 'p');
  try {
    await fs.stat(path.join(dir, `.probe-${b}`));
    return false;
  } catch {
    return true;
  } finally {
    await fs.rm(probe, { force: true });
  }
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

/** Distinct-on-NTFS pairs that JavaScript's case mapping folds together (or that differ only by a mark). */
const PAIRS: [label: string, first: string, second: string][] = [
  ['kelvin sign / K', 'Kelvin', 'Kelvin'],
  ['K / kelvin sign', 'Kilo', 'Kilo'],
  ['angstrom sign / A-ring', 'Ångstrom', 'Ångstrom'],
  ['ohm sign / omega', 'Ωmega', 'Ωmega'],
  ['dotted I / i+U+0307', 'İstanbul', 'i̇stanbul'],
  ['dotless i / i', 'Lıra', 'Lira'],
  ['capital sharp s / sharp s', 'Straẞe', 'straße'],
  ['sharp s / ss', 'Maße', 'Masse'],
  ['long s / s', 'Roſe', 'Rose'],
  ['georgian mtavruli / mkhedruli', 'Აbc', 'აbc'],
  ['cherokee upper / lower', 'Ꭰyo', 'ꭰyo'],
  ['final sigma / sigma', 'Loς', 'Loσ'],
];

// ── 1: the conservative collision skeleton ───────────────────────────────────

test('UF-1a: file level — the second spelling of every NTFS-distinct look-alike pair is refused, not duplicated', async () => {
  const { vault } = await makeVault();
  const dir = path.join(vault, '10_Atomic');
  const broker = new VaultBroker(vault);
  const failures: string[] = [];
  for (const [label, first, second] of PAIRS) {
    const distinct = await fsKeepsDistinct(dir, first, second);
    const a = await broker.createNote(`10_Atomic/${first}.md`, fm(), 'one\n');
    assert.ok(a.ok, `${label}: first create ${JSON.stringify(a)}`);
    let outcome: string;
    try {
      const b = await broker.createNote(`10_Atomic/${second}.md`, fm(), 'two\n');
      outcome = b.ok ? 'CREATED' : `result:${b.reason}`;
    } catch (err) {
      outcome = err instanceof VaultPathError ? err.violation : String(err);
    }
    // On a file system that keeps the pair distinct the only safe outcome is a
    // refusal; where it aliases them, `exists` (the same entry) is also fine.
    const ok = outcome === 'normalization_collision' || (!distinct && outcome === 'result:exists');
    if (!ok) failures.push(`${label} [fs-distinct=${distinct}] ${esc(first)} then ${esc(second)} -> ${outcome}`);
  }
  const onDisk = await entries(dir);
  assert.deepEqual(failures, [], `look-alike duplicates were minted; on disk: ${JSON.stringify(onDisk.map(esc))}`);
  assert.equal(onDisk.length, PAIRS.length, JSON.stringify(onDisk.map(esc)));
});

test('UF-1b: a human-made look-alike on disk blocks the create; both existing spellings stay readable/updatable by exact name', async () => {
  const { vault } = await makeVault();
  const dir = path.join(vault, '10_Atomic');
  await fs.writeFile(path.join(dir, 'Kelvin.md'), humanNote('01J0000000000000000000KSGN', 'kelvin sign\n'));
  const broker = new VaultBroker(vault);
  await assert.rejects(broker.createNote('10_Atomic/Kelvin.md', fm(), 'dup\n'), isViolation('normalization_collision'));
  await assert.rejects(broker.createNote('10_Atomic/kelvin.md', fm(), 'dup\n'), isViolation('normalization_collision'));
  assert.deepEqual(await entries(dir), ['Kelvin.md']);

  // If NTFS lets a human put the plain spelling next to it, each is its own note.
  if (await fsKeepsDistinct(dir, 'Kelvin.md', 'Kelvin.md')) {
    await fs.writeFile(path.join(dir, 'Kelvin.md'), humanNote('01J0000000000000000000PLNK', 'plain K\n'));
    const s1 = await broker.readNote('10_Atomic/Kelvin.md');
    const s2 = await broker.readNote('10_Atomic/Kelvin.md');
    assert.equal(s1?.body, 'kelvin sign\n');
    assert.equal(s2?.body, 'plain K\n');
    const u = await broker.updateNote('10_Atomic/Kelvin.md', s1!.hash, () => ({ body: 'edited\n' }));
    assert.ok(u.ok, JSON.stringify(u));
    assert.equal(parseNote(await fs.readFile(path.join(dir, 'Kelvin.md'), 'utf8')).body, 'edited\n');
    assert.equal(parseNote(await fs.readFile(path.join(dir, 'Kelvin.md'), 'utf8')).body, 'plain K\n');
  }
});

test('UF-1c: directory level — a look-alike folder is refused, including a board-folder squat of agent_log', async () => {
  const { vault } = await makeVault();
  const broker = new VaultBroker(vault);
  const ok1 = await broker.createNote('20_Topics/Key/a.md', fm(), 'a\n');
  assert.ok(ok1.ok, JSON.stringify(ok1));
  await assert.rejects(broker.createNote('20_Topics/Key/b.md', fm(), 'b\n'), isViolation('normalization_collision'));
  await assert.rejects(broker.createNote('20_Topics/Straße/b.md', fm(), 'b\n').then(
    () => broker.createNote('20_Topics/Straẞe/c.md', fm(), 'c\n'),
  ), isViolation('normalization_collision'));
  assert.deepEqual((await entries(path.join(vault, '20_Topics'))).map(esc).sort(), ['<U+212A>ey', 'Stra<U+DF>e']);

  // A squatter board folder spelled with U+212A, then the archival mirror's
  // agent_log for the real board: never two visually identical board folders.
  const sq = await broker.createNote('50_Agents/MarKeting/notes.md', fm(), 'x\n');
  assert.ok(sq.ok, JSON.stringify(sq));
  const logFm = makeFrontmatter({ title: 'log', type: 'agent_log', authored_by: 'test', source: null });
  await assert.rejects(
    broker.appendNote('50_Agents/Marketing/agent_log.md', 'entry', { init: { frontmatter: logFm, body: '# log\n' } }),
    isViolation('normalization_collision'),
  );
  assert.deepEqual((await entries(path.join(vault, '50_Agents'))).map(esc), ['Mar<U+212A>eting']);

  // And the other way round: the real board folder exists, the squat is refused.
  const { vault: v2 } = await makeVault(['50_Agents/marketing']);
  const b2 = new VaultBroker(v2);
  await assert.rejects(b2.createNote('50_Agents/MarKeting/notes.md', fm(), 'x\n'), isViolation('normalization_collision'));
  await assert.rejects(b2.createNote('50_Agents/MARKEŢING/notes.md', fm(), 'x\n'), isViolation('normalization_collision'));
  assert.deepEqual(await entries(path.join(v2, '50_Agents')), ['marketing']);
});

test('UF-1d: look-alikes of the reserved 40_Daily folder (dotless i, dotted I) are refused, never a second daily folder', async () => {
  const { vault } = await makeVault(['40_Daily']);
  const broker = new VaultBroker(vault);
  const daily = makeFrontmatter({ title: 'd', type: 'concept', authored_by: 'test', source: null });
  for (const p of ['40_Daıly/x.md', '40_DAİLY/x.md', '40_Daíly/x.md']) {
    let outcome: string;
    try {
      const r = await broker.createNote(p, daily, 'x\n');
      outcome = r.ok ? `CREATED ${esc(r.path)}` : `result:${r.reason}`;
    } catch (err) {
      outcome = err instanceof VaultPathError ? err.violation : (err as Error).name;
    }
    assert.ok(
      ['normalization_collision', 'lookalike', 'AppendOnlyViolationError'].includes(outcome),
      `${esc(p)} -> ${outcome}`,
    );
  }
  const top = (await entries(vault)).filter((n) => /^40_/.test(n.normalize('NFKC')));
  assert.deepEqual(top.map(esc), ['40_Daily'], 'no look-alike daily folder was created');
  // The collision layer on its own (beneath the lexical look-alike rule).
  for (const n of ['40_Daıly', '40_DAİLY', '40_Daíly']) {
    await assert.rejects(assertNoNormalizationSibling(vault, n, n), isViolation('normalization_collision'), esc(n));
  }
});

// ── 2: sidecars authenticate only at their exact location ───────────────────

test('UF-2: a genuine sidecar copied to a JS-case-fold alias (U+212A vs K) is not ours and describes nothing', async () => {
  const { vault, inbox } = await makeVault();
  const sign = path.join(inbox, 'Kelvin.xyz');
  const plain = path.join(inbox, 'Kelvin.xyz');
  const bytes = Buffer.from('same content\n');
  await fs.writeFile(sign, bytes);
  const genuine = await writeIngestError(vault, sign, 'unsupported-format', 'no extractor', '.xyz', sha256Hex(bytes));
  assert.equal(path.basename(genuine), 'Kelvin.xyz.ingest-error.json');
  assert.equal(await isOwnIngestErrorSidecar(vault, genuine), true, 'the genuine record is ours');

  if (!(await fsKeepsDistinct(inbox, 'Kelvin.xyz', 'Kelvin.xyz'))) return; // FS aliases them: nothing to copy
  await fs.writeFile(plain, bytes);
  const copy = path.join(inbox, 'Kelvin.xyz.ingest-error.json');
  await fs.copyFile(genuine, copy);
  assert.equal(await isOwnIngestErrorSidecar(vault, copy), false, 'the copied record is not authenticated at another location');
  assert.equal(await readIngestError(vault, plain), null, 'the copy does not describe (or silence) Kelvin.xyz');
  assert.equal((await readIngestError(vault, sign))?.inboxRel, 'Kelvin.xyz', 'the genuine one still does');

  const reports: string[] = [];
  const unsupported: string[] = [];
  const w = watchInbox({
    vaultRoot: vault,
    onFile: () => {},
    onUnsupported: (p) => unsupported.push(path.basename(p)),
    onRejected: (p, reason) => reports.push(`${reason} ${path.basename(p)}`),
  });
  try {
    await waitFor(() => reports.length >= 1 && unsupported.length >= 1, 4000).catch(() => {});
    await sleep(300);
  } finally {
    await w.close();
  }
  assert.ok(reports.includes('reserved-name Kelvin.xyz.ingest-error.json'), `copy reported: ${JSON.stringify(reports.map(esc))}`);
  assert.deepEqual(unsupported, ['Kelvin.xyz'], 'the plain drop is not silenced by the copy; the recorded one is');
});

// ── 3: fallback records are keyed on the exact inbox path ───────────────────

test('UF-3: two distinct drops never share one _ingest-errors/ fallback record', async () => {
  const { vault, inbox } = await makeVault();
  const a = path.join(inbox, 'K~1.xyz');
  const b = path.join(inbox, 'K~1.xyz');
  assert.notEqual(fallbackIngestErrorPath(vault, a), fallbackIngestErrorPath(vault, b), 'distinct fallback paths');
  if (!(await fsKeepsDistinct(inbox, 'K~1.xyz', 'K~1.xyz'))) return;
  await fs.writeFile(a, 'a');
  await fs.writeFile(b, 'b');
  // `~1` is an 8.3-style name: the natural sidecar path is refused, so both go to the fallback.
  const sa = await recordIngestRejection(vault, a, 'path-rejected', 'short name a');
  const sb = await recordIngestRejection(vault, b, 'path-rejected', 'short name b');
  assert.equal(path.basename(path.dirname(sa)), '_ingest-errors');
  assert.notEqual(sa, sb, 'two records');
  assert.equal((await entries(path.join(inbox, '_ingest-errors'))).length, 2);
  assert.equal((await readIngestError(vault, a))?.detail, 'short name a');
  assert.equal((await readIngestError(vault, b))?.detail, 'short name b');
});

// ── 4: the MAC key lives only in the real .skippy directory ─────────────────

test('UF-4a: the writer refuses to create the sidecar key behind a .skippy junction to a note folder', async () => {
  const { vault, inbox } = await makeVault();
  await fs.symlink(path.join(vault, '10_Atomic'), path.join(vault, '.skippy'), 'junction');
  const drop = path.join(inbox, 'x.xyz');
  await fs.writeFile(drop, 'x');
  await assert.rejects(writeIngestError(vault, drop, 'unsupported-format', 'd', '.xyz'));
  assert.deepEqual(await entries(path.join(vault, '10_Atomic')), [], 'no key was planted in 10_Atomic/');
  assert.deepEqual(await entries(inbox), ['x.xyz'], 'the drop is intact and no unauthenticated record was written');
});

test('UF-4b: a verifier never reads a key through a .skippy junction', async () => {
  // Vault A: a genuine record and key. Vault B: a copy of A whose key sits in
  // 10_Atomic/ behind a `.skippy` junction (fresh root, so no cached key).
  const { vault: a, inbox: inboxA } = await makeVault();
  const drop = path.join(inboxA, 'r.xyz');
  await fs.writeFile(drop, 'r');
  await writeIngestError(a, drop, 'unsupported-format', 'd', '.xyz', sha256Hex(Buffer.from('r')));
  const b = path.join(path.dirname(a), 'vault-b');
  await fs.cp(a, b, { recursive: true });
  await fs.rename(path.join(b, '.skippy', 'ingest-sidecar.key'), path.join(b, '10_Atomic', 'ingest-sidecar.key'));
  await fs.rm(path.join(b, '.skippy'), { recursive: true });
  await fs.symlink(path.join(b, '10_Atomic'), path.join(b, '.skippy'), 'junction');
  const dropB = path.join(b, '00_Inbox', 'r.xyz');
  assert.equal(await readIngestError(b, dropB), null, 'no record authenticates with a key read through a junction');
  assert.equal(await isOwnIngestErrorSidecar(b, `${dropB}.ingest-error.json`), false);
});

test('UF-4c: allowHiddenNames control directories are refused behind a junction (key and replay paths alike)', async () => {
  const opts = { allowHiddenNames: ['.skippy'] };
  const { vault } = await makeVault();
  await fs.symlink(path.join(vault, '10_Atomic'), path.join(vault, '.skippy'), 'junction');
  await assert.rejects(resolveContained(vault, '.skippy/ingest-sidecar.key', opts), isViolation('hidden_segment'));
  await assert.rejects(resolveContained(vault, '.skippy/replays/01J.jsonl', opts), isViolation('hidden_segment'));
  // A junction to the vault root itself.
  const { vault: v2 } = await makeVault();
  await fs.symlink(v2, path.join(v2, '.skippy'), 'junction');
  await assert.rejects(resolveContained(v2, '.skippy/ingest-sidecar.key', opts), isViolation('hidden_segment'));
  // A plain .skippy directory still works, including creating its subfolders.
  const { vault: v3 } = await makeVault();
  const cp = await resolveContained(v3, '.skippy/replays/01J.jsonl', opts);
  const parent = await ensureContainedParentDir(cp);
  assert.equal(parent, path.join(cp.realRoot, '.skippy', 'replays'));
  // ... but not when the directory is swapped for a junction after resolution.
  const { vault: v4 } = await makeVault();
  const cp4 = await resolveContained(v4, '.skippy/replays/01J.jsonl', opts);
  await fs.symlink(path.join(v4, '10_Atomic'), path.join(v4, '.skippy'), 'junction');
  await assert.rejects(ensureContainedParentDir(cp4), isViolation('hidden_segment'));
  assert.deepEqual(await entries(path.join(v4, '10_Atomic')), [], 'nothing was created in 10_Atomic/');
});

// ── Guards (pass before and after) and the documented trade-off ──────────────

test('UF-G1 (guard): existing names of either form stay readable and createNote on the exact name is `exists`', async () => {
  const { vault } = await makeVault();
  const dir = path.join(vault, '10_Atomic');
  await fs.writeFile(path.join(dir, 'Straße.md'), humanNote('01J00000000000000000000SS1', 'b\n'));
  const broker = new VaultBroker(vault);
  assert.equal((await broker.readNote('10_Atomic/Straße.md'))?.body, 'b\n');
  const c = await broker.createNote('10_Atomic/Straße.md', fm(), 'x\n');
  assert.equal(!c.ok && c.reason, 'exists');
  const other = await broker.createNote('10_Atomic/Strand.md', fm(), 'x\n');
  assert.ok(other.ok, 'unrelated names are unaffected');
});

test('UF-T (documented over-refusal, OQ-21): `resume.md` next to `résumé.md` is refused; the skeleton is over-inclusive', async () => {
  const { vault } = await makeVault();
  const broker = new VaultBroker(vault);
  assert.ok((await broker.createNote('10_Atomic/résumé.md', fm(), 'x\n')).ok);
  await assert.rejects(broker.createNote('10_Atomic/resume.md', fm(), 'x\n'), isViolation('normalization_collision'));
  assert.equal(foldKey('résumé.md'), foldKey('RESUME.md'));
  assert.equal(foldKey('Kelvin'), foldKey('kelvin'));
  assert.equal(foldKey('40_Daıly'), foldKey('40_daily'));
  assert.equal(foldKey('Straẞe'), foldKey('strasse'));
  assert.equal(foldKey('４０_Daily'), foldKey('40_daily'));
  assert.notEqual(foldKey('kelvin-a'), foldKey('kelvin-b'));
});
