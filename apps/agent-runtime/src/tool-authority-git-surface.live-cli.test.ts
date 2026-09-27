// tool-authority-git-surface.live-cli.test.ts — M1 pre-flight D-A end to end
// against the REAL bundled Claude Code CLI (@anthropic-ai/claude-agent-sdk
// 0.3.162 / CLI 2.1.162), a real `git`, and a local mock of the Anthropic
// Messages API (SSE). No network, no real key, dummy placeholder content only.
//
// Before this round: the CLI ran `git --no-optional-locks status --short` in
// the worktree at startup; a board with Write could put `core.fsmonitor =
// <script>` into `<wt>/.git/config` (`.git` was not a protected name), and
// the NEXT run — a read-only board with zero tool calls — executed the
// script (it wrote a marker OUTSIDE every root). A `.git` FILE (`gitdir:`)
// and its gitdir were exposed the same way.
//
// Now, two independent layers, each proven on its own here:
//   1. policy: writes to `.git/config`, the `.git` file, `.gitattributes`
//      and a gitdir target are denied (`git_metadata`); the hook script
//      itself (an ordinary file) is still written, so the denial is what
//      stops the chain; a second read-only run executes nothing.
//   2. executor env: even a HOSTILE repo config planted directly by the
//      test (a user-owned repo) does not run its fsmonitor under the
//      executor env (startup status off + `core.fsmonitor=false` pinned),
//      and a sensitivity control that undoes both through the test-only
//      seam DOES run it (the scenario is real); undoing only the startup
//      switch still runs nothing (the pinned keys suffice alone).
//
// SKIPPED BY DEFAULT (spawns the CLI). Requires `git` on PATH.
// Run: SKIPPY_LIVE_CLI_MOCK=1 node --import tsx --test src/tool-authority-git-surface.live-cli.test.ts
//
// FR-SEC-01 / FR-SEC-02 / OQ-22 / M0-G06.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import type { Charter } from './charter.js';
import { executeBoardMissionViaSdk, type ExecuteBoardMissionDeps } from './sdk-board.js';

const LIVE = process.env.SKIPPY_LIVE_CLI_MOCK === '1';

function nativeCliBinary(): string | null {
  try {
    const req = createRequire(import.meta.url);
    const sdkReq = createRequire(req.resolve('@anthropic-ai/claude-agent-sdk'));
    const ext = process.platform === 'win32' ? '.exe' : '';
    const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
    for (const cand of [`${pkg}/claude${ext}`, `${pkg}-musl/claude${ext}`]) {
      try {
        const p = sdkReq.resolve(cand);
        if (fs.existsSync(p)) return p;
      } catch {
        /* next */
      }
    }
  } catch {
    /* none */
  }
  return null;
}

function haveGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const CLI = LIVE ? nativeCliBinary() : null;
const skip = !LIVE ? 'set SKIPPY_LIVE_CLI_MOCK=1 to run against the bundled CLI' : !CLI ? 'no native CLI binary for this platform' : !haveGit() ? 'git is not on PATH' : false;

const MAIN_MARK = 'MOCKMARK-gitsurf';

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
let results: ToolResult[] = [];
let server: http.Server | undefined;
let tmp = '';
let wt = '';
let wt2 = '';
let marker = '';
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR'] as const;

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
      ev('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      ev('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
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
      const hasToolResult = Array.isArray(last?.content) && (last.content as Array<{ type?: string }>).some((b) => b.type === 'tool_result');
      const isMain = (j.tools ?? []).length > 0 && JSON.stringify(j.system ?? '').includes(MAIN_MARK);
      const id = `msg_${++n}`;
      if (isMain && !hasToolResult && scenario.length > 0) {
        sse(res, j.model, id, scenario.map((t, i) => ({ type: 'tool_use', id: `toolu_m_${i}_${++n}`, name: t.name, input: t.input })), 'tool_use');
      } else {
        sse(res, j.model, id, [{ type: 'text', text: isMain ? 'All done, monkeys! Magnificent.' : 'Title' }], 'end_turn');
      }
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(os.tmpdir(), 'nonexistent-gitconfig') } });

/** A hook script that appends a line to the marker (outside every root). */
function hookScript(label: string): string {
  return `#!/bin/sh\necho "${label} ran pid=$$" >> "${marker.split(path.sep).join('/')}"\nexit 1\n`;
}

before(async () => {
  if (skip) return;
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'skippy-gitsurf-live-')));
  const outside = path.join(tmp, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  marker = path.join(outside, 'PWNED_BY_FSMONITOR.txt');
  // wt: an ordinary repo with one commit.
  wt = path.join(tmp, 'wt');
  fs.mkdirSync(wt, { recursive: true });
  git(wt, 'init', '-q');
  fs.writeFileSync(path.join(wt, 'a.txt'), 'hello\n');
  git(wt, 'add', 'a.txt');
  git(wt, '-c', 'user.email=x@y', '-c', 'user.name=x', 'commit', '-qm', 'init');
  // wt2: a worktree whose `.git` is a FILE pointing at `.g2` inside the root.
  wt2 = path.join(tmp, 'wt2');
  fs.mkdirSync(wt2, { recursive: true });
  fs.cpSync(path.join(wt, '.git'), path.join(wt2, '.g2'), { recursive: true });
  fs.writeFileSync(path.join(wt2, '.git'), 'gitdir: .g2\n');
  fs.writeFileSync(path.join(wt2, 'a.txt'), 'hello\n');
  server = await startMock();
  const port = (server.address() as AddressInfo).port;
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  Object.assign(process.env, {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_API_KEY: 'sk-ant-fake-000',
    CLAUDE_CONFIG_DIR: path.join(tmp, 'cfg'),
  });
});

