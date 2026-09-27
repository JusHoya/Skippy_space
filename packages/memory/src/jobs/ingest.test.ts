// jobs/ingest.test.ts — WS-E regression tests for original preservation (FR-WIKI-03)
// and the M0 red-team defects E3-2/E4-1/E4-3/E4-4/E4-6/E4-7/E4-8.
//
// Covers: unsupported/binary drops stay intact with an explicit error;
// invalid-UTF-8/NUL/UTF-16LE-no-BOM text drops stay intact with an explicit
// error; a valid drop preserves its original by content hash with provenance
// (incl. declared encoding) frontmatter; re-ingesting identical content is
// deduplicated (no duplicate note, correct stored path even across a
// different extension); a simulated mid-step crash resumes without losing
// the source or duplicating the note; a junction planted at `60_Sources/` or
// `60_Sources/originals/` is rejected rather than followed outside the
// vault; a corrupted/missing stored original is repaired, not silently
// trusted, before the inbox copy is removed; concurrent identical drops
// serialize into exactly one note; and content that changes between the
// integrity check and the inbox delete is never discarded.
//
// Run via: node --import tsx --test src/jobs/ingest.test.ts

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runIngest, UnsupportedFormatError } from './ingest.js';
import { readIngestError, ingestErrorPath } from '../ingest/errors.js';
import { sha256Hex } from '../ingest/originals.js';
import { WikilinkViolationError } from '../atomic.js';
import { parseNote, validateFrontmatter } from '../frontmatter.js';

// Temp dirs this file creates; removed after all of its tests (best effort:
// a Windows handle still open on one must not fail the run).
const tmpDirs: string[] = [];
async function trackTmp(p: Promise<string>): Promise<string> {
  const dir = await p;
  tmpDirs.push(dir);
  return dir;
}
after(async () => {
  await Promise.all(tmpDirs.map((d) => fs.rm(d, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})));
});

async function makeVault(): Promise<string> {
  const root = await trackTmp(fs.mkdtemp(path.join(os.tmpdir(), 'skippy-ingest-')));
  for (const sub of ['00_Inbox', '60_Sources']) {
    await fs.mkdir(path.join(root, sub), { recursive: true });
  }
  return root;
}

async function drop(vaultRoot: string, name: string, contents: Buffer | string): Promise<string> {
  const p = path.join(vaultRoot, '00_Inbox', name);
  await fs.writeFile(p, contents);
  return p;
}

/** True if a junction can be created in this environment (requires privilege on some Windows setups). */
async function trySymlinkJunction(target: string, link: string): Promise<boolean> {
  try {
    await fs.symlink(target, link, 'junction');
    return true;
  } catch {
    return false;
  }
}

test('binary/PDF-looking drop stays byte-identical with an explicit error', async () => {
  const vaultRoot = await makeVault();
  // A %PDF-looking binary blob — not a text format we declare an extractor for.
  const bytes = Buffer.concat([
    Buffer.from('%PDF-1.7\n'),
    Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x80, 0x81]),
  ]);
  const sourcePath = await drop(vaultRoot, 'paper.pdf', bytes);

  await assert.rejects(
    () => runIngest({ vaultRoot, sourcePath }),
    UnsupportedFormatError,
  );

  // Original is untouched, byte-for-byte.
  const after = await fs.readFile(sourcePath);
  assert.ok(after.equals(bytes), 'unsupported original left byte-identical');

  // An explicit, visible error sidecar exists, recording the content hash.
  const errRecord = await readIngestError(vaultRoot, sourcePath);
  assert.ok(errRecord, 'ingest-error sidecar was written');
  assert.equal(errRecord?.reason, 'unsupported-format');
  assert.equal(errRecord?.contentSha256, sha256Hex(bytes));
  assert.ok(await fs.access(ingestErrorPath(sourcePath)).then(() => true).catch(() => false));

  // Nothing landed in 60_Sources.
  const sources = await fs.readdir(path.join(vaultRoot, '60_Sources'));
  assert.deepEqual(sources.filter((f) => f !== 'originals'), []);
});

