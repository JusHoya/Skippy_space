// outcome.ts — the truthful-execution outcome contract (PRD v0.2 FR-RUN-01, G0).
//
// Acknowledgement means *accepted*, never completed. A unit of delegated work
// moves through non-terminal lifecycle states (`accepted`, `running`) and ends in
// exactly one terminal `Outcome`. Only a terminal executor result that reports
// success, combined with a non-failing validation disposition, may become
// `succeeded`. Disabled execution, missing credentials, provider failures and
// demo/stub runs can never be represented as success:
//
//   • demo/stub run            → `simulated` (mode `demo`, explicit opt-in only)
//   • execution disabled       → `blocked`   (reason `execution_disabled`)
//   • missing credentials      → `blocked`   (reason `missing_credentials`)
//   • tool policy refused      → `blocked`   (reason `policy_refused`)
//   • provider threw           → `failed`    (reason `provider_error`)
//   • executor error result    → `failed`    (reason `executor_error`)
//   • stream ended, no result  → `failed`    (reason `no_terminal_result`)
//   • validation failed        → `failed`    (reason `validation_failed`)
//   • runtime shut down        → `interrupted` (reason `shutdown`)
//
// This is the seed of the M1 ExecutionRequest/Outcome protocol sketched in
// docs/CLAUDE-OPUS-HANDOFF.md ("Contracts to establish before provider work").
// It is additive: M1 can add fields (run/attempt IDs, native handles) and reason
// codes without changing the meaning of anything declared here.

import { z } from 'zod';

// ── lifecycle (non-terminal) ─────────────────────────────────────────────────

/** Non-terminal states of accepted work. `accepted` is what an ack means. */
export const LIFECYCLE_STATES = ['accepted', 'running'] as const;
export const LifecycleStateSchema = z.enum(LIFECYCLE_STATES);
export type LifecycleState = z.infer<typeof LifecycleStateSchema>;

// ── terminal outcome ─────────────────────────────────────────────────────────

/** Terminal outcomes (FR-RUN-01). `simulated` is reserved for explicit demo mode. */
export const OUTCOMES = [
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
  'blocked',
  'simulated',
] as const;
export const OutcomeSchema = z.enum(OUTCOMES);
export type Outcome = z.infer<typeof OutcomeSchema>;

/**
 * Execution mode. `demo` is an explicit opt-in (SKIPPY_DEMO_MODE=1) whose records
 * are always `simulated` (or interrupted/cancelled) — never success. `live` is a
 * real executor attempt, including attempts that were blocked before starting.
 */
export const EXECUTION_MODES = ['demo', 'live'] as const;
export const ExecutionModeSchema = z.enum(EXECUTION_MODES);
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;

/**
 * Validation disposition against the task's acceptance criteria.
 *   passed       — criteria checked and met.
 *   failed       — criteria checked and not met (forces a non-success outcome).
 *   not_defined  — the task declared no acceptance criteria (pre-M1 default).
 *   not_run      — validation never ran (every non-succeeded outcome).
 */
export const VALIDATION_DISPOSITIONS = ['passed', 'failed', 'not_defined', 'not_run'] as const;
export const ValidationDispositionSchema = z.enum(VALIDATION_DISPOSITIONS);
export type ValidationDisposition = z.infer<typeof ValidationDispositionSchema>;

/** Machine-readable reason for every non-`succeeded` outcome. Additive enum. */
export const OUTCOME_REASON_CODES = [
  'demo_mode',
  'execution_disabled',
  'missing_credentials',
  'policy_refused',
  'provider_error',
  'executor_error',
  'no_terminal_result',
  'validation_failed',
  'runtime_error',
  'shutdown',
  'cancelled_by_user',
  'legacy_unverified',
  'invalid_record',
] as const;
export const OutcomeReasonCodeSchema = z.enum(OUTCOME_REASON_CODES);
export type OutcomeReasonCode = z.infer<typeof OutcomeReasonCodeSchema>;

export const OutcomeReasonSchema = z.object({
  code: OutcomeReasonCodeSchema,
  /** Human-readable explanation, safe to display. */
  message: z.string(),
  /** Redacted native diagnostics (provider subtype, error class/message). */
  detail: z.string().optional(),
});
export type OutcomeReason = z.infer<typeof OutcomeReasonSchema>;

