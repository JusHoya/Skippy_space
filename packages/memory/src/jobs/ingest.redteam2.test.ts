// jobs/ingest.redteam2.test.ts — M0 red-team round 2 regressions for ingest
// (FR-SEC-02, FR-WIKI-03, G0).
//
//   N1: ingest must never read, delete or write a sidecar through an in-vault
//       junction inside `00_Inbox/` (to `.obsidian`, `.git`, the originals
//       store, or outside), and `runIngest` refuses anything outside the inbox.
//   N6: oversized, 8.3-named and hardlinked drops are rejected before hashing
//       WITH a visible sidecar, and the original is never modified.
//   N7: a forged/invalid completion marker is never trusted for dedup.
//
// Every test here fails on 956c208. Run via:
//   node --import tsx --test src/jobs/ingest.redteam2.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runIngest } from './ingest.js';
import { readIngestError, recordUnsupported } from '../ingest/errors.js';
import { sha256Hex } from '../ingest/originals.js';

async function makeVault(): Promise<{ base: string; vault: string; outside: string }> {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skippy-rt2-ingest-')));
  const vault = path.join(base, 'vault');
  const outside = path.join(base, 'outside');
  for (const d of ['00_Inbox', '10_Atomic', '60_Sources', '.obsidian', '.git']) {
    await fs.mkdir(path.join(vault, d), { recursive: true });
  }
  await fs.mkdir(outside, { recursive: true });
  return { base, vault, outside };
}

async function junction(target: string, link: string): Promise<boolean> {
  try {
    await fs.symlink(target, link, 'junction');
    return true;
  } catch {
    return false;
  }
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true, () => false);
}

async function listRecursive(dir: string): Promise<string[]> {
  return ((await fs.readdir(dir, { recursive: true })) as string[]).map((p) => p.replace(/\\/g, '/'));
}

async function sourceNotes(vault: string): Promise<string[]> {
  return (await fs.readdir(path.join(vault, '60_Sources'))).filter((n) => n.endsWith('.md'));
}

// ── N1 ────────────────────────────────────────────────────────────────────────

test('RT2-N1: an inbox junction to .obsidian cannot make ingest delete .obsidian/workspace.json', async (t) => {
  const { vault } = await makeVault();
  const ws = path.join(vault, '.obsidian', 'workspace.json');
  await fs.writeFile(ws, '{"a":1}');
  if (!(await junction(path.join(vault, '.obsidian'), path.join(vault, '00_Inbox', 'j')))) {
    return t.skip('junction creation not permitted');
  }
  await assert.rejects(() => runIngest({ vaultRoot: vault, sourcePath: path.join(vault, '00_Inbox', 'j', 'workspace.json') }));
  assert.equal(await fs.readFile(ws, 'utf8'), '{"a":1}', '.obsidian/workspace.json intact');
  assert.deepEqual(await listRecursive(path.join(vault, '.obsidian')), ['workspace.json'], 'nothing written into .obsidian');
  assert.deepEqual(await sourceNotes(vault), []);
});

test('RT2-N1: an inbox junction to .git cannot delete COMMIT_EDITMSG or plant a sidecar in .git', async (t) => {
  const { vault } = await makeVault();
  const msg = path.join(vault, '.git', 'COMMIT_EDITMSG');
  await fs.writeFile(msg, 'msg');
  if (!(await junction(path.join(vault, '.git'), path.join(vault, '00_Inbox', 'g')))) {
    return t.skip('junction creation not permitted');
  }
  const via = path.join(vault, '00_Inbox', 'g', 'COMMIT_EDITMSG');
  await assert.rejects(() => runIngest({ vaultRoot: vault, sourcePath: via }));
  await recordUnsupported(vault, via, '').catch(() => {});
  assert.equal(await fs.readFile(msg, 'utf8'), 'msg', '.git/COMMIT_EDITMSG intact');
  assert.deepEqual(await listRecursive(path.join(vault, '.git')), ['COMMIT_EDITMSG'], 'no sidecar in .git');
});

test('RT2-N1: runIngest refuses a note outside 00_Inbox and leaves it in place', async () => {
  const { vault } = await makeVault();
  const keep = path.join(vault, '10_Atomic', 'keep.md');
  await fs.writeFile(keep, '# keep me\n');
  await assert.rejects(() => runIngest({ vaultRoot: vault, sourcePath: keep }));
  assert.equal(await fs.readFile(keep, 'utf8'), '# keep me\n');
  assert.deepEqual(await sourceNotes(vault), [], 'no source note minted from a non-inbox file');
  assert.equal(await exists(`${keep}.ingest-error.json`), false, 'no sidecar outside the inbox');
});

