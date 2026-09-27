// tool-authority-ec2.live-cli.test.ts — M0 EC2 closure against the REAL
// bundled Claude Code CLI (@anthropic-ai/claude-agent-sdk 0.3.162 / CLI
// 2.1.162) and a local mock of the Anthropic Messages API (SSE). No network,
// no real key.
//
// It captures the exact argv and cwd the CLI hands rg for each Glob / Grep
// call — via a tiny logging `rg.exe` shim compiled with `rustc` and selected
// with the CLI's own `USE_BUILTIN_RIPGREP=0` switch (system rg from PATH;
// injected through the test-only `executorEnvOverrides`, since the
// executor's scrubbed env otherwise forces the embedded rg — M0-G06) —
// and asserts that `cliGlobSplit` (Glob) and `interpretToolPath` (Grep)
// compute the same search path (rg's LAST positional argument, the tree it
// walks), the same `--glob`, and that rg's cwd is the session cwd. It also
// replays the r4v2 p1 repro: G1/G2 are denied BEFORE rg runs (no shim record)
// and the G3 control reaches rg with the narrowed tree.
//
// SKIPPED BY DEFAULT (spawns the CLI; needs `rustc` on PATH for the shim).
// Run: SKIPPY_LIVE_CLI_MOCK=1 node --import tsx --test src/tool-authority-ec2.live-cli.test.ts
//
// FR-SEC-01 / FR-SEC-02 / G0 / OQ-18.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import type { Charter } from './charter.js';
import { executeBoardMissionViaSdk } from './sdk-board.js';
import * as policyMod from './tool-policy.js';
import { interpretToolPath } from './tool-policy.js';

const LIVE = process.env.SKIPPY_LIVE_CLI_MOCK === '1';
const HAVE_RUSTC = LIVE && spawnSync('rustc', ['--version'], { stdio: 'ignore' }).status === 0;
const skip = !LIVE
  ? 'set SKIPPY_LIVE_CLI_MOCK=1 to run against the bundled CLI'
  : process.platform !== 'win32'
    ? 'Windows path semantics'
    : !HAVE_RUSTC
      ? 'rustc is needed to build the rg logging shim'
      : false;

type Split = { baseDir: string; relativePattern: string };
const cliGlobSplit = (policyMod as unknown as { cliGlobSplit?: (pattern: string, pathArg: string | undefined, cwd: string) => Split })
  .cliGlobSplit;

const MAIN_MARK = 'MOCKMARK-board';

interface ToolUse {
  name: string;
  input: Record<string, unknown>;
}
interface RgRecord {
  cwd: string;
  argv: string[];
}

/** Tool calls issued ONE per model turn, so rg invocations log in order. */
let scenario: ToolUse[] = [];
let server: http.Server | undefined;
let tmp = '';
let shimLog = '';
const savedEnv: Record<string, string | undefined> = {};
const ENV_OVERRIDES = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'DISABLE_TELEMETRY',
  'DISABLE_AUTOUPDATER',
  'DISABLE_ERROR_REPORTING',
  'USE_BUILTIN_RIPGREP',
  'SKIPPY_RG_SHIM_LOG',
  'PATH',
] as const;

const fwd = (p: string): string => p.replace(/\\/g, '/');

/** Logs `{cwd, argv}` as one JSON line to $SKIPPY_RG_SHIM_LOG and exits 1
 * ("no matches"). */
const SHIM_RS = String.raw`use std::io::Write;
fn esc(s: &str) -> String {
    let mut o = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}
fn main() {
    let args: Vec<String> = std::env::args_os().skip(1).map(|a| a.to_string_lossy().into_owned()).collect();
    let cwd = std::env::current_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    if let Ok(log) = std::env::var("SKIPPY_RG_SHIM_LOG") {
        let line = format!("{{\"cwd\":{},\"argv\":[{}]}}\n", esc(&cwd), args.iter().map(|a| esc(a)).collect::<Vec<_>>().join(","));
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(log) {
            let _ = f.write_all(line.as_bytes());
        }
    }
    std::process::exit(1);
}
`;

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
      const isMain = (j.tools ?? []).length > 0 && JSON.stringify(j.system ?? '').includes(MAIN_MARK);
      const turn = msgs.filter((m) => m.role === 'assistant').length;
      const id = `msg_${++n}`;
      const next = isMain ? scenario[turn] : undefined;
      if (next) sse(res, j.model, id, [{ type: 'tool_use', id: `toolu_ec2_${turn}_${++n}`, name: next.name, input: next.input }], 'tool_use');
      else sse(res, j.model, id, [{ type: 'text', text: isMain ? 'All done, monkeys! Magnificent.' : 'Title' }], 'end_turn');
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

