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
  TRUNCATED_STREAM_DETAIL,
} from '@skippy/shared';

import { resolveExecutionGate } from './execution-gate.js';
import { executeBoardMissionViaSdk, NO_SUMMARY, type ClaudeAgentSdkModule } from './sdk-board.js';

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
      { type: 'result', subtype: 'success', is_error: false, result: 'Implemented the thing.', stop_reason: 'end_turn', total_cost_usd: 0.05 },
    ]),
  });
  assert.deepEqual(r, { status: 'succeeded', summary: 'Implemented the thing.', costUsd: 0.05 });
});

test('sdk executor: success subtype with terminal_reason "completed" → succeeded', async () => {
  const r = await executeBoardMissionViaSdk(params, {
    loadSdk: fakeSdk([
      { type: 'result', subtype: 'success', is_error: false, result: 'done', stop_reason: 'end_turn', terminal_reason: 'completed' },
    ]),
  });
  assert.equal(r.status, 'succeeded');
});

test('sdk executor: non-empty permission_denials → blocked(policy_refused), even on a success subtype', async () => {
  const r = await executeBoardMissionViaSdk(params, {
    loadSdk: fakeSdk([
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'wrote the file',
        permission_denials: [{ tool_name: 'Write', tool_use_id: 't1', tool_input: {} }],
      },
    ]),
  });
  assert.equal(r.status, 'blocked');
  assert.equal(r.status === 'blocked' && r.reason.code, 'policy_refused');
  assert.match(r.status === 'blocked' ? (r.reason.detail ?? '') : '', /Write/);
});

test('sdk executor: api_error_status on a "success" subtype → failed(provider_error)', async () => {
  const r = await executeBoardMissionViaSdk(params, {
    loadSdk: fakeSdk([
      { type: 'result', subtype: 'success', is_error: false, result: 'ok?', api_error_status: 529 },
    ]),
  });
  assert.equal(r.status, 'failed');
  assert.equal(r.status === 'failed' && r.reason.code, 'provider_error');
});

test('sdk executor: terminal_reason hook_stopped / stop_hook_prevented → blocked(policy_refused)', async () => {
  for (const terminal_reason of ['hook_stopped', 'stop_hook_prevented'] as const) {
    const r = await executeBoardMissionViaSdk(params, {
      loadSdk: fakeSdk([
        { type: 'result', subtype: 'success', is_error: false, result: 'x', terminal_reason },
      ]),
    });
    assert.equal(r.status, 'blocked', terminal_reason);
    assert.equal(r.status === 'blocked' && r.reason.code, 'policy_refused', terminal_reason);
  }
});

test('sdk executor: tool_deferred / deferred_tool_use → blocked(approval_required)', async () => {
  const viaReason = await executeBoardMissionViaSdk(params, {
    loadSdk: fakeSdk([
      { type: 'result', subtype: 'success', is_error: false, result: 'x', terminal_reason: 'tool_deferred' },
    ]),
  });
  assert.equal(viaReason.status, 'blocked');
  assert.equal(viaReason.status === 'blocked' && viaReason.reason.code, 'approval_required');

  const viaField = await executeBoardMissionViaSdk(params, {
    loadSdk: fakeSdk([
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'x',
        deferred_tool_use: { id: 'd1', name: 'Bash', input: {} },
      },
    ]),
  });
  assert.equal(viaField.status, 'blocked');
  assert.equal(viaField.status === 'blocked' && viaField.reason.code, 'approval_required');
});

test('sdk executor: terminal_reason aborted_tools → interrupted(tool_execution_aborted)', async () => {
  const r = await executeBoardMissionViaSdk(params, {
    loadSdk: fakeSdk([
      { type: 'result', subtype: 'success', is_error: false, result: 'x', terminal_reason: 'aborted_tools' },
    ]),
  });
  assert.equal(r.status, 'interrupted');
  assert.equal(r.status === 'interrupted' && r.reason.code, 'tool_execution_aborted');
});

