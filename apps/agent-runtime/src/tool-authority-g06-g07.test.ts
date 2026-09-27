// tool-authority-g06-g07.test.ts — M0-G06 / M0-G07 regressions (FR-SEC-01,
// FR-SEC-02, OQ-18, G0). Offline and portable (Linux + Windows).
//
// G06: the options handed to the SDK's `query()` (captured through a fake
// `loadSdk`) carry an explicit, allowlisted `env` — the embedded rg is forced
// (`USE_BUILTIN_RIPGREP=1`) and nothing ambient that can change tool
// behaviour (RIPGREP_CONFIG_PATH, CLAUDE_CODE_* toggles, CLAUDE_CONFIG_DIR,
// SHELL, proxy/CA, NODE_OPTIONS, …) survives, even when set in `process.env`.
// The live counterpart is tool-authority-g06.live-cli.test.ts.
//
// G07: an audit observer (`onDecision`) that throws never changes a decision,
// and any unexpected error inside a gate is an explicit deny / withheld
// output — never the `{}` the CLI treats as "no objection".
//
// Run: node --import tsx --test src/tool-authority-g06-g07.test.ts

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Charter } from './charter.js';
import {
  EXECUTOR_ENV_ALLOWLIST,
  buildClaudeExecutorEnv,
  createExecutorConfigDir,
  removeExecutorConfigDir,
} from './executor-env.js';
import { executeBoardMissionViaSdk, type ClaudeAgentSdkModule } from './sdk-board.js';
import { authorizeMcpDispatch, buildClaudeSdkPermissionOptions, derivePolicy } from './tool-policy.js';

const created: string[] = [];
after(() => {
  for (const d of created) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** A worktree on the canonical long temp path holding a dummy `.env`. */
function worktree(): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'skippy-g06g07-')));
  created.push(dir);
  const wt = path.join(dir, 'wt');
  fs.mkdirSync(path.join(wt, 'src'), { recursive: true });
  fs.writeFileSync(path.join(wt, '.env'), 'PLACEHOLDER_DUMMY\n');
  fs.writeFileSync(path.join(wt, 'src', 'a.ts'), 'PLACEHOLDER\n');
  return wt;
}

const charter = (tools: string[] = ['Read', 'Grep', 'Glob']): Charter => ({
  agentId: 'board.coding',
  frontmatter: { permission_mode: 'ask', tools },
  body: 'synthetic',
  loaded: true,
  path: '(synthetic)',
});

const signal = new AbortController().signal;
type HookFn = (input: unknown, toolUseID: string | undefined, o: { signal: AbortSignal }) => Promise<unknown>;
type Hooks = Record<string, Array<{ hooks: HookFn[] }> | undefined>;

const success = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'All done, monkeys! Magnificent.',
  stop_reason: 'end_turn',
  terminal_reason: 'completed',
  permission_denials: [],
};

// ── G06: the env handed to query() ───────────────────────────────────────────

/** Ambient variables a user or another tool may have set; none may reach the
 * executor's CLI. Values are dummies. */