test('invalid UTF-8 .txt drop stays intact with an explicit error', async () => {
  const vaultRoot = await makeVault();
  // 0xC3 without a valid continuation byte — invalid UTF-8.
  const bytes = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0xc3, 0x28]);
  const sourcePath = await drop(vaultRoot, 'garbled.txt', bytes);

  await assert.rejects(() => runIngest({ vaultRoot, sourcePath }));

  const after = await fs.readFile(sourcePath);
  assert.ok(after.equals(bytes), 'invalid-encoding original left byte-identical');

  const errRecord = await readIngestError(vaultRoot, sourcePath);
  assert.ok(errRecord, 'ingest-error sidecar was written');
  assert.equal(errRecord?.reason, 'invalid-encoding');
});

// E4-6: UTF-16LE text with no BOM decodes "successfully" under a fatal UTF-8
// decoder (every other byte is a valid single-byte NUL) but is not valid text
// for a vault note. Must be rejected, not silently ingested as mojibake.
test('E4-6: UTF-16LE .txt without a BOM is rejected as invalid-encoding (NUL bytes)', async () => {
  const vaultRoot = await makeVault();
  const utf16le = Buffer.from('Hello, Vault', 'utf16le'); // no BOM
  const sourcePath = await drop(vaultRoot, 'utf16.txt', utf16le);

  await assert.rejects(() => runIngest({ vaultRoot, sourcePath }));

  const after = await fs.readFile(sourcePath);
  assert.ok(after.equals(utf16le), 'original left byte-identical');

  const errRecord = await readIngestError(vaultRoot, sourcePath);
  assert.ok(errRecord, 'ingest-error sidecar was written');
  assert.equal(errRecord?.reason, 'invalid-encoding');
});

// E4-6: a NUL byte embedded directly in an otherwise-valid-UTF-8 .md drop
// must also be rejected, not accepted into a note body.
test('E4-6: a NUL byte in a .md drop is rejected as invalid-encoding', async () => {
  const vaultRoot = await makeVault();
  const bytes = Buffer.concat([Buffer.from('# Title\n\nSome text '), Buffer.from([0x00]), Buffer.from(' more.')]);
  const sourcePath = await drop(vaultRoot, 'has-nul.md', bytes);

  await assert.rejects(() => runIngest({ vaultRoot, sourcePath }));

  const errRecord = await readIngestError(vaultRoot, sourcePath);
  assert.equal(errRecord?.reason, 'invalid-encoding');
});

// E4-7: a relative markdown link in the dropped text is a content-level
// policy violation (PRD §8.2 wikilinks-only). It must be caught BEFORE the
// original is copied, and must leave an explicit sidecar (previously: no
// sidecar was written at all for this failure mode).
test('E4-7: a relative .md link in the drop is rejected before the original is copied, with a sidecar', async () => {
  const vaultRoot = await makeVault();
  const body = '# Linked\n\nSee [other note](./other.md) for details.\n';
  const sourcePath = await drop(vaultRoot, 'linked.md', body);

  await assert.rejects(() => runIngest({ vaultRoot, sourcePath }), WikilinkViolationError);

  // Original untouched (still in the inbox).
  const stillThere = await fs.access(sourcePath).then(() => true).catch(() => false);
  assert.equal(stillThere, true, 'original was not removed on a content-policy rejection');

  // Nothing was copied into the content-addressed store.
  const hash = sha256Hex(Buffer.from(body, 'utf8'));
  const originalsDir = path.join(vaultRoot, '60_Sources', 'originals');
  const storeEntries = await fs.readdir(originalsDir).catch(() => [] as string[]);
  assert.ok(
    !storeEntries.some((f) => f.startsWith(hash)),
    'the original was NOT preserved before the content-policy check ran',
  );

  const errRecord = await readIngestError(vaultRoot, sourcePath);
  assert.ok(errRecord, 'ingest-error sidecar was written for the wikilink violation');
  assert.equal(errRecord?.reason, 'wikilink-violation');
  assert.equal(errRecord?.contentSha256, hash);
});

