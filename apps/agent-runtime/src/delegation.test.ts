// delegation.test.ts — end-to-end truthful delegation (PRD v0.2 FR-RUN-01, G0).
//
// Drives real Board / BoardSupervisor / delegate_to_board code and captures the
// JSONL envelopes they write to stdout. Asserts the exact terminal outcome for
// each gate (disabled, missing key, demo, provider failure, genuine success,
// shutdown) and that only a live executor's terminal success is `succeeded`.
// No API key, network or SDK process is used.
//
// Run: node --import tsx --test src/delegation.test.ts

import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { Envelope, terminalRecordViolations, type EnvelopeT } from '@skippy/shared';

import { Board, type BoardDelegation, type BoardExecutor } from './board.js';
import type { Charter } from './charter.js';
import { resolveExecutionGate, type ExecutionGate } from './execution-gate.js';
import { handleDelegateToBoard } from './mcp-delegate.js';
import { getSupervisor, resetSupervisor } from './supervisor.js';

// ── capture sidecar envelopes written to stdout ─────────────────────────────

const captured: EnvelopeT[] = [];
const originalWrite = process.stdout.write.bind(process.stdout);

before(() => {
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
    if (typeof chunk === 'string' && chunk.startsWith('{"type":')) {
      for (const line of chunk.split('\n')) {
        if (!line.trim()) continue;
        // Every envelope the runtime emits must satisfy the wire schema.
        captured.push(Envelope.parse(JSON.parse(line)));
      }
      return true;
    }
    return (originalWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
});

after(() => {
  process.stdout.write = originalWrite;
});

beforeEach(() => {
  captured.length = 0;
});

const ENV_KEYS = ['PHASE3_AGENTS_ENABLED', 'ANTHROPIC_API_KEY', 'SKIPPY_DEMO_MODE'] as const;
function setEnv(vals: Partial<Record<(typeof ENV_KEYS)[number], string>>): void {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, vals);
}

const charter: Charter = {
  agentId: 'board.coding',
  frontmatter: {},
  body: 'You are the Coding Board Captain. You implement code under Skippy.',
  loaded: true,
  path: '(test)',
};

function mission(id: string): BoardDelegation {
  return { delegationId: id, missionBrief: 'implement the parser', fromAgentId: 'skippy' };
}

function completions(id: string): Extract<EnvelopeT, { type: 'delegation_complete' }>[] {
  return captured.filter(
    (e): e is Extract<EnvelopeT, { type: 'delegation_complete' }> =>
      e.type === 'delegation_complete' && e.delegationId === id,
  );
}

function makeBoard(gate: () => ExecutionGate, executeLive?: BoardExecutor): { board: Board; calls: () => number } {
  let n = 0;
  const exec: BoardExecutor = async (req) => {
    n++;
    if (!executeLive) throw new Error('executor must not be called');
    return executeLive(req);
  };
  return { board: new Board('coding', charter, { gate, executeLive: exec }), calls: () => n };
}

// ── Board-level outcomes ────────────────────────────────────────────────────

test('disabled SDK flag → blocked(execution_disabled); executor never runs', async () => {
  const { board, calls } = makeBoard(() => resolveExecutionGate({}));
  const env = await board.runAcceptedDelegation(mission('D-disabled'));
  assert.equal(env?.outcome, 'blocked');
  assert.equal(env?.mode, 'live');
  assert.equal(env?.reason?.code, 'execution_disabled');
  assert.equal(env?.validation, 'not_run');
  assert.equal(calls(), 0);
  assert.equal(completions('D-disabled').length, 1);
  assert.equal(captured.some((e) => e.type === 'delegation_state'), false, 'never reported running');
});

test('missing API key → blocked(missing_credentials); executor never runs', async () => {
  const { board, calls } = makeBoard(() => resolveExecutionGate({ PHASE3_AGENTS_ENABLED: '1' }));
  const env = await board.runAcceptedDelegation(mission('D-nokey'));
  assert.equal(env?.outcome, 'blocked');
  assert.equal(env?.reason?.code, 'missing_credentials');
  assert.equal(calls(), 0);
});

