// embeddings.ts — best-effort embedding helpers for semantic retrieval (PRD §8.8).
//
// Phase 3 (WS2). Two independent sources of 384-dim vectors, each optional:
//
//   1. Smart Connections cache — if the user runs Obsidian with the Smart
//      Connections plugin, it has already embedded the vault to `vault/.smart-env/`
//      with bge-micro-v2 (384-dim). We read that cache directly — zero compute,
//      zero model download. This is the v1 store the PRD §8.8 names.
//
//   2. Local transformers embedder — for headless/offline runs (CI, a job daemon
//      with Obsidian closed), we embed on the fly with @xenova/transformers running
//      the SAME model (Xenova/bge-micro-v2, quantized). Weights download from the
//      HF Hub on first use and are then cached on disk. In an offline CI with no
//      cached weights the load fails and we return `null` — callers MUST treat null
//      as "no embedder" and degrade to graph-walk/keyword (PRD §8.7). That is the
//      intended degradation, not a bug.
//
// Everything here is non-throwing: a missing cache → empty Map; a failed model
// load → null. We never crash the memory pipeline because vectors are unavailable.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

// ──────────────────────────────────────────────────────────────────────────────
// 1. Smart Connections embedding cache
// ──────────────────────────────────────────────────────────────────────────────

/** The HF model id Smart Connections (and our local embedder) use — 384-dim. */
export const EMBED_MODEL = 'Xenova/bge-micro-v2';
/** Expected embedding dimensionality (PRD §8.8). */
export const EMBED_DIM = 384;

/**
 * Read Smart Connections' on-disk embedding cache from `<vaultRoot>/.smart-env/`.
 * Returns a Map of note-id/path → vector. Missing dir, unreadable files, or an
 * empty cache all yield an empty Map (NEVER throws).
 *
 * Cache shape (defensive): Smart Connections has shipped a couple of layouts. We
 * tolerate the common ones:
 *   - `.smart-env/multi/*.json`  — one JSON file per source; either a single
 *     `{ key, vec | embedding | embeddings: { <model>: { vec } } }` object, or a
 *     map/array of such entries.
 *   - `.smart-env/smart_sources.json` (or similar) — a single JSON object keyed by
 *     source path, each value carrying a vector under `vec`/`embedding`.
 * Rather than hard-code one schema, we walk every `.json` under `.smart-env/` and
 * pull out anything that looks like `{ <pathish-key>: <number[]> }`. Any entry we
 * can't interpret is skipped silently.
 */
export async function readSmartConnectionsEmbeddings(
  vaultRoot: string,
): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  const smartEnv = path.join(vaultRoot, '.smart-env');

  let files: string[];
  try {
    files = await listJsonFilesRecursive(smartEnv);
  } catch {
    // .smart-env missing or unreadable → no embeddings. Caller falls back.
    return out;
  }
  if (files.length === 0) return out;

  for (const file of files) {
    let parsed: unknown;
    try {
      const raw = await fs.readFile(file, 'utf8');
      parsed = JSON.parse(raw);
    } catch {
      continue; // skip a corrupt/locked file rather than failing the whole read
    }
    collectVectors(parsed, out);
  }
  return out;
}