test('sdk executor: model_error / prompt_too_long / unknown terminal_reason → failed(executor_error)', async () => {
  for (const terminal_reason of ['model_error', 'prompt_too_long', 'some_future_reason'] as const) {
    const r = await executeBoardMissionViaSdk(params, {
      loadSdk: fakeSdk([
        { type: 'result', subtype: 'success', is_error: false, result: 'x', terminal_reason },
      ]),
    });
    assert.equal(r.status, 'failed', terminal_reason);
    assert.equal(r.status === 'failed' && r.reason.code, 'executor_error', terminal_reason);
  }
});

test('sdk executor: error result followed by a later success result → the error wins, never succeeded (D1)', async () => {
  const r = await executeBoardMissionViaSdk(params, {
    loadSdk: fakeSdk([
      { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['tool crashed'], total_cost_usd: 0.1 },
      { type: 'result', subtype: 'success', is_error: false, result: 'looked done', stop_reason: 'end_turn', total_cost_usd: 0.15 },
    ]),
  });
  assert.equal(r.status, 'failed');
  assert.equal(r.status === 'failed' && r.reason.code, 'executor_error');
  // The disqualified success result's cost must not silently become the
  // reported cost of a run this adapter is telling the caller failed.
  assert.equal(r.costUsd, 0.1);
});

test('sdk executor: production board.ts never awaits a worktreePath, so a live mission that hits any real denial is blocked, not succeeded (regression for the reported false-success)', async () => {
  const r = await executeBoardMissionViaSdk(params, {
    loadSdk: fakeSdk([
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'edited files',
        permission_denials: [
          { tool_name: 'Write', tool_use_id: 't1', tool_input: {} },
          { tool_name: 'Edit', tool_use_id: 't2', tool_input: {} },
        ],
      },
    ]),
  });
  assert.equal(r.status, 'blocked');
  assert.notEqual(r.status, 'succeeded');
});

// ── D6: assert the *actual* options object passed to query() ───────────────

test('sdk executor: options actually passed to query() are locked down (D6)', async () => {
  let captured: Record<string, unknown> | null = null;
  const loadSdk = (): Promise<ClaudeAgentSdkModule> => {
    const query = ((opts: { options: Record<string, unknown> }) => {
      captured = opts.options;
      async function* gen(): AsyncGenerator<unknown> {
        yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', stop_reason: 'end_turn' };
      }
      return gen();
    }) as unknown as ClaudeAgentSdkModule['query'];
    return Promise.resolve({ query });
  };

  const r = await executeBoardMissionViaSdk(params, { loadSdk });
  assert.equal(r.status, 'succeeded');
  assert.ok(captured, 'query() was never called');
  const opts = captured as Record<string, unknown>;

  assert.ok(
    opts.permissionMode === 'default' || opts.permissionMode === 'plan',
    `permissionMode must be 'default' or 'plan', got ${String(opts.permissionMode)}`,
  );
  assert.equal(opts.allowDangerouslySkipPermissions, false);
  assert.deepEqual(opts.allowedTools, []);
  assert.deepEqual(opts.settingSources, []);
  assert.equal(opts.strictMcpConfig, true);
  assert.equal(typeof opts.canUseTool, 'function');
  const hooks = opts.hooks as { PreToolUse?: unknown[] } | undefined;
  assert.ok(hooks?.PreToolUse && hooks.PreToolUse.length > 0, 'a PreToolUse hook must be registered');

  const serialized = JSON.stringify(opts, (_key, value) => (typeof value === 'function' ? '<fn>' : value));
  assert.doesNotMatch(serialized, /bypassPermissions/);
});

// ── N1: task-agent (subagent) denials never become success ─────────────────
//
// The real CLI does NOT put a subagent's hook/canUseTool denials into the
// parent result's `permission_denials` (verified against bundled CLI 0.3.162:
// raw `permission_denials: []` while the task agent's Read/Bash were denied).
// These fakes drive the policy gate the adapter installs exactly as the CLI
// does — a PreToolUse hook call and a canUseTool call carrying the task
// agent's id — then report an ordinary "success" result.

