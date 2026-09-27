// sdk-board-run-failures.test.ts — EC1 D1/D2 regressions (FR-RUN-01, G0).
//
// Replays the exact SDK message sequences captured from the bundled Claude
// Code CLI 2.1.162 (@anthropic-ai/claude-agent-sdk 0.3.162) talking to a local
// mock Messages API (sub401 / sub400 / subrefusal / bg401 / unknowntool and
// the ctrl / subok / submaxtok controls). The sequences are trimmed to the
// fields the CLI actually sent (usage blocks and session ids elided). The
// `StopFailure` hook is driven exactly where the CLI fired it.
//
// Run: node --import tsx --test src/sdk-board-run-failures.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deriveTaskOutcome } from '@skippy/shared';

import { executeBoardMissionViaSdk, NO_SUMMARY, type ClaudeAgentSdkModule, type SdkBoardResult } from './sdk-board.js';

const params = {
  boardId: 'coding',
  systemPrompt: 'MOCKMARK You are the Coding Board Captain.',
  model: 'claude-sonnet-4-6' as never,
  missionBrief: 'do the thing',
};

type HookFn = (input: unknown, toolUseID: string | undefined, o: { signal: AbortSignal }) => Promise<unknown>;
type Step = { hook: string; input: Record<string, unknown> } | Record<string, unknown>;

const signal = new AbortController().signal;

/** Fake SDK: replays `steps`; a `{ hook }` step invokes every registered hook
 * callback for that event (as the CLI does) instead of yielding a message. */
function replaySdk(steps: Step[], captured?: { options?: Record<string, unknown> }): () => Promise<ClaudeAgentSdkModule> {
  const query = ((opts: { options: Record<string, unknown> }) => {
    if (captured) captured.options = opts.options;
    const hooks = (opts.options.hooks ?? {}) as Record<string, Array<{ hooks: HookFn[] }> | undefined>;
    async function* gen(): AsyncGenerator<unknown> {
      for (const s of steps) {
        if (typeof s.hook === 'string' && 'input' in s) {
          for (const m of hooks[s.hook] ?? []) for (const h of m.hooks) await h(s.input, undefined, { signal });
          continue;
        }
        yield s;
      }
    }
    return gen();
  }) as unknown as ClaudeAgentSdkModule['query'];
  return () => Promise.resolve({ query });
}

async function run(steps: Step[]): Promise<SdkBoardResult> {
  return executeBoardMissionViaSdk(params, { loadSdk: replaySdk(steps) });
}

function reasonOf(r: SdkBoardResult): { code: string; message: string; detail: string } {
  assert.notEqual(r.status, 'succeeded', JSON.stringify(r));
  if (r.status === 'succeeded') throw new Error('unreachable');
  return { code: r.reason.code, message: r.reason.message, detail: r.reason.detail ?? '' };
}

// ── captured building blocks ─────────────────────────────────────────────────

const AGENT_TU = 'toolu_main_0_0_1';
const TASK = 'a12498b1a5529c341';

const init = {
  type: 'system',
  subtype: 'init',
  tools: ['Task', 'Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write'],
};

const agentCall = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'assistant',
  message: {
    id: 'msg_2',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    content: [
      {
        type: 'tool_use',
        id: AGENT_TU,
        name: 'Agent',
        input: { description: 'sub', prompt: 'SUBMARK go', subagent_type: 'general-purpose', ...extra },
      },
    ],
    stop_reason: null,
    stop_sequence: null,
  },
  parent_tool_use_id: null,
});

const taskStarted = {
  type: 'system',
  subtype: 'task_started',
  task_id: TASK,
  tool_use_id: AGENT_TU,
  description: 'sub',
  subagent_type: 'general-purpose',
  task_type: 'local_agent',
  prompt: 'SUBMARK go',
};

const subPrompt = {
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text: 'SUBMARK go' }] },
  parent_tool_use_id: AGENT_TU,
  subagent_type: 'general-purpose',
  task_description: 'sub',
};

const taskNotification = (status: string, taskId = TASK): Record<string, unknown> => ({
  type: 'system',
  subtype: 'task_notification',
  task_id: taskId,
  tool_use_id: AGENT_TU,
  status,
  output_file: '',
  summary: 'sub',
  usage: { total_tokens: 0, tool_uses: 0, duration_ms: 15 },
});

/** The Agent tool_result the parent sees: NOT flagged is_error, status completed. */
const agentToolResult = (text: string): Record<string, unknown> => ({
  type: 'user',
  message: {
    role: 'user',
    content: [
      {
        tool_use_id: AGENT_TU,
        type: 'tool_result',
        content: [
          { type: 'text', text },
          { type: 'text', text: `agentId: ${TASK} (use SendMessage with to: '${TASK}' to continue this agent)` },
        ],
      },
    ],
  },
  parent_tool_use_id: null,
  tool_use_result: { status: 'completed', prompt: 'SUBMARK go', agentId: TASK, agentType: 'general-purpose', content: [{ type: 'text', text }], totalTokens: 0 },
});

/** The CLI's synthetic terminal assistant message of a failed task agent
 * (forwarded only with `forwardSubagentText: true`). */
const syntheticSub = (text: string, error: string, stopReason: string): Record<string, unknown> => ({
  type: 'assistant',
  message: {
    id: '72bffc5b-9695-41ac-9e0c-73e7fd65896a',
    container: null,
    model: '<synthetic>',
    role: 'assistant',
    stop_details: null,
    stop_reason: stopReason,
    stop_sequence: '',
    type: 'message',
    content: [{ type: 'text', text }],
    context_management: null,
  },
  parent_tool_use_id: AGENT_TU,
  error,
  subagent_type: 'general-purpose',
  task_description: 'sub',
});

const stopFailure = (error: string, last: string, agentId = TASK): Step => ({
  hook: 'StopFailure',
  input: {
    session_id: 's',
    transcript_path: '',
    cwd: '',
    agent_id: agentId,
    agent_type: 'general-purpose',
    hook_event_name: 'StopFailure',
    error,
    last_assistant_message: last,
  },
});

const finalText = {
  type: 'assistant',
  message: {
    id: 'msg_3',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    content: [{ type: 'text', text: 'All done, monkeys! Magnificent.' }],
    stop_reason: null,
  },
  parent_tool_use_id: null,
};

/** The parent's result in every captured failure scenario: an ordinary success. */
const successResult = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  api_error_status: null,
  num_turns: 2,
  result: 'All done, monkeys! Magnificent.',
  stop_reason: 'end_turn',
  total_cost_usd: 0.00021,
  permission_denials: [],
  terminal_reason: 'completed',
};

const INVALID_KEY = 'Invalid API key · Fix external API key';
const AUP =
  'API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy (https://www.anthropic.com/legal/aup). Try rephrasing the request or attempting a different approach.';

// Exact captured orderings.
const SUB401: Step[] = [
  init,
  agentCall(),
  taskStarted,
  subPrompt,
  stopFailure('authentication_failed', INVALID_KEY),
  syntheticSub(INVALID_KEY, 'authentication_failed', 'stop_sequence'),
  taskNotification('completed'),
  agentToolResult(INVALID_KEY),
  finalText,
  successResult,
];
const SUB400: Step[] = [
  init,
  agentCall(),
  taskStarted,
  subPrompt,
  stopFailure('unknown', 'API Error: 400 mock error'),
  syntheticSub('API Error: 400 mock error', 'unknown', 'stop_sequence'),
  taskNotification('completed'),
  agentToolResult('API Error: 400 mock error'),
  finalText,
  successResult,
];
const refusedText = {
  type: 'assistant',
  message: { id: 'msg_3', model: 'claude-sonnet-4-6', role: 'assistant', content: [{ type: 'text', text: 'I refuse' }], stop_reason: null },
  parent_tool_use_id: AGENT_TU,
  subagent_type: 'general-purpose',
};
const SUBREFUSAL: Step[] = [
  init,
  agentCall(),
  taskStarted,
  subPrompt,
  refusedText,
  syntheticSub(AUP, 'invalid_request', 'refusal'),
  stopFailure('invalid_request', AUP),
  taskNotification('completed'),
  agentToolResult(AUP),
  finalText,
  successResult,
];

