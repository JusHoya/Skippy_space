// model-limits.ts — per-model context window sizes (PRD §7.4 / §9.4).
//
// Phase 3 (WS6). The "HP-equivalent" context-window-pressure bar needs to know
// each model's window so it can render used/limit as a percentage. Pinned
// alongside pricing; refresh together (OQ-18 / R-02).

import type { ModelId } from './phase3prep.js';

/** Total context window in tokens, per model. Pinned 2026-06-03. */
export const MODEL_CONTEXT_LIMITS: Record<ModelId, number> = {
  // Opus 4.7 is the "(1M)" tier per the model picker label.
  'claude-opus-4-7': 1_000_000,
  'claude-sonnet-4-6': 200_000,
  'claude-haiku-4-5-20251001': 200_000,
};

const FALLBACK_LIMIT = 200_000;

/** Context window for a model id, falling back to 200k if unknown. */
export function contextLimitFor(model: string): number {
  return MODEL_CONTEXT_LIMITS[model as ModelId] ?? FALLBACK_LIMIT;
}

/** Fraction (0..1) of a model's context window consumed by `usedTokens`. */
export function contextPct(model: string, usedTokens: number): number {
  const limit = contextLimitFor(model);
  if (limit <= 0) return 0;
  return Math.min(1, Math.max(0, usedTokens / limit));
}