type HookFn = (input: unknown, toolUseID: string | undefined, o: { signal: AbortSignal }) => Promise<unknown>;
type CanUseToolFn = (
  toolName: string,
  input: Record<string, unknown>,
  o: { signal: AbortSignal; toolUseID: string; agentID?: string },
) => Promise<{ behavior: string }>;

/** A fake SDK whose query() runs `drive` against the installed gate, then
 * yields `messages`. */
function gateDrivingSdk(
  drive: (gate: { hook: HookFn; canUseTool: CanUseToolFn }) => Promise<void>,
  messages: unknown[],
): () => Promise<ClaudeAgentSdkModule> {
  const query = ((opts: { options: Record<string, unknown> }) => {
    const hooks = opts.options.hooks as { PreToolUse: Array<{ hooks: HookFn[] }> };
    const hook = hooks.PreToolUse[0]!.hooks[0]!;
    const canUseTool = opts.options.canUseTool as CanUseToolFn;
    async function* gen(): AsyncGenerator<unknown> {
      await drive({ hook, canUseTool });
      for (const m of messages) yield m;
    }
    return gen();
  }) as unknown as ClaudeAgentSdkModule['query'];
  return () => Promise.resolve({ query });
}

const signal = new AbortController().signal;
const SUBAGENT = 'a-task-agent-01';
const successResult = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'All done, monkeys! Magnificent.',
  stop_reason: 'end_turn',
  terminal_reason: 'completed',
  permission_denials: [],
  total_cost_usd: 0.0004,
};

function preToolUse(toolName: string, toolInput: Record<string, unknown>, toolUseId: string, agentId?: string): unknown {
  return {
    hook_event_name: 'PreToolUse',
    session_id: 's',
    transcript_path: '',
    cwd: process.cwd(),
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: toolUseId,
    ...(agentId ? { agent_id: agentId } : {}),
  };
}