// ── D1: task-agent provider failure / refusal never succeeds ────────────────

test('D1 sub401: task agent 401 under a parent success → failed(provider_error) naming the task agent', async () => {
  const r = await run(SUB401);
  assert.equal(r.status, 'failed', JSON.stringify(r));
  const { code, message, detail } = reasonOf(r);
  assert.equal(code, 'provider_error');
  assert.match(message, new RegExp(`task agent ${TASK}`));
  assert.match(detail, /StopFailure error="authentication_failed"/);
  assert.match(detail, /assistant error="authentication_failed"/);
  assert.equal(r.costUsd, 0.00021);
  assert.equal(deriveTaskOutcome(r, 'not_defined').outcome, 'failed');
});

test('D1 sub401: the StopFailure hook alone (no forwarded subagent text) still fails the run', async () => {
  const r = await run(SUB401.filter((s) => !(s as { error?: unknown }).error));
  assert.equal(r.status, 'failed');
  assert.equal(reasonOf(r).code, 'provider_error');
});

test('D1 sub401: the forwarded synthetic error message alone (no hook) still fails the run', async () => {
  const r = await run(SUB401.filter((s) => (s as { hook?: unknown }).hook === undefined));
  assert.equal(r.status, 'failed');
  assert.equal(reasonOf(r).code, 'provider_error');
  assert.match(reasonOf(r).detail, /model=<synthetic>/);
});

test('D1 sub400: task agent 400 → failed(provider_error)', async () => {
  const r = await run(SUB400);
  assert.equal(r.status, 'failed');
  assert.equal(reasonOf(r).code, 'provider_error');
  assert.match(reasonOf(r).detail, new RegExp(`task agent ${TASK}`));
});

test('D1 subrefusal: task agent refusal → failed(model_refused), whichever signal arrives first', async () => {
  const r = await run(SUBREFUSAL);
  assert.equal(r.status, 'failed');
  assert.equal(reasonOf(r).code, 'model_refused');
  // Hook before the forwarded message (the sub401 ordering): still refusal.
  const hookFirst = [...SUBREFUSAL];
  const [hook] = hookFirst.splice(6, 1);
  hookFirst.splice(4, 0, hook!);
  const r2 = await run(hookFirst);
  assert.equal(reasonOf(r2).code, 'model_refused');
  assert.match(reasonOf(r2).detail, /stop_reason=refusal/);
});

test('D1 background task agent (bg401 capture: async_launched, task_updated completed, two results) → failed(provider_error)', async () => {
  const launched = {
    type: 'user',
    message: {
      role: 'user',
      content: [{ tool_use_id: AGENT_TU, type: 'tool_result', content: [{ type: 'text', text: 'Async agent launched successfully.' }] }],
    },
    parent_tool_use_id: null,
    tool_use_result: { isAsync: true, status: 'async_launched', agentId: TASK },
  };
  const r = await run([
    init,
    agentCall({ run_in_background: true }),
    { ...taskStarted, prompt: 'SUBMARK bg' },
    launched,
    syntheticSub(INVALID_KEY, 'authentication_failed', 'stop_sequence'),
    stopFailure('authentication_failed', INVALID_KEY),
    { type: 'system', subtype: 'task_updated', task_id: TASK, patch: { status: 'completed', end_time: 1 } },
    finalText,
    successResult,
    { ...taskNotification('completed'), summary: 'Agent "sub" completed' },
    finalText,
    { ...successResult, num_turns: 1, origin: { kind: 'task-notification' } },
  ]);
  assert.equal(r.status, 'failed');
  assert.equal(reasonOf(r).code, 'provider_error');
});

test('D1: a task-agent denial still wins as blocked(policy_refused) over a task-agent provider failure', async () => {
  const deniedRead = {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'toolu_sub_1', name: 'Read', input: { file_path: 'C:/Windows/win.ini' } }], stop_reason: null },
    parent_tool_use_id: AGENT_TU,
  };
  const r = await run([
    init,
    agentCall(),
    taskStarted,
    deniedRead,
    {
      type: 'system',
      subtype: 'permission_denied',
      tool_name: 'Read',
      tool_use_id: 'toolu_sub_1',
      agent_id: TASK,
      message: 'Denied by Skippy tool policy (path_outside_roots)',
    },
    stopFailure('authentication_failed', INVALID_KEY),
    agentToolResult(INVALID_KEY),
    successResult,
  ]);
  assert.equal(r.status, 'blocked');
  const { code, detail } = reasonOf(r);
  assert.equal(code, 'policy_refused');
  assert.match(detail, new RegExp(`Read \\[task agent ${TASK}\\]`));
  assert.match(detail, /run also ended failed\(provider_error\)/);
});

test('D1: task_notification failed/stopped and task_updated failed/killed for a task agent → failed(executor_error)', async () => {
  for (const tail of [
    [taskNotification('failed')],
    [taskNotification('stopped')],
    [{ type: 'system', subtype: 'task_updated', task_id: TASK, patch: { status: 'failed' } }],
    [{ type: 'system', subtype: 'task_updated', task_id: TASK, patch: { status: 'killed' } }],
  ]) {
    const r = await run([init, agentCall(), taskStarted, ...tail, successResult]);
    assert.equal(r.status, 'failed', JSON.stringify(tail));
    assert.equal(reasonOf(r).code, 'executor_error');
    assert.match(reasonOf(r).detail, new RegExp(`task agent ${TASK}`));
  }
});

test('D1: a failed background SHELL task (local_bash) is an ordinary tool outcome, not a task-agent failure', async () => {
  const r = await run([
    init,
    { type: 'system', subtype: 'task_started', task_id: 'b1', tool_use_id: 'toolu_bash', description: 'npm test', task_type: 'local_bash' },
    taskNotification('failed', 'b1'),
    successResult,
  ]);
  assert.equal(r.status, 'succeeded', JSON.stringify(r));
});

test('D1: a main-thread Agent tool_result flagged is_error → failed(executor_error)', async () => {
  const r = await run([
    init,
    agentCall(),
    {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: AGENT_TU, is_error: true, content: 'Agent type not found' }] },
      parent_tool_use_id: null,
    },
    successResult,
  ]);
  assert.equal(r.status, 'failed');
  assert.equal(reasonOf(r).code, 'executor_error');
  assert.match(reasonOf(r).detail, /Agent tool_result is_error/);
});

test('D1: a task-agent failure never overrides an already-failed run code, but is kept in the detail', async () => {
  const r = await run([
    init,
    agentCall(),
    taskStarted,
    stopFailure('authentication_failed', INVALID_KEY),
    { type: 'result', subtype: 'error_max_turns', is_error: true, terminal_reason: 'max_turns', permission_denials: [] },
  ]);
  assert.equal(r.status, 'failed');
  const { code, detail } = reasonOf(r);
  assert.equal(code, 'executor_error');
  assert.match(detail, /task agents also failed: provider_error/);
});

