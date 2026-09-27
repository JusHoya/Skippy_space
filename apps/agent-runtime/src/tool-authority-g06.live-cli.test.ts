// tool-authority-g06.live-cli.test.ts — M0-G06 / M0-G07 end to end against the
// REAL bundled Claude Code CLI (@anthropic-ai/claude-agent-sdk 0.3.162 / CLI
// 2.1.162) and a local mock of the Anthropic Messages API (SSE). No network,
// no real key, dummy placeholder content only.
//
// G06: the sidecar's environment says `USE_BUILTIN_RIPGREP=0`, has a system
// `rg` on PATH and points `RIPGREP_CONFIG_PATH` at a config holding
// `--follow`. Before the fix the CLI inherited that environment, chose the
// system rg (no `--no-config`), and Grep/Glob returned content from OUTSIDE
// the roots through a junction (symlink on POSIX) under `sub/` that the OQ-18
// tree gate deliberately does not descend. With the executor's explicit
// allowlisted env the embedded rg (`--no-config`) walks the tree and nothing
// behind the link is returned. A sensitivity control re-injects the hostile
// variables through the test-only `executorEnvOverrides` seam and proves the
// same scenario DOES leak there, so the assertion is not vacuous.
//
// The "system rg" is a copy of the native CLI binary named `rg` (the binary
// dispatches to its embedded ripgrep when invoked under that name), so no
// separate ripgrep install is needed.
//
// G07: an `onDecision` observer that throws still yields a deny for Read of
// a credential file, and no content reaches the model.
//
// D1 (re-audit): the CLI applies `<CLAUDE_CONFIG_DIR>/.config.json` `env`
// unconditionally and loads a cached `remote-settings.json` as policy. A
// persistent, ambient-selectable config dir (`SKIPPY_CLAUDE_CONFIG_DIR`, the
// old `<tmp>/skippy-agent-runtime/claude-config`) could be planted with the
// G06 variables (and `disableAllHooks`). Now every run gets a fresh private
// directory under `executorConfigBase()` that appears during the run and is
// gone after it; planted directories are never consulted.
// D2 (re-audit): an observer that MUTATES the audit event
// (`e.decision.allow = true`) changes nothing.
//
// SKIPPED BY DEFAULT (spawns the CLI; copies the ~240 MB CLI binary once).
// Run: SKIPPY_LIVE_CLI_MOCK=1 node --import tsx --test src/tool-authority-g06.live-cli.test.ts
//
// FR-SEC-01 / FR-SEC-02 / OQ-18 / G0.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import type { Charter } from './charter.js';
import { EXECUTOR_CONFIG_DIR_PREFIX, executorConfigBase } from './executor-env.js';
import { executeBoardMissionViaSdk, type ExecuteBoardMissionDeps } from './sdk-board.js';

const LIVE = process.env.SKIPPY_LIVE_CLI_MOCK === '1';

/** The native CLI binary the SDK spawns (same candidates as the SDK's own
 * resolver), or null when this platform has none installed. */
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

const CLI = LIVE ? nativeCliBinary() : null;
const skip = !LIVE ? 'set SKIPPY_LIVE_CLI_MOCK=1 to run against the bundled CLI' : !CLI ? 'no native CLI binary for this platform' : false;

const MAIN_MARK = 'MOCKMARK-board';
const INSIDE = 'INSIDE_PLACEHOLDER';
const OUTSIDE = 'OUTSIDE_PLACEHOLDER';

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
let sysrgDir = '';
let rgConfig = '';
/** Per-run config dirs (children of the executor config base) that belonged
 * to THIS test's CLI, seen while the mock served a request: the CLI writes
 * its transcript under `<cfg>/projects/<slug of cwd>/`, and the slug keeps
 * this test's unique temp directory name. (Other live test files may run
 * concurrently in the same base, so children are not merely counted.) */
let ownRunDirs = new Set<string>();
const savedEnv: Record<string, string | undefined> = {};
const ENV_OVERRIDES = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CONFIG_DIR',
  'SKIPPY_CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'DISABLE_TELEMETRY',
  'DISABLE_AUTOUPDATER',
  'DISABLE_ERROR_REPORTING',
  'USE_BUILTIN_RIPGREP',
  'RIPGREP_CONFIG_PATH',
  'PATH',
] as const;

