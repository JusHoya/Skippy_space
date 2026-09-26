// jobs/ingest.test.ts — WS-E regression tests for original preservation (FR-WIKI-03).
//
// Covers: unsupported/binary drops stay intact with an explicit error;
// invalid-UTF-8 text drops stay intact with an explicit error; a valid
// drop preserves its original by content hash with provenance frontmatter;
// re-ingesting identical content is deduplicated (no duplicate note); and a
// simulated mid-step crash resumes without losing the source or duplicating
// the note.
//
// Run via: node --import tsx --test src/jobs/ingest.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runIngest, UnsupportedFormatError } from './ingest.js';
import { readIngestError, ingestErrorPath } from '../ingest/errors.js';
import { sha256Hex } from '../ingest/originals.js';
import { parseNote, validateFrontmatter } from '../frontmatter.js';

async function makeVault(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skippy-ingest-'));
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

  // An explicit, visible error sidecar exists.
  const errRecord = await readIngestError(sourcePath);
  assert.ok(errRecord, 'ingest-error sidecar was written');
  assert.equal(errRecord?.reason, 'unsupported-format');
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

  const errRecord = await readIngestError(sourcePath);
  assert.ok(errRecord, 'ingest-error sidecar was written');
  assert.equal(errRecord?.reason, 'invalid-encoding');
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

  // Derived note carries provenance.
  const noteRaw = await fs.readFile(result.sourceNotePath, 'utf8');
  const parsed = parseNote(noteRaw);
  assert.equal(parsed.frontmatter['source_sha256'], expectedHash);
  assert.equal(parsed.frontmatter['original_path'], result.originalPath);
  assert.equal(parsed.frontmatter['extractor_name'], 'utf8-text');
  assert.ok(typeof parsed.frontmatter['extractor_version'] === 'string');
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
