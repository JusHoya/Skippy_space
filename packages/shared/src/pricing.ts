// pricing.ts — model $-cost table (PRD §9.4 cost meter).
//
// Phase 3 (WS6). The telemetry panel's cost meter is worthless without a
// per-model price, so we pin one here. These are USD per 1,000,000 tokens.
//
// PINNED 2026-06-03. OQ-18: these are the figures the cost meter bills against;
// they MUST be refreshed when Anthropic changes list pricing (quarterly per
// R-02). The numbers are wrapped in this DTO precisely so a bump is a one-file
// edit and never leaks model-specific arithmetic into call sites.
//
// Note on the 1M-context Opus tier: long-context requests above the standard
// window can carry premium rates upstream. We bill a single flat rate here and
// accept the small drift — a Phase 3.x refinement can add a >200k surcharge
// band if the cost meter proves materially off.

import type { ModelId } from './phase3prep.js';

export interface ModelPrice {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
}

/** USD / 1M tokens, pinned 2026-06-03. */
export const MODEL_PRICING: Record<ModelId, ModelPrice> = {
  'claude-opus-4-7': { input: 15, output: 75 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
};

/** Fallback used for an unknown model id (Sonnet-class mid rate). */
const FALLBACK_PRICE: ModelPrice = { input: 3, output: 15 };

/** Look up the price for a model id, falling back to a mid rate if unknown. */
export function priceFor(model: string): ModelPrice {
  return MODEL_PRICING[model as ModelId] ?? FALLBACK_PRICE;
}

/**
 * Compute the USD cost of a single call given its token usage. Pure function —
 * the cost meter and the replay writer both call it so the number is consistent
 * everywhere.
 */
export function getCost(model: string, inputTokens: number, outputTokens: number): number {
  const p = priceFor(model);
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
}