test('explicit demo mode → simulated (mode demo), labelled, never success', async () => {
  const { board, calls } = makeBoard(() => resolveExecutionGate({ SKIPPY_DEMO_MODE: '1' }));
  const env = await board.runAcceptedDelegation(mission('D-demo'));
  assert.equal(env?.outcome, 'simulated');
  assert.equal(env?.mode, 'demo');
  assert.equal(env?.reason?.code, 'demo_mode');
  assert.match(env?.summary ?? '', /SIMULATED/);
  assert.equal(calls(), 0);
});

test('provider failure → failed(provider_error), no fallback summary as success', async () => {
  const { board } = makeBoard(
    () => ({ kind: 'live' }),
    async () => ({
      status: 'failed',
      reason: { code: 'provider_error', message: 'executor failed', detail: 'Error: 529 overloaded' },
    }),
  );
  const env = await board.runAcceptedDelegation(mission('D-provider'));
  assert.equal(env?.outcome, 'failed');
  assert.equal(env?.reason?.code, 'provider_error');
  const kinds = captured.map((e) => e.type);
  assert.ok(kinds.indexOf('delegation_state') < kinds.indexOf('delegation_complete'));
});

test('tool-policy refusal (T02) → blocked(policy_refused), never success', async () => {
  const { board } = makeBoard(
    () => ({ kind: 'live' }),
    async () => ({
      status: 'blocked',
      reason: { code: 'policy_refused', message: 'refused', detail: '[tool-policy:bypass_forbidden]' },
    }),
  );
  const env = await board.runAcceptedDelegation(mission('D-policy'));
  assert.equal(env?.outcome, 'blocked');
  assert.equal(env?.mode, 'live');
  assert.equal(env?.reason?.code, 'policy_refused');
  assert.equal(env?.validation, 'not_run');
});

test('executor throws (e.g. MCP build) → failed(runtime_error), still exactly one terminal record', async () => {
  const { board } = makeBoard(
    () => ({ kind: 'live' }),
    async () => {
      throw new Error('buildMcpServers exploded');
    },
  );
  const env = await board.runAcceptedDelegation(mission('D-throw'));
  assert.equal(env?.outcome, 'failed');
  assert.equal(env?.reason?.code, 'runtime_error');
  assert.equal(completions('D-throw').length, 1);
});

test('gate itself throws → failed, not a dangling accepted delegation', async () => {
  const { board } = makeBoard(() => {
    throw new Error('env unreadable');
  });
  const env = await board.runAcceptedDelegation(mission('D-gate-throw'));
  assert.equal(env?.outcome, 'failed');
  assert.equal(completions('D-gate-throw').length, 1);
});

test('genuine success (mock executor terminal result) → succeeded, after running', async () => {
  const { board, calls } = makeBoard(
    () => ({ kind: 'live' }),
    async () => ({ status: 'succeeded', summary: 'Parser implemented; 12 tests added.', costUsd: 0.03 }),
  );
  const env = await board.runAcceptedDelegation(mission('D-ok'));
  assert.equal(calls(), 1);
  assert.equal(env?.outcome, 'succeeded');
  assert.equal(env?.mode, 'live');
  assert.equal(env?.validation, 'not_defined');
  assert.equal(env?.costUsd, 0.03);
  assert.equal(env?.summary, 'Parser implemented; 12 tests added.');
  const kinds = captured.map((e) => e.type);
  const running = captured.find((e) => e.type === 'delegation_state');
  assert.equal(running?.type === 'delegation_state' && running.state, 'running');
  assert.ok(kinds.indexOf('delegation_state') < kinds.indexOf('delegation_complete'));
});

test('shutdown mid-run → interrupted; the late executor success is dropped', async () => {
  let release!: () => void;
  const gateOpen = new Promise<void>((r) => (release = r));
  const { board } = makeBoard(
    () => ({ kind: 'live' }),
    async () => {
      await gateOpen;
      return { status: 'succeeded', summary: 'late' };
    },
  );
  const pending = board.runAcceptedDelegation(mission('D-shutdown'));
  await new Promise((r) => setImmediate(r));
  await board.shutdown();
  release();
  const late = await pending;
  assert.equal(late, null, 'late result emits nothing');
  const all = completions('D-shutdown');
  assert.equal(all.length, 1);
  assert.equal(all[0]?.outcome, 'interrupted');
  assert.equal(all[0]?.reason?.code, 'shutdown');
});

