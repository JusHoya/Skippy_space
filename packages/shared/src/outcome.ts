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
//   • model refused the request → `failed`   (reason `model_refused`)
//   • stream ended, no result  → `failed`    (reason `no_terminal_result`)
//   • "success" result whose provider stream never reported a stop reason
//     (truncated stream)       → `failed`    (reason `provider_error`, OQ-20)
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
  // Added for the SDK executor's `terminal_reason` mapping (D1, FR-RUN-01):
  // a tool call the executor deferred pending an approval channel that does
  // not exist yet (`tool_deferred` / `deferred_tool_use`).
  'approval_required',
  // The executor's own tool calls were aborted mid-run (`terminal_reason:
  // 'aborted_tools'`) — the run was cut short, not a hard provider/model
  // failure, so it maps to `interrupted` rather than `failed`.
  'tool_execution_aborted',
  // The model itself declined the request (`stop_reason: 'refusal'` on the
  // SDK result). Distinct from `executor_error` so a refusal is never read as
  // a transient provider fault; still `failed`, never success (FR-RUN-01).
  'model_refused',
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
    // M0-G05: every reason code is a non-success reason; a success carrying
    // one is contradictory (no writer produces it — `deriveTaskOutcome`
    // never sets a reason on success).
    if (r.reason) v.push(`succeeded cannot carry a failure reason (${r.reason.code})`);
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
 * Anthropic Messages API stop reasons that mean the final model turn ended
 * normally (FR-RUN-01, OQ-20). An executor on Anthropic API semantics may
 * report `succeeded` only when its final turn carries one of these: a missing
 * (`null`/absent) stop reason means the provider stream ended before its
 * `message_delta`/`message_stop` — a truncated turn, never a success. Every
 * other value (`max_tokens`, `pause_turn`, `tool_use`, `refusal`, …) is a
 * cut-short, paused or refused turn. Adapters for endpoints that cannot report
 * a stop reason are ineligible for unattended success until qualified (OQ-20).
 */
export const NORMAL_STOP_REASONS = ['end_turn', 'stop_sequence'] as const;
export type NormalStopReason = (typeof NORMAL_STOP_REASONS)[number];

/** True only for a stop reason in {@link NORMAL_STOP_REASONS}. */
export function isNormalStopReason(v: unknown): v is NormalStopReason {
  return typeof v === 'string' && (NORMAL_STOP_REASONS as readonly string[]).includes(v);
}

/** Reason detail for a "success" whose provider stream ended without a stop
 * reason (OQ-20). Stable text so readers and tests can recognise it. */
export const TRUNCATED_STREAM_DETAIL = 'provider stream ended without a stop reason (truncated)';

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
/** Reader-side schema (never a writer's): terminal outcomes + `unverified`. */
export const RecordedOutcomeSchema = z.enum(RECORDED_OUTCOMES);

/** A terminal record as a *reader* may receive it: the Rust shell downgrades
 * a contract-violating record to `unverified` before forwarding it (EC1 D3). */
export type ReceivedTerminalRecord = Omit<TerminalRecord, 'outcome'> & { outcome: RecordedOutcome };

/** What a reader may display for a received terminal record. */
export interface GuardedTerminalRecord {
  outcome: RecordedOutcome;
  mode: ExecutionMode;
  validation: ValidationDisposition;
  reason?: OutcomeReason;
  /** Contract violations found; non-empty means the claim was NOT honoured. */
  violations: string[];
}

/**
 * Reader-side guard (EC1 D3, FR-RUN-01, G0 — defense in depth): a received
 * terminal record that violates the outcome invariants (e.g. a live
 * `succeeded` claiming `mode: "demo"`, or a failure without a reason) is shown
 * as `unverified` with an `invalid_record` reason — never as the outcome it
 * claims. A record already downgraded to `unverified` stays `unverified`.
 */
export function guardTerminalRecord(r: ReceivedTerminalRecord): GuardedTerminalRecord {
  if (r.outcome === 'unverified') {
    const out: GuardedTerminalRecord = { outcome: 'unverified', mode: r.mode, validation: 'not_run', violations: [] };
    out.reason = r.reason ?? {
      code: 'invalid_record',
      message: 'Record was not verified; treated as unverified.',
    };
    return out;
  }
  const violations = terminalRecordViolations(r as TerminalRecord);
  if (violations.length === 0) {
    const out: GuardedTerminalRecord = { outcome: r.outcome, mode: r.mode, validation: r.validation, violations };
    if (r.reason) out.reason = r.reason;
    return out;
  }
  return {
    outcome: 'unverified',
    mode: r.mode,
    validation: 'not_run',
    reason: {
      code: 'invalid_record',
      message: 'Record violates the outcome contract; treated as unverified.',
      detail: `claimed ${r.outcome}${r.reason ? `(${r.reason.code})` : ''}: ${violations.join('; ')}`,
    },
    violations,
  };
}
