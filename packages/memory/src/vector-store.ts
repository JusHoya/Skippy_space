// vector-store.ts — the retrieval abstraction the link/distill jobs rank against.
//
// Phase 3 (WS2). PRD §8.7 step 4 is "vector search fallback". This module wraps the
// available embedding source behind one small interface so the link job doesn't care
// whether vectors came from Smart Connections' cache, the local transformers model,
// or nowhere at all. When nothing is available, `search()` returns `[]` and the job
// degrades to graph-walk/keyword (§8.7 steps 2-3) — no special-casing at the call site.
//
// Precedence (PRD §8.8 — Smart Connections is the v1 store):
//   1. Smart Connections cache (`vault/.smart-env/`) — precomputed, zero compute.
//   2. Local @xenova/transformers embedder — headless/offline on-the-fly.
//   3. NullVectorStore — `available:false`, `search()` → [].
//
// Ranking is a plain O(n) cosine scan over the (small, Phase-3) corpus. LanceDB is
// the v2 path (PRD §8.8) and explicitly out of scope here.

import {
  cosineSimilarity,
  getLocalEmbedder,
  readSmartConnectionsEmbeddings,
  type LocalEmbedder,
} from './embeddings.js';

// ──────────────────────────────────────────────────────────────────────────────
// Interface
// ──────────────────────────────────────────────────────────────────────────────

/** One corpus item to rank: a stable id and the text to embed/compare. */
export interface CorpusItem {
  id: string;
  text: string;
}

/** A ranked hit: the item id and its cosine similarity to the query (desc order). */
export interface ScoredHit {
  id: string;
  score: number;
}

export interface VectorStore {
  /** True if this store can actually produce vectors (else search() returns []). */
  readonly available: boolean;
  /** Embed text → vector, or null when no embedder is available. */
  embed(text: string): Promise<number[] | null>;
  /**
   * Vector for a CORPUS item, preferring its precomputed Smart Connections vector
   * (no model load) and only embedding the text live on a cache miss. Callers that
   * precompute corpus vectors (e.g. the link job) MUST use this rather than
   * `embed(item.text)`, or the SC cache is bypassed entirely. Null when neither an
   * SC vector nor a live embedder is available.
   */
  vectorForItem(item: CorpusItem): Promise<number[] | null>;
  /** Rank `corpus` against `query` by cosine similarity; top `topK`, desc. */
  search(query: string, corpus: CorpusItem[], topK: number): Promise<ScoredHit[]>;
}

export interface MakeVectorStoreOptions {
  /** Absolute path to the Obsidian vault root (holds `.smart-env/`). */
  vaultRoot: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Factory
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Build the best available VectorStore for `vaultRoot`. Tries Smart Connections'
 * cache first, then the local transformers embedder, then falls back to a no-op
 * store. Never throws — a totally cold environment yields a NullVectorStore.
 */
export async function makeVectorStore(
  opts: MakeVectorStoreOptions,
): Promise<VectorStore> {
  // 1. Smart Connections precomputed vectors (preferred — no model load).
  const scVectors = await readSmartConnectionsEmbeddings(opts.vaultRoot);

  // 2. Local embedder — needed to embed the *query* (and any corpus item the SC
  //    cache doesn't cover). We attempt it regardless of #1: SC gives us corpus
  //    vectors but not a way to embed a fresh query string, and `search()` always
  //    has to embed the query live. Without an embedder there is no usable search
  //    path (SC corpus vectors alone can't score a fresh query), so we degrade.
  const embedder = await getLocalEmbedder();

  if (embedder !== null) {
    // SC vectors (if any) accelerate corpus scoring; the embedder handles the query
    // and any item the SC cache misses.
    return new EmbeddingVectorStore(scVectors, embedder);
  }

  // 3. No live embedder — even with SC corpus vectors we can't embed the query, so
  //    `search()` would always return []. Report unavailable rather than lie.
  return new NullVectorStore();
}

// ──────────────────────────────────────────────────────────────────────────────
// Implementations
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Backed by an optional Smart Connections vector map + an optional local embedder.
 *
 * `available` reflects whether `search()` can ACTUALLY return hits, not merely
 * whether some vectors exist. The query string has no precomputed vector (SC only
 * embeds vault notes, never an arbitrary query), so it MUST be embedded live — a
 * store with SC corpus vectors but no live embedder can never score anything and
 * `search()` would always return []. We therefore gate `available` on the live
 * embedder, so an SC-only/no-embedder store correctly reports `available:false`
 * instead of advertising a search path that silently yields nothing (review §3).
 *
 * Corpus lookup: SC keys its cache by vault PATH (`10_Atomic/<ULID>.md`), but the
 * corpus addresses items by bare ULID. We bridge that by indexing the SC map on the
 * ULID embedded in each path key (the filename stem) at construction time, so a
 * corpus item's `id` resolves to its precomputed SC vector. Anything the SC cache
 * doesn't cover falls back to live embedding of the item text.
 */
export class EmbeddingVectorStore implements VectorStore {
  readonly available: boolean;