test('D1: an interrupted run whose task agent failed is failed, keeping the interruption in the detail', async () => {
  const r = await run([
    init,
    agentCall(),
    taskStarted,
    stopFailure('rate_limit', 'API Error: 429'),
    { type: 'result', subtype: 'success', is_error: false, terminal_reason: 'aborted_tools', permission_denials: [] },
  ]);
  assert.equal(r.status, 'failed');
  assert.equal(reasonOf(r).code, 'provider_error');
  assert.match(reasonOf(r).detail, /run also ended interrupted\(tool_execution_aborted\)/);
});

test('D1 controls: subok / submaxtok (recovered truncation) / an ordinary tool error still succeed', async () => {
  const subDone = {
    type: 'assistant',
    message: { id: 'msg_4', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'sub done' }], stop_reason: null },
    parent_tool_use_id: AGENT_TU,
  };
  const subok: Step[] = [
    init,
    agentCall(),
    taskStarted,
    subPrompt,
    { hook: 'SubagentStop', input: { hook_event_name: 'SubagentStop', agent_id: TASK, last_assistant_message: 'sub done' } },
    taskNotification('completed'),
    agentToolResult('sub done'),
    finalText,
    successResult,
  ];
  assert.equal((await run(subok)).status, 'succeeded');
  const submaxtok: Step[] = [
    init,
    agentCall(),
    taskStarted,
    subPrompt,
    { ...subDone, message: { ...subDone.message, id: 'msg_3', content: [{ type: 'text', text: 'partial wor' }] } },
    subDone,
    taskNotification('completed'),
    agentToolResult('sub done'),
    finalText,
    successResult,
  ];
  assert.equal((await run(submaxtok)).status, 'succeeded');
  const readMissing: Step[] = [
    init,
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_r', name: 'Read', input: { file_path: 'x' } }] }, parent_tool_use_id: null },
    {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_r', is_error: true, content: 'File does not exist.' }] },
      parent_tool_use_id: null,
    },
    finalText,
    successResult,
  ];
  assert.equal((await run(readMissing)).status, 'succeeded');
});

test('D1: query() options forward subagent text and register a StopFailure observer, keeping the policy hooks', async () => {
  const captured: { options?: Record<string, unknown> } = {};
  const r = await executeBoardMissionViaSdk(params, { loadSdk: replaySdk([successResult], captured) });
  assert.equal(r.status, 'succeeded');
  const opts = captured.options!;
  assert.equal(opts.forwardSubagentText, true);
  // OQ-20: main-thread SSE events are needed to see a truncated final turn.
  assert.equal(opts.includePartialMessages, true);
  const hooks = opts.hooks as Record<string, unknown[] | undefined>;
  assert.ok(hooks.StopFailure && hooks.StopFailure.length > 0, 'StopFailure hook must be registered');
  assert.ok(hooks.PreToolUse && hooks.PreToolUse.length > 0, 'the policy PreToolUse hook must remain');
});

// ── OQ-20: truncated main-thread provider stream never succeeds ─────────────
//
// Captured with `includePartialMessages: true` from the bundled CLI 2.1.162
// against the local mock (maintruncend, subthenmaintrunc, bgoktrunc,
// maindropmidrecover, mainmaxtok, ctrl). The CLI forwards the main thread's
// raw SSE events as `stream_event`s; its `assistant` messages are emitted at
// `content_block_stop` and always carry `stop_reason: null`. A turn whose
// `message_start` never got a `message_delta` stop reason was truncated. The
// result's `stop_reason` is the last main-thread `message_delta` of the
// segment, so after a `tool_use` turn it is stale.

const se = (event: Record<string, unknown>): Record<string, unknown> => ({
  type: 'stream_event',
  event,
  parent_tool_use_id: null,
});
const msgStart = (id: string): Record<string, unknown> =>
  se({ type: 'message_start', message: { id, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: null } });
const msgDelta = (stop: string): Record<string, unknown> =>
  se({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } });
const msgStop = se({ type: 'message_stop' });
const mainText = (id: string, text: string, stop: string | null = null): Record<string, unknown> => ({
  type: 'assistant',
  message: { id, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text }], stop_reason: stop },
  parent_tool_use_id: null,
});
/** One complete streamed main-thread turn. */
const streamedTurn = (id: string, text: string, stop: string): Step[] => [
  msgStart(id),
  mainText(id, text),
  se({ type: 'content_block_stop', index: 0 }),
  msgDelta(stop),
  msgStop,
];
/** A streamed main-thread turn whose SSE stream ended after the text block. */
const truncatedTurn = (id: string, text: string): Step[] => [msgStart(id), mainText(id, text), se({ type: 'content_block_stop', index: 0 })];
const streamedAgentCall: Step[] = [msgStart('msg_2'), agentCall(), se({ type: 'content_block_stop', index: 0 }), msgDelta('tool_use'), msgStop];
const truncResult = (stop: string | null, text: string): Record<string, unknown> => ({
  ...successResult,
  result: text,
  stop_reason: stop,
});

test('OQ-20 maintruncend: main-thread stream ends without message_delta/message_stop (result stop_reason null) → failed(provider_error)', async () => {
  const r = await run([init, ...truncatedTurn('msg_1', 'partial answer'), { ...truncResult(null, 'partial answer'), num_turns: 1, total_cost_usd: 0 }]);
  assert.equal(r.status, 'failed', JSON.stringify(r));
  const { code, message, detail } = reasonOf(r);
  assert.equal(code, 'provider_error');
  assert.match(message, /provider stream ended without a stop reason \(truncated\)/);
  assert.match(detail, /final main-thread turn msg_1 got no stop reason/);
  assert.match(detail, /result stop_reason: null/);
  assert.equal(deriveTaskOutcome(r, 'not_defined').outcome, 'failed');
});

test('OQ-20: the replayed result alone (no stream events) with stop_reason null still fails', async () => {
  const r = await run([init, mainText('msg_1', 'partial answer'), truncResult(null, 'partial answer')]);
  assert.equal(reasonOf(r).code, 'provider_error');
});

test('OQ-20 subthenmaintrunc: truncated final turn after a tool_use turn (stale result stop_reason "tool_use") → failed(provider_error)', async () => {
  const r = await run([
    init,
    ...streamedAgentCall,
    taskStarted,
    subPrompt,
    taskNotification('completed'),
    agentToolResult('sub done'),
    ...truncatedTurn('msg_4', 'partial after sub'),
    truncResult('tool_use', 'partial after sub'),
  ]);
  assert.equal(r.status, 'failed', JSON.stringify(r));
  assert.equal(reasonOf(r).code, 'provider_error');
  assert.match(reasonOf(r).detail, /final main-thread turn msg_4/);
  assert.match(reasonOf(r).detail, /result stop_reason: "tool_use"/);
});

test('OQ-20: a stale NORMAL result stop_reason cannot mask a truncated final main-thread turn', async () => {
  for (const stale of ['end_turn', 'stop_sequence']) {
    const r = await run([init, ...streamedTurn('msg_1', 'first', 'end_turn'), ...truncatedTurn('msg_2', 'partial'), truncResult(stale, 'partial')]);
    assert.equal(r.status, 'failed', stale);
    assert.equal(reasonOf(r).code, 'provider_error', stale);
  }
});

test('OQ-20 bgoktrunc: a background wake-up turn that is truncated fails the run even though the first segment completed', async () => {
  const r = await run([
    init,
    ...streamedAgentCall,
    { ...taskStarted, prompt: 'SUBMARK bg' },
    ...streamedTurn('msg_4', 'waiting on bg', 'end_turn'),
    { ...successResult, result: 'waiting on bg' },
    { ...taskNotification('completed'), summary: 'Agent "sub" completed' },
    ...truncatedTurn('msg_5', 'partial after bg'),
    { ...truncResult(null, 'partial after bg'), num_turns: 1 },
  ]);
  assert.equal(r.status, 'failed', JSON.stringify(r));
  assert.equal(reasonOf(r).code, 'provider_error');
  assert.match(reasonOf(r).detail, /msg_5/);
});