test('valid .md ingest preserves the original by hash with provenance frontmatter', async () => {
  const vaultRoot = await makeVault();
  const body = '# Hello Vault\n\nSome verbatim body text.\n';
  const sourcePath = await drop(vaultRoot, 'note.md', body);
  const expectedHash = sha256Hex(Buffer.from(body, 'utf8'));

  const result = await runIngest({ vaultRoot, sourcePath });

  assert.equal(result.deduplicated, false);
  assert.equal(result.sourceSha256, expectedHash);

  // Original preserved, content-addressed, hash verified.
  const preserved = await fs.readFile(result.originalPath);
  assert.equal(sha256Hex(preserved), expectedHash, 'preserved original hashes to the same value');
  assert.ok(result.originalPath.includes(path.join('60_Sources', 'originals')));

  // Derived note carries provenance, including the declared encoding (E4-6).
  const noteRaw = await fs.readFile(result.sourceNotePath, 'utf8');
  const parsed = parseNote(noteRaw);
  assert.equal(parsed.frontmatter['source_sha256'], expectedHash);
  assert.equal(parsed.frontmatter['original_path'], result.originalPath);
  assert.equal(parsed.frontmatter['extractor_name'], 'utf8-text');
  assert.ok(typeof parsed.frontmatter['extractor_version'] === 'string');
  assert.equal(parsed.frontmatter['source_encoding'], 'utf-8');
  assert.equal(parsed.frontmatter['source_bom_stripped'], false);
  const v = validateFrontmatter(parsed.frontmatter);
  assert.ok(v.ok, v.ok ? '' : v.errors.join('; '));

  // Inbox is emptied only after preservation + note are durable.
  const inboxLeft = await fs.readdir(path.join(vaultRoot, '00_Inbox'));
  assert.deepEqual(inboxLeft, []);
});

test('re-ingesting identical content is deduplicated (no duplicate note)', async () => {
  const vaultRoot = await makeVault();
  const body = '# Dup Check\n\nSame bytes, dropped twice.\n';

  const first = await drop(vaultRoot, 'first.md', body);
  const r1 = await runIngest({ vaultRoot, sourcePath: first });
  assert.equal(r1.deduplicated, false);

  const second = await drop(vaultRoot, 'second.md', body); // different filename, identical bytes
  const r2 = await runIngest({ vaultRoot, sourcePath: second });
  assert.equal(r2.deduplicated, true);
  assert.equal(r2.sourceId, r1.sourceId, 'dedup reuses the first ingest\'s note');
  assert.equal(r2.sourceNotePath, r1.sourceNotePath);

  // Exactly one note in 60_Sources (not counting the originals/ subdir).
  const sources = (await fs.readdir(path.join(vaultRoot, '60_Sources'))).filter(
    (f) => f.toLowerCase().endsWith('.md'),
  );
  assert.equal(sources.length, 1, 'no duplicate note was written');

  // Second drop's inbox copy was removed too (fully deduplicated).
  const secondLeft = await fs.access(second).then(() => true).catch(() => false);
  assert.equal(secondLeft, false);
});

// E4-8: dedup across a DIFFERENT extension than the one originally stored
// must report the ACTUAL stored path/extension, not silently substitute the
// new drop's extension into a path that was never written.
test('E4-8: cross-extension dedup returns the actual stored original path', async () => {
  const vaultRoot = await makeVault();
  const body = '# Cross Extension\n\nSame bytes, different filename extension.\n';

  const first = await drop(vaultRoot, 'a.md', body);
  const r1 = await runIngest({ vaultRoot, sourcePath: first });
  assert.equal(r1.originalPath, path.join(vaultRoot, '60_Sources', 'originals', `${r1.sourceSha256}.md`));

  const second = await drop(vaultRoot, 'c.txt', body); // identical bytes, different extension
  const r2 = await runIngest({ vaultRoot, sourcePath: second });
  assert.equal(r2.deduplicated, true);

  // Must point at the file that ACTUALLY exists on disk.
  const stat = await fs.stat(r2.originalPath);
  assert.ok(stat.isFile(), `reported originalPath ${r2.originalPath} must exist`);
  assert.equal(r2.originalPath, r1.originalPath, 'reports the SAME store file the first ingest wrote (.md, not .txt)');

  // The store never gained a second (wrongly-extensioned) copy.
  const originalsDir = path.join(vaultRoot, '60_Sources', 'originals');
  const entries = (await fs.readdir(originalsDir)).filter((f) => !f.endsWith('.note.json') && !f.endsWith('.lock'));
  assert.equal(entries.length, 1, 'exactly one stored original for this content, under its real extension');
});