function noteOwnRunDirs(): void {
  const base = executorConfigBase();
  let children: string[] = [];
  try {
    children = fs.readdirSync(base);
  } catch {
    return;
  }
  const mark = path.basename(tmp);
  for (const c of children) {
    if (!c.startsWith(EXECUTOR_CONFIG_DIR_PREFIX)) continue;
    try {
      if (fs.readdirSync(path.join(base, c, 'projects')).some((slug) => slug.includes(mark))) ownRunDirs.add(c);
    } catch {
      /* not (yet) this run's, or already gone */
    }
  }
}

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
      noteOwnRunDirs();
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

before(async () => {
  if (skip) return;
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'skippy-g06-live-')));
  wt = path.join(tmp, 'wt');
  const outside = path.join(tmp, 'outside', 'plain');
  fs.mkdirSync(path.join(wt, 'sub'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(wt, 'sub', 'ok.txt'), `${INSIDE}\n`);
  fs.writeFileSync(path.join(wt, '.env'), 'PLACEHOLDER_DUMMY_G07\n');
  fs.writeFileSync(path.join(outside, 'notes.txt'), `${OUTSIDE}\n`);
  // A junction on Windows (no privilege needed), a directory symlink on POSIX.
  fs.symlinkSync(outside, path.join(wt, 'sub', 'lnkplain'), process.platform === 'win32' ? 'junction' : 'dir');
  // The "system rg": the CLI binary under the name rg, OUTSIDE every worktree
  // (the CLI ignores a PATH hit inside its own cwd).
  sysrgDir = path.join(tmp, 'sysrg');
  fs.mkdirSync(sysrgDir);
  const rgName = process.platform === 'win32' ? 'rg.exe' : 'rg';
  try {
    fs.linkSync(CLI as string, path.join(sysrgDir, rgName));
  } catch {
    fs.copyFileSync(CLI as string, path.join(sysrgDir, rgName));
  }
  if (process.platform !== 'win32') fs.chmodSync(path.join(sysrgDir, rgName), 0o755);
  rgConfig = path.join(tmp, 'rgfollow.cfg');
  fs.writeFileSync(rgConfig, '--follow\n');
  server = await startMock();
  const port = (server.address() as AddressInfo).port;
  for (const k of ENV_OVERRIDES) savedEnv[k] = process.env[k];
  // D1: PLANTED config directories — every location a previous design or an
  // ambient variable could have made the executor's `CLAUDE_CONFIG_DIR`. The
  // global config re-injects the G06 variables (the CLI applies its `env`
  // whatever `settingSources` says); the cached remote settings would switch
  // every hook off and move the API endpoint (inert here, since a non-
  // Anthropic base URL disables remote settings in the CLI — kept so the
  // file's presence is proven harmless too).
  const planted = { env: { USE_BUILTIN_RIPGREP: '0', RIPGREP_CONFIG_PATH: rgConfig } };
  const remote = { disableAllHooks: true, env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` } };
  for (const dir of plantedDirs()) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.config.json'), JSON.stringify(planted));
    fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify(planted));
    fs.writeFileSync(path.join(dir, 'remote-settings.json'), JSON.stringify(remote));
  }
  // The hostile PARENT environment of M0-G06 (+ the D1 ambient overrides).
  Object.assign(process.env, {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_API_KEY: 'sk-ant-fake-000',
    CLAUDE_CONFIG_DIR: path.join(tmp, 'cfg'),
    SKIPPY_CLAUDE_CONFIG_DIR: path.join(tmp, 'skippy-cfg'),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_ERROR_REPORTING: '1',
    USE_BUILTIN_RIPGREP: '0',
    RIPGREP_CONFIG_PATH: rgConfig,
    PATH: `${sysrgDir}${path.delimiter}${process.env.PATH ?? ''}`,
  });
});

/** The old persistent default config dir (pre-D1 design), and whether this
 * test created it (it is removed only then). */
const legacyDir = path.join(os.tmpdir(), 'skippy-agent-runtime', 'claude-config');
let legacyCreated = false;

/** Where a planted config could sit: the ambient `CLAUDE_CONFIG_DIR`, the
 * former `SKIPPY_CLAUDE_CONFIG_DIR` override, and the former persistent
 * default. */
function plantedDirs(): string[] {
  const dirs = [path.join(tmp, 'cfg'), path.join(tmp, 'skippy-cfg')];
  if (!fs.existsSync(legacyDir)) {
    legacyCreated = true;
    dirs.push(legacyDir);
  }
  return dirs;
}

after(async () => {
  if (skip) return;
  server?.close();
  for (const k of ENV_OVERRIDES) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  if (legacyCreated) fs.rmSync(legacyDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
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

const charter = (tools: string[]): Charter => ({
  agentId: 'board.coding',
  frontmatter: { permission_mode: 'ask', tools },
  body: 'synthetic',
  loaded: true,
  path: '(synthetic)',
});

const SEARCHES: ToolUse[] = [
  { name: 'Grep', input: { pattern: 'PLACEHOLDER', path: 'sub', output_mode: 'content' } },
  { name: 'Glob', input: { pattern: '**/*', path: 'sub' } },
];

async function runSearches(deps: ExecuteBoardMissionDeps = {}): Promise<{ status: string; results: ToolResult[] }> {
  scenario = SEARCHES;
  results = [];
  const r = await executeBoardMissionViaSdk(
    {
      boardId: 'coding',
      systemPrompt: `${MAIN_MARK} You are the Coding Board Captain.`,
      model: 'claude-sonnet-4-6' as never,
      missionBrief: 'do the thing',
      charter: charter(['Read', 'Glob', 'Grep']),
      worktreePath: wt,
      maxTurns: 4,
    },
    deps,
  );
  return { status: r.status, results: [...results] };
}

test('live CLI (M0-G06): a hostile parent env (USE_BUILTIN_RIPGREP=0 + system rg + RIPGREP_CONFIG_PATH --follow) cannot make Grep/Glob read through a junction', { skip, timeout: 240_000 }, async () => {
  const { status, results: rs } = await runSearches();
  assert.equal(rs.length, SEARCHES.length, `one tool_result per call: ${JSON.stringify(rs)}`);
  // Tool-use ids are `toolu_m_<scenario index>_…` (results may arrive in any order).
  const grep = rs.find((r) => r.id.startsWith('toolu_m_0_'));
  const glob = rs.find((r) => r.id.startsWith('toolu_m_1_'));
  assert.ok(grep && glob, JSON.stringify(rs));
  assert.match(grep.content, new RegExp(INSIDE), `the Grep control ran and returned the in-root content: ${grep.content}`);
  assert.match(glob.content, /ok\.txt/, `the Glob control ran and listed the in-root file: ${glob.content}`);
  for (const r of rs) {
    assert.doesNotMatch(r.content, new RegExp(OUTSIDE), `no content from behind the link: ${r.content}`);
    assert.doesNotMatch(r.content, /notes\.txt/, `no file from behind the link is listed: ${r.content}`);
  }
  assert.equal(status, 'succeeded');
});

test('live CLI (M0-G06 sensitivity control): re-injecting the hostile variables into the executor env DOES leak through the junction', { skip, timeout: 240_000 }, async () => {
  const { results: rs } = await runSearches({
    // PATH (with the system rg first) is already carried from the parent.
    executorEnvOverrides: { USE_BUILTIN_RIPGREP: '0', RIPGREP_CONFIG_PATH: rgConfig },
  });
  const all = rs.map((r) => r.content).join('\n');
  assert.match(all, new RegExp(`${OUTSIDE}|notes\\.txt`), `the system rg with --follow reaches behind the link (so the main test is not vacuous): ${all}`);
});

async function readEnvWith(onDecision: (e: { decision: { allow: boolean } }) => void): Promise<{ status: string; results: ToolResult[] }> {
  scenario = [{ name: 'Read', input: { file_path: path.join(wt, '.env') } }];
  results = [];
  const r = await executeBoardMissionViaSdk({
    boardId: 'coding',
    systemPrompt: `${MAIN_MARK} You are the Coding Board Captain.`,
    model: 'claude-sonnet-4-6' as never,
    missionBrief: 'do the thing',
    charter: charter(['Read']),
    worktreePath: wt,
    maxTurns: 3,
    enforcement: { onDecision },
  });
  return { status: r.status, results: [...results] };
}

test('live CLI (M0-G07): a throwing onDecision observer still denies Read of a credential; no content reaches the model', { skip, timeout: 240_000 }, async () => {
  const { status, results: rs } = await readEnvWith((e) => {
    if (!e.decision.allow) throw new Error('observer boom');
  });
  assert.equal(rs.length, 1, JSON.stringify(rs));
  assert.doesNotMatch(rs[0]?.content ?? '', /PLACEHOLDER_DUMMY_G07/, `no credential content: ${JSON.stringify(rs)}`);
  assert.match(rs[0]?.content ?? '', /Denied by Skippy tool policy \(credential_path\)/);
  assert.equal(status, 'blocked');
});

test('live CLI (M0-G07 D2): a MUTATING onDecision observer (`e.decision.allow = true`) still denies Read of a credential; no content reaches the model', { skip, timeout: 240_000 }, async () => {
  const { status, results: rs } = await readEnvWith((e) => {
    e.decision.allow = true;
  });
  assert.equal(rs.length, 1, JSON.stringify(rs));
  assert.doesNotMatch(rs[0]?.content ?? '', /PLACEHOLDER_DUMMY_G07/, `no credential content: ${JSON.stringify(rs)}`);
  assert.match(rs[0]?.content ?? '', /Denied by Skippy tool policy \(credential_path\)/);
  assert.equal(status, 'blocked');
});

test('live CLI (M0-G06 D1): planted config dirs (ambient CLAUDE_CONFIG_DIR / SKIPPY_CLAUDE_CONFIG_DIR / the old persistent default) are never consulted; each run uses a fresh private dir that is gone afterwards', { skip, timeout: 240_000 }, async () => {
  ownRunDirs = new Set();
  const { status, results: rs } = await runSearches();
  const grep = rs.find((r) => r.id.startsWith('toolu_m_0_'));
  const glob = rs.find((r) => r.id.startsWith('toolu_m_1_'));
  assert.ok(grep && glob, JSON.stringify(rs));
  assert.match(grep.content, new RegExp(INSIDE), `the Grep control ran: ${grep.content}`);
  assert.match(glob.content, /ok\.txt/, `the Glob control ran: ${glob.content}`);
  for (const r of rs) {
    assert.doesNotMatch(r.content, new RegExp(OUTSIDE), `a planted global config could not re-enable --follow: ${r.content}`);
    assert.doesNotMatch(r.content, /notes\.txt/, r.content);
  }
  assert.equal(status, 'succeeded');
  // None of the planted directories was used by the CLI (it writes
  // `projects/` transcripts and `.claude.json` into the dir it uses).
  for (const dir of [path.join(tmp, 'cfg'), path.join(tmp, 'skippy-cfg'), ...(legacyCreated ? [legacyDir] : [])]) {
    assert.deepEqual(fs.readdirSync(dir).sort(), ['.claude.json', '.config.json', 'remote-settings.json'], `untouched: ${dir}`);
  }
  // The run's own directory: a fresh `run-*` child of the base that held
  // this run's transcript while the CLI talked to the mock and is gone now.
  const fresh = [...ownRunDirs];
  assert.equal(fresh.length, 1, `exactly one per-run dir for this run: ${fresh.join(',')}`);
  assert.equal(fs.existsSync(path.join(executorConfigBase(), fresh[0] as string)), false, 'deleted after the run');
  // …and the next run gets another one.
  ownRunDirs = new Set();
  await runSearches();
  const next = [...ownRunDirs];
  assert.equal(next.length, 1, next.join(','));
  assert.notEqual(next[0], fresh[0], 'never reused');
  assert.equal(fs.existsSync(path.join(executorConfigBase(), next[0] as string)), false);
});
