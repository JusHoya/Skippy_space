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

import { executeBoardMissionViaSdk, type ClaudeAgentSdkModule, type SdkBoardResult } from './sdk-board.js';

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
  const hooks = opts.hooks as Record<string, unknown[] | undefined>;
  assert.ok(hooks.StopFailure && hooks.StopFailure.length > 0, 'StopFailure hook must be registered');
  assert.ok(hooks.PreToolUse && hooks.PreToolUse.length > 0, 'the policy PreToolUse hook must remain');
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
