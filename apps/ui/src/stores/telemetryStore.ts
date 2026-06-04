import { create } from 'zustand';
import type {
  TelemetrySpanEnvelope,
  ContextWindowEnvelope,
  ErrorSpanEnvelope,
} from '@skippy/shared';

/**
 * Telemetry aggregation store (PRD §9.4 / D5). Fed by the OTel→Channel stream
 * in `lib/channel.ts`: each `telemetry_span` / `context_window` / `error_span`
 * envelope is folded in here, and the TelemetryPanel renders the four widgets
 * (cost meter, latency histogram, context-window bar, error feed) off this
 * state.
 *
 * Per CLAUDE.md this is UI-visible discrete state (a completed LLM turn), so
 * Zustand is the right home — NOT the per-frame ref-store. Spans arrive at most
 * a few per second, so the re-render cost is negligible; we still cap the ring
 * buffers so a long session can't grow unbounded.
 */

const MAX_LATENCY_SAMPLES = 200;
const MAX_ERRORS = 50;

export interface ContextSnapshot {
  model: string;
  usedTokens: number;
  limitTokens: number;
  updatedAt: string;
}

export interface ErrorEntry {
  agentId: string;
  errorKind: string;
  message: string;
  ts: string;
  spanId?: string;
}

export interface TelemetryStore {
  /** Total session cost in USD. */
  sessionCostUsd: number;
  /** Cost bucketed by board id (Skippy buckets under his agent id). */
  costByBucket: Record<string, number>;
  /** Rolling window of recent LLM-turn durations (ms) for the histogram. */
  latencies: number[];
  /** Latest context-window snapshot per agent. */
  contextByAgent: Record<string, ContextSnapshot>;
  /** Recent error spans (newest last), capped. */
  errors: ErrorEntry[];
  /** Cumulative token counters. */
  totalInputTokens: number;
  totalOutputTokens: number;
  /** Output tokens/sec of the most recent turn (for the TopBar gauge). */
  lastTokPerSec: number;
  /** Epoch ms of the last telemetry envelope, or null if none yet. */
  lastSpanAt: number | null;

  recordSpan: (e: TelemetrySpanEnvelope) => void;
  recordContext: (e: ContextWindowEnvelope) => void;
  recordError: (e: ErrorSpanEnvelope) => void;
  reset: () => void;
}

const EMPTY = {
  sessionCostUsd: 0,
  costByBucket: {} as Record<string, number>,
  latencies: [] as number[],
  contextByAgent: {} as Record<string, ContextSnapshot>,
  errors: [] as ErrorEntry[],
  totalInputTokens: 0,
  totalOutputTokens: 0,
  lastTokPerSec: 0,
  lastSpanAt: null as number | null,
};

export const useTelemetryStore = create<TelemetryStore>((set) => ({
  ...EMPTY,

  recordSpan: (e) =>
    set((s) => {
      const bucket = e.boardId ?? e.agentId;
      const latencies = [...s.latencies, e.durationMs];
      if (latencies.length > MAX_LATENCY_SAMPLES) latencies.shift();
      return {
        sessionCostUsd: s.sessionCostUsd + e.costUsd,
        costByBucket: {
          ...s.costByBucket,
          [bucket]: (s.costByBucket[bucket] ?? 0) + e.costUsd,
        },
        latencies,
        totalInputTokens: s.totalInputTokens + e.inputTokens,
        totalOutputTokens: s.totalOutputTokens + e.outputTokens,
        lastTokPerSec: e.durationMs > 0 ? e.outputTokens / (e.durationMs / 1000) : 0,
        lastSpanAt: Date.now(),
      };
    }),

  recordContext: (e) =>
    set((s) => ({
      contextByAgent: {
        ...s.contextByAgent,
        [e.agentId]: {
          model: e.model,
          usedTokens: e.usedTokens,
          limitTokens: e.limitTokens,
          updatedAt: e.ts,
        },
      },
      lastSpanAt: Date.now(),
    })),

  recordError: (e) =>
    set((s) => {
      const entry: ErrorEntry = {
        agentId: e.agentId,
        errorKind: e.errorKind,
        message: e.message,
        ts: e.ts,
        ...(e.spanId !== undefined ? { spanId: e.spanId } : {}),
      };
      const errors = [...s.errors, entry];
      if (errors.length > MAX_ERRORS) errors.shift();
      return { errors, lastSpanAt: Date.now() };
    }),

  reset: () => set({ ...EMPTY, costByBucket: {}, contextByAgent: {}, errors: [], latencies: [] }),
}));

/** Percentile (nearest-rank) over an unsorted sample array. Returns 0 if empty. */
export function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx] ?? 0;
}