test('OQ-20 controls: complete streamed runs, CLI max_tokens recovery and the non-streaming fallback still succeed', async () => {
  // ctrl: tool_use turn then an end_turn turn.
  const ctrl = await run([init, ...streamedAgentCall, taskStarted, taskNotification('completed'), agentToolResult('sub done'), ...streamedTurn('msg_4', 'All done', 'end_turn'), successResult]);
  assert.equal(ctrl.status, 'succeeded', JSON.stringify(ctrl));
  // mainmaxtok: the CLI recovers a max_tokens turn with a continuation turn.
  const maxtok = await run([init, ...streamedTurn('msg_1', 'partial wor', 'max_tokens'), ...streamedTurn('msg_2', 'All done', 'end_turn'), successResult]);
  assert.equal(maxtok.status, 'succeeded', JSON.stringify(maxtok));
  // maindropmidrecover: the stream dropped after message_start; the CLI fell
  // back to a non-streamed request whose message carries its own stop_reason.
  const fallback = await run([init, msgStart('msg_1'), mainText('msg_2', 'recovered', 'end_turn'), { ...successResult, result: 'recovered', num_turns: 1 }]);
  assert.equal(fallback.status, 'succeeded', JSON.stringify(fallback));
  // stop_sequence is a normal stop.
  const stopSeq = await run([init, ...streamedTurn('msg_1', 'done at seq', 'stop_sequence'), { ...successResult, stop_reason: 'stop_sequence' }]);
  assert.equal(stopSeq.status, 'succeeded', JSON.stringify(stopSeq));
  // Two complete segments (background wake-up): each result sees its own turn.
  const twoSegments = await run([init, ...streamedTurn('msg_1', 'a', 'end_turn'), successResult, ...streamedTurn('msg_2', 'b', 'end_turn'), successResult]);
  assert.equal(twoSegments.status, 'succeeded', JSON.stringify(twoSegments));
});

test('OQ-20: a non-streamed fallback message with stop_reason null is not a completed turn', async () => {
  const r = await run([init, msgStart('msg_1'), mainText('msg_2', 'partial'), truncResult('end_turn', 'partial')]);
  assert.equal(reasonOf(r).code, 'provider_error');
  assert.match(reasonOf(r).detail, /non-streamed message with stop_reason null/);
});

test('OQ-20: a main-thread <synthetic> API-error message keeps its is_error executor_error mapping', async () => {
  const synthetic = {
    type: 'assistant',
    message: { id: 'syn-1', model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'API Error: Overloaded' }], stop_reason: 'stop_sequence' },
    parent_tool_use_id: null,
  };
  const r = await run([
    init,
    ...truncatedTurn('msg_1', 'x'),
    synthetic,
    { type: 'result', subtype: 'success', is_error: true, result: 'API Error: Overloaded', stop_reason: 'stop_sequence', permission_denials: [] },
  ]);
  assert.equal(r.status, 'failed');
  assert.equal(reasonOf(r).code, 'executor_error');
});

// ── D2: calls to tools the charter withheld are policy refusals ─────────────

const noSuchTool = (id: string, name: string): Step[] => [
  {
    type: 'assistant',
    message: { id: 'msg_3', content: [{ type: 'tool_use', id, name, input: {} }], stop_reason: null },
    parent_tool_use_id: null,
  },
  {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          content: `<tool_use_error>Error: No such tool available: ${name}. ${name} exists but is not enabled in this context. Use one of the available tools instead.</tool_use_error>`,
          is_error: true,
          tool_use_id: id,
        },
      ],
    },
    parent_tool_use_id: null,
    tool_use_result: `Error: No such tool available: ${name}. ${name} exists but is not enabled in this context. Use one of the available tools instead.`,
  },
];

test('D2 unknowntool: WebSearch / NotebookEdit withheld by the charter → blocked(policy_refused)', async () => {
  const r = await run([
    init,
    ...noSuchTool('toolu_main_0_0_1', 'WebSearch'),
    ...noSuchTool('toolu_main_0_1_2', 'NotebookEdit'),
    finalText,
    successResult,
  ]);
  assert.equal(r.status, 'blocked', JSON.stringify(r));
  const { code, message, detail } = reasonOf(r);
  assert.equal(code, 'policy_refused');
  assert.match(message, /denied 2 tool call\(s\)/);
  assert.match(detail, /WebSearch/);
  assert.match(detail, /NotebookEdit/);
});

test('D2: a task agent calling a withheld tool → blocked(policy_refused) attributed to the task agent', async () => {
  const [call, result] = noSuchTool('toolu_sub_9', 'WebFetch');
  const r = await run([
    init,
    agentCall(),
    taskStarted,
    { ...call, parent_tool_use_id: AGENT_TU },
    { ...result, parent_tool_use_id: AGENT_TU },
    agentToolResult('sub done'),
    successResult,
  ]);
  assert.equal(r.status, 'blocked');
  assert.match(reasonOf(r).detail, new RegExp(`WebFetch \\[task agent ${TASK}\\]`));
});

test('D2: the CLI "Task" alias of the granted Agent tool is never treated as withheld', async () => {
  const r = await run([
    init,
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_t', name: 'Task', input: {} }] },
      parent_tool_use_id: null,
    },
    {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_t', is_error: true, content: 'Denied by Skippy tool policy' }] },
      parent_tool_use_id: null,
    },
    successResult,
  ]);
  // The Agent call failed (executor_error), but it was offered: no D2 denial.
  assert.equal(r.status, 'failed');
  assert.equal(reasonOf(r).code, 'executor_error');
});

// ── OQ-20 (EC1 round 5): every main-thread turn is judged, not only the last ──
//
// Captured from the bundled CLI 2.1.162 against the r4v1/r5 mock. While a
// background task agent still runs, the CLI emits NO `result` between the
// board's segments (t_bgTwoWakes: four main requests, one result), so a turn
// truncated in a non-final segment was overwritten by the next
// `message_start` and the run reported success (t_pairSlowSub,
// t_bgTruncLostTool). `system/status: requesting` precedes every main-thread
// streamed request and never the non-streaming fallback or a task agent's
// request; the fallback message arrives right after the dropped stream and
// carries its own stop reason (under a new id or the same one).