// E4-1: dedup must not blindly trust the marker's presence — if the stored
// original is missing or corrupted, it must be repaired from the (already
// hash-verified) inbox bytes before the inbox copy is removed.
test('E4-1: dedup repairs a missing/corrupted stored original before removing the inbox copy', async () => {
  const vaultRoot = await makeVault();
  const body = '# Repair Check\n\nContent whose stored original will be destroyed.\n';

  const first = await drop(vaultRoot, 'a.md', body);
  const r1 = await runIngest({ vaultRoot, sourcePath: first });

  // Destroy the stored original (simulating disk corruption / accidental deletion).
  await fs.rm(r1.originalPath, { force: true });
  assert.equal(await fs.access(r1.originalPath).then(() => true).catch(() => false), false);

  // A fresh, identical drop must repair the store, not just delete the inbox copy.
  const second = await drop(vaultRoot, 'd.md', body);
  const r2 = await runIngest({ vaultRoot, sourcePath: second });
  assert.equal(r2.deduplicated, true);

  const repaired = await fs.readFile(r1.originalPath);
  assert.equal(sha256Hex(repaired), r1.sourceSha256, 'the stored original was repaired byte-for-byte');

  // Only now is it safe to have removed the inbox copy.
  const secondLeft = await fs.access(second).then(() => true).catch(() => false);
  assert.equal(secondLeft, false);
});

// E4-1 corollary: if the stored original is corrupted (wrong bytes, not just
// missing), dedup must still repair it, not ingest garbage as "verified".
test('E4-1: dedup repairs a bit-flipped stored original, not just a missing one', async () => {
  const vaultRoot = await makeVault();
  const body = '# Corruption Check\n\nContent whose stored original will be corrupted.\n';

  const first = await drop(vaultRoot, 'a.md', body);
  const r1 = await runIngest({ vaultRoot, sourcePath: first });
  await fs.writeFile(r1.originalPath, 'tampered bytes, wrong hash');

  const second = await drop(vaultRoot, 'e.md', body);
  await runIngest({ vaultRoot, sourcePath: second });

  const repaired = await fs.readFile(r1.originalPath);
  assert.equal(sha256Hex(repaired), r1.sourceSha256, 'the stored original was repaired, not left tampered');
});

test('crash after original preservation, before note write: resumes without loss or duplication', async () => {
  const vaultRoot = await makeVault();
  const body = '# Crash After Copy\n\nBody text.\n';
  const sourcePath = await drop(vaultRoot, 'crash1.md', body);

  await assert.rejects(() => runIngest({ vaultRoot, sourcePath, crashAfter: 'copy' }));

  // The "crash" happened after preservation but before note write — the
  // original must still be sitting in 00_Inbox (not yet safe to remove).
  const stillThere = await fs.access(sourcePath).then(() => true).catch(() => false);
  assert.equal(stillThere, true, 'original survives a crash before the note is durable');

  // Resume: re-running to completion produces exactly one note, no data loss.
  const result = await runIngest({ vaultRoot, sourcePath });
  assert.equal(result.deduplicated, false);
  const inboxLeft = await fs.readdir(path.join(vaultRoot, '00_Inbox'));
  assert.deepEqual(inboxLeft, []);
  const sources = (await fs.readdir(path.join(vaultRoot, '60_Sources'))).filter((f) =>
    f.toLowerCase().endsWith('.md'),
  );
  assert.equal(sources.length, 1, 'resume produced exactly one note');
});