test('N1: task-agent hook denial + success result (empty permission_denials) → blocked(policy_refused), not succeeded', async () => {
  const seen: unknown[] = [];
  const r = await executeBoardMissionViaSdk(params, {
    loadSdk: gateDrivingSdk(async ({ hook }) => {
      // Mirrors scen-spawn: the task agent's Read outside the roots and its Bash.
      seen.push(await hook(preToolUse('Read', { file_path: 'C:/Windows/win.ini' }, 'toolu_s1', SUBAGENT), 'toolu_s1', { signal }));
      seen.push(await hook(preToolUse('Bash', { command: 'echo hi' }, 'toolu_s2', SUBAGENT), 'toolu_s2', { signal }));
    }, [successResult]),
  });
  // The gate really denied both natively (precondition for the regression).
  for (const out of seen) {
    assert.equal(
      (out as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision,
      'deny',
    );
  }
  assert.equal(r.status, 'blocked');
  assert.equal(r.status === 'blocked' && r.reason.code, 'policy_refused');
  const detail = r.status === 'blocked' ? (r.reason.detail ?? '') : '';
  assert.match(detail, /Read \[task agent a-task-agent-01\]/);
  assert.match(detail, /Bash \[task agent a-task-agent-01\]/);
  assert.match(r.status === 'blocked' ? r.reason.message : '', /denied 2 tool call\(s\).*2 in task agents/);
  assert.equal(r.costUsd, 0.0004);
});

test('N1: task-agent canUseTool denial (agentID set) + success result → blocked(policy_refused)', async () => {
  let behavior = '';
  const r = await executeBoardMissionViaSdk(params, {
    loadSdk: gateDrivingSdk(async ({ canUseTool }) => {
      ({ behavior } = await canUseTool('Bash', { command: 'echo hi' }, { signal, toolUseID: 'toolu_c1', agentID: SUBAGENT }));
    }, [successResult]),
  });
  assert.equal(behavior, 'deny');
  assert.equal(r.status, 'blocked');
  assert.equal(r.status === 'blocked' && r.reason.code, 'policy_refused');
  assert.match(r.status === 'blocked' ? (r.reason.detail ?? '') : '', /Bash \[task agent a-task-agent-01\]/);
});

test('N1: a denial reported by the hook, canUseTool AND permission_denials counts once (keyed by tool-use id)', async () => {
  const r = await executeBoardMissionViaSdk(params, {
    loadSdk: gateDrivingSdk(
      async ({ hook, canUseTool }) => {
        await hook(preToolUse('Read', { file_path: 'C:/Windows/win.ini' }, 'toolu_m1'), 'toolu_m1', { signal });
        // Same call re-checked through canUseTool: still one denial.
        await canUseTool('Read', { file_path: 'C:/Windows/win.ini' }, { signal, toolUseID: 'toolu_m1' });
      },
      [
        {
          ...successResult,
          permission_denials: [
            { tool_name: 'Read', tool_use_id: 'toolu_m1', tool_input: { file_path: 'C:/Windows/win.ini' } },
          ],
        },
      ],
    ),
  });
  assert.equal(r.status, 'blocked');
  assert.match(r.status === 'blocked' ? r.reason.message : '', /denied 1 tool call\(s\)/);
  assert.match(r.status === 'blocked' ? (r.reason.detail ?? '') : '', /Denied by Skippy tool policy/);
});

test('N1: a task-agent denial followed by a stream with no result is blocked, keeping the no_terminal_result detail', async () => {
  const r = await executeBoardMissionViaSdk(params, {
    loadSdk: gateDrivingSdk(async ({ hook }) => {
      await hook(preToolUse('Bash', { command: 'rm -rf /' }, 'toolu_x', SUBAGENT), 'toolu_x', { signal });
    }, [{ type: 'assistant' }]),
  });
  assert.equal(r.status, 'blocked');
  assert.match(r.status === 'blocked' ? (r.reason.detail ?? '') : '', /no_terminal_result/);
});

// ── N6: stop_reason, malformed permission_denials, summary shape ────────────

test('N6a: stop_reason refusal on a "success" result → failed(model_refused)', async () => {
  const r = await executeBoardMissionViaSdk(params, {
    loadSdk: fakeSdk([
      { type: 'result', subtype: 'success', is_error: false, result: 'I cannot help with that.', stop_reason: 'refusal' },
    ]),
  });
  assert.equal(r.status, 'failed');
  assert.equal(r.status === 'failed' && r.reason.code, 'model_refused');
});

test('N6a: CLI refusal shape (is_error + refusal, then the SDK throws) → failed(model_refused), not provider_error', async () => {
  const r = await executeBoardMissionViaSdk(params, {
    loadSdk: fakeSdk(
      [{ type: 'result', subtype: 'success', is_error: true, result: 'API Error: unable to respond', stop_reason: 'refusal' }],
      new Error('Claude Code returned an error result: API Error: unable to respond'),
    ),
  });
  assert.equal(r.status, 'failed');
  assert.equal(r.status === 'failed' && r.reason.code, 'model_refused');
});

test('N6a: abnormal stop_reason (max_tokens, pause_turn, tool_use, unknown) on a "success" result → failed(executor_error)', async () => {
  for (const stop_reason of ['max_tokens', 'pause_turn', 'tool_use', 'model_context_window_exceeded', 'some_future_stop']) {
    const r = await executeBoardMissionViaSdk(params, {
      loadSdk: fakeSdk([{ type: 'result', subtype: 'success', is_error: false, result: 'trunc', stop_reason }]),
    });
    assert.equal(r.status, 'failed', stop_reason);
    assert.equal(r.status === 'failed' && r.reason.code, 'executor_error', stop_reason);
    assert.match(r.status === 'failed' ? (r.reason.detail ?? '') : '', new RegExp(stop_reason), stop_reason);
  }
});

test('N6a: normal stop_reason (end_turn, stop_sequence) still succeeds', async () => {
  for (const stop_reason of ['end_turn', 'stop_sequence']) {
    const r = await executeBoardMissionViaSdk(params, {
      loadSdk: fakeSdk([{ type: 'result', subtype: 'success', is_error: false, result: 'ok', stop_reason }]),
    });
    assert.equal(r.status, 'succeeded', String(stop_reason));
  }
});

// OQ-20 (FR-RUN-01, G0): the bundled CLI 2.1.162 reports a main-thread SSE
// stream that ended after a text block, without message_delta/message_stop, as
// `success` / `is_error: false` / `terminal_reason: "completed"` with
// `stop_reason: null` and the partial text as `result` (live-mock maintruncend).
test('OQ-20: a "success" result with stop_reason null/absent (truncated stream) → failed(provider_error), never succeeded', async () => {
  for (const extra of [{ stop_reason: null }, { stop_reason: undefined }, {}]) {
    const r = await executeBoardMissionViaSdk(params, {
      loadSdk: fakeSdk([
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          api_error_status: null,
          result: 'partial answer',
          terminal_reason: 'completed',
          permission_denials: [],
          total_cost_usd: 0,
          ...extra,
        },
      ]),
    });
    const label = JSON.stringify(extra);
    assert.equal(r.status, 'failed', label);
    assert.equal(r.status === 'failed' && r.reason.code, 'provider_error', label);
    assert.match(r.status === 'failed' ? r.reason.message : '', /without a stop reason \(truncated\)/, label);
    assert.ok(r.status === 'failed' && r.reason.detail?.startsWith(TRUNCATED_STREAM_DETAIL), label);
    assert.match(r.status === 'failed' ? (r.reason.detail ?? '') : '', /partial answer/, label);
    assert.equal(deriveTaskOutcome(r, 'not_defined').outcome, 'failed', label);
  }
});