after(async () => {
  if (skip) return;
  server?.close();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
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

const charter = (tools: string[], mode: string): Charter => ({
  agentId: 'board.coding',
  frontmatter: { permission_mode: mode, tools },
  body: 'synthetic',
  loaded: true,
  path: '(synthetic)',
});

async function run(root: string, tools: string[], mode: string, calls: ToolUse[], deps: ExecuteBoardMissionDeps = {}): Promise<{ status: string; results: ToolResult[] }> {
  scenario = calls;
  results = [];
  const r = await executeBoardMissionViaSdk(
    {
      boardId: 'coding',
      systemPrompt: `${MAIN_MARK} You are the Coding Board Captain.`,
      model: 'claude-sonnet-4-6' as never,
      missionBrief: 'do the thing',
      charter: charter(tools, mode),
      worktreePath: root,
      maxTurns: 4,
    },
    deps,
  );
  return { status: r.status, results: [...results] };
}

const markerText = (): string => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '');
const byIndex = (rs: ToolResult[], i: number): ToolResult | undefined => rs.find((r) => r.id.startsWith(`toolu_m_${i}_`));

test('live CLI (D-A, policy): a board cannot write .git/config, the .git file, .gitattributes or a gitdir target; the next read-only run executes nothing', { skip, timeout: 300_000 }, async () => {
  fs.rmSync(marker, { force: true });
  const configBefore = fs.readFileSync(path.join(wt, '.git', 'config'), 'utf8');
  const hostileConfig = `${configBefore}[core]\n\tfsmonitor = ${path.join(wt, 'fsm.sh').split(path.sep).join('/')}\n`;
  // Run 1 (acceptEdits, Write): the ordinary file goes through, every git
  // metadata target is denied. `.git/config` is Read first (reads stay
  // allowed) because the CLI's own Write/Edit input validation ("read it
  // first") runs BEFORE the permission gate for an existing file and would
  // otherwise mask the policy denial.
  const r1 = await run(wt, ['Read', 'Write', 'Edit'], 'acceptEdits', [
    { name: 'Read', input: { file_path: path.join(wt, '.git', 'config') } },
    { name: 'Write', input: { file_path: path.join(wt, 'fsm.sh'), content: hookScript('fsmonitor') } },
    { name: 'Write', input: { file_path: path.join(wt, '.git', 'config'), content: hostileConfig } },
    { name: 'Write', input: { file_path: path.join(wt, '.gitattributes'), content: '* filter=evil\n' } },
    { name: 'Edit', input: { file_path: path.join(wt, '.git', 'config'), old_string: '[core]', new_string: '[core]\n\tfsmonitor = true' } },
    { name: 'Write', input: { file_path: path.join(wt, '.git', 'hooks', 'post-index-change'), content: hookScript('hook') } },
    { name: 'Write', input: { file_path: path.join(wt, 'sub', '.git'), content: `gitdir: ${path.join(wt2, '.g2').split(path.sep).join('/')}\n` } },
  ]);
  assert.equal(r1.results.length, 7, JSON.stringify(r1.results));
  const read = byIndex(r1.results, 0);
  assert.ok(read && !read.isError, `reading .git/config is allowed: ${JSON.stringify(read)}`);
  const script = byIndex(r1.results, 1);
  assert.ok(script && !script.isError, `the ordinary file was written: ${JSON.stringify(script)}`);
  assert.ok(fs.existsSync(path.join(wt, 'fsm.sh')));
  for (const i of [2, 3, 4, 5, 6]) {
    const r = byIndex(r1.results, i);
    assert.ok(r, `result ${i}`);
    assert.match(r.content, /Denied by Skippy tool policy \(git_metadata\)/, `call ${i}: ${r.content}`);
  }
  assert.equal(r1.status, 'blocked');
  assert.equal(fs.existsSync(path.join(wt, 'sub', '.git')), false, 'no new .git entry');
  assert.equal(fs.readFileSync(path.join(wt, '.git', 'config'), 'utf8'), configBefore, '.git/config is unchanged');
  assert.ok(fs.statSync(path.join(wt, '.git')).isDirectory(), '.git is still the directory');
  assert.equal(fs.existsSync(path.join(wt, '.gitattributes')), false);
  assert.equal(fs.existsSync(path.join(wt, '.git', 'hooks', 'post-index-change')), false);
  // wt2: the gitdir a `.git` FILE points to is unwritable as well.
  const g2Before = fs.readFileSync(path.join(wt2, '.g2', 'config'), 'utf8');
  const r2 = await run(wt2, ['Read', 'Write'], 'acceptEdits', [
    { name: 'Read', input: { file_path: path.join(wt2, '.git') } },
    { name: 'Read', input: { file_path: path.join(wt2, '.g2', 'config') } },
    { name: 'Write', input: { file_path: path.join(wt2, '.g2', 'config'), content: hostileConfig } },
    { name: 'Write', input: { file_path: path.join(wt2, '.git'), content: `gitdir: ${path.join(wt, '.git').split(path.sep).join('/')}\n` } },
    { name: 'Write', input: { file_path: path.join(wt2, 'b.txt'), content: 'fine\n' } },
  ]);
  assert.equal(r2.results.length, 5, JSON.stringify(r2.results));
  assert.ok(byIndex(r2.results, 0) && !byIndex(r2.results, 0)?.isError, 'reading the .git file is allowed');
  assert.ok(byIndex(r2.results, 1) && !byIndex(r2.results, 1)?.isError, 'reading the gitdir config is allowed');
  assert.match(byIndex(r2.results, 2)?.content ?? '', /Denied by Skippy tool policy \(git_metadata\)/, JSON.stringify(byIndex(r2.results, 2)));
  assert.match(byIndex(r2.results, 3)?.content ?? '', /Denied by Skippy tool policy \(git_metadata\)/, JSON.stringify(byIndex(r2.results, 3)));
  assert.ok(byIndex(r2.results, 4) && !byIndex(r2.results, 4)?.isError, JSON.stringify(byIndex(r2.results, 4)));
  assert.ok(fs.existsSync(path.join(wt2, 'b.txt')));
  assert.equal(fs.readFileSync(path.join(wt2, '.g2', 'config'), 'utf8'), g2Before, 'the gitdir config is unchanged');
  assert.equal(fs.readFileSync(path.join(wt2, '.git'), 'utf8'), 'gitdir: .g2\n', 'the .git file is unchanged');
  // Run 3: a read-only board, zero tool calls, same worktree. Nothing ran.
  const r3 = await run(wt, ['Read'], 'ask', []);
  assert.equal(r3.status, 'succeeded', JSON.stringify(r3));
  assert.equal(markerText(), '', 'no fsmonitor/hook executed across runs');
});

test('live CLI (D-A, env): a HOSTILE repo config planted directly (fsmonitor + hooksPath) executes nothing under the executor env; the sensitivity control proves the scenario is real', { skip, timeout: 300_000 }, async () => {
  fs.rmSync(marker, { force: true });
  // The user's own repo carries the hostile configuration (not board-written).
  fs.writeFileSync(path.join(wt, 'fsm.sh'), hookScript('fsmonitor'));
  const hooks = path.join(tmp, 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  for (const h of ['post-index-change', 'pre-auto-gc', 'post-checkout', 'reference-transaction']) fs.writeFileSync(path.join(hooks, h), hookScript(h));
  const cfg = path.join(wt, '.git', 'config');
  const original = fs.readFileSync(cfg, 'utf8');
  fs.writeFileSync(
    cfg,
    `${original}[core]\n\tfsmonitor = ${path.join(wt, 'fsm.sh').split(path.sep).join('/')}\n\thooksPath = ${hooks.split(path.sep).join('/')}\n`,
  );
  // Make the tree dirty so status has work to do.
  fs.writeFileSync(path.join(wt, 'a.txt'), 'hello2\n');
  try {
    // Proof that git honours the planted config here (outside the executor).
    execFileSync('git', ['--no-optional-locks', 'status', '--short'], { cwd: wt, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
    assert.match(markerText(), /fsmonitor ran/, 'a plain git status runs the planted fsmonitor (control)');
    fs.rmSync(marker, { force: true });

    // 1. The executor env: nothing runs.
    const r1 = await run(wt, ['Read'], 'ask', []);
    assert.equal(r1.status, 'succeeded', JSON.stringify(r1));
    assert.equal(markerText(), '', 'the executor env neutralised the hostile config');

    // 2. Sensitivity control: undo BOTH layers through the test-only seam
    //    (startup status back on, config overrides off) -> the CLI's own
    //    startup git status runs the planted fsmonitor.
    const r2 = await run(wt, ['Read'], 'ask', [], { executorEnvOverrides: { CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '0', GIT_CONFIG_COUNT: '0' } });
    assert.equal(r2.status, 'succeeded', JSON.stringify(r2));
    assert.match(markerText(), /fsmonitor ran/, 'with the neutralisation undone the CLI startup status DOES execute the repo config (so the assertion above is not vacuous)');
    fs.rmSync(marker, { force: true });

    // 3. Only the startup switch undone: the pinned keys alone suffice.
    const r3 = await run(wt, ['Read'], 'ask', [], { executorEnvOverrides: { CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '0' } });
    assert.equal(r3.status, 'succeeded', JSON.stringify(r3));
    assert.equal(markerText(), '', 'GIT_CONFIG_COUNT overrides alone keep the fsmonitor off even when the CLI runs its startup status');
  } finally {
    fs.writeFileSync(cfg, original);
  }
});
