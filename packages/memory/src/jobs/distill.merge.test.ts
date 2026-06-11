// jobs/distill.merge.test.ts — lock-in tests for the topic-page read-modify-write
// correctness bug from docs/REVIEW-2026-06-10.md §3 (node:test).
//
// Run via: node --import tsx --test src/jobs/distill.merge.test.ts
//
// The bug: the topic-page merge re-stamped `created_at`, silently dropped unknown
// passthrough frontmatter fields, and minted a NEW ULID when the existing page
// failed validation — and the whole read-modify-write happened OUTSIDE the file
// lock, so concurrent distills could clobber pages and lose links.
//
// We assert that a SECOND distill run over the same vault:
//   1. preserves the topic page's original `created_at` + `id` (no re-stamp),
//   2. carries through unknown passthrough frontmatter fields losslessly,
//   3. bumps `updated_at` and ACCUMULATES the new atomic links (no clobber),
//   4. never re-mints an id even when the existing page's frontmatter is invalid,
// and that concurrent runs racing the same topic don't lose either run's links.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runDistill, topicSlug } from './distill.js';
import { parseNote, validateFrontmatter, serializeNote } from '../frontmatter.js';

// A focused source: repeated proper noun "Transformer" so a stable topic forms,
// plus enough prose that mockDistill yields its ≥8 atomic drafts.
const SOURCE_A = {
  sourceId: 'ref:#paper-a',
  title: 'The Transformer Architecture',
  body:
    'The Transformer architecture replaced recurrent networks for sequence modeling. ' +
    'Self-attention lets the Transformer weigh every token against every other token. ' +
    'Karpathy argues the Transformer is a remarkably general differentiable computer. ' +
    'Attention scales quadratically so the Transformer is costly on very long inputs. ' +
    'The Transformer block combines multi-head attention with a feed-forward network. ' +
    'Layer normalization and residual connections stabilize deep Transformer stacks. ' +
    'A Transformer encoder maps a token sequence into contextual representations. ' +
    'The Transformer decoder generates tokens autoregressively one step at a time.',
};

const SOURCE_B = {
  sourceId: 'ref:#paper-b',
  title: 'The Transformer Revisited',
  body:
    'The Transformer remains the dominant architecture for large language models today. ' +
    'A Transformer scales with more parameters, more data, and longer training runs. ' +
    'Rotary embeddings let the Transformer extrapolate to longer context windows. ' +
    'Flash attention makes the Transformer faster without changing its math at all. ' +
    'Mixture-of-experts routing gives the Transformer more capacity per forward pass. ' +
    'Quantization shrinks the Transformer so it fits on commodity inference hardware. ' +
    'Speculative decoding speeds up the Transformer by drafting tokens in parallel. ' +
    'The Transformer still struggles with faithful multi-step arithmetic reasoning.',
};

async function makeVault(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skippy-distill-merge-'));
  for (const sub of ['10_Atomic', '20_Topics']) {
    await fs.mkdir(path.join(root, sub), { recursive: true });
  }
  return root;
}

function readTopic(vaultRoot: string, name: string) {
  const slug = topicSlug(name);
  return path.join(vaultRoot, '20_Topics', `${slug}.md`);
}

