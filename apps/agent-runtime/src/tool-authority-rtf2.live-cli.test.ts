// tool-authority-rtf2.live-cli.test.ts — F2 end-to-end regression against the
// REAL bundled Claude Code CLI (via @anthropic-ai/claude-agent-sdk 0.3.162 /
// CLI 2.1.162), talking to a local mock of the Anthropic Messages API (SSE).
// No network, no real key. Mirrors the red-team's rtf2/live.mts scenarios.
//
// SKIPPED BY DEFAULT: it spawns the CLI process and takes tens of seconds.
// Run: SKIPPY_LIVE_CLI_MOCK=1 node --import tsx --test src/tool-authority-rtf2.live-cli.test.ts
//
// FR-SEC-01 / FR-SEC-02 / G0: on a worktree holding well-known credential
// files, every Read of an 8.3 short name / junction alias, every Grep that
// could reach a credential entry and every Glob that could list one must
// come back to the model WITHOUT a secret, while benign reads and searches
// still work. Layer (b) is exercised separately: a credential inside
// `node_modules` (not enumerated pre-execution) is still redacted from the
// rg output by the PostToolUse hook.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { executeBoardMissionViaSdk } from './sdk-board.js';
import type { Charter } from './charter.js';

const LIVE = process.env.SKIPPY_LIVE_CLI_MOCK === '1';
const skip = LIVE ? false : 'set SKIPPY_LIVE_CLI_MOCK=1 to run against the bundled CLI';

const MAIN_MARK = 'MOCKMARK-board';

interface ToolUse {
  name: string;
  input: Record<string, unknown>;
}
interface ToolResult {
  id: string;
  isError: boolean;
  content: string;
}

let scenario: ToolUse[] = [];
/** Every tool_result the CLI sent back to the (mock) model. */
let results: ToolResult[] = [];
let server: http.Server | undefined;
let tmp = '';
let work = '';
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

function collectToolResults(messages: Array<{ role?: string; content?: unknown }>): void {
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content as Array<Record<string, unknown>>) {
      if (b['type'] !== 'tool_result') continue;
      const id = String(b['tool_use_id']);
      if (results.some((r) => r.id === id)) continue;
      const c = b['content'];
      const content =
        typeof c === 'string'
          ? c
          : Array.isArray(c)
            ? (c as Array<Record<string, unknown>>).map((x) => (typeof x['text'] === 'string' ? x['text'] : JSON.stringify(x))).join('\n')
            : JSON.stringify(c);
      results.push({ id, isError: b['is_error'] === true, content });
    }
  }
}

function startMock(): Promise<http.Server> {
  let n = 0;
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      let j: { model?: unknown; system?: unknown; tools?: unknown[]; messages?: Array<{ role?: string; content?: unknown }> } = {};
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
      collectToolResults(msgs);
      const last = msgs[msgs.length - 1];
      const hasToolResult =
        Array.isArray(last?.content) && (last.content as Array<{ type?: string }>).some((b) => b.type === 'tool_result');
      const isMain = (j.tools ?? []).length > 0 && JSON.stringify(j.system ?? '').includes(MAIN_MARK);
      const id = `msg_${++n}`;
      if (isMain && !hasToolResult && scenario.length > 0) {
        sse(res, j.model, id, scenario.map((t, i) => ({ type: 'tool_use', id: `toolu_${i}_${++n}`, name: t.name, input: t.input })), 'tool_use');
      } else {
        sse(res, j.model, id, [{ type: 'text', text: isMain ? 'All done, monkeys! Magnificent.' : 'Title' }], 'end_turn');
      }
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

before(async () => {
  if (!LIVE) return;
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'skippy-rtf2-live-')));
  work = path.join(tmp, 'work');
  for (const d of ['.aws', '.ssh', 'sub', path.join('node_modules', 'pkg')]) fs.mkdirSync(path.join(work, d), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'cfg'));
  const files: Record<string, string> = {
    '.env': 'SECRET_ENV=sk-ant-envleak\n',
    '.env.production': 'SECRET_ENVPROD=prodleak\n',
    '.aws/credentials': 'aws_secret_access_key=SECRET_AWS\n',
    '.ssh/config': 'SECRET_SSHCONFIG\n',
    '.ssh/id_ed25519': 'SECRET_SSHKEY\n',
    'server.pem': 'SECRET_PEM\n',
    'inside.txt': 'inside BENIGN_MARKER\n',
    'sub/notes.txt': 'plain BENIGN_MARKER\n',
    'node_modules/pkg/.env': 'SECRET_NM=nmleak\n',
    'node_modules/pkg/index.js': '// BENIGN_MARKER\n',
  };
  for (const [rel, content] of Object.entries(files)) fs.writeFileSync(path.join(work, ...rel.split('/')), content);
  fs.symlinkSync(path.join(work, '.aws'), path.join(work, 'lnk'), 'junction');
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

