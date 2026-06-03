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
  //    vectors but not a way to embed a fresh query string.
  const embedder = await getLocalEmbedder();

  if (scVectors.size > 0 || embedder !== null) {
    return new EmbeddingVectorStore(scVectors, embedder);
  }

  // 3. Nothing available — degrade.
  return new NullVectorStore();
}

// ──────────────────────────────────────────────────────────────────────────────
// Implementations
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Backed by an optional Smart Connections vector map + an optional local embedder.
 * `available` is true if *either* source exists. Corpus items are embedded by
 * looking them up in the SC map first (by id), falling back to live embedding.
 * The query is always embedded live (SC has no entry for an arbitrary query), so a
 * store with SC vectors but no live embedder can only score pre-embedded queries —
 * in that (rare) case `search()` returns [] for an un-embeddable query.
 */
class EmbeddingVectorStore implements VectorStore {
  readonly available = true;

  constructor(
    private readonly scVectors: Map<string, number[]>,
    private readonly embedder: LocalEmbedder | null,
  ) {}

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
      const itemVec = await this.vectorFor(item);
      if (itemVec === null) continue;
      hits.push({ id: item.id, score: cosineSimilarity(queryVec, itemVec) });
    }

    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, topK);
  }

  /** Prefer a precomputed SC vector for this item; else embed its text live. */
  private async vectorFor(item: CorpusItem): Promise<number[] | null> {
    const precomputed = this.scVectors.get(item.id);
    if (precomputed) return precomputed;
    if (this.embedder === null) return null;
    return this.embedder(item.text);
  }
}

/** The degraded store: no vectors, `search()` always returns []. */
class NullVectorStore implements VectorStore {
  readonly available = false;
  async embed(): Promise<number[] | null> {
    return null;
  }
  async search(): Promise<ScoredHit[]> {
    return [];
  }
}
