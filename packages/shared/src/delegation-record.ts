// delegation-record.ts — tolerant reader for persisted `delegation_complete`
// records (replay JSONL, imported logs). PRD v0.2 FR-OPS-05: legacy
// simulated/ambiguous results never become verified success.
//
// Pre-v0.2 sidecars wrote `result: 'success' | 'failure'` — and wrote
// `'success'` for the Phase-1 stub and for SDK failures that fell back to the
// stub summary. Those records are therefore ambiguous: a reader maps legacy
// `'success'` to `unverified`, legacy `'failure'` to `failed`, and any
// current-shape record that violates the outcome invariants to `unverified`.
// Nothing read through here is ever upgraded to `succeeded`.

import { BoardIdSchema } from './agents.js';
import { DelegationCompleteEnvelope } from './envelope.js';
import {
  terminalRecordViolations,
  type ExecutionMode,
  type OutcomeReason,
  type RecordedOutcome,
  type ValidationDisposition,
} from './outcome.js';

export interface DelegationCompleteRecord {
  type: 'delegation_complete';
  delegationId: string;
  fromBoardId: string;
  outcome: RecordedOutcome;
  /** `unknown` for legacy records, which predate explicit demo mode. */
  mode: ExecutionMode | 'unknown';
  validation: ValidationDisposition;
  reason?: OutcomeReason;
  summary: string;
  costUsd?: number;
  ts: string;
  /** True when the record predates the v0.2 outcome contract. */
  legacy: boolean;
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

/**
 * Normalize one raw persisted record. Returns null when `raw` is not a
 * `delegation_complete` record at all.
 */
export function readDelegationCompleteRecord(raw: unknown): DelegationCompleteRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (obj.type !== 'delegation_complete') return null;

  const parsed = DelegationCompleteEnvelope.safeParse(raw);
  if (parsed.success) {
    const env = parsed.data;
    const violations = terminalRecordViolations(env);
    if (violations.length === 0) {
      const rec: DelegationCompleteRecord = {
        type: 'delegation_complete',
        delegationId: env.delegationId,
        fromBoardId: env.fromBoardId,
        outcome: env.outcome,
        mode: env.mode,
        validation: env.validation,
        summary: env.summary,
        ts: env.ts,
        legacy: false,
      };
      if (env.reason) rec.reason = env.reason;
      if (env.costUsd !== undefined) rec.costUsd = env.costUsd;
      return rec;
    }
    // Current shape but semantically inconsistent (e.g. demo "succeeded").
    return {
      type: 'delegation_complete',
      delegationId: env.delegationId,
      fromBoardId: env.fromBoardId,
      outcome: env.outcome === 'succeeded' ? 'unverified' : env.outcome,
      mode: env.mode,
      validation: 'not_run',
      reason: {
        code: 'invalid_record',
        message: 'Record violates the outcome contract; treated as unverified.',
        detail: violations.join('; '),
      },
      summary: env.summary,
      ts: env.ts,
      legacy: false,
    };
  }

  // Legacy (pre-v0.2) or malformed record. Never upgrade to success.
  const legacyResult = obj.result;
  const board = BoardIdSchema.safeParse(obj.fromBoardId);
  const base = {
    type: 'delegation_complete' as const,
    delegationId: str(obj.delegationId),
    fromBoardId: board.success ? board.data : str(obj.fromBoardId),
    mode: 'unknown' as const,
    validation: 'not_run' as const,
    summary: str(obj.summary),
    ts: str(obj.ts),
    legacy: true,
  };
  if (legacyResult === 'failure') {
    return {
      ...base,
      outcome: 'failed',
      reason: { code: 'legacy_unverified', message: 'Legacy record reported failure.' },
    };
  }
  return {
    ...base,
    outcome: 'unverified',
    reason: {
      code: 'legacy_unverified',
      message:
        legacyResult === 'success'
          ? 'Legacy "success" may have been a stub or fallback acknowledgement; not verified.'
          : 'Unrecognized delegation_complete record; not verified.',
    },
  };
}