before(async () => {
  if (skip) return;
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'skippy-ec2-live-')));
  assert.match(tmp, /^[A-Za-z]:\\/, 'the fixture lives on a drive-lettered volume');
  // The shim lives OUTSIDE every worktree (the CLI ignores a PATH hit inside
  // its own cwd).
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(tmp, 'shim.rs'), SHIM_RS);
  const built = spawnSync('rustc', ['-O', path.join(tmp, 'shim.rs'), '-o', path.join(bin, 'rg.exe')], { encoding: 'utf8' });
  assert.equal(built.status, 0, `rg shim build failed: ${built.stderr}`);
  shimLog = path.join(tmp, 'rg-calls.jsonl');
  // clean: no credential entry anywhere; `deep/sub` makes a basename glob
  // `sub` match below the top level.
  writeFiles(path.join(tmp, 'clean'), {
    'sub/ok.txt': 'x\n',
    'deep/sub/ok3.txt': 'x\n',
    'clean/a.ts': 'x\n',
    'clean/deep/b.ts': 'x\n',
    'src/x.ts': 'x\n',
  });
  // p1: the r4v2 repro fixture (dummy credential-named file, no secret).
  writeFiles(path.join(tmp, 'p1'), {
    'sub/ok.txt': 'PLACEHOLDER\n',
    'deep/sub/.env': 'PLACEHOLDER_DUMMY\n',
    'clean/a.ts': 'PLACEHOLDER\n',
  });
  fs.mkdirSync(path.join(tmp, 'cfg'));
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
    USE_BUILTIN_RIPGREP: '0',
    SKIPPY_RG_SHIM_LOG: shimLog,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
  });
});

