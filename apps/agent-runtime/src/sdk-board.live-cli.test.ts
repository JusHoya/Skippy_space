// sdk-board.live-cli.test.ts — N1 end-to-end regression against the REAL
// bundled Claude Code CLI (via @anthropic-ai/claude-agent-sdk), talking to a
// local mock of the Anthropic Messages API (SSE). No network, no real key.
//
// SKIPPED BY DEFAULT: it spawns the CLI process and takes a few seconds.
// Run: SKIPPY_LIVE_CLI_MOCK=1 node --import tsx --test src/sdk-board.live-cli.test.ts
//
// FR-RUN-01 / G0: a board that spawns a task agent whose tool calls the
// policy gate denies must end `blocked(policy_refused)`, even though the CLI
// reports `permission_denials: []` and a `success` result for the parent.
// EC1 D1: a task agent whose provider call fails (401/400) or is refused must
// end the run `failed` (the CLI still reports a parent `success`). EC1 D2: a
// main-thread call to a tool the charter withheld is `blocked`. OQ-20: a
// main-thread SSE stream that ends without `message_delta`/`message_stop` is
// reported by the CLI as a `success` with `stop_reason: null` — it must end
// `failed(provider_error)`, never `succeeded`.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { executeBoardMissionViaSdk, type ExecuteBoardMissionDeps } from './sdk-board.js';

const LIVE = process.env.SKIPPY_LIVE_CLI_MOCK === '1';
const skip = LIVE ? false : 'set SKIPPY_LIVE_CLI_MOCK=1 to run against the bundled CLI';

const MAIN_MARK = 'MOCKMARK-board';
const SUB_MARK = 'SUBMARK-task';

interface ToolUse {
  name: string;
  input: Record<string, unknown>;
}
/** How the task agent's first model call fails (EC1 D1), if at all. */
type SubFailure = { http: number; body: unknown } | { refusal: true };
interface Scenario {
  mainTools: ToolUse[];
  subTools: ToolUse[];
  subFailure?: SubFailure;
  /** OQ-20: the main thread's final (text) turn stream ends after its text
   * block, without `message_delta`/`message_stop`. */
  mainTruncEnd?: boolean;
  /** OQ-20 round 5: per-turn scripted responses; overrides everything above. */
  script?: { main: ScriptStep[]; sub?: ScriptStep[] };
}

/**
 * One scripted model turn, selected by the request's assistant-turn count (the
 * CLI's retry / non-streaming fallback of the same turn counts as the next
 * `attempts` entry). Mirrors the r4v1/r5 investigation mock.
 */
interface ScriptStep {
  text?: string;
  tools?: ToolUse[];
  stop?: string;
  /** End the stream after the last block: no message_delta / message_stop. */
  truncEnd?: boolean;
  /** End the stream right after this block's content_block_stop. */
  cutAfterBlock?: number;
  /** Never send content_block_stop (message_delta + message_stop still sent). */
  noBlockStop?: boolean;
  /** Destroy the socket after the first block's delta. */
  dropMid?: boolean;
  msgId?: string;
  delayMs?: number;
  attempts?: ScriptStep[];
  /** Answer with this HTTP error status (JSON `body`) instead of a message. */
  http?: number;
  body?: unknown;
}

let scenario: Scenario = { mainTools: [], subTools: [] };
/** Per-scenario attempt counters of scripted turns (reset by scriptedRun). */
const scriptAttempts = new Map<string, number>();
/** Non-streaming (fallback) requests served to scripted scenarios. */
let nonStreamedRequests = 0;
let server: http.Server | undefined;
let tmp = '';
const savedEnv: Record<string, string | undefined> = {};
const ENV_OVERRIDES = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'DISABLE_TELEMETRY',
  'DISABLE_AUTOUPDATER',
  'DISABLE_ERROR_REPORTING',
  'CLAUDE_CODE_MAX_RETRIES',
] as const;