const statusRequesting = { type: 'system', subtype: 'status', status: 'requesting' };
const textStart = (index: number): Record<string, unknown> =>
  se({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
const toolStart = (index: number, id: string, name = 'Read'): Record<string, unknown> =>
  se({ type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } });
const blockStop = (index: number): Record<string, unknown> => se({ type: 'content_block_stop', index });
/** A complete streamed text turn, as the CLI forwards it (status first). */
const fullTextTurn = (id: string, text: string, stop = 'end_turn'): Step[] => [
  statusRequesting,
  msgStart(id),
  textStart(0),
  mainText(id, text),
  blockStop(0),
  msgDelta(stop),
  msgStop,
];
/** A streamed text turn whose SSE stream ended after its (closed) text block. */
const cutTextTurn = (id: string, text: string): Step[] => [statusRequesting, msgStart(id), textStart(0), mainText(id, text), blockStop(0)];
/** The board's first turn: a background Agent call, then its async launch. */
const bgLaunch: Step[] = [
  init,
  statusRequesting,
  msgStart('msg_2'),
  toolStart(0, AGENT_TU, 'Agent'),
  agentCall({ run_in_background: true }),
  blockStop(0),
  msgDelta('tool_use'),
  msgStop,
  { ...taskStarted, prompt: 'SUBMARK s bg' },
  agentToolResult('Async agent launched successfully.'),
];
/** The background task agent finishing while the board waits (no result). */
const bgFinish: Step[] = [
  {
    type: 'assistant',
    message: { id: 'msg_3', model: 'claude-sonnet-4-6', role: 'assistant', content: [{ type: 'text', text: 'bg sub done' }], stop_reason: null },
    parent_tool_use_id: AGENT_TU,
  },
  { type: 'system', subtype: 'task_updated', task_id: TASK, patch: { status: 'completed' } },
  { ...taskNotification('completed'), summary: 'Agent "sub" completed' },
  init,
];
const segmentResult = (text: string): Record<string, unknown> => ({ ...successResult, result: text, num_turns: 1 });

test('OQ-20 t_pairSlowSub: a turn truncated in a non-final segment (no result before the next segment) → failed(provider_error)', async () => {
  const r = await run([
    ...bgLaunch,
    ...cutTextTurn('msg_4', 'I will now write the report file and then'),
    ...bgFinish,
    ...fullTextTurn('msg_5', 'Report complete, monkeys.'),
    segmentResult('Report complete, monkeys.'),
  ]);
  assert.equal(r.status, 'failed', JSON.stringify(r));
  const { code, message, detail } = reasonOf(r);
  assert.equal(code, 'provider_error');
  assert.match(message, /provider stream ended without a stop reason \(truncated\) in 1 main-thread turn/);
  assert.match(detail, /main-thread turn msg_4 got no stop reason/);
  assert.match(detail, /superseded by main-thread turn msg_5/);
  assert.equal(deriveTaskOutcome(r, 'not_defined').outcome, 'failed');
});

test('OQ-20 t_bgTruncLostTool: stream cut after the text block, before a Write tool_use (never ran) → failed(provider_error)', async () => {
  const r = await run([
    ...bgLaunch,
    ...cutTextTurn('msg_5', 'Now writing the file'),
    ...bgFinish,
    ...fullTextTurn('msg_6', 'All done, monkeys.'),
    segmentResult('All done, monkeys.'),
  ]);
  assert.equal(r.status, 'failed', JSON.stringify(r));
  assert.equal(reasonOf(r).code, 'provider_error');
  assert.match(reasonOf(r).detail, /main-thread turn msg_5 got no stop reason/);
});

test('OQ-20: the same truncated turn fails whether or not the CLI put a result between the segments (t_pairFastSub ≡ t_pairSlowSub)', async () => {
  const fast = await run([
    ...bgLaunch,
    ...cutTextTurn('msg_4', 'I will now write the report file and then'),
    { ...successResult, result: 'I will now write the report file and then', stop_reason: 'tool_use', num_turns: 2 },
    ...bgFinish,
    ...fullTextTurn('msg_5', 'Report complete, monkeys.'),
    segmentResult('Report complete, monkeys.'),
  ]);
  assert.equal(fast.status, 'failed', JSON.stringify(fast));
  assert.equal(reasonOf(fast).code, 'provider_error');
  assert.match(reasonOf(fast).detail, /final main-thread turn msg_4/);
});

test('OQ-20 t_bgTwoWakesMidTrunc: a truncated middle wake-up turn fails the run although first and last turns completed', async () => {
  const r = await run([
    ...bgLaunch,
    ...fullTextTurn('msg_6', 'waiting'),
    ...bgFinish,
    ...cutTextTurn('msg_7', 'partial'),
    ...bgFinish,
    ...fullTextTurn('msg_8', 'both done'),
    segmentResult('both done'),
  ]);
  assert.equal(r.status, 'failed', JSON.stringify(r));
  assert.match(reasonOf(r).detail, /main-thread turn msg_7 got no stop reason/);
  assert.doesNotMatch(reasonOf(r).detail, /msg_6/);
  assert.doesNotMatch(reasonOf(r).detail, /turn msg_8 got/);
});

test('OQ-20 t_twoToolsCutMid1: the CLI ran tool #0 but dropped the half-streamed tool #1 (block never closed) → failed(provider_error)', async () => {
  const read = (id: string): Record<string, unknown> => ({
    type: 'assistant',
    message: { id: 'msg_3', model: 'claude-sonnet-4-6', role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: 'inside.txt' } }], stop_reason: null },
    parent_tool_use_id: null,
  });
  const readResult = (id: string): Record<string, unknown> => ({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: '1\tinside' }] },
    parent_tool_use_id: null,
  });
  const cutMid = await run([
    init,
    statusRequesting,
    msgStart('msg_3'),
    toolStart(0, 'toolu_main_0_0_1'),
    read('toolu_main_0_0_1'),
    blockStop(0),
    toolStart(1, 'toolu_main_0_1_2'),
    readResult('toolu_main_0_0_1'),
    ...fullTextTurn('msg_4', 'All done, monkeys! Magnificent.'),
    { ...successResult, num_turns: 2 },
  ]);
  assert.equal(cutMid.status, 'failed', JSON.stringify(cutMid));
  assert.match(reasonOf(cutMid).detail, /msg_3 got no stop reason .*1 content block\(s\) never closed/);

  // Control t_toolBlockCut: every opened block closed and the CLI executed the
  // tool — the CLI accepted the turn; the next turn completes the run.
  const blockCut = await run([
    init,
    statusRequesting,
    msgStart('msg_3'),
    toolStart(0, 'toolu_main_0_0_1'),
    read('toolu_main_0_0_1'),
    blockStop(0),
    readResult('toolu_main_0_0_1'),
    ...fullTextTurn('msg_4', 'All done, monkeys! Magnificent.'),
    { ...successResult, num_turns: 2 },
  ]);
  assert.equal(blockCut.status, 'succeeded', JSON.stringify(blockCut));

  // A closed tool_use the CLI never executed is still a truncated turn.
  const notRun = await run([
    init,
    statusRequesting,
    msgStart('msg_3'),
    toolStart(0, 'toolu_main_0_0_1'),
    read('toolu_main_0_0_1'),
    blockStop(0),
    ...fullTextTurn('msg_4', 'All done'),
    successResult,
  ]);
  assert.equal(notRun.status, 'failed', JSON.stringify(notRun));
});

test('OQ-20 D2 t_fallbackNsSameId: the non-streamed fallback under the dropped turn\'s own id completes that turn', async () => {
  const dropped: Step[] = [init, statusRequesting, msgStart('msg_same'), textStart(0)];
  const ok = await run([...dropped, mainText('msg_same', 'fallback ok', 'end_turn'), { ...successResult, result: 'fallback ok', num_turns: 1 }]);
  assert.equal(ok.status, 'succeeded', JSON.stringify(ok));
  assert.equal(ok.status === 'succeeded' && ok.summary, 'fallback ok');
  // t_fallbackNsSameIdNull: the same-id fallback without a stop reason is not a completion.
  const nul = await run([...dropped, mainText('msg_same', 'x'), { ...successResult, result: 'x', stop_reason: null, num_turns: 1 }]);
  assert.equal(reasonOf(nul).code, 'provider_error');
  // t_startStopEndTrunc: the CLI copies message_start's stop_reason into the
  // turn's STREAMED messages; that copy is not a fallback completion.
  const startStop = await run([
    init,
    statusRequesting,
    se({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: 'end_turn' } }),
    textStart(0),
    mainText('msg_1', 'partial', 'end_turn'),
    blockStop(0),
    { ...successResult, result: 'partial', num_turns: 1 },
  ]);
  assert.equal(startStop.status, 'failed', JSON.stringify(startStop));
  assert.match(reasonOf(startStop).detail, /final main-thread turn msg_1 got no stop reason/);
});