test('crash after note write, before source removal: resumes without duplicating the note', async () => {
  const vaultRoot = await makeVault();
  const body = '# Crash After Note\n\nBody text.\n';
  const sourcePath = await drop(vaultRoot, 'crash2.md', body);

  await assert.rejects(() => runIngest({ vaultRoot, sourcePath, crashAfter: 'note' }));

  // The note WAS written, but the marker/removal never ran — the original
  // (a second, still-valid copy of the same content) must remain intact.
  const stillThere = await fs.access(sourcePath).then(() => true).catch(() => false);
  assert.equal(stillThere, true, 'original survives a crash after the note is written');
  const sourcesAfterCrash = (await fs.readdir(path.join(vaultRoot, '60_Sources'))).filter((f) =>
    f.toLowerCase().endsWith('.md'),
  );
  assert.equal(sourcesAfterCrash.length, 1, 'exactly one note exists after the crash');

  // Resume: must reuse the orphaned note, not write a second one.
  const result = await runIngest({ vaultRoot, sourcePath });
  const inboxLeft = await fs.readdir(path.join(vaultRoot, '00_Inbox'));
  assert.deepEqual(inboxLeft, []);
  const sourcesAfterResume = (await fs.readdir(path.join(vaultRoot, '60_Sources'))).filter((f) =>
    f.toLowerCase().endsWith('.md'),
  );
  assert.equal(sourcesAfterResume.length, 1, 'resume reused the orphaned note, no duplicate');
  assert.equal(
    path.basename(result.sourceNotePath),
    sourcesAfterCrash[0],
    'resume returned the SAME note that survived the crash, not a fresh one',
  );
});

test('a hash collision at the content-addressed path is detected, not silently trusted', async () => {
  // Sanity check that preserveOriginal's verify-on-reuse path is exercised by
  // the normal flow: corrupt an already-preserved original in place and
  // confirm a subsequent ingest of the SAME logical content notices.
  const { preserveOriginal, originalStorePath } = await import('../ingest/originals.js');
  const vaultRoot = await makeVault();
  const buf = Buffer.from('content for corruption test');
  const { hash } = await preserveOriginal(vaultRoot, buf, '.txt');
  const storePath = originalStorePath(vaultRoot, hash, '.txt');

  // Corrupt the stored copy directly (simulating disk corruption).
  await fs.writeFile(storePath, Buffer.from('tampered bytes, wrong hash'));

  await assert.rejects(() => preserveOriginal(vaultRoot, buf, '.txt'));
});

// E4-3: two (or more) concurrent drops of BYTE-IDENTICAL content must
// serialize into exactly one note — not both observe "no marker yet" and
// both mint one.
test('E4-3: concurrent identical drops produce exactly one note, not duplicates', async () => {
  const vaultRoot = await makeVault();
  const body = '# Concurrency Check\n\nThree identical drops, dropped at once.\n';

  const paths = await Promise.all(
    ['x.md', 'y.md', 'z.md'].map((name) => drop(vaultRoot, name, body)),
  );

  const results = await Promise.all(paths.map((sourcePath) => runIngest({ vaultRoot, sourcePath })));

  const dedupedCount = results.filter((r) => r.deduplicated).length;
  assert.equal(dedupedCount, 2, 'exactly one of the three ingests was NOT a dedup short-circuit');

  const sources = (await fs.readdir(path.join(vaultRoot, '60_Sources'))).filter((f) =>
    f.toLowerCase().endsWith('.md'),
  );
  assert.equal(sources.length, 1, 'concurrent identical drops produced exactly one note');

  const sourceIds = new Set(results.map((r) => r.sourceId));
  assert.equal(sourceIds.size, 1, 'all three ingests agree on the same source id');

  const inboxLeft = await fs.readdir(path.join(vaultRoot, '00_Inbox'));
  assert.deepEqual(inboxLeft, [], 'all three inbox copies were cleaned up');
});