function sse(
  res: http.ServerResponse,
  model: unknown,
  id: string,
  blocks: Array<Record<string, unknown>>,
  stop: string,
  truncEnd = false,
): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const ev = (e: string, d: unknown): void => {
    res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`);
  };
  const usage = { input_tokens: 10, output_tokens: 5 };
  ev('message_start', {
    type: 'message_start',
    message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage },
  });
  blocks.forEach((b, index) => {
    if (b.type === 'text') {
      ev('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      ev('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } });
    } else {
      ev('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} },
      });
      ev('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) },
      });
    }
    ev('content_block_stop', { type: 'content_block_stop', index });
  });
  if (truncEnd) {
    res.end();
    return;
  }
  ev('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } });
  ev('message_stop', { type: 'message_stop' });
  res.end();
}

function scripted(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  j: { model?: unknown; stream?: unknown; messages?: Array<{ role?: string; content?: unknown }> },
  steps: ScriptStep[],
  key: string,
  next: () => number,
  attempts: Map<string, number>,
  dflt: ScriptStep,
): void {
  const msgs = j.messages ?? [];
  const turn = msgs.filter((m) => m.role === 'assistant').length;
  const akey = `${key}#${turn}`;
  const attempt = attempts.get(akey) ?? 0;
  attempts.set(akey, attempt + 1);
  let step = steps[turn] ?? dflt;
  if (step.attempts) step = step.attempts[attempt] ?? step.attempts[step.attempts.length - 1]!;
  const s = step;
  if (s.http !== undefined) {
    res.writeHead(s.http, { 'content-type': 'application/json' });
    res.end(JSON.stringify(s.body ?? { type: 'error', error: { type: 'invalid_request_error', message: 'mock error' } }));
    return;
  }
  if (j.stream !== true) nonStreamedRequests++;
  const blocks: Array<Record<string, unknown>> = (s.tools ?? []).map((t, i) => ({
    type: 'tool_use',
    id: `toolu_${key.replace(/\W/g, '')}_${turn}_${i}_${next()}`,
    name: t.name,
    input: t.input,
  }));
  if (s.text !== undefined) blocks.unshift({ type: 'text', text: s.text });
  const stop = s.tools ? 'tool_use' : (s.stop ?? 'end_turn');
  const id = s.msgId ?? `msg_${next()}`;
  const usage = { input_tokens: 10, output_tokens: 5 };
  const go = (): void => {
    if (j.stream !== true) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model: j.model, content: blocks, stop_reason: stop, stop_sequence: null, usage }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const ev = (e: string, d: unknown): void => {
      res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`);
    };
    ev('message_start', {
      type: 'message_start',
      message: { id, type: 'message', role: 'assistant', model: j.model, content: [], stop_reason: null, stop_sequence: null, usage },
    });
    for (let index = 0; index < blocks.length; index++) {
      const b = blocks[index]!;
      if (b.type === 'text') {
        ev('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
        ev('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } });
      } else {
        ev('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
        ev('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
      }
      if (s.dropMid) {
        setTimeout(() => req.socket.destroy(), 20);
        return;
      }
      if (!s.noBlockStop) ev('content_block_stop', { type: 'content_block_stop', index });
      if (s.cutAfterBlock === index) {
        res.end();
        return;
      }
    }
    if (s.truncEnd) {
      res.end();
      return;
    }
    ev('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } });
    ev('message_stop', { type: 'message_stop' });
    res.end();
  };
  if (s.delayMs) setTimeout(go, s.delayMs);
  else go();
}

function startMock(): Promise<http.Server> {
  let n = 0;
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      let j: {
        model?: unknown;
        stream?: unknown;
        system?: unknown;
        tools?: unknown[];
        messages?: Array<{ role?: string; content?: unknown }>;
      } = {};
      try {
        j = JSON.parse(body || '{}') as typeof j;
      } catch {
        /* empty */
      }
      const url = req.url ?? '';
      if (url.includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"input_tokens":10}');
        return;
      }
      if (!url.startsWith('/v1/messages')) {
        res.writeHead(404);
        res.end('{}');
        return;
      }
      const msgs = j.messages ?? [];
      const last = msgs[msgs.length - 1];
      const hasToolResult =
        Array.isArray(last?.content) &&
        (last.content as Array<{ type?: string }>).some((b) => b.type === 'tool_result');
      const hasTools = (j.tools ?? []).length > 0;
      const isMain = hasTools && JSON.stringify(j.system ?? '').includes(MAIN_MARK);
      const isSub = !isMain && hasTools && JSON.stringify(msgs[0] ?? '').includes(SUB_MARK);
      if (scenario.script && (isMain || isSub)) {
        const steps = isMain ? scenario.script.main : (scenario.script.sub ?? []);
        const dflt: ScriptStep = isMain ? { text: 'All done, monkeys! Magnificent.' } : { text: 'sub done' };
        scripted(req, res, j, steps, isMain ? 'main' : 'sub', () => ++n, scriptAttempts, dflt);
        return;
      }
      const toolBlocks = (tools: ToolUse[]): Array<Record<string, unknown>> =>
        tools.map((t, i) => ({ type: 'tool_use', id: `toolu_${i}_${++n}`, name: t.name, input: t.input }));
      const id = `msg_${++n}`;
      const fail = scenario.subFailure;
      if (isSub && fail && 'http' in fail) {
        res.writeHead(fail.http, { 'content-type': 'application/json' });
        res.end(JSON.stringify(fail.body));
      } else if (isSub && fail && 'refusal' in fail) {
        sse(res, j.model, id, [{ type: 'text', text: 'I refuse' }], 'refusal');
      } else if (isSub && !hasToolResult && scenario.subTools.length > 0) {
        sse(res, j.model, id, toolBlocks(scenario.subTools), 'tool_use');
      } else if (isMain && !hasToolResult && scenario.mainTools.length > 0) {
        sse(res, j.model, id, toolBlocks(scenario.mainTools), 'tool_use');
      } else {
        const text = isMain ? 'All done, monkeys! Magnificent.' : isSub ? 'sub done' : 'Title';
        sse(res, j.model, id, [{ type: 'text', text: isMain && scenario.mainTruncEnd ? 'partial answer' : text }], 'end_turn', isMain && scenario.mainTruncEnd === true);
      }
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

before(async () => {
  if (!LIVE) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skippy-live-cli-'));
  fs.mkdirSync(path.join(tmp, 'work'));
  fs.mkdirSync(path.join(tmp, 'cfg'));
  fs.writeFileSync(path.join(tmp, 'work', 'inside.txt'), 'inside\n');
  server = await startMock();
  const port = (server.address() as AddressInfo).port;
  for (const k of ENV_OVERRIDES) savedEnv[k] = process.env[k];
  Object.assign(process.env, {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_API_KEY: 'sk-ant-fake-000',
    CLAUDE_CONFIG_DIR: path.join(tmp, 'cfg'),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_ERROR_REPORTING: '1',
    CLAUDE_CODE_MAX_RETRIES: '0',
  });
});

after(() => {
  if (!LIVE) return;
  server?.close();
  for (const k of ENV_OVERRIDES) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

function mission(): Parameters<typeof executeBoardMissionViaSdk>[0] {
  return {
    boardId: 'coding',
    systemPrompt: `${MAIN_MARK} You are the Coding Board Captain.`,
    model: 'claude-sonnet-4-6' as never,
    missionBrief: 'do the thing',
    worktreePath: path.join(tmp, 'work'),
    maxTurns: 6,
  };
}

/** The executor's env is an allowlist (M0-G06), so the CLI retry budget this
 * suite depends on is injected through the test-only seam, read at call time
 * (the M0-G01 controls raise it temporarily). */
function liveDeps(): ExecuteBoardMissionDeps {
  return { executorEnvOverrides: { CLAUDE_CODE_MAX_RETRIES: process.env.CLAUDE_CODE_MAX_RETRIES ?? '0' } };
}

test('live CLI (N1): task agent denied Read-outside-roots + Bash, parent reports success → blocked(policy_refused)', { skip, timeout: 120_000 }, async () => {
  const outside = path.join(path.parse(tmp).root, 'Windows', 'win.ini');
  scenario = {
    mainTools: [{ name: 'Agent', input: { description: 'sub', prompt: `${SUB_MARK} go`, subagent_type: 'general-purpose' } }],
    subTools: [
      { name: 'Read', input: { file_path: outside } },
      { name: 'Bash', input: { command: 'echo hi' } },
    ],
  };
  const decisions: Array<{ tool: string; allow: boolean }> = [];
  const r = await executeBoardMissionViaSdk(
    {
      ...mission(),
      enforcement: { onDecision: (e) => decisions.push({ tool: e.toolName, allow: e.decision.allow }) },
    },
    liveDeps(),
  );
  assert.ok(decisions.some((d) => !d.allow), `the gate denied nothing: ${JSON.stringify(decisions)}`);
  assert.equal(r.status, 'blocked', JSON.stringify(r));
  assert.equal(r.status === 'blocked' && r.reason.code, 'policy_refused');
  assert.match(r.status === 'blocked' ? (r.reason.detail ?? '') : '', /task agent/);
});

test('live CLI (control): an allowed in-worktree Read with no denials → succeeded', { skip, timeout: 120_000 }, async () => {
  scenario = { mainTools: [{ name: 'Read', input: { file_path: path.join(tmp, 'work', 'inside.txt') } }], subTools: [] };
  const r = await executeBoardMissionViaSdk(mission(), liveDeps());
  assert.equal(r.status, 'succeeded', JSON.stringify(r));
});

// ── EC1 D1: task-agent provider failures / refusal (parent still "success") ──

const spawnTaskAgent: ToolUse = {
  name: 'Agent',
  input: { description: 'sub', prompt: `${SUB_MARK} go`, subagent_type: 'general-purpose' },
};

test('live CLI (D1 sub401): task agent gets 401 → failed(provider_error), not succeeded', { skip, timeout: 120_000 }, async () => {
  scenario = {
    mainTools: [spawnTaskAgent],
    subTools: [],
    subFailure: { http: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } },
  };
  const r = await executeBoardMissionViaSdk(mission(), liveDeps());
  assert.equal(r.status, 'failed', JSON.stringify(r));
  assert.equal(r.status === 'failed' && r.reason.code, 'provider_error');
  assert.match(r.status === 'failed' ? `${r.reason.message} ${r.reason.detail ?? ''}` : '', /task agent/);
  assert.match(r.status === 'failed' ? (r.reason.detail ?? '') : '', /authentication_failed/);
});

test('live CLI (D1 sub400): task agent gets 400 → failed(provider_error)', { skip, timeout: 120_000 }, async () => {
  scenario = {
    mainTools: [spawnTaskAgent],
    subTools: [],
    subFailure: { http: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'mock error' } } },
  };
  const r = await executeBoardMissionViaSdk(mission(), liveDeps());
  assert.equal(r.status, 'failed', JSON.stringify(r));
  assert.equal(r.status === 'failed' && r.reason.code, 'provider_error');
});

test('live CLI (D1 subrefusal): task agent refused (stop_reason refusal) → failed(model_refused)', { skip, timeout: 120_000 }, async () => {
  scenario = { mainTools: [spawnTaskAgent], subTools: [], subFailure: { refusal: true } };
  const r = await executeBoardMissionViaSdk(mission(), liveDeps());
  assert.equal(r.status, 'failed', JSON.stringify(r));
  assert.equal(r.status === 'failed' && r.reason.code, 'model_refused');
});

test('live CLI (D1 control): a task agent that finishes normally → succeeded', { skip, timeout: 120_000 }, async () => {
  scenario = { mainTools: [spawnTaskAgent], subTools: [] };
  const r = await executeBoardMissionViaSdk(mission(), liveDeps());
  assert.equal(r.status, 'succeeded', JSON.stringify(r));
});

// ── EC1 D2: withheld tools ("No such tool available") are policy refusals ───

test('live CLI (D2 unknowntool): main-thread WebSearch + NotebookEdit withheld by charter → blocked(policy_refused)', { skip, timeout: 120_000 }, async () => {
  scenario = {
    mainTools: [
      { name: 'WebSearch', input: { query: 'x' } },
      { name: 'NotebookEdit', input: {} },
    ],
    subTools: [],
  };
  const r = await executeBoardMissionViaSdk(mission(), liveDeps());
  assert.equal(r.status, 'blocked', JSON.stringify(r));
  assert.equal(r.status === 'blocked' && r.reason.code, 'policy_refused');
  assert.match(r.status === 'blocked' ? (r.reason.detail ?? '') : '', /WebSearch/);
  assert.match(r.status === 'blocked' ? (r.reason.detail ?? '') : '', /NotebookEdit/);
});

// ── OQ-20: truncated main-thread provider stream (FR-RUN-01, G0) ─────────────

test('live CLI (OQ-20 maintruncend): main stream ends without message_delta/message_stop → failed(provider_error), not succeeded', { skip, timeout: 120_000 }, async () => {
  scenario = { mainTools: [], subTools: [], mainTruncEnd: true };
  const r = await executeBoardMissionViaSdk(mission(), liveDeps());
  assert.equal(r.status, 'failed', JSON.stringify(r));
  assert.equal(r.status === 'failed' && r.reason.code, 'provider_error');
  assert.match(r.status === 'failed' ? (r.reason.detail ?? '') : '', /without a stop reason \(truncated\)/);
  assert.match(r.status === 'failed' ? (r.reason.detail ?? '') : '', /final main-thread turn/);
});

test('live CLI (OQ-20 maintooltrunc): truncated final turn after a tool turn (stale result stop_reason) → failed(provider_error)', { skip, timeout: 120_000 }, async () => {
  scenario = { mainTools: [{ name: 'Read', input: { file_path: path.join(tmp, 'work', 'inside.txt') } }], subTools: [], mainTruncEnd: true };
  const r = await executeBoardMissionViaSdk(mission(), liveDeps());
  assert.equal(r.status, 'failed', JSON.stringify(r));
  assert.equal(r.status === 'failed' && r.reason.code, 'provider_error');
});

// ── OQ-20 round 5: non-final segment turns, same-id fallback, unclosed block ──
//
// While a background task agent runs, the CLI emits no `result` between the
// board's segments; a truncated turn there must still fail the run.

const bgAgent: ToolUse = {
  name: 'Agent',
  input: { description: 'sub', prompt: `${SUB_MARK} bg`, subagent_type: 'general-purpose', run_in_background: true },
};
const slowSub: ScriptStep[] = [{ text: 'bg sub done', stop: 'end_turn', delayMs: 2500 }];

async function scriptedRun(script: NonNullable<Scenario['script']>): Promise<Awaited<ReturnType<typeof executeBoardMissionViaSdk>>> {
  scenario = { mainTools: [], subTools: [], script };
  scriptAttempts.clear();
  nonStreamedRequests = 0;
  return executeBoardMissionViaSdk(mission(), liveDeps());
}

test('live CLI (OQ-20 t_pairSlowSub): turn truncated while a background task runs (no result before the wake-up) → failed(provider_error)', { skip, timeout: 120_000 }, async () => {
  const r = await scriptedRun({
    main: [{ tools: [bgAgent] }, { text: 'I will now write the report file and then', truncEnd: true, delayMs: 600 }, { text: 'Report complete, monkeys.' }],
    sub: slowSub,
  });
  assert.equal(r.status, 'failed', JSON.stringify(r));
  assert.equal(r.status === 'failed' && r.reason.code, 'provider_error');
  assert.match(r.status === 'failed' ? (r.reason.detail ?? '') : '', /main-thread turn msg_\d+ got no stop reason/);
});

test('live CLI (OQ-20 t_bgTruncLostTool): stream cut before a Write tool_use (never ran), then a wake-up success → failed(provider_error)', { skip, timeout: 120_000 }, async () => {
  const r = await scriptedRun({
    main: [
      { tools: [bgAgent] },
      { text: 'Now writing the file', tools: [{ name: 'Write', input: { file_path: path.join(tmp, 'work', 'lost.txt'), content: 'z' } }], cutAfterBlock: 0 },
      { text: 'All done, monkeys.' },
    ],
    sub: slowSub,
  });
  assert.equal(r.status, 'failed', JSON.stringify(r));
  assert.equal(r.status === 'failed' && r.reason.code, 'provider_error');
  assert.equal(fs.existsSync(path.join(tmp, 'work', 'lost.txt')), false);
});

test('live CLI (OQ-20 control t_pairSlowSubOk): complete turns around a background wake-up → succeeded', { skip, timeout: 120_000 }, async () => {
  const r = await scriptedRun({
    main: [{ tools: [bgAgent] }, { text: 'waiting on bg', stop: 'end_turn', delayMs: 600 }, { text: 'Report complete, monkeys.' }],
    sub: slowSub,
  });
  assert.equal(r.status, 'succeeded', JSON.stringify(r));
  assert.equal(r.status === 'succeeded' && r.summary, 'Report complete, monkeys.');
});

test('live CLI (OQ-20 D2 t_fallbackNsSameId): non-streamed fallback reusing the dropped turn\'s id completes it → succeeded', { skip, timeout: 120_000 }, async () => {
  const r = await scriptedRun({
    main: [{ attempts: [{ text: 'x', dropMid: true, msgId: 'msg_same' }, { text: 'fallback ok', msgId: 'msg_same' }] }],
  });
  assert.equal(nonStreamedRequests, 1, 'the CLI must have used the non-streaming fallback');
  assert.equal(r.status, 'succeeded', JSON.stringify(r));
  assert.equal(r.status === 'succeeded' && r.summary, 'fallback ok');
});

test('live CLI (OQ-20 D3 t_noBlockStopEnd): end_turn with a text block never closed (CLI reports result "") → failed(provider_error)', { skip, timeout: 120_000 }, async () => {
  const r = await scriptedRun({ main: [{ text: 'partial', noBlockStop: true }] });
  assert.equal(r.status, 'failed', JSON.stringify(r));
  assert.equal(r.status === 'failed' && r.reason.code, 'provider_error');
  assert.match(r.status === 'failed' ? (r.reason.detail ?? '') : '', /never closed/);
});

// ── M0-G01: main-thread terminal failure in a segment with no `result` ──────
//
// While the background task agent runs, the CLI ends the failed main-thread
// segment WITHOUT a result (only a `<synthetic>` error message + the main-
// thread StopFailure hook); the wake-up segment then ends `success/end_turn`.

const failureOf = (r: Awaited<ReturnType<typeof executeBoardMissionViaSdk>>): { code: string; text: string } => {
  assert.equal(r.status, 'failed', JSON.stringify(r));
  return r.status === 'failed' ? { code: r.reason.code, text: `${r.reason.message} ${r.reason.detail ?? ''}` } : { code: '', text: '' };
};

test('live CLI (M0-G01 m_bgMid401): main-thread 401 while a background task runs, then a wake-up success → failed(provider_error)', { skip, timeout: 120_000 }, async () => {
  const r = await scriptedRun({
    main: [
      { tools: [bgAgent] },
      { attempts: [{ http: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } }, { text: 'final ok' }] },
    ],
    sub: slowSub,
  });
  const f = failureOf(r);
  assert.equal(f.code, 'provider_error');
  assert.match(f.text, /main thread/);
  assert.match(f.text, /authentication_failed/);
});

test('live CLI (M0-G01 m_bgMidRefusal): main-thread refusal while a background task runs → failed(model_refused)', { skip, timeout: 120_000 }, async () => {
  const r = await scriptedRun({ main: [{ tools: [bgAgent] }, { text: 'no', stop: 'refusal' }, { text: 'final ok' }], sub: slowSub });
  assert.equal(failureOf(r).code, 'model_refused');
});

test('live CLI (M0-G01 m_bgMidPause): main-thread pause_turn never continued before the wake-up → failed(executor_error)', { skip, timeout: 120_000 }, async () => {
  const r = await scriptedRun({ main: [{ tools: [bgAgent] }, { text: 'paused', stop: 'pause_turn' }, { text: 'final ok' }], sub: slowSub });
  const f = failureOf(r);
  assert.equal(f.code, 'executor_error');
  assert.match(f.text, /pause_turn/);
});

test('live CLI (M0-G01 m_bgMidMaxTokAll): the CLI gives up on max_tokens recovery while a background task runs → failed(executor_error)', { skip, timeout: 120_000 }, async () => {
  const r = await scriptedRun({
    main: [
      { tools: [bgAgent] },
      { text: 'a', stop: 'max_tokens' },
      { text: 'b', stop: 'max_tokens' },
      { text: 'c', stop: 'max_tokens' },
      { text: 'd', stop: 'max_tokens' },
      { text: 'final ok' },
    ],
    sub: slowSub,
  });
  const f = failureOf(r);
  assert.equal(f.code, 'executor_error');
  assert.match(f.text, /max_output_tokens/);
});

test('live CLI (M0-G01 controls): a retried 529 and a recovered max_tokens turn while a background task runs → succeeded', { skip, timeout: 120_000 }, async () => {
  const saved = process.env.CLAUDE_CODE_MAX_RETRIES;
  process.env.CLAUDE_CODE_MAX_RETRIES = '2';
  try {
    const retried = await scriptedRun({
      main: [
        { tools: [bgAgent] },
        { attempts: [{ http: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } }, { text: 'waiting on bg' }] },
        { text: 'Report complete, monkeys.' },
      ],
      sub: slowSub,
    });
    assert.equal(retried.status, 'succeeded', JSON.stringify(retried));
  } finally {
    process.env.CLAUDE_CODE_MAX_RETRIES = saved;
  }
  const maxTok = await scriptedRun({
    main: [{ tools: [bgAgent] }, { text: 'partial', stop: 'max_tokens' }, { text: 'continued' }, { text: 'Report complete, monkeys.' }],
    sub: slowSub,
  });
  assert.equal(maxTok.status, 'succeeded', JSON.stringify(maxTok));
});