/** Reference to an artifact produced by the work (file path, commit, note id). */
export const ArtifactRefSchema = z.object({
  kind: z.string().min(1),
  ref: z.string().min(1),
});
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

/**
 * The terminal record for one unit of work. Embedded (spread) into the
 * `delegation_complete` envelope; M1 run/attempt records reuse it verbatim.
 */
export const TerminalRecordShape = {
  outcome: OutcomeSchema,
  mode: ExecutionModeSchema,
  validation: ValidationDispositionSchema,
  reason: OutcomeReasonSchema.optional(),
  summary: z.string(),
  costUsd: z.number().nonnegative().optional(),
  artifacts: z.array(ArtifactRefSchema).optional(),
};
export const TerminalRecordSchema = z.object(TerminalRecordShape);
export type TerminalRecord = z.infer<typeof TerminalRecordSchema>;

/**
 * Semantic invariants that the plain object schema cannot express (the wire
 * union needs bare ZodObjects, so these live in a function). Returns a list of
 * violations; an empty list means the record is truthful by construction.
 */
export function terminalRecordViolations(r: TerminalRecord): string[] {
  const v: string[] = [];
  if (r.outcome === 'succeeded') {
    if (r.mode !== 'live') v.push('succeeded requires mode=live');
    if (r.validation !== 'passed' && r.validation !== 'not_defined') {
      v.push(`succeeded requires validation passed|not_defined, got ${r.validation}`);
    }
  } else if (!r.reason) {
    v.push(`${r.outcome} requires a reason`);
  }
  if (r.outcome === 'simulated' && r.mode !== 'demo') v.push('simulated requires mode=demo');
  if (r.mode === 'demo' && !['simulated', 'interrupted', 'cancelled'].includes(r.outcome)) {
    v.push(`demo mode cannot produce ${r.outcome}`);
  }
  return v;
}

// ── executor adapter result ──────────────────────────────────────────────────

/**
 * What an executor adapter (Claude Agent SDK, Codex, local loop, …) returns
 * once it has observed a *terminal* result from its provider. Adapters report
 * executor status only; the task outcome is derived by `deriveTaskOutcome`
 * together with the validation disposition.
 */
export type ExecutorTerminal =
  | {
      status: 'succeeded';
      summary: string;
      costUsd?: number;
      artifacts?: ArtifactRef[];
    }
  | {
      /** `blocked`: the adapter refused before starting (e.g. tool policy). */
      status: 'failed' | 'cancelled' | 'interrupted' | 'blocked';
      reason: OutcomeReason;
      summary?: string;
      costUsd?: number;
    };

/**
 * Combine a live executor's terminal result with the task's validation
 * disposition. This is the ONLY function that yields `succeeded`.
 */
export function deriveTaskOutcome(
  executor: ExecutorTerminal,
  validation: Exclude<ValidationDisposition, 'not_run'>,
): TerminalRecord {
  if (executor.status !== 'succeeded') {
    const out: TerminalRecord = {
      outcome: executor.status,
      mode: 'live',
      validation: 'not_run',
      reason: executor.reason,
      summary: executor.summary ?? executor.reason.message,
    };
    if (executor.costUsd !== undefined) out.costUsd = executor.costUsd;
    return out;
  }
  const base: TerminalRecord =
    validation === 'failed'
      ? {
          outcome: 'failed',
          mode: 'live',
          validation: 'failed',
          reason: {
            code: 'validation_failed',
            message: 'Executor finished but the task failed its acceptance criteria.',
          },
          summary: executor.summary,
        }
      : { outcome: 'succeeded', mode: 'live', validation, summary: executor.summary };
  if (executor.costUsd !== undefined) base.costUsd = executor.costUsd;
  if (executor.artifacts && executor.artifacts.length > 0) base.artifacts = executor.artifacts;
  return base;
}

/** Non-success terminal record helper (blocked / simulated / interrupted …). */
export function nonSuccessRecord(
  outcome: Exclude<Outcome, 'succeeded'>,
  mode: ExecutionMode,
  reason: OutcomeReason,
  summary: string = reason.message,
): TerminalRecord {
  return { outcome, mode, validation: 'not_run', reason, summary };
}

/** Outcomes a *reader* may report: terminal outcomes plus legacy `unverified`. */
export const RECORDED_OUTCOMES = [...OUTCOMES, 'unverified'] as const;
export type RecordedOutcome = (typeof RECORDED_OUTCOMES)[number];