test('RT2-N1: an inbox junction to 60_Sources/originals cannot delete the only preserved copy', async (t) => {
  const { vault } = await makeVault();
  const drop = path.join(vault, '00_Inbox', 'a.md');
  await fs.writeFile(drop, '# only copy\n');
  const r = await runIngest({ vaultRoot: vault, sourcePath: drop });
  const originals = path.join(vault, '60_Sources', 'originals');
  const before = (await fs.readdir(originals)).sort();
  if (!(await junction(originals, path.join(vault, '00_Inbox', 'o')))) {
    return t.skip('junction creation not permitted');
  }
  for (const name of before) {
    await runIngest({ vaultRoot: vault, sourcePath: path.join(vault, '00_Inbox', 'o', name) }).catch(() => {});
  }
  assert.deepEqual((await fs.readdir(originals)).sort(), before, 'store and markers untouched');
  assert.equal(sha256Hex(await fs.readFile(r.originalPath)), r.sourceSha256, 'stored original intact');
});

test('RT2-N1: an inbox junction to outside the vault is neither ingested nor written into', async (t) => {
  const { vault, outside } = await makeVault();
  await fs.writeFile(path.join(outside, 'secret.md'), '# secret\n');
  await fs.writeFile(path.join(outside, 'secret.pdf'), '%PDF');
  if (!(await junction(outside, path.join(vault, '00_Inbox', 'out')))) {
    return t.skip('junction creation not permitted');
  }
  for (const n of ['secret.md', 'secret.pdf']) {
    await assert.rejects(() => runIngest({ vaultRoot: vault, sourcePath: path.join(vault, '00_Inbox', 'out', n) }));
  }
  assert.deepEqual((await listRecursive(outside)).sort(), ['secret.md', 'secret.pdf']);
  assert.deepEqual(await sourceNotes(vault), []);
});

// ── N6 ────────────────────────────────────────────────────────────────────────

test('RT2-N6: an oversized drop is rejected before reading with a too-large sidecar', async () => {
  const { vault } = await makeVault();
  const huge = path.join(vault, '00_Inbox', 'huge.md');
  const fh = await fs.open(huge, 'w');
  await fh.truncate(64 * 1024 * 1024 + 1);
  await fh.close();
  try {
    await assert.rejects(() => runIngest({ vaultRoot: vault, sourcePath: huge }));
    assert.equal((await fs.stat(huge)).size, 64 * 1024 * 1024 + 1, 'original untouched');
    const rec = await readIngestError(vault, huge);
    assert.ok(rec, 'a sidecar reports the rejection');
    assert.equal(rec?.reason, 'too-large');
    assert.deepEqual(await sourceNotes(vault), []);
  } finally {
    await fs.rm(huge, { force: true });
  }
});

test('RT2-N6: a legit 8.3-looking name (Report~1.md) is rejected WITH a sidecar and kept intact', async () => {
  const { vault } = await makeVault();
  const drop = path.join(vault, '00_Inbox', 'Report~1.md');
  await fs.writeFile(drop, '# legit\n');
  await assert.rejects(() => runIngest({ vaultRoot: vault, sourcePath: drop }));
  assert.equal(await fs.readFile(drop, 'utf8'), '# legit\n');
  const rec = await readIngestError(vault, drop);
  assert.ok(rec, 'a sidecar reports the rejection (fallback location, since the name is rejected)');
  assert.equal(rec?.reason, 'path-rejected');
  assert.equal(rec?.sourcePath, drop);
});

test('RT2-N6: a hardlinked drop is rejected WITH a sidecar; neither link is modified', async () => {
  const { vault, outside } = await makeVault();
  const victim = path.join(outside, 'victim.md');
  await fs.writeFile(victim, '# outside\n');
  const drop = path.join(vault, '00_Inbox', 'h.md');
  await fs.link(victim, drop);
  await assert.rejects(() => runIngest({ vaultRoot: vault, sourcePath: drop }));
  assert.equal(await fs.readFile(victim, 'utf8'), '# outside\n');
  assert.equal((await fs.stat(drop)).nlink, 2, 'the drop is still there');
  const rec = await readIngestError(vault, drop);
  assert.ok(rec, 'a sidecar reports the rejection');
  assert.equal(rec?.reason, 'hardlinked');
  assert.equal(rec?.contentSha256, undefined, 'the hardlinked content was never read');
});

