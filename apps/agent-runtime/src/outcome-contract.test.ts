// outcome-contract.test.ts — PRD v0.2 FR-RUN-01 / FR-OPS-05 / G0 regressions
// for the shared outcome contract, the execution gate and the Claude Agent SDK
// executor adapter. No API key, network or real SDK process is used: the SDK
// module is injected.
//
// Run: node --import tsx --test src/outcome-contract.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DelegationCompleteEnvelope,
  deriveTaskOutcome,
  nonSuccessRecord,
  readDelegationCompleteRecord,
  terminalRecordViolations,
} from '@skippy/shared';

import { resolveExecutionGate } from './execution-gate.js';
import { executeBoardMissionViaSdk, type ClaudeAgentSdkModule } from './sdk-board.js';

// ── shared contract ─────────────────────────────────────────────────────────

test('deriveTaskOutcome: only executor success + non-failing validation is succeeded', () => {
  const ok = deriveTaskOutcome({ status: 'succeeded', summary: 'done', costUsd: 0.01 }, 'not_defined');
  assert.equal(ok.outcome, 'succeeded');
  assert.equal(ok.mode, 'live');
  assert.equal(ok.validation, 'not_defined');
  assert.equal(ok.costUsd, 0.01);
  assert.deepEqual(terminalRecordViolations(ok), []);

  const passed = deriveTaskOutcome({ status: 'succeeded', summary: 'done' }, 'passed');
  assert.equal(passed.outcome, 'succeeded');

  const validationFailed = deriveTaskOutcome({ status: 'succeeded', summary: 'claims done' }, 'failed');
  assert.equal(validationFailed.outcome, 'failed');
  assert.equal(validationFailed.reason?.code, 'validation_failed');

  for (const status of ['failed', 'cancelled', 'interrupted'] as const) {
    const r = deriveTaskOutcome(
      { status, reason: { code: 'provider_error', message: 'boom' } },
      'passed',
    );
    assert.equal(r.outcome, status, `${status} executor stays ${status}`);
    assert.equal(r.validation, 'not_run');
    assert.deepEqual(terminalRecordViolations(r), []);
  }
});

test('terminalRecordViolations rejects demo success, simulated live, and reasonless failures', () => {
  assert.notDeepEqual(
    terminalRecordViolations({ outcome: 'succeeded', mode: 'demo', validation: 'not_defined', summary: '' }),
    [],
  );
  assert.notDeepEqual(
    terminalRecordViolations({ outcome: 'simulated', mode: 'live', validation: 'not_run', summary: '', reason: { code: 'demo_mode', message: '' } }),
    [],
  );
  assert.notDeepEqual(
    terminalRecordViolations({ outcome: 'failed', mode: 'live', validation: 'not_run', summary: '' }),
    [],
  );
  assert.notDeepEqual(
    terminalRecordViolations({ outcome: 'succeeded', mode: 'live', validation: 'not_run', summary: '' }),
    [],
  );
  assert.deepEqual(
    terminalRecordViolations(
      nonSuccessRecord('simulated', 'demo', { code: 'demo_mode', message: 'demo' }),
    ),
    [],
  );
});

test('the wire schema no longer accepts a bare legacy result:"success"', () => {
  const legacy = {
    type: 'delegation_complete',
    delegationId: 'D1',
    fromBoardId: 'coding',
    result: 'success',
    summary: 'Board coding acknowledges and is queuing this mission. (Stub)',
    ts: '2026-04-30T00:00:00.000Z',
  };
  assert.equal(DelegationCompleteEnvelope.safeParse(legacy).success, false);
});

test('legacy reader never upgrades ambiguous results to verified success (FR-OPS-05)', () => {
  const base = { type: 'delegation_complete', delegationId: 'D1', fromBoardId: 'coding', summary: 's', ts: '2026-04-30T00:00:00.000Z' };

  const legacySuccess = readDelegationCompleteRecord({ ...base, result: 'success' });
  assert.equal(legacySuccess?.outcome, 'unverified');
  assert.equal(legacySuccess?.legacy, true);
  assert.equal(legacySuccess?.reason?.code, 'legacy_unverified');

  const legacyFailure = readDelegationCompleteRecord({ ...base, result: 'failure' });
  assert.equal(legacyFailure?.outcome, 'failed');

  // Current shape but contract-violating (demo "success") → unverified.
  const forged = readDelegationCompleteRecord({ ...base, outcome: 'succeeded', mode: 'demo', validation: 'not_defined' });
  assert.equal(forged?.outcome, 'unverified');
  assert.equal(forged?.reason?.code, 'invalid_record');

  // A genuine current success is preserved as-is.
  const genuine = readDelegationCompleteRecord({ ...base, outcome: 'succeeded', mode: 'live', validation: 'not_defined' });
  assert.equal(genuine?.outcome, 'succeeded');
  assert.equal(genuine?.legacy, false);

  assert.equal(readDelegationCompleteRecord({ type: 'agent_state' }), null);
});