test('OQ-20: stop_reason null on an is_error or error-subtype result keeps its executor_error mapping', async () => {
  const flagged = await executeBoardMissionViaSdk(params, {
    loadSdk: fakeSdk([{ type: 'result', subtype: 'success', is_error: true, result: 'API Error', stop_reason: null }]),
  });
  assert.equal(flagged.status === 'failed' && flagged.reason.code, 'executor_error');
  const errSubtype = await executeBoardMissionViaSdk(params, {
    loadSdk: fakeSdk([{ type: 'result', subtype: 'error_max_turns', is_error: true, stop_reason: null }]),
  });
  assert.equal(errSubtype.status === 'failed' && errSubtype.reason.code, 'executor_error');
  assert.doesNotMatch(errSubtype.status === 'failed' ? (errSubtype.reason.detail ?? '') : '', /stop_reason/);
});

test('N6b: non-array permission_denials ({}, string, null, number) → failed(executor_error), never "no denials"', async () => {
  for (const permission_denials of [{}, { a: 1 }, 'Write', null, 1]) {
    const r = await executeBoardMissionViaSdk(params, {
      loadSdk: fakeSdk([{ type: 'result', subtype: 'success', is_error: false, result: 'ok', permission_denials }]),
    });
    assert.equal(r.status, 'failed', JSON.stringify(permission_denials));
    assert.equal(r.status === 'failed' && r.reason.code, 'executor_error');
    assert.match(r.status === 'failed' ? r.reason.message : '', /malformed/);
  }
});

test('N6c: success with a missing/non-string result → succeeded with a string summary', async () => {
  for (const extra of [{}, { result: undefined }, { result: null }, { result: 42 }]) {
    const r = await executeBoardMissionViaSdk(params, {
      loadSdk: fakeSdk([{ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', ...extra }]),
    });
    assert.equal(r.status, 'succeeded', JSON.stringify(extra));
    assert.equal(typeof (r.status === 'succeeded' ? r.summary : null), 'string', JSON.stringify(extra));
  }
});

// OQ-20 D3 (live-mock t_noBlockStopEnd): the CLI drops a text block that never
// got content_block_stop and reports `result: ""`. A succeeded result's summary
// is never the empty string.
test('OQ-20 D3: success with an empty/blank result → succeeded with NO_SUMMARY, never ""', async () => {
  for (const result of ['', ' ', '\n\t']) {
    const r = await executeBoardMissionViaSdk(params, {
      loadSdk: fakeSdk([{ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result }]),
    });
    assert.equal(r.status, 'succeeded', JSON.stringify(result));
    assert.equal(r.status === 'succeeded' && r.summary, NO_SUMMARY, JSON.stringify(result));
    assert.equal(deriveTaskOutcome(r, 'not_defined').summary, NO_SUMMARY);
  }
});
