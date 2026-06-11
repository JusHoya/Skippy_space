// atomic.test.ts — WS1 unit tests for the vault write boundary.
//
// Run via: node --import tsx --test src/atomic.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  writeNote,
  writeNoteIfAbsent,
  appendSection,
  assertNoRelativeMdLinks,
  resolveInVault,
  WikilinkViolationError,
  PathEscapesVaultError,
} from './atomic.js';
import { makeFrontmatter, parseNote, validateFrontmatter } from './frontmatter.js';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'skippy-atomic-'));
}

function note(title: string, body: string) {
  const fm = makeFrontmatter({
    title,
    type: 'concept',
    authored_by: 'human',
    source: 'ref://test',
  });
  return { fm, body };
}

test('writeNote writes a valid, re-parseable note', async () => {
  const dir = await tmpDir();
  const target = path.join(dir, '20_Topics', 'alpha.md');
  const { fm, body } = note('Alpha', 'Body of alpha with a [[wikilink]].');
  const res = await writeNote(target, fm, body);
  assert.equal(res.written, true);
  const raw = await fs.readFile(target, 'utf8');
  const parsed = parseNote(raw);
  const v = validateFrontmatter(parsed.frontmatter);
  assert.ok(v.ok, v.ok ? '' : v.errors.join('; '));
  assert.match(parsed.body, /\[\[wikilink\]\]/);
});

test('wikilink guard rejects relative md links, allows wikilinks + http', () => {
  assert.throws(() => assertNoRelativeMdLinks('see [text](./other.md)'), WikilinkViolationError);
  assert.throws(() => assertNoRelativeMdLinks('see [t](../a/b.md#h)'), WikilinkViolationError);
  assert.doesNotThrow(() => assertNoRelativeMdLinks('see [[other]] and [src](https://x.com/a.md)'));
  assert.doesNotThrow(() => assertNoRelativeMdLinks('plain text, no links'));
});

test('writeNote refuses a relative-md-link body before touching disk', async () => {
  const dir = await tmpDir();
  const target = path.join(dir, 'bad.md');
  const { fm } = note('Bad', '');
  await assert.rejects(
    () => writeNote(target, fm, 'links to [other](./other.md)'),
    WikilinkViolationError,
  );
  assert.equal(
    await fs
      .access(target)
      .then(() => true)
      .catch(() => false),
    false,
    'no file should have been written',
  );
});

test('10 concurrent writes to the same path → no torn file', async () => {
  const dir = await tmpDir();
  const target = path.join(dir, '10_Atomic', 'contended.md');
  const writers = Array.from({ length: 10 }, (_, i) => {
    const { fm, body } = note(`Writer ${i}`, `Body number ${i}.`);
    return writeNote(target, fm, body);
  });
  const results = await Promise.all(writers);
  // Every call either wrote or cleanly reported contention — none threw.
  assert.equal(results.length, 10);
  // Final file is intact and valid (atomic rename guarantees no partial write).
  const raw = await fs.readFile(target, 'utf8');
  const v = validateFrontmatter(parseNote(raw).frontmatter);
  assert.ok(v.ok, v.ok ? '' : v.errors.join('; '));
  assert.match(parseNote(raw).body, /Body number \d+\./);
});

test('writeNoteIfAbsent is idempotent (no clobber)', async () => {
  const dir = await tmpDir();
  const target = path.join(dir, '40_Daily', 'once.md');
  const { fm, body } = note('Once', 'first body');
  const first = await writeNoteIfAbsent(target, fm, body);
  assert.equal(first.written, true);
  const { fm: fm2, body: body2 } = note('Once again', 'second body');
  const second = await writeNoteIfAbsent(target, fm2, body2);
  assert.equal(second.written, false);
  if (!second.written) assert.equal(second.reason, 'exists');
  // original content preserved
  assert.match(await fs.readFile(target, 'utf8'), /first body/);
});

test('resolveInVault rejects traversal + absolute paths, accepts relative', async () => {
  const vault = await tmpDir();
  // Traversal escape.
  assert.throws(() => resolveInVault(vault, '../x.md'), PathEscapesVaultError);
  assert.throws(() => resolveInVault(vault, '..\\..\\x.md'), PathEscapesVaultError);
  // Absolute path (would make path.resolve discard the vault root).
  assert.throws(
    () => resolveInVault(vault, path.join(os.tmpdir(), 'abs.md')),
    PathEscapesVaultError,
  );
  // A normal relative path is accepted and resolves inside the vault.
  const target = resolveInVault(vault, '10_Atomic/fact.md');
  assert.ok(target.startsWith(path.resolve(vault) + path.sep));
});

test('writeNote with a vaultRoot option contains the target (defense-in-depth)', async () => {
  const vault = await tmpDir();
  const { fm, body } = note('Escape', 'pwned');
  // A target that resolves OUTSIDE the vault is rejected before any disk I/O.
  const escape = path.join(vault, '..', 'escape.md');
  await assert.rejects(
    () => writeNote(escape, fm, body, { vaultRoot: vault }),
    PathEscapesVaultError,
  );
  assert.equal(
    await fs
      .access(escape)
      .then(() => true)
      .catch(() => false),
    false,
    'no file should have escaped the vault',
  );
  // A contained target still writes normally with the guard on.
  const inside = path.join(vault, '10_Atomic', 'fact.md');
  const r = await writeNote(inside, fm, 'A contained [[note]].', { vaultRoot: vault });
  assert.equal(r.written, true);
});

test('appendSection is append-only (preserves prior content)', async () => {
  const dir = await tmpDir();
  const target = path.join(dir, 'log.md');
  await fs.writeFile(target, '# Log\n');
  await appendSection(target, '- entry one');
  await appendSection(target, '- entry two');
  const raw = await fs.readFile(target, 'utf8');
  assert.match(raw, /# Log/);
  assert.match(raw, /- entry one/);
  assert.match(raw, /- entry two/);
  assert.ok(raw.indexOf('entry one') < raw.indexOf('entry two'), 'order preserved');
});
