// jobs/pipeline-tail.regression.test.ts — lock-in tests for three pipeline-TAIL bugs
// from docs/REVIEW-2026-06-10.md §3/§7 + the perf review (node:test).
//
// Run via: node --import tsx --test src/jobs/pipeline-tail.regression.test.ts
//
//   1. LINT minted a NEW ulid-named proposal note EVERY run, even on a clean sweep —
//      unbounded near-duplicate notes nothing reads. We assert: a clean vault writes
//      NO proposal (proposalPath === null), a vault WITH findings writes exactly ONE
//      rolling proposal, and a second run with findings OVERWRITES that one note
//      (the proposals dir never grows past one file).
//   2. ARCHIVAL-MIRROR could leave a header-less agent_log forever after a lost
//      create-race (appendSection created the file before the header was stamped).
//      We seed a header-less log and assert the next mirror REPAIRS it — valid §8.3
//      frontmatter is prepended and the pre-existing history survives (append-only).
//   3. LINK re-embedded the ENTIRE atomic corpus PER topic (O(topics × notes) forward
//      passes). We assert embedCorpusOnce embeds each note exactly once per run and
//      semanticNeighbors reuses that cache (no re-embed), with ranking unchanged.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ulid } from 'ulid';

import { runLint } from './lint.js';
import { mirrorArchivalToVault } from './archival-mirror.js';
import { embedCorpusOnce, semanticNeighbors } from './link.js';
import { serializeNote, parseNote, validateFrontmatter } from '../frontmatter.js';
import type { VectorStore } from '../vector-store.js';

async function makeVault(...subs: string[]): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skippy-pipeline-tail-'));
  for (const sub of subs) await fs.mkdir(path.join(root, sub), { recursive: true });
  return root;
}

async function listMd(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).filter((f) => f.toLowerCase().endsWith('.md'));
  } catch {
    return [];
  }
}

/** Write a valid atomic_fact note into 10_Atomic with the given id + body keyword. */
async function writeAtomic(
  vaultRoot: string,
  id: string,
  opts: { sourced: boolean; body: string; tags?: string[] },
): Promise<void> {
  const now = new Date().toISOString();
  const fm = {
    id,
    title: 'a fact',
    created_at: now,
    updated_at: now,
    type: 'atomic_fact',
    status: opts.sourced ? 'active' : 'draft',
    tags: opts.tags ?? [],
    source: opts.sourced ? 'ref:#test' : null,
    authored_by: 'staff.distill',
    confidence: 0.6,
    distilled_from: [],
    supersedes: null,
    contradicts: [],
  };
  const note = serializeNote(fm, `\n${opts.body}\n`);
  await fs.writeFile(path.join(vaultRoot, '10_Atomic', `${id}.md`), note, 'utf8');
}

// ──────────────────────────────────────────────────────────────────────────────
// Bug 1 — lint must NOT mint a fresh proposal note every run.
// ──────────────────────────────────────────────────────────────────────────────

test('runLint writes NOTHING when the sweep is clean (no findings)', async () => {
  // No atomic notes → no orphans/sourceless/stale → nothing to propose.
  const vaultRoot = await makeVault('10_Atomic', '20_Topics', '_index/proposals');

  const res = await runLint({ vaultRoot });

  assert.equal(res.proposalPath, null, 'clean sweep returns proposalPath: null');
  assert.equal(res.orphanCount, 0);
  const proposals = await listMd(path.join(vaultRoot, '_index', 'proposals'));
  assert.equal(proposals.length, 0, 'no proposal note written on a clean sweep');
});

test('runLint writes ONE rolling proposal on findings and OVERWRITES it on re-run', async () => {
  const vaultRoot = await makeVault('10_Atomic', '20_Topics', '_index/proposals');

  // An orphan atomic note (no topic links to it) → a finding → a proposal is written.
  const orphanId = ulid();
  await writeAtomic(vaultRoot, orphanId, { sourced: true, body: 'an orphan claim' });

  const first = await runLint({ vaultRoot });
  assert.equal(typeof first.proposalPath, 'string', 'a finding writes a proposal');
  assert.ok(first.orphanCount >= 1, 'the orphan is counted');

  const afterFirst = await listMd(path.join(vaultRoot, '_index', 'proposals'));
  assert.equal(afterFirst.length, 1, 'exactly one proposal note after the first run');

  // The written note is valid §8.3 frontmatter authored by staff.lint.
  const firstRaw = await fs.readFile(first.proposalPath as string, 'utf8');
  const v = validateFrontmatter(parseNote(firstRaw).frontmatter);
  assert.ok(v.ok, v.ok ? '' : v.errors.join('; '));
  assert.equal(v.ok && v.value.authored_by, 'staff.lint');

  // Add a SECOND orphan and run again — the proposals dir must NOT grow; the single
  // rolling note is overwritten with the newer sweep (this is the unbounded-growth fix).
  const orphan2 = ulid();
  await writeAtomic(vaultRoot, orphan2, { sourced: true, body: 'a second orphan claim' });

  const second = await runLint({ vaultRoot });
  assert.equal(
    second.proposalPath,
    first.proposalPath,
    'the rolling proposal keeps the SAME stable path across runs',
  );
  const afterSecond = await listMd(path.join(vaultRoot, '_index', 'proposals'));
  assert.equal(afterSecond.length, 1, 'still exactly one proposal note after the re-run');

  // The overwritten note reflects the newer sweep (both orphans listed).
  const secondRaw = await fs.readFile(second.proposalPath as string, 'utf8');
  assert.match(secondRaw, new RegExp(orphanId));
  assert.match(secondRaw, new RegExp(orphan2));
});