const HOSTILE: Record<string, string> = {
  USE_BUILTIN_RIPGREP: '0',
  RIPGREP_CONFIG_PATH: path.join(os.tmpdir(), 'rgfollow.cfg'),
  CLAUDE_CONFIG_DIR: path.join(os.tmpdir(), 'someone-elses-claude'),
  CLAUDE_CODE_USE_BEDROCK: '1',
  CLAUDE_CODE_USE_POWERSHELL_TOOL: '1',
  CLAUDE_CODE_SHELL: '/bin/evil',
  CLAUDE_CODE_SHELL_PREFIX: 'evil',
  CLAUDE_CODE_GLOB_TIMEOUT_SECONDS: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '0',
  EMBEDDED_SEARCH_TOOLS: '1',
  ANTHROPIC_MODEL: 'claude-evil',
  ANTHROPIC_CUSTOM_HEADERS: 'x-evil: 1',
  ANTHROPIC_AUTH_TOKEN: 'dummy-token',
  SHELL: '/bin/evil',
  NODE_OPTIONS: '--require=evil.js',
  NODE_EXTRA_CA_CERTS: path.join(os.tmpdir(), 'evil-ca.pem'),
  HTTPS_PROXY: 'http://127.0.0.1:9',
  https_proxy: 'http://127.0.0.1:9',
  GIT_DIR: path.join(os.tmpdir(), 'evil.git'),
  GIT_CONFIG_GLOBAL: path.join(os.tmpdir(), 'evil.gitconfig'),
  GITHUB_TOKEN: 'dummy-gh',
  AWS_SECRET_ACCESS_KEY: 'dummy-aws',
  MAX_MCP_OUTPUT_TOKENS: '1',
  BASH_MAX_OUTPUT_LENGTH: '1',
  DEBUG: '1',
  SKIPPY_G06_SENTINEL: 'x',
};
const FORCED: Record<string, string> = { USE_BUILTIN_RIPGREP: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };

test('G06: query() gets an explicit allowlisted env that forces the embedded rg and drops ambient tool/authority variables', async () => {
  const wt = worktree();
  const saved: Record<string, string | undefined> = {};
  const set = { ...HOSTILE, ANTHROPIC_API_KEY: 'sk-ant-dummy-000', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' };
  for (const k of Object.keys(set)) saved[k] = process.env[k];
  Object.assign(process.env, set);
  let options: Record<string, unknown> | undefined;
  try {
    const query = ((args: { options: Record<string, unknown> }) => {
      options = args.options;
      return (async function* () {
        yield await Promise.resolve(success);
      })();
    }) as unknown as ClaudeAgentSdkModule['query'];
    const r = await executeBoardMissionViaSdk(
      { boardId: 'coding', systemPrompt: 'x', model: 'claude-sonnet-4-6' as never, missionBrief: 'm', charter: charter(), worktreePath: wt },
      { loadSdk: () => Promise.resolve({ query }) },
    );
    assert.equal(r.status, 'succeeded', JSON.stringify(r));
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  assert.ok(options, 'query() was called');
  const env = options['env'] as Record<string, string> | undefined;
  assert.ok(env && typeof env === 'object', `options.env is explicit (the SDK REPLACES the CLI env with it): ${JSON.stringify(env)}`);
  for (const [k, v] of Object.entries(FORCED)) assert.equal(env[k], v, `${k} is forced`);
  assert.notEqual(env['CLAUDE_CONFIG_DIR'], HOSTILE['CLAUDE_CONFIG_DIR'], 'CLAUDE_CONFIG_DIR is the runtime-owned directory');
  assert.ok(path.isAbsolute(env['CLAUDE_CONFIG_DIR'] ?? ''), 'CLAUDE_CONFIG_DIR is absolute');
  assert.equal(fs.existsSync(env['CLAUDE_CONFIG_DIR'] ?? ''), false, 'the per-execution config dir is gone after the run (D1)');
  const upper = new Map(Object.entries(env).map(([k, v]) => [k.toUpperCase(), v]));
  for (const k of Object.keys(HOSTILE)) {
    const K = k.toUpperCase();
    if (K in FORCED || K === 'CLAUDE_CONFIG_DIR') continue;
    assert.equal(upper.has(K), false, `${k} must not reach the executor (got ${upper.get(K)})`);
  }
  // Every key is either allowlisted or forced.
  const allowed = new Set([...EXECUTOR_ENV_ALLOWLIST, ...Object.keys(FORCED), 'CLAUDE_CONFIG_DIR'].map((k) => k.toUpperCase()));
  for (const k of Object.keys(env)) assert.ok(allowed.has(k.toUpperCase()), `unexpected executor env key ${k}`);
  // What the executor needs is still there.
  assert.equal(env['ANTHROPIC_API_KEY'], 'sk-ant-dummy-000');
  assert.equal(env['ANTHROPIC_BASE_URL'], 'http://127.0.0.1:1');
  assert.equal(upper.get('PATH'), process.env.PATH, 'PATH is carried');
});

test('G06: buildClaudeExecutorEnv folds case on Windows only and emits the canonical spelling', async () => {
  const src = { Path: 'P', systemroot: 'S', ripgrep_config_path: 'R', use_builtin_ripgrep: '0', HOME: 'H' };
  const cfg = createExecutorConfigDir();
  try {
    const win = buildClaudeExecutorEnv(src, cfg, undefined, 'win32');
    assert.equal(win['PATH'], 'P');
    assert.equal(win['SystemRoot'], 'S');
    assert.equal(win['HOME'], 'H');
    assert.equal(win['USE_BUILTIN_RIPGREP'], '1');
    assert.equal(win['CLAUDE_CONFIG_DIR'], cfg);
    assert.deepEqual(
      Object.keys(win).filter((k) => /ripgrep_config|^path$|^systemroot$|^use_builtin_ripgrep$/.test(k)),
      [],
      'no source-cased duplicate or dropped key survives',
    );
    const posix = buildClaudeExecutorEnv(src, cfg, undefined, 'linux');
    assert.equal(posix['PATH'], undefined, 'POSIX environments are case-sensitive: `Path` is not PATH');
    assert.equal(posix['HOME'], 'H');
    assert.equal(posix['USE_BUILTIN_RIPGREP'], '1');
    assert.equal(Object.hasOwn(posix, 'ripgrep_config_path'), false);
  } finally {
    assert.equal(await removeExecutorConfigDir(cfg), true);
  }
});

// ── G07: a throwing observer never changes a decision ────────────────────────

const boom = (): never => {
  throw new Error('observer boom');
};

test('G07: a throwing onDecision still denies Read of a credential in the PreToolUse hook and canUseTool', async () => {
  const wt = worktree();
  const policy = derivePolicy(charter(['Read']), { worktreePath: wt });
  const opts = buildClaudeSdkPermissionOptions(policy, { onDecision: boom });
  const hook = (opts.hooks.PreToolUse?.[0]?.hooks[0]) as unknown as HookFn;
  const input = { file_path: path.join(wt, '.env') };
  const out = (await hook(
    { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: input, tool_use_id: 'tu1', session_id: 's', transcript_path: '', cwd: wt },
    'tu1',
    { signal },
  )) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
  assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny', JSON.stringify(out));
  assert.match(out.hookSpecificOutput?.permissionDecisionReason ?? '', /credential_path/);

  const r = await opts.canUseTool('Read', input, { signal, toolUseID: 'tu2', suggestions: [] } as never);
  assert.equal(r.behavior, 'deny', JSON.stringify(r));

  // An allowed call stays allowed: the observer error changes nothing.
  const ok = await opts.canUseTool('Read', { file_path: path.join(wt, 'src', 'a.ts') }, { signal, toolUseID: 'tu3', suggestions: [] } as never);
  assert.equal(ok.behavior, 'allow', JSON.stringify(ok));

  // A rejected promise from an async observer is contained too (no unhandled rejection).
  const asyncOpts = buildClaudeSdkPermissionOptions(policy, { onDecision: (() => Promise.reject(new Error('async boom'))) as never });
  const asyncHook = asyncOpts.hooks.PreToolUse?.[0]?.hooks[0] as unknown as HookFn;
  const out2 = (await asyncHook(
    { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: input, tool_use_id: 'tu4', session_id: 's', transcript_path: '', cwd: wt },
    'tu4',
    { signal },
  )) as { hookSpecificOutput?: { permissionDecision?: string } };
  assert.equal(out2.hookSpecificOutput?.permissionDecision, 'deny');
});

test('G07: an unexpected error inside the gates fails closed (explicit deny / withheld output), never `{}`', async () => {
  const wt = worktree();
  const policy = derivePolicy(charter(), { worktreePath: wt });
  const opts = buildClaudeSdkPermissionOptions(policy);
  const pre = opts.hooks.PreToolUse?.[0]?.hooks[0] as unknown as HookFn;
  const exploding = {
    hook_event_name: 'PreToolUse',
    tool_name: 'Read',
    tool_use_id: 'tu5',
    get tool_input(): unknown {
      throw new Error('hostile input');
    },
  };
  const out = (await pre(exploding, 'tu5', { signal })) as { hookSpecificOutput?: { permissionDecision?: string } };
  assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny', JSON.stringify(out));

  const post = opts.hooks.PostToolUse?.[0]?.hooks[0] as unknown as HookFn;
  const res = {
    hook_event_name: 'PostToolUse',
    tool_name: 'Glob',
    tool_input: { pattern: '*' },
    tool_response: {
      durationMs: 1,
      numFiles: 1,
      truncated: false,
      get filenames(): unknown {
        throw new Error('hostile output');
      },
    },
  };
  const withheld = (await post(res, 'tu6', { signal })) as { hookSpecificOutput?: { updatedToolOutput?: unknown } };
  assert.deepEqual(withheld.hookSpecificOutput?.updatedToolOutput, { durationMs: 0, numFiles: 0, filenames: [], truncated: false });

  const r = await opts.canUseTool('Read', { file_path: path.join(wt, 'src', 'a.ts') }, null as never);
  assert.equal(r.behavior, 'deny', JSON.stringify(r));
});

test('G07: authorizeMcpDispatch returns the decision even when onDecision throws', async () => {
  const policy = derivePolicy({ ...charter(), frontmatter: { mcp_servers: ['obsidian'] } }, {});
  const d = await authorizeMcpDispatch(policy, 'letta', 'letta_search_archival', { query: 'x' }, { onDecision: boom });
  assert.equal(d.allow, false, JSON.stringify(d));
  assert.equal(d.allow === false && d.code, 'mcp_server_not_allowed');
});

test('G07 end to end: a throwing observer yields a PreToolUse deny, no tool output and a blocked run', async () => {
  const wt = worktree();
  const toolOutputs: string[] = [];
  const hookOutputs: unknown[] = [];
  const query = ((args: { options: Record<string, unknown> }) => {
    const hooks = args.options['hooks'] as Hooks;
    return (async function* () {
      // What the CLI does for an auto-approved Read: run every PreToolUse hook;
      // a thrown hook becomes `{}` (fail open) and canUseTool is not consulted.
      let deniedByHook = false;
      for (const m of hooks['PreToolUse'] ?? []) {
        for (const h of m.hooks) {
          let out: unknown = {};
          try {
            out = await h(
              { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(wt, '.env') }, tool_use_id: 'tu7' },
              'tu7',
              { signal },
            );
          } catch {
            out = {};
          }
          hookOutputs.push(out);
          const d = (out as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision;
          if (d === 'deny') deniedByHook = true;
        }
      }
      if (!deniedByHook) toolOutputs.push(fs.readFileSync(path.join(wt, '.env'), 'utf8'));
      yield success;
    })();
  }) as unknown as ClaudeAgentSdkModule['query'];
  const r = await executeBoardMissionViaSdk(
    {
      boardId: 'coding',
      systemPrompt: 'x',
      model: 'claude-sonnet-4-6' as never,
      missionBrief: 'm',
      charter: charter(['Read']),
      worktreePath: wt,
      enforcement: { onDecision: (e) => (e.decision.allow ? undefined : boom()) },
    },
    { loadSdk: () => Promise.resolve({ query }) },
  );
  assert.deepEqual(toolOutputs, [], 'no tool output reached the model');
  assert.equal(
    (hookOutputs[0] as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision,
    'deny',
    JSON.stringify(hookOutputs),
  );
  assert.equal(r.status, 'blocked', JSON.stringify(r));
});