after(async () => {
  if (!LIVE) return;
  server?.close();
  for (const k of ENV_OVERRIDES) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  // The spawned CLI's cwd is `work`; Windows refuses to remove a process's
  // working directory until it has fully exited, so poll for a while.
  const deadline = Date.now() + 15_000;
  while (fs.existsSync(tmp) && Date.now() < deadline) {
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      /* retry below */
    }
    if (fs.existsSync(tmp)) await new Promise((r) => setTimeout(r, 500));
  }
});

const charter: Charter = {
  agentId: 'board.coding',
  frontmatter: { permission_mode: 'ask', tools: ['Read', 'Glob', 'Grep'] },
  body: 'synthetic',
  loaded: true,
  path: '(synthetic)',
};

function mission(): Parameters<typeof executeBoardMissionViaSdk>[0] {
  return {
    boardId: 'coding',
    systemPrompt: `${MAIN_MARK} You are the Coding Board Captain.`,
    model: 'claude-sonnet-4-6' as never,
    missionBrief: 'do the thing',
    charter,
    worktreePath: work,
    maxTurns: 6,
  };
}

const SECRET = /SECRET_|sk-ant-envleak|prodleak|nmleak/;

test('live CLI (F2 D1-D3): 8.3 / junction reads, bare Grep, wildcard globs and Glob **/* return no secret; benign reads work', { skip, timeout: 180_000 }, async () => {
  const w = (rel: string): string => path.join(work, ...rel.split('/'));
  results = [];
  scenario = [
    { name: 'Read', input: { file_path: w('ENV~1') } },
    { name: 'Read', input: { file_path: w('ENV~1.PRO') } },
    { name: 'Read', input: { file_path: w('AWS~1/credentials') } },
    { name: 'Read', input: { file_path: w('SSH~1/config') } },
    { name: 'Read', input: { file_path: w('lnk/credentials') } },
    { name: 'Read', input: { file_path: w('.env') } },
    { name: 'Grep', input: { pattern: 'SECRET', output_mode: 'content' } },
    { name: 'Grep', input: { pattern: 'SECRET', path: work, output_mode: 'content' } },
    { name: 'Grep', input: { pattern: 'SECRET', glob: '.en?', output_mode: 'content' } },
    { name: 'Grep', input: { pattern: 'SECRET', glob: '[.]env', output_mode: 'content' } },
    { name: 'Grep', input: { pattern: 'SECRET', glob: '*.pe?', output_mode: 'content' } },
    { name: 'Grep', input: { pattern: 'SECRET', path: w('AWS~1'), output_mode: 'content' } },
    { name: 'Grep', input: { pattern: 'SECRET', path: w('lnk'), output_mode: 'content' } },
    { name: 'Grep', input: { pattern: 'SECRET' } },
    { name: 'Glob', input: { pattern: '**/*' } },
    { name: 'Glob', input: { pattern: '.en?' } },
    { name: 'Glob', input: { pattern: '*.pe?' } },
    { name: 'Glob', input: { pattern: 'AWS~1/*' } },
    { name: 'Glob', input: { pattern: 'lnk/*' } },
    { name: 'Glob', input: { pattern: '*', path: w('SSH~1') } },
    // Benign work must still succeed.
    { name: 'Read', input: { file_path: w('inside.txt') } },
    { name: 'Grep', input: { pattern: 'BENIGN_MARKER', output_mode: 'content' } },
    { name: 'Grep', input: { pattern: 'BENIGN_MARKER', path: w('sub'), output_mode: 'files_with_matches' } },
    { name: 'Glob', input: { pattern: '*.txt' } },
    { name: 'Glob', input: { pattern: 'sub/**/*.txt' } },
  ];
  const decisions: Array<{ via: string; tool: string; allow: boolean; code?: string }> = [];
  const r = await executeBoardMissionViaSdk({
    ...mission(),
    enforcement: {
      onDecision: (e) => decisions.push({ via: e.via, tool: e.toolName, allow: e.decision.allow, ...(e.decision.allow ? {} : { code: e.decision.code }) }),
    },
  });
  assert.equal(results.length, scenario.length, `every tool call produced a tool_result: ${JSON.stringify(results.map((x) => x.id))}`);
  const leaked = results.filter((x) => SECRET.test(x.content));
  assert.deepEqual(leaked, [], `no tool_result carries a secret: ${JSON.stringify(leaked)}`);
  // The credential names themselves are not listed either (Glob **/*).
  const listed = results.filter((x) => !x.isError && /\.env|\.ssh|\.aws|\.pem|credentials|id_ed25519/i.test(x.content));
  assert.deepEqual(listed, [], `no successful result lists a credential name: ${JSON.stringify(listed)}`);
  // Benign calls: the in-worktree Read, the rewritten Grep and the clean Globs
  // produced real output.
  const ok = results.filter((x) => !x.isError && /BENIGN_MARKER|inside\.txt|notes\.txt/.test(x.content));
  assert.ok(ok.length >= 5, `benign reads/searches still work: ${JSON.stringify(results.filter((x) => !x.isError))}`);
  // Denied BEFORE execution by the policy gate: the 6 Reads, the 6 Globs and
  // the 2 Greps whose `path` is a short name / junction. The 6 remaining
  // Greps run with credential negatives appended (allowed, rewritten) and —
  // asserted above — returned no secret. The run is blocked (G0).
  const preDenied = decisions.filter((d) => d.via === 'PreToolUse' && !d.allow);
  assert.equal(preDenied.length, 14, `PreToolUse denials: ${JSON.stringify(preDenied)}`);
  assert.deepEqual(
    preDenied.map((d) => d.tool).sort(),
    ['Glob', 'Glob', 'Glob', 'Glob', 'Glob', 'Glob', 'Grep', 'Grep', 'Read', 'Read', 'Read', 'Read', 'Read', 'Read'],
  );
  assert.ok(preDenied.every((d) => d.code === 'credential_path' || d.code === 'path_outside_roots'), JSON.stringify(preDenied));
  const rewrittenGreps = decisions.filter((d) => d.via === 'PreToolUse' && d.allow && d.tool === 'Grep');
  assert.equal(rewrittenGreps.length, 8, `6 credential-probing + 2 benign Greps ran rewritten: ${JSON.stringify(decisions)}`);
  assert.equal(r.status, 'blocked', JSON.stringify(r));
});

