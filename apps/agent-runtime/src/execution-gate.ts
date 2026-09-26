// execution-gate.ts — decide HOW an accepted delegation may execute
// (PRD v0.2 FR-RUN-01, M0 "explicit demo").
//
//   SKIPPY_DEMO_MODE=1                          → demo   (labelled `simulated`, no work)
//   PHASE3_AGENTS_ENABLED=1 + ANTHROPIC_API_KEY → live   (Claude Agent SDK executor)
//   PHASE3_AGENTS_ENABLED=1, no key             → blocked: missing_credentials
//   otherwise                                   → blocked: execution_disabled
//
// Demo mode wins over live when both are set: an operator who explicitly asked
// for a demo must not incur provider cost or side effects by surprise. Neither
// blocked branch can ever surface as success.

import type { OutcomeReason } from '@skippy/shared';

export type ExecutionGate =
  | { kind: 'live' }
  | { kind: 'demo' }
  | { kind: 'blocked'; reason: OutcomeReason };

export function resolveExecutionGate(env: NodeJS.ProcessEnv = process.env): ExecutionGate {
  if (env.SKIPPY_DEMO_MODE === '1') return { kind: 'demo' };
  if (env.PHASE3_AGENTS_ENABLED !== '1') {
    return {
      kind: 'blocked',
      reason: {
        code: 'execution_disabled',
        message:
          'Live board execution is disabled. Set PHASE3_AGENTS_ENABLED=1 with ANTHROPIC_API_KEY for real execution, or SKIPPY_DEMO_MODE=1 for a labelled simulation.',
      },
    };
  }
  if (!env.ANTHROPIC_API_KEY) {
    return {
      kind: 'blocked',
      reason: {
        code: 'missing_credentials',
        message: 'PHASE3_AGENTS_ENABLED=1 but ANTHROPIC_API_KEY is not set; live execution cannot start.',
      },
    };
  }
  return { kind: 'live' };
}