// ──────────────────────────────────────────────────────────────────────────────
// Bug 2 — archival-mirror must repair a header-less agent_log (lost create-race).
// ──────────────────────────────────────────────────────────────────────────────

test('mirrorArchivalToVault repairs a header-less agent_log left by a lost create-race', async () => {
  const vaultRoot = await makeVault();
  const board = 'research';
  const target = path.join(vaultRoot, '50_Agents', board, 'agent_log.md');
  await fs.mkdir(path.dirname(target), { recursive: true });

  // Simulate the lost race: appendSection created the file FIRST, so it has history
  // sections but NO §8.3 frontmatter header — the artifact writeNoteIfAbsent can never
  // repair via its {exists} no-op. (Mirror of appendSection's `\n…\n` chunk shape.)
  const headerless = '\n## 2026-06-03T00:00:00.000Z — archival\nthe earliest memory\n';
  await fs.writeFile(target, headerless, 'utf8');

  // Sanity: the seeded file is NOT a valid note yet.
  assert.equal(
    validateFrontmatter(parseNote(await fs.readFile(target, 'utf8')).frontmatter).ok,
    false,
    'precondition: the seeded log has no valid frontmatter',
  );

  // The next mirror call must REPAIR the header (not skip it forever) and append.
  const res = await mirrorArchivalToVault({
    board,
    text: 'a fresh memory',
    vaultRoot,
    ts: '2026-06-04T00:00:00.000Z',
  });
  assert.equal(res.ok, true, res.error ?? '');

  const raw = await fs.readFile(target, 'utf8');
  const parsed = parseNote(raw);
  const v = validateFrontmatter(parsed.frontmatter);
  assert.ok(v.ok, v.ok ? '' : v.errors.join('; '));
  assert.equal(v.ok && v.value.type, 'agent_log');
  assert.equal(v.ok && v.value.authored_by, 'board.research');

  // Append-only: the PRE-EXISTING history survives the repair (not rewritten/dropped)...
  assert.match(parsed.body, /the earliest memory/, 'pre-race history is preserved');
  // ...and the new section was appended too.
  assert.match(parsed.body, /a fresh memory/, 'the new archival section was appended');
});

// ──────────────────────────────────────────────────────────────────────────────
// Bug 3 — link must embed each atomic note ONCE per run, not once per topic.
// ──────────────────────────────────────────────────────────────────────────────

/** A fake VectorStore that records every embed() input so we can count calls. */
function countingStore(): { store: VectorStore; embedded: string[] } {
  const embedded: string[] = [];
  const embed = async (text: string): Promise<number[]> => {
    embedded.push(text);
    // Deterministic toy embedding: length + a tiny per-char signal. Enough for the
    // cache-reuse + ranking-stability assertions; the exact geometry doesn't matter.
    const a = text.length % 7;
    const b = (text.charCodeAt(0) || 0) % 11;
    return [a, b, 1];
  };
  const store: VectorStore = {
    available: true,
    embed,
    // No SC cache in this fake, so the SC-preferring path falls straight through to
    // embed(item.text) — preserving the "exactly one embed per note" invariant.
    async vectorForItem(item: { id: string; text: string }): Promise<number[]> {
      return embed(item.text);
    },
    async search(): Promise<{ id: string; score: number }[]> {
      throw new Error('search() must not be called once the corpus is cached');
    },
  };
  return { store, embedded };
}

test('embedCorpusOnce embeds each atomic note exactly once per run', async () => {
  const { store, embedded } = countingStore();
  const atomic = [
    { id: 'a', text: 'note one about transformers' },
    { id: 'b', text: 'note two about attention' },
    { id: 'c', text: 'note three about embeddings' },
  ] as Parameters<typeof embedCorpusOnce>[1];

  const cache = await embedCorpusOnce(store, atomic);

  assert.equal(cache.size, 3, 'every note is cached');
  assert.equal(embedded.length, 3, 'exactly one embed() per note (no per-topic re-embed)');
  // The cache covers every corpus id.
  for (const id of ['a', 'b', 'c']) assert.ok(cache.has(id), `cache has ${id}`);
});

test('semanticNeighbors reuses the cache across topics without re-embedding the corpus', async () => {
  const { store, embedded } = countingStore();
  const atomic = [
    { id: 'a', text: 'note one about transformers' },
    { id: 'b', text: 'note two about attention' },
    { id: 'c', text: 'note three about embeddings' },
  ] as Parameters<typeof embedCorpusOnce>[1];

  const cache = await embedCorpusOnce(store, atomic);
  assert.equal(embedded.length, 3, 'corpus embedded once up front');

  // Rank THREE topics against the cache. Each topic embeds only its OWN query string —
  // the corpus is never re-embedded (the old per-topic store.search did 3 × 3 = 9
  // corpus embeds; the cache path does 3 corpus + 3 query = 6, i.e. O(topics + notes)).
  const topics = ['topic alpha', 'topic beta', 'topic gamma'];
  const rankings: { id: string; score: number }[][] = [];
  for (const t of topics) rankings.push(await semanticNeighbors(store, t, cache, 12));

  // After ranking 3 topics: 3 corpus embeds + 3 query embeds = 6 total. Crucially the
  // corpus count did NOT scale with topics (would be 3 + 3×3 = 12 under per-topic search).
  assert.equal(embedded.length, 6, 'only the 3 queries were embedded on top of the cached corpus');

  // Ranking is stable + well-formed: every topic returns all 3 ids, desc by score.
  for (const r of rankings) {
    assert.equal(r.length, 3, 'all corpus ids ranked');
    for (let i = 1; i < r.length; i++) {
      assert.ok(r[i - 1]!.score >= r[i]!.score, 'hits are sorted descending by score');
    }
  }
});