/** Recursively list every `*.json` under `dir`. Throws if `dir` is missing. */
async function listJsonFilesRecursive(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      try {
        found.push(...(await listJsonFilesRecursive(full)));
      } catch {
        // Unreadable subdir — skip, keep what we have.
      }
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Walk an arbitrary parsed-JSON value and harvest `{ key → number[] }` pairs into
 * `out`. We look for vectors under common field names (`vec`, `embedding`,
 * `values`) and also accept a bare `number[]` value keyed by a path-like string.
 * Defensive by design — Smart Connections' exact shape varies by version.
 */
function collectVectors(value: unknown, out: Map<string, number[]>): void {
  if (value === null || typeof value !== 'object') return;

  // An entry that directly carries an id + a vector.
  const direct = extractEntry(value);
  if (direct) {
    out.set(direct.key, direct.vec);
    return;
  }

  // Otherwise treat it as a container (object map or array) and recurse, using
  // object keys as candidate note-ids when the child itself only carries a vector.
  if (Array.isArray(value)) {
    for (const child of value) collectVectors(child, out);
    return;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    // Case A: child is a bare vector → the parent key is the note id.
    const bare = asVector(child);
    if (bare) {
      out.set(key, bare);
      continue;
    }
    // Case B: child is an entry object carrying its own vector (and maybe its own
    // key). Prefer the entry's own key, else fall back to the map key.
    if (child !== null && typeof child === 'object') {
      const entry = extractEntry(child);
      if (entry) {
        out.set(entry.keyExplicit ? entry.key : key, entry.vec);
        continue;
      }
      // Otherwise keep recursing into nested containers.
      collectVectors(child, out);
    }
  }
}

/**
 * Try to read a single `{ key, vec }` entry out of an object. Returns the entry's
 * own key if it carries one (`key`/`path`/`id`), and whether that key was explicit.
 */
function extractEntry(
  value: unknown,
): { key: string; vec: number[]; keyExplicit: boolean } | null {
  if (value === null || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;

  // Find the vector. Smart Connections nests it under `vec`/`embedding`, and some
  // versions keep a per-model map: `embeddings: { <model>: { vec: [...] } }`.
  let vec =
    asVector(obj['vec']) ??
    asVector(obj['embedding']) ??
    asVector(obj['values']) ??
    asVector(obj['vector']);

  if (!vec && obj['embeddings'] && typeof obj['embeddings'] === 'object') {
    for (const modelEntry of Object.values(obj['embeddings'] as Record<string, unknown>)) {
      const found =
        asVector(modelEntry) ??
        (modelEntry && typeof modelEntry === 'object'
          ? asVector((modelEntry as Record<string, unknown>)['vec'])
          : null);
      if (found) {
        vec = found;
        break;
      }
    }
  }

  if (!vec) return null;

  const keyRaw = obj['key'] ?? obj['path'] ?? obj['id'];
  if (typeof keyRaw === 'string' && keyRaw.length > 0) {
    return { key: keyRaw, vec, keyExplicit: true };
  }
  // No own key — caller supplies one (e.g. the parent map key).
  return { key: '', vec, keyExplicit: false };
}

/** Coerce a value to `number[]` iff it's a non-empty all-number array, else null. */
function asVector(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  for (const n of value) {
    if (typeof n !== 'number' || Number.isNaN(n)) return null;
  }
  return value as number[];
}

// ──────────────────────────────────────────────────────────────────────────────
// 2. Local transformers embedder (lazy, offline-tolerant)
// ──────────────────────────────────────────────────────────────────────────────

/** A function that turns text into a 384-dim L2-normalized vector. */
export type LocalEmbedder = (text: string) => Promise<number[]>;

// Cache the load attempt so we pay the (slow, network-touching) pipeline init at
// most once per process. `null` is a *valid, cached* result meaning "no embedder".
let embedderPromise: Promise<LocalEmbedder | null> | undefined;

/**
 * Lazily build a local embedder over @xenova/transformers (Xenova/bge-micro-v2,
 * quantized). Returns a function `text → number[]` (mean-pooled, L2-normalized,
 * 384-dim) or `null` if the model can't load — offline with no cached weights,
 * an incompatible runtime, or any init error. Callers that get `null` must fall
 * back to non-vector retrieval.
 *
 * NOTE: the first successful call downloads ~quantized weights from the HF Hub and
 * caches them under the transformers.js cache dir. Subsequent runs are offline-OK.
 */
export async function getLocalEmbedder(): Promise<LocalEmbedder | null> {
  if (embedderPromise === undefined) {
    embedderPromise = buildLocalEmbedder();
  }
  return embedderPromise;
}

async function buildLocalEmbedder(): Promise<LocalEmbedder | null> {
  try {
    // Dynamic import so merely importing this module never pulls in the (heavy)
    // transformers runtime, and so an install/runtime problem degrades to null
    // instead of crashing at module-eval time.
    const transformers = await import('@xenova/transformers');
    const pipeline = transformers.pipeline;

    // `pipeline('feature-extraction', model, { quantized })` resolves to a callable
    // FeatureExtractionPipeline. Its call returns a Tensor with `.data` (typed
    // array) and `.dims`. We request native mean-pooling + L2-normalization, then
    // copy the typed array out to a plain number[].
    const extractor = await pipeline('feature-extraction', EMBED_MODEL, {
      quantized: true,
    });

    return async (text: string): Promise<number[]> => {
      // The pipeline already mean-pools + L2-normalizes when asked; we then defensively
      // re-normalize the copied vector so the contract holds even if a future model
      // variant ignored the flag.
      const output = await extractor(text, { pooling: 'mean', normalize: true });
      // `output.data` is a Float32Array (DataArray); spread into a plain array.
      const raw = Array.from((output as { data: ArrayLike<number> }).data, Number);
      return l2normalize(raw);
    };
  } catch {
    // Model download blocked, weights absent offline, wasm/onnx load failure — all
    // mean "no local embedder". Intended degradation path (see file header).
    return null;
  }
}

/** L2-normalize a vector in place-safe fashion (returns a new array). Zero-safe. */
function l2normalize(v: number[]): number[] {
  let sumSq = 0;
  for (const x of v) sumSq += x * x;
  const norm = Math.sqrt(sumSq);
  if (norm === 0) return v.slice();
  return v.map((x) => x / norm);
}

// ──────────────────────────────────────────────────────────────────────────────
// 3. Cosine similarity (pure)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Cosine similarity of two equal-length vectors. Returns 0 for a length mismatch
 * or a zero vector (rather than NaN) so ranking is always well-defined. For
 * L2-normalized inputs this equals the dot product, but we divide by the norms
 * anyway so it's correct for un-normalized (e.g. raw Smart Connections) vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] as number;
    const bi = b[i] as number;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
