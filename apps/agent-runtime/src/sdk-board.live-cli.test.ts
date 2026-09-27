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

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { executeBoardMissionViaSdk } from './sdk-board.js';

const LIVE = process.env.SKIPPY_LIVE_CLI_MOCK === '1';
const skip = LIVE ? false : 'set SKIPPY_LIVE_CLI_MOCK=1 to run against the bundled CLI';

const MAIN_MARK = 'MOCKMARK-board';
const SUB_MARK = 'SUBMARK-task';

interface ToolUse {
  name: string;
  input: Record<string, unknown>;
}
interface Scenario {
  mainTools: ToolUse[];
  subTools: ToolUse[];
}

let scenario: Scenario = { mainTools: [], subTools: [] };
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
] as const;

function sse(res: http.ServerResponse, model: unknown, id: string, blocks: Array<Record<string, unknown>>, stop: string): void {
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
  ev('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } });
  ev('message_stop', { type: 'message_stop' });
  res.end();
}

function startMock(): Promise<http.Server> {
  let n = 0;
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      let j: { model?: unknown; system?: unknown; tools?: unknown[]; messages?: Array<{ content?: unknown }> } = {};
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
      const toolBlocks = (tools: ToolUse[]): Array<Record<string, unknown>> =>
        tools.map((t, i) => ({ type: 'tool_use', id: `toolu_${i}_${++n}`, name: t.name, input: t.input }));
      const id = `msg_${++n}`;
      if (isSub && !hasToolResult && scenario.subTools.length > 0) {
        sse(res, j.model, id, toolBlocks(scenario.subTools), 'tool_use');
      } else if (isMain && !hasToolResult && scenario.mainTools.length > 0) {
        sse(res, j.model, id, toolBlocks(scenario.mainTools), 'tool_use');
      } else {
        const text = isMain ? 'All done, monkeys! Magnificent.' : isSub ? 'sub done' : 'Title';
        sse(res, j.model, id, [{ type: 'text', text }], 'end_turn');
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
  const r = await executeBoardMissionViaSdk({
    ...mission(),
    enforcement: { onDecision: (e) => decisions.push({ tool: e.toolName, allow: e.decision.allow }) },
  });
  assert.ok(decisions.some((d) => !d.allow), `the gate denied nothing: ${JSON.stringify(decisions)}`);
  assert.equal(r.status, 'blocked', JSON.stringify(r));
  assert.equal(r.status === 'blocked' && r.reason.code, 'policy_refused');
  assert.match(r.status === 'blocked' ? (r.reason.detail ?? '') : '', /task agent/);
});

test('live CLI (control): an allowed in-worktree Read with no denials → succeeded', { skip, timeout: 120_000 }, async () => {
  scenario = { mainTools: [{ name: 'Read', input: { file_path: path.join(tmp, 'work', 'inside.txt') } }], subTools: [] };
  const r = await executeBoardMissionViaSdk(mission());
  assert.equal(r.status, 'succeeded', JSON.stringify(r));
});