test('live CLI (F2 D2 layer b): a credential inside node_modules that rg reaches is redacted by the PostToolUse hook', { skip, timeout: 180_000 }, async () => {
  results = [];
  scenario = [
    { name: 'Grep', input: { pattern: 'SECRET|BENIGN', path: path.join(work, 'node_modules'), output_mode: 'content' } },
    { name: 'Glob', input: { pattern: '**/*', path: path.join(work, 'node_modules') } },
    { name: 'Grep', input: { pattern: 'BENIGN', path: path.join(work, 'node_modules', 'pkg'), glob: '*.js', output_mode: 'content' } },
  ];
  const decisions: Array<{ via: string; tool: string; allow: boolean }> = [];
  const r = await executeBoardMissionViaSdk({
    ...mission(),
    enforcement: { onDecision: (e) => decisions.push({ via: e.via, tool: e.toolName, allow: e.decision.allow }) },
  });
  assert.equal(results.length, 3, JSON.stringify(results));
  const leaked = results.filter((x) => SECRET.test(x.content) || /\.env/.test(x.content));
  assert.deepEqual(leaked, [], `PostToolUse withheld the credential-bearing output: ${JSON.stringify(results)}`);
  assert.ok(results.some((x) => /withheld|credential/i.test(x.content)), `the model is told why: ${JSON.stringify(results)}`);
  assert.ok(results.some((x) => !x.isError && /index\.js/.test(x.content)), `the clean Grep still returns its match: ${JSON.stringify(results)}`);
  assert.ok(decisions.some((d) => d.via === 'PostToolUse' && !d.allow), JSON.stringify(decisions));
  assert.equal(r.status, 'blocked', JSON.stringify(r));
});

test('live CLI (control): benign Read + Grep on the credential-bearing worktree → succeeded', { skip, timeout: 180_000 }, async () => {
  results = [];
  scenario = [
    { name: 'Read', input: { file_path: path.join(work, 'inside.txt') } },
    { name: 'Grep', input: { pattern: 'BENIGN_MARKER', output_mode: 'content' } },
    { name: 'Glob', input: { pattern: '*.txt' } },
  ];
  const r = await executeBoardMissionViaSdk(mission());
  assert.equal(r.status, 'succeeded', JSON.stringify(r));
  assert.equal(results.length, 3);
  assert.ok(results.every((x) => !x.isError && !SECRET.test(x.content)), JSON.stringify(results));
  assert.ok(results.some((x) => /inside\.txt:1:inside BENIGN_MARKER/.test(x.content)), JSON.stringify(results));
});
