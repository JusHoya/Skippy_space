// daily.test.ts — lock-in tests for the persisted-data correctness fixes (review §3).
//
// Covers two findings, both of which silently produced data that downstream code
// could not consume:
//   1. daily.ts emitted UNQUOTED ISO timestamps + bypassed the §8.3 validator, so
//      generated daily notes failed `validateFrontmatter` (timestamps re-parsed as
//      Date objects). We route the note through makeFrontmatter + serializeNote now.
//   2. vector-store.ts keyed the Smart Connections cache by vault PATH but looked it
//      up by bare ULID, so SC-backed search() always returned []. The cache is now
//      re-indexed by the ULID embedded in each path key so lookups actually hit.
//
// Run via: node --import tsx --test src/daily.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { generateDailyNote, dailyNotePath } from './daily.js';
import { parseNote, validateFrontmatter } from './frontmatter.js';
import { EmbeddingVectorStore, type CorpusItem } from './vector-store.js';
import type { LocalEmbedder } from './embeddings.js';

async function tmpVault(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'skippy-daily-'));
}

// ──────────────────────────────────────────────────────────────────────────────
// daily.ts — the generated note must pass the §8.3 validator (quoted timestamps)
// ──────────────────────────────────────────────────────────────────────────────

test('generateDailyNote writes a §8.3-valid note with string (not Date) timestamps', async () => {
  const vault = await tmpVault();
  const date = new Date(2026, 5, 10); // local 2026-06-10
  const res = await generateDailyNote({ date, vaultRoot: vault });

  assert.equal(res.created, true);
  assert.equal(res.path, dailyNotePath(vault, date));

  const raw = await fs.readFile(res.path, 'utf8');

  // The timestamp lines must be quoted so YAML round-trips them as strings, not
  // Date objects — the exact failure the §8.3 validator caught.
  assert.match(raw, /created_at: ['"]\d{4}-\d{2}-\d{2}T/);
  assert.match(raw, /updated_at: ['"]\d{4}-\d{2}-\d{2}T/);

  const parsed = parseNote(raw);
  assert.equal(
    typeof parsed.frontmatter.created_at,
    'string',
    'created_at must re-parse as a string',
  );
  assert.ok(
    !(parsed.frontmatter.created_at instanceof Date),
    'created_at must NOT re-parse as a Date',
  );

  const v = validateFrontmatter(parsed.frontmatter);
  assert.ok(v.ok, v.ok ? '' : `frontmatter failed §8.3: ${v.errors.join('; ')}`);
  if (v.ok) {
    assert.equal(v.value.type, 'daily');
    assert.equal(v.value.authored_by, 'skippy.staff.memory_manager');
  }
});

test('generateDailyNote is idempotent (append-only daily notes are not rewritten)', async () => {
  const vault = await tmpVault();
  const date = new Date(2026, 5, 10);
  const first = await generateDailyNote({ date, vaultRoot: vault });
  const before = await fs.readFile(first.path, 'utf8');

  const second = await generateDailyNote({ date, vaultRoot: vault });
  assert.equal(second.created, false);

  const after = await fs.readFile(second.path, 'utf8');
  assert.equal(after, before, 'existing daily note must be left byte-for-byte intact');
});

// ──────────────────────────────────────────────────────────────────────────────
// vector-store.ts — SC cache keyed by PATH must be reachable by corpus ULID
// ──────────────────────────────────────────────────────────────────────────────

// Two atomic notes: downstream code addresses them by bare ULID, but the Smart
// Connections cache keys them by their vault PATH (`10_Atomic/<ULID>.md`).
const ID_A = '01HZX9K2P7M4QTYV3BRWC8XENF';
const ID_B = '01HZX9K2P7M4QTYV3BRWC8XENG';
const VEC_A = [1, 0, 0];
const VEC_B = [0, 1, 0];

/** A deterministic query embedder so search() depends only on the corpus key match. */
function stubEmbedder(vec: number[]): LocalEmbedder {
  return async () => vec.slice();
}

test('PATH-keyed SC vectors resolve against bare-ULID corpus ids (the key-match fix)', async () => {
  // SC keys are vault PATHS; the corpus addresses items by bare ULID. Before the
  // fix, vectorFor() did scVectors.get(<ULID>) against a PATH-keyed map and always
  // missed, so SC vectors were never used and search() leaned on live embedding only.
  const scVectors = new Map<string, number[]>([
    [`10_Atomic/${ID_A}.md`, VEC_A],
    [`10_Atomic/${ID_B}.md`, VEC_B],
  ]);

  // The live embedder returns VEC_A for ANY text, including the corpus item text.
  // If the PATH->ULID bridge is broken, BOTH items fall back to the live embedder
  // and tie (both score 1.0). If it works, item A uses its precomputed VEC_A (score
  // 1.0) while item B uses precomputed VEC_B (score 0.0) — a strict, observable gap.
  const store = new EmbeddingVectorStore(scVectors, stubEmbedder(VEC_A));
  assert.equal(store.available, true, 'a store with a live embedder is available');

  const corpus: CorpusItem[] = [
    { id: ID_A, text: 'alpha' },
    { id: ID_B, text: 'beta' },
  ];
  const hits = await store.search('query', corpus, 5);

  assert.equal(hits.length, 2);
  const byId = new Map(hits.map((h) => [h.id, h.score] as const));
  assert.ok(Math.abs((byId.get(ID_A) ?? 0) - 1) < 1e-9, 'A scores ~1 via PATH-keyed VEC_A');
  assert.ok(Math.abs(byId.get(ID_B) ?? 1) < 1e-9, 'B scores ~0 via PATH-keyed VEC_B');
  assert.equal(hits[0]?.id, ID_A, 'ranking must put the precomputed-match first');
});

test('an SC-only store with no live embedder reports unavailable and search() is []', async () => {
  // SC corpus vectors exist, but there is no way to embed the QUERY (SC never embeds
  // an arbitrary query). search() therefore can never return anything, so available
  // must be false rather than advertising a dead search path (review §3).
  const scVectors = new Map<string, number[]>([[`10_Atomic/${ID_A}.md`, VEC_A]]);
  const store = new EmbeddingVectorStore(scVectors, null);

  assert.equal(store.available, false, 'no live embedder => not actually available');
  const hits = await store.search('query', [{ id: ID_A, text: 'alpha' }], 5);
  assert.deepEqual(hits, [], 'un-embeddable query yields no hits');
});