// E4-4: if the inbox file's content changes concurrently between the point
// ingest verified/preserved it and the point it would delete it, the delete
// must be skipped (content re-hashed immediately before removal) rather than
// discarding whatever is now sitting at that path.
test('E4-4: content changed in the inbox just before removal is not deleted', async () => {
  const vaultRoot = await makeVault();
  const body = '# Race Check\n\nOriginal content, preserved successfully.\n';
  const sourcePath = await drop(vaultRoot, 'race.md', body);
  const racedContent = 'this landed after preservation but before the delete';

  const result = await runIngest({
    vaultRoot,
    sourcePath,
    onBeforeInboxRemoval: async () => {
      // Simulate a concurrent writer replacing the inbox file's content in
      // the window between "fully preserved" and "safe to delete".
      await fs.writeFile(sourcePath, racedContent, 'utf8');
    },
  });

  assert.equal(result.deduplicated, false);

  // The original content was still fully preserved and normalized...
  const preserved = await fs.readFile(result.originalPath, 'utf8');
  assert.equal(preserved, body);

  // ...but the raced-in content was NOT silently discarded: it is either
  // still sitting at the original inbox path (delete skipped) or, at worst,
  // recoverable under a `.ingest-tmp` staging name — never simply gone.
  const stillAtOriginalPath = await fs
    .readFile(sourcePath, 'utf8')
    .then((c) => c === racedContent)
    .catch(() => false);
  const inboxEntries = await fs.readdir(path.join(vaultRoot, '00_Inbox'));
  const tmpEntries = inboxEntries.filter((f) => f.endsWith('.ingest-tmp'));
  assert.ok(
    stillAtOriginalPath || tmpEntries.length > 0,
    'the racing writer\'s content was preserved somewhere in the inbox, not silently deleted',
  );
});

// E3-2: a junction planted at `60_Sources/originals` pointing OUTSIDE the
// vault must be rejected — the original must never be written through it,
// and the inbox drop must be left untouched (nothing "partially succeeded").
test('E3-2: a junction at 60_Sources/originals pointing outside the vault is rejected, not followed', async (t) => {
  const vaultRoot = await makeVault();
  const outside = await trackTmp(fs.mkdtemp(path.join(os.tmpdir(), 'skippy-outside-')));
  const originalsPath = path.join(vaultRoot, '60_Sources', 'originals');

  const made = await trySymlinkJunction(outside, originalsPath);
  if (!made) {
    t.skip('junction creation not permitted in this environment');
    return;
  }

  const body = '# Junction Attack\n\nMust never land outside the vault.\n';
  const sourcePath = await drop(vaultRoot, 'attack.md', body);

  await assert.rejects(() => runIngest({ vaultRoot, sourcePath }));

  // Nothing was written into the outside directory the junction points to.
  const outsideEntries = await fs.readdir(outside);
  assert.deepEqual(outsideEntries, [], 'the junction target received NO writes');

  // The inbox drop is untouched — the failure did not silently "succeed".
  const stillThere = await fs.access(sourcePath).then(() => true).catch(() => false);
  assert.equal(stillThere, true, 'original was not removed after a rejected containment check');
});

// E3-2: a junction planted at `60_Sources` itself (one level up) pointing
// outside the vault must also be rejected before any write is attempted.
test('E3-2: a junction at 60_Sources pointing outside the vault is rejected, not followed', async (t) => {
  const vaultRoot = await makeVault();
  const outside = await trackTmp(fs.mkdtemp(path.join(os.tmpdir(), 'skippy-outside2-')));
  const sourcesPath = path.join(vaultRoot, '60_Sources');

  // Replace the real 60_Sources with a junction to `outside`.
  await fs.rm(sourcesPath, { recursive: true, force: true });
  const made = await trySymlinkJunction(outside, sourcesPath);
  if (!made) {
    t.skip('junction creation not permitted in this environment');
    return;
  }

  const body = '# Junction Attack 2\n\nMust never land outside the vault.\n';
  const sourcePath = await drop(vaultRoot, 'attack2.md', body);

  await assert.rejects(() => runIngest({ vaultRoot, sourcePath }));

  const outsideEntries = await fs.readdir(outside);
  assert.deepEqual(outsideEntries, [], 'the junction target received NO writes');

  const stillThere = await fs.access(sourcePath).then(() => true).catch(() => false);
  assert.equal(stillThere, true, 'original was not removed after a rejected containment check');
});