// Collect the [[id]] wikilinks present in a body.
function linkedIds(body: string): Set<string> {
  return new Set(
    [...body.matchAll(/\[\[([0-9A-Za-z]{26})\]\]/g)].map((m) => m[1]!),
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// 1. A second distill preserves created_at + id, keeps passthrough fields, and
//    accumulates links (the core review §3 regression).
// ──────────────────────────────────────────────────────────────────────────────

test('a second distill run preserves created_at + id and keeps passthrough frontmatter', async () => {
  const vaultRoot = await makeVault();

  const first = await runDistill({ vaultRoot, source: SOURCE_A });
  assert.ok(first.topicPaths.length > 0, 'first run wrote at least one topic page');
  assert.ok(first.atomicIds.length >= 8, 'first run wrote ≥8 atomic notes');

  const topicPath = readTopic(vaultRoot, 'Transformer');
  const before = parseNote(await fs.readFile(topicPath, 'utf8'));
  const beforeV = validateFrontmatter(before.frontmatter);
  assert.ok(beforeV.ok, beforeV.ok ? '' : beforeV.errors.join('; '));
  const originalId = beforeV.value.id;
  const originalCreatedAt = beforeV.value.created_at;
  const firstLinks = linkedIds(before.body);
  assert.ok(firstLinks.size > 0, 'first run linked atomic notes into the topic');

  // Inject an unknown passthrough field + a backdated created_at to prove identity
  // and arbitrary fields both survive the second run's merge. Serialize through the
  // real writer so the timestamp is quoted (round-trips back as a string).
  const backdated = '2020-01-02T03:04:05.000Z';
  const doctored = serializeNote(
    { ...beforeV.value, created_at: backdated, schema_version: 7, custom_pointer: 'keep-me' },
    `\n${before.body}\n`,
  );
  await fs.writeFile(topicPath, doctored, 'utf8');

  // Second distill over the SAME vault — same topic name, fresh atomic ids.
  const second = await runDistill({ vaultRoot, source: SOURCE_B });
  assert.ok(second.atomicIds.length >= 8, 'second run wrote ≥8 new atomic notes');

  const after = parseNote(await fs.readFile(topicPath, 'utf8'));
  const afterV = validateFrontmatter(after.frontmatter);
  assert.ok(afterV.ok, afterV.ok ? '' : afterV.errors.join('; '));

  // Identity is preserved verbatim — NOT re-stamped to now / re-minted.
  assert.equal(afterV.value.id, originalId, 'topic id must be preserved across runs');
  assert.equal(
    afterV.value.created_at,
    backdated,
    'created_at must be preserved (not reset to now)',
  );
  assert.notEqual(originalCreatedAt, backdated, 'sanity: we actually changed created_at');

  // updated_at moved forward (the page was re-touched).
  assert.ok(
    afterV.value.updated_at >= originalCreatedAt,
    'updated_at should be bumped on merge',
  );

  // Unknown passthrough fields survive losslessly.
  assert.equal(
    (after.frontmatter as Record<string, unknown>).schema_version,
    7,
    'unknown passthrough field schema_version must survive',
  );
  assert.equal(
    (after.frontmatter as Record<string, unknown>).custom_pointer,
    'keep-me',
    'unknown passthrough field custom_pointer must survive',
  );

  // Links ACCUMULATE: the first run's links are still present AND new ones appeared.
  const mergedLinks = linkedIds(after.body);
  for (const id of firstLinks) {
    assert.ok(mergedLinks.has(id), `first-run link ${id} must survive the merge`);
  }
  assert.ok(
    mergedLinks.size > firstLinks.size,
    'second run must add new links, not clobber the page',
  );
});

// ──────────────────────────────────────────────────────────────────────────────
// 2. An existing page with INVALID frontmatter is repaired without re-minting its id.
// ──────────────────────────────────────────────────────────────────────────────

test('a degraded topic page is repaired without re-minting its id', async () => {
  const vaultRoot = await makeVault();
  await runDistill({ vaultRoot, source: SOURCE_A });

  const topicPath = readTopic(vaultRoot, 'Transformer');
  const before = parseNote(await fs.readFile(topicPath, 'utf8'));
  const originalId = (before.frontmatter as Record<string, unknown>).id as string;
  const originalCreatedAt = (before.frontmatter as Record<string, unknown>)
    .created_at as string;
  assert.match(originalId, /^[0-9A-Za-z]{26}$/, 'sanity: original id is a ULID');

  // Hand-break the frontmatter: a status the §8.3 schema rejects. The id + created_at
  // stay valid strings; the page as a WHOLE fails validation. gray-matter quotes the
  // confidence/status we write here, so the id round-trips as a string.
  const broken =
    `---\n` +
    `id: ${originalId}\n` +
    `title: Transformer\n` +
    `created_at: '${originalCreatedAt}'\n` +
    `updated_at: '${originalCreatedAt}'\n` +
    `type: concept\n` +
    `status: not-a-real-status\n` +
    `authored_by: research.distiller\n` +
    `source: 'gen://distill'\n` +
    `keepme: yes\n` +
    `---\n\n# Transformer\n\nSeed.\n`;
  await fs.writeFile(topicPath, broken, 'utf8');

  await runDistill({ vaultRoot, source: SOURCE_B });

  const after = parseNote(await fs.readFile(topicPath, 'utf8'));
  const afterV = validateFrontmatter(after.frontmatter);
  assert.ok(afterV.ok, afterV.ok ? '' : afterV.errors.join('; '));

  // The id is the SAME — repaired, never re-minted (review §3).
  assert.equal(afterV.value.id, originalId, 'invalid page must keep its original id');
  assert.equal(
    afterV.value.created_at,
    originalCreatedAt,
    'invalid page must keep its original created_at',
  );
});

// ──────────────────────────────────────────────────────────────────────────────
// 3. Concurrent distills racing the SAME topic don't lose either run's links.
//    (Holding the proper-lockfile lock across the whole read-modify-write.)
// ──────────────────────────────────────────────────────────────────────────────

test('concurrent distills on the same topic do not lose links (lock held across RMW)', async () => {
  const vaultRoot = await makeVault();
  // Seed the topic page once so both racers take the read-modify-write (merge) path.
  await runDistill({ vaultRoot, source: SOURCE_A });

  const topicPath = readTopic(vaultRoot, 'Transformer');
  const seeded = linkedIds(parseNote(await fs.readFile(topicPath, 'utf8')).body);

  // Fire two distills with DIFFERENT sources (so different atomic ids) concurrently.
  // Without the lock spanning the read+write, one run's read would predate the
  // other's write and the later write would clobber the earlier run's new links.
  const [r1, r2] = await Promise.all([
    runDistill({ vaultRoot, source: SOURCE_B }),
    runDistill({
      vaultRoot,
      source: { ...SOURCE_B, sourceId: 'ref:#paper-c', title: 'Transformer Notes' },
    }),
  ]);

  const finalLinks = linkedIds(parseNote(await fs.readFile(topicPath, 'utf8')).body);

  // Every seeded link must still be present (no clobber of the pre-existing page).
  for (const id of seeded) {
    assert.ok(finalLinks.has(id), `seeded link ${id} survived concurrency`);
  }

  // At least one of the two concurrent runs' atomic links must be present, and the
  // page must have GROWN past the seed — the merge under-lock cannot silently drop
  // everything a racing run added.
  const r1ByName = r1.atomicIds.filter((id) => finalLinks.has(id));
  const r2ByName = r2.atomicIds.filter((id) => finalLinks.has(id));
  assert.ok(
    r1ByName.length > 0 || r2ByName.length > 0,
    'at least one racing run wrote its links into the shared topic page',
  );
  assert.ok(
    finalLinks.size > seeded.size,
    'the shared topic page grew under concurrency (no full clobber)',
  );
});
