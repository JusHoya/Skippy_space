// phase3.ts — Phase 3 "Memory deepens" wire contracts.
//
// Five new envelopes join the discriminated union in `./envelope.js`:
//   • telemetry_span   — one billable LLM turn (tokens + cost + latency)  [WS6/D5]
//   • context_window   — per-agent context-window pressure snapshot        [WS6/D5]
//   • error_span       — an errored span for the telemetry error feed      [WS6/D5]
//   • memory_job       — ingest/distill/link/lint pipeline progress        [WS5/D3]
//   • replay_session   — a .replay file opened/closed                      [WS8/D5]
//
// As with phase3prep.ts, anything crossing the sidecar↔shell↔renderer IPC
// boundary gets a Zod schema. agentId is a permissive string here (not
// AgentIdSchema) because task/job ids like "research.distiller" or
// "staff.lint" are not in the strict agent-id grammar but still emit telemetry.

import { z } from 'zod';

import { BoardIdSchema } from './envelope.js';

const Iso = z.string().datetime({ offset: true });

// ── telemetry_span (WS6) ──────────────────────────────────────────────────────

/**
 * Emitted at the END of an agent's LLM turn (not per token). Carries the exact
 * token usage from the API response + the derived USD cost so the renderer can
 * sum a session/by-board cost meter and a latency histogram with zero further
 * model knowledge.
 */
export const TelemetrySpanEnvelope = z.object({
  type: z.literal('telemetry_span'),
  spanId: z.string(),
  traceId: z.string().optional(),
  agentId: z.string().min(1),
  boardId: BoardIdSchema.optional(),
  promptId: z.string().optional(),
  model: z.string(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  durationMs: z.number().nonnegative(),
  ts: Iso,
});
export type TelemetrySpanEnvelope = z.infer<typeof TelemetrySpanEnvelope>;

// ── context_window (WS6) ──────────────────────────────────────────────────────

/** Per-agent context-window pressure. `usedTokens` is typically the input-token
 * count of the most recent call (which includes the whole conversation tail). */
export const ContextWindowEnvelope = z.object({
  type: z.literal('context_window'),
  agentId: z.string().min(1),
  boardId: BoardIdSchema.optional(),
  model: z.string(),
  usedTokens: z.number().int().nonnegative(),
  limitTokens: z.number().int().positive(),
  ts: Iso,
});
export type ContextWindowEnvelope = z.infer<typeof ContextWindowEnvelope>;

// ── error_span (WS6) ──────────────────────────────────────────────────────────

/** An errored span surfaced to the telemetry error feed (PRD §9.4 widget 4). */
export const ErrorSpanEnvelope = z.object({
  type: z.literal('error_span'),
  spanId: z.string().optional(),
  agentId: z.string().min(1),
  boardId: BoardIdSchema.optional(),
  errorKind: z.string(),
  message: z.string(),
  ts: Iso,
});
export type ErrorSpanEnvelope = z.infer<typeof ErrorSpanEnvelope>;

// ── memory_job (WS5) ──────────────────────────────────────────────────────────

export const MemoryJobName = z.enum(['ingest', 'distill', 'link', 'lint']);
export type MemoryJobName = z.infer<typeof MemoryJobName>;

export const MemoryJobPhase = z.enum(['start', 'progress', 'complete', 'error']);
export type MemoryJobPhase = z.infer<typeof MemoryJobPhase>;

/**
 * One pulse from the four-job memory pipeline. The renderer can surface these
 * as toast/log activity and (later) animate a beercan walking to a pedestal.
 * `counts` accumulates whatever the job produced (atomic notes, links, etc.).
 */
export const MemoryJobEnvelope = z.object({
  type: z.literal('memory_job'),
  job: MemoryJobName,
  phase: MemoryJobPhase,
  sourcePath: z.string().optional(),
  detail: z.string().optional(),
  counts: z
    .object({
      sources: z.number().int().nonnegative().optional(),
      atomic: z.number().int().nonnegative().optional(),
      links: z.number().int().nonnegative().optional(),
      proposals: z.number().int().nonnegative().optional(),
    })
    .optional(),
  ts: Iso,
});
export type MemoryJobEnvelope = z.infer<typeof MemoryJobEnvelope>;

// ── replay_session (WS8) ──────────────────────────────────────────────────────

/** A .replay file opened at boot / closed at shutdown (PRD §9.5). */
export const ReplaySessionEnvelope = z.object({
  type: z.literal('replay_session'),
  sessionId: z.string(),
  event: z.enum(['started', 'ended']),
  path: z.string().optional(),
  ts: Iso,
});
export type ReplaySessionEnvelope = z.infer<typeof ReplaySessionEnvelope>;