test('OQ-20 D3 t_noBlockStopEnd: end_turn arrives with a content block never closed (CLI dropped the text) → failed(provider_error)', async () => {
  const r = await run([
    init,
    statusRequesting,
    msgStart('msg_1'),
    textStart(0),
    msgDelta('end_turn'),
    msgStop,
    { ...successResult, result: '', num_turns: 1 },
  ]);
  assert.equal(r.status, 'failed', JSON.stringify(r));
  assert.equal(reasonOf(r).code, 'provider_error');
  assert.match(reasonOf(r).detail, /final main-thread turn msg_1 ended \(stop_reason "end_turn"\) with 1 content block\(s\) never closed/);
});

test('OQ-20 D3: a succeeded result never carries an empty summary', async () => {
  for (const blank of ['', '   ']) {
    const r = await run([init, ...fullTextTurn('msg_1', 'x'), { ...successResult, result: blank }]);
    assert.equal(r.status, 'succeeded', JSON.stringify(r));
    assert.equal(r.status === 'succeeded' && r.summary, NO_SUMMARY);
  }
});

test('OQ-20: an empty turn abandoned for a NEW request (status requesting in between) is truncated; a stray duplicate message_start is not', async () => {
  const abandoned = await run([init, statusRequesting, msgStart('msg_1'), ...fullTextTurn('msg_2', 'ok'), { ...successResult, result: 'ok' }]);
  assert.equal(abandoned.status, 'failed', JSON.stringify(abandoned));
  assert.match(reasonOf(abandoned).detail, /main-thread turn msg_1 got no stop reason/);
  // t_dupStartOtherOk / t_preStartOk: two message_starts in one response.
  const dup = await run([
    init,
    statusRequesting,
    msgStart('msg_1'),
    msgStart('msg_other'),
    textStart(0),
    mainText('msg_other', 'ok'),
    blockStop(0),
    msgDelta('end_turn'),
    msgStop,
    { ...successResult, result: 'ok', num_turns: 1 },
  ]);
  assert.equal(dup.status, 'succeeded', JSON.stringify(dup));
});

test('OQ-20: a non-streamed message after a NEW request does not complete an earlier abandoned turn', async () => {
  const r = await run([
    init,
    ...cutTextTurn('msg_1', 'partial'),
    statusRequesting,
    mainText('msg_9', 'done', 'end_turn'),
    { ...successResult, result: 'done' },
  ]);
  assert.equal(r.status, 'failed', JSON.stringify(r));
  assert.match(reasonOf(r).detail, /main-thread turn msg_1 got no stop reason.*superseded by non-streamed main-thread message msg_9/);
});

test('OQ-20: a mid-run truncation keeps a later, more specific failure code and adds its detail', async () => {
  // A later segment that hits an is_error result keeps executor_error and
  // gains the truncated-turn detail.
  const failedLater = await run([
    ...bgLaunch,
    ...cutTextTurn('msg_4', 'partial'),
    ...bgFinish,
    statusRequesting,
    msgStart('msg_5'),
    {
      type: 'assistant',
      message: { id: 'syn', model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'API Error: Overloaded' }], stop_reason: 'stop_sequence' },
      parent_tool_use_id: null,
    },
    { type: 'result', subtype: 'success', is_error: true, result: 'API Error: Overloaded', stop_reason: 'stop_sequence', permission_denials: [] },
  ]);
  assert.equal(failedLater.status, 'failed');
  assert.equal(reasonOf(failedLater).code, 'executor_error');
  assert.match(reasonOf(failedLater).detail, /truncated\): main-thread turn msg_4/);
});