after(async () => {
  if (skip) return;
  server?.close();
  for (const k of ENV_OVERRIDES) {
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

const charter: Charter = {
  agentId: 'board.coding',
  frontmatter: { permission_mode: 'ask', tools: ['Read', 'Glob', 'Grep'] },
  body: 'synthetic',
  loaded: true,
  path: '(synthetic)',
};

interface Decision {
  via: string;
  tool: string;
  allow: boolean;
  code?: string;
}

async function run(root: string, calls: ToolUse[]): Promise<{ records: RgRecord[]; decisions: Decision[] }> {
  scenario = calls;
  fs.rmSync(shimLog, { force: true });
  const decisions: Decision[] = [];
  await executeBoardMissionViaSdk(
    {
      boardId: 'coding',
      systemPrompt: `${MAIN_MARK} You are the Coding Board Captain.`,
      model: 'claude-sonnet-4-6' as never,
      missionBrief: 'do the thing',
      charter,
      worktreePath: root,
      maxTurns: calls.length + 3,
      enforcement: {
        onDecision: (e) =>
          decisions.push({ via: e.via, tool: e.toolName, allow: e.decision.allow, ...(e.decision.allow ? {} : { code: e.decision.code }) }),
      },
    },
    // The executor env forces the embedded rg (M0-G06); this capture harness
    // deliberately re-selects the logging shim through the test-only seam.
    { executorEnvOverrides: { USE_BUILTIN_RIPGREP: '0', SKIPPY_RG_SHIM_LOG: shimLog } },
  );
  const raw = fs.existsSync(shimLog) ? fs.readFileSync(shimLog, 'utf8') : '';
  const all = raw
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RgRecord);
  // Only the Glob (`--sort=modified`) and Grep (`--max-columns`) invocations;
  // the CLI may also count files with its own `rg --files` at startup.
  const records = all.filter((r) => r.argv.includes('--sort=modified') || r.argv.includes('--max-columns'));  return { records, decisions };
}

const globOf = (r: RgRecord): string | undefined => r.argv[r.argv.indexOf('--glob') + 1];
const searchPathOf = (r: RgRecord): string | undefined => r.argv[r.argv.length - 1];

test('live CLI (EC2): cliGlobSplit / interpretToolPath equal the rg argv + cwd the CLI actually uses', { skip, timeout: 300_000 }, async () => {
  assert.equal(typeof cliGlobSplit, 'function', 'tool-policy exports cliGlobSplit');
  const wt = path.join(tmp, 'clean');
  const drive = wt.charAt(0).toLowerCase();
  const msys = `/${drive}/${fwd(wt.slice(3))}/clean`;
  const globs: Array<Record<string, unknown>> = [
    { pattern: '**/*.ts' },
    { pattern: 'sub' }, // relative, no metachar: rg walks the cwd with --glob sub
    { pattern: '*.ts', path: 'clean' },
    { pattern: 'deep/*.ts', path: `${fwd(wt)}/clean` },
    { pattern: '*', path: path.join(wt, 'clean', 'deep') },
    { pattern: '*', path: msys },
    { pattern: path.join(wt, 'sub') }, // absolute, no metachar: dirname walk
    { pattern: path.join(wt, 'sub', 'ok.txt') },
    { pattern: `${fwd(wt)}/sub/ok.txt` },
    { pattern: `${path.join(wt, 'sub')}\\` },
    { pattern: `${fwd(wt)}/sub/` },
    { pattern: path.join(wt, '{sub,clean}') }, // brace first
    { pattern: `${path.join(wt, '{sub,clean}')}\\*.txt` },
    { pattern: path.join(wt, 'clean', '*.ts') },
    { pattern: `${fwd(wt)}/clean/**/*.ts` },
    { pattern: `${path.join(wt, 'cl?an')}\\deep\\*` }, // wildcard in the middle
    { pattern: path.join(wt, 'clean', '[ab].ts') },
    { pattern: `${fwd(wt)}/./clean/*.ts` },
    { pattern: path.join(wt, 'clean', '*.ts'), path: 'sub' }, // path + absolute pattern
    { pattern: path.join(wt, 'sub'), path: 'clean' },
  ];
  const greps: Array<Record<string, unknown>> = [
    { pattern: 'x' },
    { pattern: 'x', path: 'clean' },
    { pattern: 'x', path: `${fwd(wt)}/clean/` },
    { pattern: 'x', path: path.join(wt, 'clean', 'a.ts') },
    { pattern: 'x', path: '  src  ' },
    { pattern: 'x', path: msys },
  ];
  const calls: ToolUse[] = [...globs.map((input) => ({ name: 'Glob', input })), ...greps.map((input) => ({ name: 'Grep', input }))];
  const { records, decisions } = await run(wt, calls);
  const denials = decisions.filter((d) => !d.allow);
  assert.deepEqual(denials, [], `every capture call passes the gate on the clean fixture: ${JSON.stringify(denials)}`);
  assert.equal(records.length, calls.length, `one rg invocation per call, in order: ${JSON.stringify(records, null, 1)}`);
  const mismatches: string[] = [];
  globs.forEach((input, i) => {
    const rec = records[i] as RgRecord;
    const want = cliGlobSplit?.(input['pattern'] as string, input['path'] as string | undefined, wt);
    const got = { baseDir: searchPathOf(rec), relativePattern: globOf(rec) };
    if (JSON.stringify(want) !== JSON.stringify(got) || rec.cwd.toLowerCase() !== wt.toLowerCase()) {
      mismatches.push(`Glob ${JSON.stringify(input)}: want ${JSON.stringify(want)} (cwd ${wt}), CLI ${JSON.stringify(got)} (cwd ${rec.cwd})`);
    }
  });
  greps.forEach((input, i) => {
    const rec = records[globs.length + i] as RgRecord;
    const r = interpretToolPath((input['path'] as string | undefined) ?? '', wt);
    const want = r.ok ? r.path : `refused: ${r.reason}`;
    if (searchPathOf(rec) !== want || rec.cwd.toLowerCase() !== wt.toLowerCase()) {
      mismatches.push(`Grep ${JSON.stringify(input)}: want ${want} (cwd ${wt}), CLI ${searchPathOf(rec)} (cwd ${rec.cwd})`);
    }
  });
  assert.deepEqual(mismatches, [], mismatches.join('\n'));
});

test('live CLI (EC2 p1): G1/G2 are denied before rg runs; the G3 control reaches rg on the narrowed tree', { skip, timeout: 180_000 }, async () => {
  const wt = path.join(tmp, 'p1');
  const calls: ToolUse[] = [
    { name: 'Glob', input: { pattern: path.join(wt, 'sub') } }, // G1
    { name: 'Glob', input: { pattern: path.join(wt, '{sub,clean}') } }, // G2
    { name: 'Glob', input: { pattern: `${path.join(wt, 'sub')}\\**` } }, // G3 control
  ];
  const { records, decisions } = await run(wt, calls);
  const pre = decisions.filter((d) => d.via === 'PreToolUse');
  assert.equal(pre.length, 3, JSON.stringify(decisions));
  assert.deepEqual(
    pre.map((d) => (d.allow ? 'allow' : d.code)),
    ['credential_path', 'credential_path', 'allow'],
    JSON.stringify(decisions),
  );
  assert.equal(records.length, 1, `only the control reached rg: ${JSON.stringify(records)}`);
  assert.equal(searchPathOf(records[0] as RgRecord), path.join(wt, 'sub'), JSON.stringify(records));
  assert.equal(globOf(records[0] as RgRecord), '**', JSON.stringify(records));
});