test('D7: delegate() accepted after shutdown → interrupted(shutdown) without executing', async () => {
  const { board, calls } = makeBoard(
    () => ({ kind: 'live' }),
    async () => ({ status: 'succeeded', summary: 'should never run' }),
  );
  await board.shutdown();
  const env = await board.runAcceptedDelegation(mission('D-post-shutdown'));
  assert.equal(calls(), 0, 'the executor must never run once the board has shut down');
  assert.equal(env?.outcome, 'interrupted');
  assert.equal(env?.mode, 'live');
  assert.equal(env?.reason?.code, 'shutdown');
  assert.equal(env?.validation, 'not_run');
  assert.equal(completions('D-post-shutdown').length, 1);
  assert.equal(captured.some((e) => e.type === 'delegation_state'), false, 'never reported running');
});

// ── G0 sweep: no non-live-success path yields `succeeded` ───────────────────

test('G0: across every non-success path, zero succeeded records and all records satisfy invariants', async () => {
  const scenarios: Array<[string, () => ExecutionGate, BoardExecutor | undefined]> = [
    ['disabled', () => resolveExecutionGate({}), undefined],
    ['nokey', () => resolveExecutionGate({ PHASE3_AGENTS_ENABLED: '1' }), undefined],
    ['demo', () => resolveExecutionGate({ SKIPPY_DEMO_MODE: '1', PHASE3_AGENTS_ENABLED: '1', ANTHROPIC_API_KEY: 'k' }), undefined],
    ['provider', () => ({ kind: 'live' }), async () => ({ status: 'failed', reason: { code: 'provider_error', message: 'x' } })],
    ['policy', () => ({ kind: 'live' }), async () => ({ status: 'blocked', reason: { code: 'policy_refused', message: 'x' } })],
    ['cancel', () => ({ kind: 'live' }), async () => ({ status: 'cancelled', reason: { code: 'cancelled_by_user', message: 'x' } })],
    ['throw', () => ({ kind: 'live' }), async () => { throw new Error('x'); }],
  ];
  for (const [name, gate, exec] of scenarios) {
    const { board } = makeBoard(gate, exec);
    await board.runAcceptedDelegation(mission(`G0-${name}`));
  }
  const terminal = captured.filter((e) => e.type === 'delegation_complete');
  assert.equal(terminal.length, scenarios.length);
  for (const e of terminal) {
    if (e.type !== 'delegation_complete') continue;
    assert.notEqual(e.outcome, 'succeeded', `${e.delegationId} must not succeed`);
    assert.deepEqual(terminalRecordViolations(e), [], e.delegationId);
  }
});

// ── Supervisor + Skippy's tool: ack means accepted, then a terminal record ──

test('supervisor: ack (accepted) is emitted before the terminal record; tool output says accepted, not done', async () => {
  setEnv({}); // live execution disabled, no demo
  resetSupervisor();
  const supervisor = getSupervisor();
  await supervisor.start();
  captured.length = 0;

  const out = await handleDelegateToBoard({ board_name: 'coding', mission_brief: 'implement the parser' });
  assert.equal(out.decision, 'accept');
  assert.equal(out.status, 'accepted');
  assert.equal(out.execution, 'blocked');
  assert.match(out.narration, /not completed/i);
  assert.doesNotMatch(out.narration, /success|completed successfully/i);

  // Wait for the async terminal record.
  for (let i = 0; i < 50 && completions(out.delegation_id).length === 0; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const kinds = captured
    .filter((e) => 'delegationId' in e && e.delegationId === out.delegation_id)
    .map((e) => e.type);
  assert.deepEqual(kinds, ['delegation', 'delegation_ack', 'delegation_complete']);
  const done = completions(out.delegation_id)[0];
  assert.equal(done?.outcome, 'blocked');
  assert.equal(done?.reason?.code, 'execution_disabled');

  await supervisor.shutdown();
  resetSupervisor();
  setEnv({});
});