test('RT2-N6: runIngest never ingests (and deletes) its own ingest-error sidecars', async () => {
  const { vault } = await makeVault();
  const pdf = path.join(vault, '00_Inbox', 'paper.pdf');
  await fs.writeFile(pdf, '%PDF-1.7');
  await assert.rejects(() => runIngest({ vaultRoot: vault, sourcePath: pdf }));
  const sidecar = `${pdf}.ingest-error.json`;
  assert.equal(await exists(sidecar), true);
  await assert.rejects(() => runIngest({ vaultRoot: vault, sourcePath: sidecar }));
  assert.equal(await exists(sidecar), true, 'the sidecar is still there');
  assert.deepEqual(await sourceNotes(vault), []);
});

// ── N7 ────────────────────────────────────────────────────────────────────────

test('RT2-N7: a forged marker pointing outside never returns outside content or skips ingest', async () => {
  const { vault, outside } = await makeVault();
  await fs.writeFile(path.join(outside, 'topsecret.md'), '---\nid: x\n---\nTOP SECRET CONTENT\n');
  const content = Buffer.from('# poisoned\n');
  const h = sha256Hex(content);
  const originals = path.join(vault, '60_Sources', 'originals');
  await fs.mkdir(originals, { recursive: true });
  await fs.writeFile(
    path.join(originals, `${h}.note.json`),
    JSON.stringify({ sourceId: 'X', sourceNotePath: path.join(outside, 'topsecret.md'), hash: h, ext: '.md' }),
  );
  const drop = path.join(vault, '00_Inbox', 'p.md');
  await fs.writeFile(drop, content);

  const r = await runIngest({ vaultRoot: vault, sourcePath: drop });
  assert.equal(r.deduplicated, false, 'the forged marker is not trusted');
  assert.doesNotMatch(r.body, /TOP SECRET/);
  assert.equal(r.body, '# poisoned\n');
  assert.equal(await fs.readFile(path.join(outside, 'topsecret.md'), 'utf8'), '---\nid: x\n---\nTOP SECRET CONTENT\n');
  assert.equal(sha256Hex(await fs.readFile(r.originalPath)), h, 'the drop was preserved before removal');
  const marker = JSON.parse(await fs.readFile(path.join(originals, `${h}.note.json`), 'utf8'));
  assert.equal(marker.sourceId, r.sourceId, 'the marker was rewritten to the real note');
  assert.ok(!String(marker.sourceNotePath).includes(outside));
});

test('RT2-N7: a marker whose note does not record this hash is ignored', async () => {
  const { vault } = await makeVault();
  const first = path.join(vault, '00_Inbox', 'first.md');
  await fs.writeFile(first, '# first\n');
  const r1 = await runIngest({ vaultRoot: vault, sourcePath: first });

  const content = Buffer.from('# second\n');
  const h = sha256Hex(content);
  // Forged marker: points at r1's (real, contained) note, which records a different hash.
  await fs.writeFile(
    path.join(vault, '60_Sources', 'originals', `${h}.note.json`),
    JSON.stringify({ sourceId: r1.sourceId, sourceNotePath: r1.sourceNotePath, hash: h, ext: '.md' }),
  );
  const drop = path.join(vault, '00_Inbox', 'second.md');
  await fs.writeFile(drop, content);
  const r2 = await runIngest({ vaultRoot: vault, sourcePath: drop });
  assert.equal(r2.deduplicated, false);
  assert.notEqual(r2.sourceId, r1.sourceId);
  assert.equal(r2.body, '# second\n');
  assert.equal((await sourceNotes(vault)).length, 2);
});

test('RT2-N7: a marker with an undeclared ext is ignored (no store entry is written under it)', async () => {
  const { vault } = await makeVault();
  const content = '# ext\n';
  const a = path.join(vault, '00_Inbox', 'a.md');
  await fs.writeFile(a, content);
  const r1 = await runIngest({ vaultRoot: vault, sourcePath: a });
  const markerFile = path.join(vault, '60_Sources', 'originals', `${r1.sourceSha256}.note.json`);
  const m = JSON.parse(await fs.readFile(markerFile, 'utf8'));
  await fs.writeFile(markerFile, JSON.stringify({ ...m, ext: '.exe' }));

  const b = path.join(vault, '00_Inbox', 'b.md');
  await fs.writeFile(b, content);
  const r2 = await runIngest({ vaultRoot: vault, sourcePath: b });
  assert.equal(r2.deduplicated, false, 'invalid marker not used for dedup');
  assert.equal(r2.sourceId, r1.sourceId, 'the existing note is reused by hash (no duplicate)');
  const names = await fs.readdir(path.join(vault, '60_Sources', 'originals'));
  assert.ok(!names.some((n) => n.endsWith('.exe')), 'nothing written under the forged extension');
  assert.equal(JSON.parse(await fs.readFile(markerFile, 'utf8')).ext, '.md', 'marker repaired');
});