  /** SC vectors re-indexed by the ULID extracted from each (path-like) cache key. */
  private readonly scByUlid: Map<string, number[]>;

  constructor(
    scVectors: Map<string, number[]>,
    private readonly embedder: LocalEmbedder | null,
  ) {
    // The query can only be scored via the live embedder; without it `search()`
    // cannot return anything, so the store is not actually "available".
    this.available = embedder !== null;
    this.scByUlid = indexScByUlid(scVectors);
  }

  async embed(text: string): Promise<number[] | null> {
    if (this.embedder === null) return null;
    return this.embedder(text);
  }

  async search(
    query: string,
    corpus: CorpusItem[],
    topK: number,
  ): Promise<ScoredHit[]> {
    if (topK <= 0 || corpus.length === 0) return [];

    // The query has no precomputed vector — it must be embedded live.
    const queryVec = await this.embed(query);
    if (queryVec === null) return [];

    const hits: ScoredHit[] = [];
    for (const item of corpus) {
      const itemVec = await this.vectorForItem(item);
      if (itemVec === null) continue;
      hits.push({ id: item.id, score: cosineSimilarity(queryVec, itemVec) });
    }

    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, topK);
  }

  /** Prefer a precomputed SC vector for this item; else embed its text live. */
  async vectorForItem(item: CorpusItem): Promise<number[] | null> {
    // Corpus items are addressed by bare ULID; SC vectors are indexed here by the
    // ULID extracted from each path key, so this lookup actually hits (review §3).
    const precomputed = this.scByUlid.get(item.id);
    if (precomputed) return precomputed;
    if (this.embedder === null) return null;
    return this.embedder(item.text);
  }
}

// A ULID is 26 chars of Crockford base32. We match leniently on `[0-9A-Za-z]{26}`
// (the same charset frontmatter.ts validates) so a real id is never missed; the
// surrounding `/` and `.` path delimiters keep the run from over-matching.
const ULID_IN_KEY_RE = /[0-9A-Za-z]{26}/;

/**
 * Re-index a Smart Connections vector map (keyed by vault PATH, e.g.
 * `10_Atomic/<ULID>.md`) by the ULID embedded in each key, so corpus items — which
 * are addressed by bare ULID — can resolve their precomputed vectors. Keys that are
 * already bare ULIDs map to themselves; keys with no recognizable ULID are dropped
 * (they can't be matched to a corpus id anyway). On collision, first write wins.
 */
function indexScByUlid(scVectors: Map<string, number[]>): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const [key, vec] of scVectors) {
    const ulid = ulidFromKey(key);
    if (ulid !== null && !out.has(ulid)) out.set(ulid, vec);
  }
  return out;
}

/** Extract the note ULID from a path-like SC cache key, or null if absent. */
function ulidFromKey(key: string): string | null {
  // Prefer the filename stem (`.../<ULID>.md` → `<ULID>`), which is where the
  // distiller writes the id; fall back to any 26-char ULID-shaped run in the key.
  const stem = key.replace(/\\/g, '/').split('/').pop() ?? key;
  const fromStem = stem.replace(/\.[^.]+$/, '');
  if (ULID_IN_KEY_RE.test(fromStem) && fromStem.length === 26) return fromStem;
  const m = key.match(ULID_IN_KEY_RE);
  return m ? m[0] : null;
}

/** The degraded store: no vectors, `search()` always returns []. */
class NullVectorStore implements VectorStore {
  readonly available = false;
  async embed(): Promise<number[] | null> {
    return null;
  }
  async vectorForItem(): Promise<number[] | null> {
    return null;
  }
  async search(): Promise<ScoredHit[]> {
    return [];
  }
}