test('OQ-20 controls: background wake-ups, fallbacks and executed tool turns still succeed', async () => {
  // t_bgTwoWakes / t_pairSlowSubOk: complete turns in every segment.
  const wakes = await run([
    ...bgLaunch,
    ...fullTextTurn('msg_6', 'waiting'),
    ...bgFinish,
    ...fullTextTurn('msg_7', 'one done'),
    ...bgFinish,
    ...fullTextTurn('msg_8', 'both done'),
    segmentResult('both done'),
  ]);
  assert.equal(wakes.status, 'succeeded', JSON.stringify(wakes));
  // maindropmidrecover / t_midText: dropped stream, non-streamed fallback (new id).
  const fb = await run([init, statusRequesting, msgStart('msg_1'), textStart(0), mainText('msg_2', 'recovered', 'end_turn'), { ...successResult, result: 'recovered', num_turns: 1 }]);
  assert.equal(fb.status, 'succeeded', JSON.stringify(fb));
  // t_turn2Fallback: tool turn, then a dropped turn recovered by the fallback.
  const turn2 = await run([
    init,
    ...streamedAgentCall,
    taskStarted,
    taskNotification('completed'),
    agentToolResult('sub done'),
    statusRequesting,
    msgStart('msg_4'),
    textStart(0),
    mainText('msg_5', 'fallback ok', 'end_turn'),
    { ...successResult, result: 'fallback ok' },
  ]);
  assert.equal(turn2.status, 'succeeded', JSON.stringify(turn2));
  // A fallback that itself returns a tool_use turn, executed, then a complete turn.
  const toolFb = await run([
    init,
    statusRequesting,
    msgStart('msg_2'),
    toolStart(0, 'toolu_main_0_0_1'),
    {
      type: 'assistant',
      message: { id: 'msg_4', model: 'claude-sonnet-4-6', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_main_0_0_3', name: 'Read', input: {} }], stop_reason: 'tool_use' },
      parent_tool_use_id: null,
    },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_main_0_0_3', content: 'x' }] }, parent_tool_use_id: null },
    ...fullTextTurn('msg_5', 'All done, monkeys! Magnificent.'),
    successResult,
  ]);
  assert.equal(toolFb.status, 'succeeded', JSON.stringify(toolFb));
});

// ── M0-G01: main-thread terminal failures inside a result-less segment ──────
//
// Captured from the bundled CLI 2.1.162 against the local mock (m_bgMid401,
// m_bgMidRefusal, m_bgMidPause, m_bgMidMaxTokAll and the controls
// y_bgMid529ThenOkR2, n_bgMidMaxTok, main401). While a background task agent
// runs, a main-thread request that fails terminally ends its segment with
// NO `result`: the CLI emits only a main-thread `<synthetic>` assistant
// message with the typed `error` field and fires the main-thread
// `StopFailure` hook (no `agent_id`). After the background wake-up the next
// segment ends with one `result: success / end_turn`. A retry the CLI
// recovers from emits only `system/api_retry` (no synthetic message, no hook).

/** The CLI's synthetic terminal error message on the board's main thread. */
const syntheticMain = (text: string, error: string, stopReason: string): Record<string, unknown> => ({
  type: 'assistant',
  message: {
    id: 'a3371ed1-6949-45e4-90ee-de30c53975bc',
    container: null,
    model: '<synthetic>',
    role: 'assistant',
    stop_details: null,
    stop_reason: stopReason,
    stop_sequence: '',
    type: 'message',
    content: [{ type: 'text', text }],
    context_management: null,
  },
  parent_tool_use_id: null,
  error,
});
/** The main-thread `StopFailure` hook call (no `agent_id`). */
const stopFailureMain = (error: string, last: string): Step => ({
  hook: 'StopFailure',
  input: { session_id: 's', transcript_path: '', cwd: '', hook_event_name: 'StopFailure', error, last_assistant_message: last },
});
const MAX_OUT =
  "API Error: Claude's response exceeded the 32000 output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.";
/** The single result the CLI sends after the background wake-up. */
const wakeResult = (text: string): Record<string, unknown> => ({ ...successResult, result: text, num_turns: 1 });

const BG_MID_401: Step[] = [
  ...bgLaunch,
  statusRequesting,
  syntheticMain(INVALID_KEY, 'authentication_failed', 'stop_sequence'),
  stopFailureMain('authentication_failed', INVALID_KEY),
  ...bgFinish,
  ...fullTextTurn('msg_4', 'final ok'),
  wakeResult('final ok'),
];

test('M0-G01 m_bgMid401: main-thread 401 in a result-less segment, then a wake-up success → failed(provider_error)', async () => {
  const r = await run(BG_MID_401);
  assert.equal(r.status, 'failed', JSON.stringify(r));
  const { code, message, detail } = reasonOf(r);
  assert.equal(code, 'provider_error');
  assert.match(message, /Board coding main thread hit a provider API error\.$/);
  assert.match(detail, /provider_error \[main thread\]: assistant error="authentication_failed"/);
  assert.match(detail, /StopFailure error="authentication_failed"/);
  assert.equal(deriveTaskOutcome(r, 'not_defined').outcome, 'failed');
  // Either signal alone fails the run (hook first, message first, or one only).
  const noHook = BG_MID_401.filter((s) => (s as { hook?: unknown }).hook === undefined);
  const noMsg = BG_MID_401.filter((s) => (s as { error?: unknown }).error === undefined);
  for (const steps of [noHook, noMsg]) {
    const one = await run(steps);
    assert.equal(one.status, 'failed', JSON.stringify(one));
    assert.equal(reasonOf(one).code, 'provider_error');
  }
});

test('M0-G01 m_bgMid400/500/destroy: every typed main-thread API error in a result-less segment fails the run', async () => {
  for (const [error, text] of [
    ['unknown', 'API Error: 400 mock error'],
    ['server_error', 'API Error: 500 boom'],
    ['unknown', 'API Error: Unable to connect to API (ECONNRESET)'],
    ['rate_limit', 'API Error: 429'],
  ] as const) {
    const r = await run([
      ...bgLaunch,
      statusRequesting,
      syntheticMain(text, error, 'stop_sequence'),
      stopFailureMain(error, text),
      ...bgFinish,
      ...fullTextTurn('msg_4', 'final ok'),
      wakeResult('final ok'),
    ]);
    assert.equal(r.status, 'failed', `${error}: ${JSON.stringify(r)}`);
    assert.equal(reasonOf(r).code, 'provider_error', error);
  }
});

test('M0-G01 m_bgMidRefusal: main-thread refusal in a result-less segment → failed(model_refused), counted once', async () => {
  const refusal: Step[] = [
    ...bgLaunch,
    statusRequesting,
    msgStart('msg_4'),
    textStart(0),
    mainText('msg_4', 'no'),
    blockStop(0),
    syntheticMain(AUP, 'invalid_request', 'refusal'),
    msgDelta('refusal'),
    msgStop,
    stopFailureMain('invalid_request', AUP),
    ...bgFinish,
    ...fullTextTurn('msg_5', 'All done, monkeys! Magnificent.'),
    wakeResult('All done, monkeys! Magnificent.'),
  ];
  const r = await run(refusal);
  assert.equal(r.status, 'failed', JSON.stringify(r));
  const { code, message, detail } = reasonOf(r);
  assert.equal(code, 'model_refused');
  // The synthetic message, the hook and the superseded refusal turn are one failure.
  assert.match(message, /main thread was refused by the model\.$/);
  assert.match(detail, /main-thread turn msg_4 was refused \(stop_reason "refusal"\)/);
  // The streamed refusal turn alone (no synthetic message, no hook) still fails.
  const turnOnly = await run(refusal.filter((s) => (s as { hook?: unknown }).hook === undefined && (s as { error?: unknown }).error === undefined));
  assert.equal(reasonOf(turnOnly).code, 'model_refused');
});

test('M0-G01 m_bgMidPause: a pause_turn the CLI never continued before the wake-up → failed(executor_error)', async () => {
  const r = await run([
    ...bgLaunch,
    ...fullTextTurn('msg_4', 'paused', 'pause_turn'),
    ...bgFinish,
    ...fullTextTurn('msg_5', 'All done, monkeys! Magnificent.'),
    wakeResult('All done, monkeys! Magnificent.'),
  ]);
  assert.equal(r.status, 'failed', JSON.stringify(r));
  assert.equal(reasonOf(r).code, 'executor_error');
  assert.match(reasonOf(r).detail, /msg_4 ended with stop_reason "pause_turn" and the CLI did not continue it/);
});

test('M0-G01 m_bgMidMaxTokAll: the CLI gives up on max_tokens recovery in a result-less segment → failed(executor_error), counted once', async () => {
  const steps: Step[] = [
    ...bgLaunch,
    ...fullTextTurn('msg_4', 'a', 'max_tokens'),
    ...fullTextTurn('msg_5', 'b', 'max_tokens'),
    ...fullTextTurn('msg_6', 'c', 'max_tokens'),
    ...fullTextTurn('msg_7', 'd', 'max_tokens'),
    syntheticMain(MAX_OUT, 'max_output_tokens', 'stop_sequence'),
    stopFailureMain('max_output_tokens', MAX_OUT),
    ...bgFinish,
    ...fullTextTurn('msg_8', 'final ok'),
    wakeResult('final ok'),
  ];
  const r = await run(steps);
  assert.equal(r.status, 'failed', JSON.stringify(r));
  const { code, message, detail } = reasonOf(r);
  assert.equal(code, 'executor_error');
  assert.match(message, /main thread ended abnormally\.$/);
  assert.match(detail, /error="max_output_tokens"/);
  // The recovered max_tokens turns (msg_4..msg_6) are not failures.
  assert.doesNotMatch(detail, /msg_[456]/);
  // Without either CLI signal the unrecovered last turn still fails the run.
  const turnOnly = await run(steps.filter((s) => (s as { hook?: unknown }).hook === undefined && (s as { error?: unknown }).error === undefined));
  assert.equal(reasonOf(turnOnly).code, 'executor_error');
  assert.match(reasonOf(turnOnly).detail, /msg_7 ended with stop_reason "max_tokens"/);
});

test('M0-G01 dedupe: a main-thread error whose segment ends with an error result keeps the result mapping, not doubled', async () => {
  // main401 capture: synthetic message + hook + `is_error` result (status 401).
  const r = await run([
    init,
    statusRequesting,
    syntheticMain(INVALID_KEY, 'authentication_failed', 'stop_sequence'),
    stopFailureMain('authentication_failed', INVALID_KEY),
    {
      type: 'result',
      subtype: 'success',
      is_error: true,
      api_error_status: 401,
      num_turns: 1,
      result: INVALID_KEY,
      stop_reason: 'stop_sequence',
      total_cost_usd: 0,
      permission_denials: [],
      terminal_reason: 'completed',
    },
  ]);
  assert.equal(r.status, 'failed');
  assert.deepEqual(reasonOf(r), {
    code: 'provider_error',
    message: 'Board coding executor hit a provider API error (status 401).',
    detail: '401',
  });
  // max_output_tokens give-up with a result (t_finalMaxTokAll): executor_error, one reason.
  const maxTok = await run([
    init,
    ...fullTextTurn('msg_1', 'a', 'max_tokens'),
    syntheticMain(MAX_OUT, 'max_output_tokens', 'stop_sequence'),
    stopFailureMain('max_output_tokens', MAX_OUT),
    { type: 'result', subtype: 'success', is_error: true, result: MAX_OUT, stop_reason: 'stop_sequence', permission_denials: [], terminal_reason: 'completed' },
  ]);
  assert.equal(reasonOf(maxTok).code, 'executor_error');
  assert.doesNotMatch(reasonOf(maxTok).detail, /also failed/);
});

test('M0-G01: a main-thread failure in an EARLIER segment survives a later clean result and a later error result keeps it in the detail', async () => {
  const r = await run([
    ...bgLaunch,
    statusRequesting,
    syntheticMain(INVALID_KEY, 'authentication_failed', 'stop_sequence'),
    ...bgFinish,
    statusRequesting,
    syntheticMain('API Error: 500 boom', 'server_error', 'stop_sequence'),
    { type: 'result', subtype: 'success', is_error: true, api_error_status: 500, result: 'API Error: 500 boom', stop_reason: 'stop_sequence', permission_denials: [], terminal_reason: 'completed' },
  ]);
  assert.equal(r.status, 'failed');
  const { code, detail } = reasonOf(r);
  assert.equal(code, 'provider_error');
  assert.match(detail, /main thread also failed: provider_error \[main thread\]: assistant error="authentication_failed"/);
  assert.doesNotMatch(detail, /server_error/);
});

test('M0-G01: a tool_use turn whose tools never ran, superseded by a later turn → failed(executor_error)', async () => {
  const r = await run([
    init,
    statusRequesting,
    msgStart('msg_3'),
    toolStart(0, 'toolu_main_1_0_2'),
    {
      type: 'assistant',
      message: { id: 'msg_3', model: 'claude-sonnet-4-6', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_main_1_0_2', name: 'Read', input: { file_path: 'inside.txt' } }], stop_reason: null },
      parent_tool_use_id: null,
    },
    blockStop(0),
    msgDelta('tool_use'),
    msgStop,
    ...fullTextTurn('msg_4', 'All done'),
    successResult,
  ]);
  assert.equal(r.status, 'failed', JSON.stringify(r));
  assert.equal(reasonOf(r).code, 'executor_error');
  assert.match(reasonOf(r).detail, /msg_3 ended with stop_reason "tool_use" but none of its tool calls ran/);
});

test('M0-G01 controls: recovered retries, recovered max_tokens, tool errors and complete wake-ups still succeed', async () => {
  // y_bgMid529ThenOkR2: a 529 the CLI retried (system/api_retry only).
  const retry = await run([
    ...bgLaunch,
    statusRequesting,
    { type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 2, retry_delay_ms: 525, error_status: 529, error: 'overloaded' },
    msgStart('msg_4'),
    textStart(0),
    mainText('msg_4', 'final ok'),
    blockStop(0),
    msgDelta('end_turn'),
    msgStop,
    ...bgFinish,
    ...fullTextTurn('msg_5', 'All done, monkeys! Magnificent.'),
    wakeResult('All done, monkeys! Magnificent.'),
  ]);
  assert.equal(retry.status, 'succeeded', JSON.stringify(retry));
  // n_bgMidMaxTok: a max_tokens turn the CLI continued inside its segment.
  const maxTok = await run([
    ...bgLaunch,
    ...fullTextTurn('msg_4', 'partial', 'max_tokens'),
    ...fullTextTurn('msg_5', 'continued'),
    ...bgFinish,
    ...fullTextTurn('msg_6', 'All done, monkeys! Magnificent.'),
    wakeResult('All done, monkeys! Magnificent.'),
  ]);
  assert.equal(maxTok.status, 'succeeded', JSON.stringify(maxTok));
  // x_invalidToolOk: a complete tool_use turn whose call the CLI rejected
  // (is_error) — the model recovers in the next turn.
  const toolErr = await run([
    init,
    statusRequesting,
    msgStart('msg_2'),
    toolStart(0, 'toolu_main_0_0_1'),
    { type: 'assistant', message: { id: 'msg_2', model: 'claude-sonnet-4-6', content: [{ type: 'tool_use', id: 'toolu_main_0_0_1', name: 'Read', input: {} }], stop_reason: null }, parent_tool_use_id: null },
    blockStop(0),
    msgDelta('tool_use'),
    msgStop,
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_main_0_0_1', is_error: true, content: '<tool_use_error>InputValidationError</tool_use_error>' }] }, parent_tool_use_id: null },
    ...fullTextTurn('msg_3', 'All done, monkeys! Magnificent.'),
    successResult,
  ]);
  assert.equal(toolErr.status, 'succeeded', JSON.stringify(toolErr));
  // z_deltaToolUseNoTools: stop_reason tool_use with no tool_use block (nothing to run).
  const noTools = await run([init, ...fullTextTurn('msg_1', 'x', 'tool_use'), ...fullTextTurn('msg_2', 'All done'), successResult]);
  assert.equal(noTools.status, 'succeeded', JSON.stringify(noTools));
  // stop_sequence mid-segment and end_turn wake-ups.
  const stopSeq = await run([
    ...bgLaunch,
    ...fullTextTurn('msg_4', 'waiting', 'stop_sequence'),
    ...bgFinish,
    ...fullTextTurn('msg_5', 'All done'),
    wakeResult('All done'),
  ]);
  assert.equal(stopSeq.status, 'succeeded', JSON.stringify(stopSeq));
});

// ── M0-G02 / M0-G03: tool evidence for a turn without a stop reason ─────────

/** z_nsToolNullStop: the stream was cut inside a tool block; the CLI's
 * non-streamed fallback returned a tool_use turn with `stop_reason: null`. */
const nsToolNull = (isError: boolean): Step[] => [
  init,
  statusRequesting,
  msgStart('msg_2'),
  toolStart(0, 'toolu_main_0_0_1'),
  {
    type: 'assistant',
    message: { id: 'msg_4', model: 'claude-sonnet-4-6', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_main_0_0_3', name: 'Read', input: { file_path: 'inside.txt' } }], stop_reason: null },
    parent_tool_use_id: null,
  },
  {
    type: 'user',
    message: { role: 'user', content: [{ tool_use_id: 'toolu_main_0_0_3', type: 'tool_result', content: isError ? '<tool_use_error>InputValidationError</tool_use_error>' : '1\tinside', ...(isError ? { is_error: true } : {}) }] },
    parent_tool_use_id: null,
  },
  ...fullTextTurn('msg_5', 'final ok'),
  { ...successResult, result: 'final ok' },
];

test('M0-G02 z_nsToolNullStop: a non-streamed stop_reason-null turn whose tool the CLI ran is complete → succeeded', async () => {
  const r = await run(nsToolNull(false));
  assert.equal(r.status, 'succeeded', JSON.stringify(r));
});

test('M0-G03: a cut turn whose only tool_use the CLI rejected (is_error) is still truncated → failed(provider_error)', async () => {
  // z_nsToolNullInvalid: the non-streamed variant.
  const ns = await run(nsToolNull(true));
  assert.equal(ns.status, 'failed', JSON.stringify(ns));
  assert.match(reasonOf(ns).detail, /msg_4 got no stop reason \(non-streamed message with stop_reason null\)/);
  // x_invalidToolCut: streamed, cut after the tool block, before message_delta.
  const cut = await run([
    init,
    statusRequesting,
    msgStart('msg_2'),
    toolStart(0, 'toolu_main_0_0_1'),
    { type: 'assistant', message: { id: 'msg_2', model: 'claude-sonnet-4-6', content: [{ type: 'tool_use', id: 'toolu_main_0_0_1', name: 'Read', input: {} }], stop_reason: null }, parent_tool_use_id: null },
    blockStop(0),
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_main_0_0_1', is_error: true, content: '<tool_use_error>InputValidationError</tool_use_error>' }] }, parent_tool_use_id: null },
    ...fullTextTurn('msg_3', 'All done, monkeys! Magnificent.'),
    successResult,
  ]);
  assert.equal(cut.status, 'failed', JSON.stringify(cut));
  assert.equal(reasonOf(cut).code, 'provider_error');
  assert.match(reasonOf(cut).detail, /main-thread turn msg_2 got no stop reason/);
});
