// jobs/archival-mirror.test.ts — WS-D tests for the archival->vault mirror (node:test).
//
// Run via: node --import tsx --test src/jobs/archival-mirror.test.ts
//
// PURE FILESYSTEM — no Letta, no Obsidian REST. Over a tmp vault we assert:
//   - first write creates 50_Agents/{board}/agent_log.md with VALID §8.3 frontmatter
//     (parseNote + validateFrontmatter ok, type 'agent_log');
//   - a second write APPENDS (file grows) without adding a second frontmatter block;
//   - a payload containing a relative `.md` link does NOT throw — the link is
//     neutralized and the section is still written (or, worst case, {ok:false}
//     cleanly). No call ever throws.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { mirrorArchivalToVault } from './archival-mirror.js';
import { parseNote, validateFrontmatter } from '../frontmatter.js';

async function tmpVault(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'skippy-archival-mirror-'));
}

/** Count `---`-fenced frontmatter blocks at the very top of a note (should be 1). */
function countFrontmatterFences(raw: string): number {
  // gray-matter requires the opening fence on line 1. We count leading `---` lines
  // that bound a single block: a valid note has exactly two fence lines (open+close)
  // before the body, i.e. ONE frontmatter block.
  const lines = raw.split(/\r?\n/);
  let fences = 0;
  for (const line of lines) {
    if (line.trim() === '---') fences += 1;
    else if (fences >= 2) break; // past the (single) frontmatter block into the body
  }
  return fences;
}

test('mirrorArchivalToVault: first write creates a valid agent_log note', async () => {
  const vaultRoot = await tmpVault();
  const res = await mirrorArchivalToVault({
    board: 'research',
    text: 'first memory',
    vaultRoot,
  });

  assert.equal(res.ok, true, res.error ?? '');
  const expected = path.join(vaultRoot, '50_Agents', 'research', 'agent_log.md');
  assert.equal(res.path, expected);

  const raw = await fs.readFile(expected, 'utf8');
  const parsed = parseNote(raw);
  const v = validateFrontmatter(parsed.frontmatter);
  assert.ok(v.ok, v.ok ? '' : v.errors.join('; '));
  assert.equal(v.ok && v.value.type, 'agent_log');
  assert.equal(v.ok && v.value.authored_by, 'board.research');

  // The body carries the header + the first archival section.
  assert.match(parsed.body, /# research — agent log/);
  assert.match(parsed.body, /## .+ — archival/);
  assert.match(parsed.body, /first memory/);
});

test('mirrorArchivalToVault: a second write appends without a second frontmatter block', async () => {
  const vaultRoot = await tmpVault();
  const target = path.join(vaultRoot, '50_Agents', 'research', 'agent_log.md');

  const first = await mirrorArchivalToVault({
    board: 'research',
    text: 'first memory',
    vaultRoot,
    ts: '2026-06-03T00:00:00.000Z',
  });
  assert.equal(first.ok, true, first.error ?? '');
  const sizeAfterFirst = (await fs.readFile(target, 'utf8')).length;
  const fencesAfterFirst = countFrontmatterFences(await fs.readFile(target, 'utf8'));
  assert.equal(fencesAfterFirst, 2, 'exactly one frontmatter block (two fence lines)');

  const second = await mirrorArchivalToVault({
    board: 'research',
    text: 'second memory',
    vaultRoot,
    ts: '2026-06-03T01:00:00.000Z',
  });
  assert.equal(second.ok, true, second.error ?? '');

  const after = await fs.readFile(target, 'utf8');
  assert.ok(after.length > sizeAfterFirst, 'file grew on the second append');
  assert.equal(
    countFrontmatterFences(after),
    2,
    'still exactly one frontmatter block after the second write',
  );
  assert.match(after, /first memory/);
  assert.match(after, /second memory/);
});

test('mirrorArchivalToVault: relative .md link in text does not throw; file still written', async () => {
  const vaultRoot = await tmpVault();
  const target = path.join(vaultRoot, '50_Agents', 'design', 'agent_log.md');

  // This payload would make appendSection's wikilink guard throw if passed raw.
  const res = await mirrorArchivalToVault({
    board: 'design',
    text: 'see [x](./foo.md) for the prior decision',
    vaultRoot,
  });

  // Contract: either it wrote (link neutralized) or it failed cleanly — never threw.
  assert.equal(typeof res.ok, 'boolean');
  if (res.ok) {
    const raw = await fs.readFile(target, 'utf8');
    // The forbidden relative-md link must NOT survive into the vault.
    assert.doesNotMatch(raw, /\]\(\.\/foo\.md\)/, 'relative md link was neutralized');
    // The human-readable label is preserved.
    assert.match(raw, /see x for the prior decision|see\s+x/);
    // And the note is still valid §8.3 frontmatter.
    const v = validateFrontmatter(parseNote(raw).frontmatter);
    assert.ok(v.ok, v.ok ? '' : v.errors.join('; '));
  } else {
    // A clean soft-failure is acceptable too.
    assert.equal(typeof res.error, 'string');
  }
});

test('mirrorArchivalToVault: independent boards write to independent logs, no throw', async () => {
  const vaultRoot = await tmpVault();
  const a = await mirrorArchivalToVault({ board: 'engineering', text: 'eng note', vaultRoot });
  const b = await mirrorArchivalToVault({ board: 'finance', text: 'fin note', vaultRoot });

  assert.equal(a.ok, true, a.error ?? '');
  assert.equal(b.ok, true, b.error ?? '');
  assert.notEqual(a.path, b.path);

  const engRaw = await fs.readFile(a.path, 'utf8');
  const finRaw = await fs.readFile(b.path, 'utf8');
  assert.match(engRaw, /eng note/);
  assert.match(finRaw, /fin note/);
  assert.doesNotMatch(engRaw, /fin note/);
});