// ── execution gate ──────────────────────────────────────────────────────────

test('gate: disabled flag → blocked(execution_disabled)', () => {
  const g = resolveExecutionGate({ ANTHROPIC_API_KEY: 'sk-test' });
  assert.equal(g.kind, 'blocked');
  assert.equal(g.kind === 'blocked' && g.reason.code, 'execution_disabled');
});

test('gate: flag on but missing key → blocked(missing_credentials)', () => {
  const g = resolveExecutionGate({ PHASE3_AGENTS_ENABLED: '1' });
  assert.equal(g.kind, 'blocked');
  assert.equal(g.kind === 'blocked' && g.reason.code, 'missing_credentials');
});

test('gate: flag + key → live; explicit demo wins over live', () => {
  assert.equal(resolveExecutionGate({ PHASE3_AGENTS_ENABLED: '1', ANTHROPIC_API_KEY: 'k' }).kind, 'live');
  assert.equal(
    resolveExecutionGate({ SKIPPY_DEMO_MODE: '1', PHASE3_AGENTS_ENABLED: '1', ANTHROPIC_API_KEY: 'k' }).kind,
    'demo',
  );
  assert.equal(resolveExecutionGate({ SKIPPY_DEMO_MODE: '0' }).kind, 'blocked');
});

// ── SDK executor adapter (mocked SDK) ───────────────────────────────────────

const params = {
  boardId: 'coding',
  systemPrompt: 'You are the Coding Board Captain.',
  model: 'claude-sonnet-4-6' as never,
  missionBrief: 'implement the thing',
};

/** Build a fake SDK whose query() yields `messages` (or throws `throwAfter`). */
function fakeSdk(messages: unknown[], throwAfter?: Error): () => Promise<ClaudeAgentSdkModule> {
  const query = (() => {
    async function* gen(): AsyncGenerator<unknown> {
      for (const m of messages) yield m;
      if (throwAfter) throw throwAfter;
    }
    return gen();
  }) as unknown as ClaudeAgentSdkModule['query'];
  return () => Promise.resolve({ query });
}

test('sdk executor: SDK import/provider throws → failed(provider_error), never success', async () => {
  const r = await executeBoardMissionViaSdk(params, {
    loadSdk: () => Promise.reject(new Error('Cannot find module / no API key')),
  });
  assert.equal(r.status, 'failed');
  assert.equal(r.status === 'failed' && r.reason.code, 'provider_error');
  assert.match(r.status === 'failed' ? (r.reason.detail ?? '') : '', /no API key/);
});

test('sdk executor: stream throws mid-run → failed(provider_error)', async () => {
  const r = await executeBoardMissionViaSdk(params, {
    loadSdk: fakeSdk([{ type: 'assistant' }], new Error('socket hang up')),
  });
  assert.equal(r.status, 'failed');
  assert.equal(r.status === 'failed' && r.reason.code, 'provider_error');
});

test('sdk executor: error result subtype → failed(executor_error)', async () => {
  const r = await executeBoardMissionViaSdk(params, {
    loadSdk: fakeSdk([
      { type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['too many turns'], total_cost_usd: 0.2 },
    ]),
  });
  assert.equal(r.status, 'failed');
  assert.equal(r.status === 'failed' && r.reason.code, 'executor_error');
  assert.equal(r.costUsd, 0.2);
});

test('sdk executor: success subtype flagged is_error → failed', async () => {
  const r = await executeBoardMissionViaSdk(params, {
    loadSdk: fakeSdk([{ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 401' }]),
  });
  assert.equal(r.status, 'failed');
});

test('sdk executor: stream ends with no terminal result → failed(no_terminal_result)', async () => {
  const r = await executeBoardMissionViaSdk(params, { loadSdk: fakeSdk([{ type: 'assistant' }]) });
  assert.equal(r.status, 'failed');
  assert.equal(r.status === 'failed' && r.reason.code, 'no_terminal_result');
});

test('sdk executor: genuine terminal success → succeeded with summary + cost', async () => {
  const r = await executeBoardMissionViaSdk(params, {
    loadSdk: fakeSdk([
      { type: 'assistant' },
      { type: 'result', subtype: 'success', is_error: false, result: 'Implemented the thing.', total_cost_usd: 0.05 },
    ]),
  });
  assert.deepEqual(r, { status: 'succeeded', summary: 'Implemented the thing.', costUsd: 0.05 });
});
