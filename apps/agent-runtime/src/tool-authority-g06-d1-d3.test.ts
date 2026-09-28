// tool-authority-g06-d1-d3.test.ts — M0-G06 / M0-G07 re-audit regressions
// (FR-SEC-01, FR-SEC-02, OQ-18, OQ-22, G0). Offline and portable (Linux +
// Windows; canonical long temp paths).
//
// D1 — the executor's config directory is an environment: the CLI reads
//   `<CLAUDE_CONFIG_DIR>/.config.json` / `.claude.json` (`env` applied
//   unconditionally) and `remote-settings.json` (policy settings, incl.
//   `disableAllHooks`). A persistent shared directory, reachable from a tool
//   root or through the ambient `SKIPPY_CLAUDE_CONFIG_DIR`, let a board
//   rewrite the next run's tool behaviour. Now: a fresh, random, empty,
//   private directory per execution, gone afterwards, outside every root,
//   with no ambient or seam override.
// D2 — `onDecision` observers receive a deep-frozen clone and the gate's
//   output is computed before they run: `e.decision.allow = true` changes
//   nothing.
// D3 — every hook / canUseTool wrapper (raw gate, instrumented, run
//   observers) fails closed on any input, including non-objects and hostile
//   getters: an explicit deny / withheld output, never `{}` or a throw.
//
// Run: node --import tsx --test src/tool-authority-g06-d1-d3.test.ts

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Charter } from './charter.js';
import * as executorEnv from './executor-env.js';
import {
  DenialLedger,
  RunFailureLedger,
  RunStreamObserver,
  TruncatedTurnLedger,
  executeBoardMissionViaSdk,
  instrumentPermissionOptions,
  withRunObservers,
  type ClaudeAgentSdkModule,
} from './sdk-board.js';
import * as toolPolicy from './tool-policy.js';
import { authorizeMcpDispatch, buildClaudeSdkPermissionOptions, derivePolicy, evaluateToolCall } from './tool-policy.js';

const created: string[] = [];
after(() => {
  for (const d of created) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** A worktree on the canonical long temp path holding a dummy `.env`. */
function worktree(): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'skippy-g06d1-')));
  created.push(dir);
  const wt = path.join(dir, 'wt');
  fs.mkdirSync(path.join(wt, 'src'), { recursive: true });
  fs.writeFileSync(path.join(wt, '.env'), 'PLACEHOLDER_DUMMY\n');
  fs.writeFileSync(path.join(wt, 'src', 'a.ts'), 'PLACEHOLDER\n');
  return wt;
}

const charter = (tools: string[] = ['Read', 'Grep', 'Glob'], mode = 'ask'): Charter => ({
  agentId: 'board.coding',
  frontmatter: { permission_mode: mode, tools },
  body: 'synthetic',
  loaded: true,
  path: '(synthetic)',
});

const signal = new AbortController().signal;
type HookFn = (input: unknown, toolUseID: string | undefined, o: { signal: AbortSignal }) => Promise<unknown>;
type Hooks = Record<string, Array<{ hooks: HookFn[] }> | undefined>;
type Pre = { hookSpecificOutput?: { hookEventName?: string; permissionDecision?: string; permissionDecisionReason?: string } };
type Post = { hookSpecificOutput?: { hookEventName?: string; updatedToolOutput?: unknown; additionalContext?: string } };

const success = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'All done, monkeys! Magnificent.',
  stop_reason: 'end_turn',
  terminal_reason: 'completed',
  permission_denials: [],
};

const mission = (wt: string, tools: string[] = ['Read'], extra: Record<string, unknown> = {}) => ({
  boardId: 'coding',
  systemPrompt: 'x',
  model: 'claude-sonnet-4-6' as never,
  missionBrief: 'm',
  charter: charter(tools),
  worktreePath: wt,
  ...extra,
});

/** A fake SDK whose `query()` hands the captured options to `body` before
 * yielding `success` (or whatever `body` returns). */
function fakeSdk(body: (options: Record<string, unknown>) => Promise<unknown[]> | unknown[]): {
  loadSdk: () => Promise<ClaudeAgentSdkModule>;
  options: () => Record<string, unknown>;
} {
  let captured: Record<string, unknown> | undefined;
  const query = ((args: { options: Record<string, unknown> }) => {
    captured = args.options;
    return (async function* () {
      for (const m of await body(args.options)) yield m;
    })();
  }) as unknown as ClaudeAgentSdkModule['query'];
  return { loadSdk: () => Promise.resolve({ query }), options: () => captured ?? assert.fail('query() was not called') };
}

const cfgOf = (o: Record<string, unknown>): string => (o['env'] as Record<string, string>)['CLAUDE_CONFIG_DIR'] as string;

/** Every file the CLI 2.1.162 reads for env / settings / policy / hooks /
 * customisation under `CLAUDE_CONFIG_DIR` (verified in cli.js; see
 * executor-env.ts). */
const CLI_CONFIG_FILES = [
  '.config.json',
  '.claude.json',
  'remote-settings.json',
  'settings.json',
  'settings.local.json',
  'managed-settings.json',
  'keybindings.json',
  '.credentials.json',
  'CLAUDE.md',
  'agents',
  'skills',
  'commands',
  'plugins',
  'rules',
  'projects',
];

// ── D1: an ephemeral, private, validated config directory per run ───────────

test('D1: each run gets a fresh, empty, random config dir under the runtime base, present during the run and gone after it', async () => {
  const wt = worktree();
  const base = executorEnv.executorConfigBase();
  const seen: Array<{ dir: string; entries: string[]; parent: string }> = [];
  const sdk = fakeSdk((o) => {
    const dir = cfgOf(o);
    seen.push({ dir, entries: fs.readdirSync(dir), parent: fs.realpathSync.native(path.dirname(dir)) });
    return [success];
  });
  for (let i = 0; i < 2; i++) {
    const r = await executeBoardMissionViaSdk(mission(wt), { loadSdk: sdk.loadSdk });
    assert.equal(r.status, 'succeeded', JSON.stringify(r));
  }
  assert.equal(seen.length, 2);
  const [a, b] = seen as [(typeof seen)[0], (typeof seen)[0]];
  assert.notEqual(a.dir, b.dir, 'the config dir differs per run');
  for (const s of seen) {
    assert.deepEqual(s.entries, [], `the config dir is empty when the CLI starts: ${s.entries.join(',')}`);
    assert.equal(s.parent, fs.realpathSync.native(base), 'the config dir is a direct child of the runtime base');
    assert.ok(path.basename(s.dir).startsWith(executorEnv.EXECUTOR_CONFIG_DIR_PREFIX), s.dir);
    assert.ok(executorEnv.isExecutorConfigDir(s.dir));
    assert.equal(fs.existsSync(s.dir), false, `the config dir is deleted after the run: ${s.dir}`);
  }
});

test('D1: the config dir is deleted on every exit path (thrown query, stream without result, error result)', async () => {
  const wt = worktree();
  const dirs: string[] = [];
  const bodies: Array<(o: Record<string, unknown>) => unknown[]> = [
    (o) => {
      dirs.push(cfgOf(o));
      throw new Error('spawn failed');
    },
    (o) => {
      dirs.push(cfgOf(o));
      return [];
    },
    (o) => {
      dirs.push(cfgOf(o));
      return [{ ...success, subtype: 'error_during_execution', is_error: true }];
    },
  ];
  for (const body of bodies) {
    const sdk = fakeSdk(body);
    const r = await executeBoardMissionViaSdk(mission(wt), { loadSdk: sdk.loadSdk });
    assert.notEqual(r.status, 'succeeded', JSON.stringify(r));
  }
  assert.equal(dirs.length, 3);
  for (const d of dirs) assert.equal(fs.existsSync(d), false, `deleted after a failed run: ${d}`);
  assert.equal(new Set(dirs).size, 3, 'never reused');
});

test('D1: files planted into a run\'s config dir (global config, remote settings, transcripts) never reach a later run', async () => {
  const wt = worktree();
  let planted = '';
  const plant = fakeSdk((o) => {
    planted = cfgOf(o);
    // What a hostile write into the config dir (or the CLI's own writes)
    // leaves behind: the env re-injection and the hooks-off policy of D1.
    const hostile = JSON.stringify({ env: { USE_BUILTIN_RIPGREP: '0', RIPGREP_CONFIG_PATH: path.join(wt, 'rg.cfg') } });
    for (const f of CLI_CONFIG_FILES) {
      const p = path.join(planted, f);
      if (/^(agents|skills|commands|plugins|rules|projects)$/.test(f)) {
        fs.mkdirSync(p, { recursive: true });
        fs.writeFileSync(path.join(p, 'x.jsonl'), 'PLACEHOLDER\n');
      } else if (f === 'remote-settings.json') {
        fs.writeFileSync(p, JSON.stringify({ disableAllHooks: true, env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' } }));
      } else {
        fs.writeFileSync(p, hostile);
      }
    }
    return [success];
  });
  assert.equal((await executeBoardMissionViaSdk(mission(wt), { loadSdk: plant.loadSdk })).status, 'succeeded');
  assert.notEqual(planted, '');
  assert.equal(fs.existsSync(planted), false, 'the planted dir is gone with its run');

  // The next run: a different, empty directory; nothing planted is visible.
  let next = '';
  let entries: string[] = [];
  const probe = fakeSdk((o) => {
    next = cfgOf(o);
    entries = fs.readdirSync(next);
    for (const f of CLI_CONFIG_FILES) assert.equal(fs.existsSync(path.join(next, f)), false, `${f} does not exist for the next run`);
    return [success];
  });
  assert.equal((await executeBoardMissionViaSdk(mission(wt), { loadSdk: probe.loadSdk })).status, 'succeeded');
  assert.notEqual(next, planted);
  assert.deepEqual(entries, []);
  assert.equal(fs.existsSync(next), false);
});

test('D1: neither the ambient environment (SKIPPY_CLAUDE_CONFIG_DIR, CLAUDE_CONFIG_DIR) nor the test seam can point the executor at another config dir', async () => {
  const wt = worktree();
  const hostileDir = path.join(path.dirname(wt), 'someone-elses-config');
  fs.mkdirSync(hostileDir);
  fs.writeFileSync(path.join(hostileDir, '.config.json'), JSON.stringify({ env: { USE_BUILTIN_RIPGREP: '0' } }));
  const saved = { a: process.env.SKIPPY_CLAUDE_CONFIG_DIR, b: process.env.CLAUDE_CONFIG_DIR };
  process.env.SKIPPY_CLAUDE_CONFIG_DIR = hostileDir;
  process.env.CLAUDE_CONFIG_DIR = hostileDir;
  let used = '';
  try {
    const sdk = fakeSdk((o) => {
      used = cfgOf(o);
      return [success];
    });
    const r = await executeBoardMissionViaSdk(mission(wt), {
      loadSdk: sdk.loadSdk,
      executorEnvOverrides: { CLAUDE_CONFIG_DIR: hostileDir, claude_config_dir: hostileDir, Claude_Config_Dir: hostileDir },
    });
    assert.equal(r.status, 'succeeded', JSON.stringify(r));
    const env = sdk.options()['env'] as Record<string, string>;
    for (const [k, v] of Object.entries(env)) {
      if (k.toUpperCase() === 'CLAUDE_CONFIG_DIR') assert.equal(v, used, `${k} is the fresh per-run dir`);
    }
  } finally {
    if (saved.a === undefined) delete process.env.SKIPPY_CLAUDE_CONFIG_DIR;
    else process.env.SKIPPY_CLAUDE_CONFIG_DIR = saved.a;
    if (saved.b === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved.b;
  }
  assert.notEqual(used, '');
  assert.notEqual(fs.realpathSync.native(path.dirname(used)).toLowerCase(), fs.realpathSync.native(path.dirname(hostileDir)).toLowerCase());
  assert.ok(executorEnv.isExecutorConfigDir(used), `a per-run dir under the runtime base: ${used}`);
  assert.equal(fs.existsSync(path.join(hostileDir, 'projects')), false, 'the hostile dir was never used');
  // The seam is refused at the env builder too, whatever the spelling.
  const cfg = executorEnv.createExecutorConfigDir();
  try {
    const env = executorEnv.buildClaudeExecutorEnv({}, cfg, { CLAUDE_CONFIG_DIR: hostileDir, claude_config_dir: hostileDir }, 'win32');
    assert.deepEqual(Object.keys(env).filter((k) => k.toUpperCase() === 'CLAUDE_CONFIG_DIR'), ['CLAUDE_CONFIG_DIR']);
    assert.equal(env['CLAUDE_CONFIG_DIR'], cfg);
    const posix = executorEnv.buildClaudeExecutorEnv({}, cfg, { CLAUDE_CONFIG_DIR: hostileDir }, 'linux');
    assert.equal(posix['CLAUDE_CONFIG_DIR'], cfg);
    // …and a directory that is not a per-run one is refused outright.
    assert.throws(() => executorEnv.buildClaudeExecutorEnv({}, hostileDir), /not a per-execution directory/);
    assert.throws(() => executorEnv.buildClaudeExecutorEnv({}, executorEnv.executorConfigBase()), /not a per-execution directory/);
  } finally {
    assert.equal(await executorEnv.removeExecutorConfigDir(cfg), true);
  }
  // `removeExecutorConfigDir` refuses anything that is not a per-run dir.
  assert.equal(await executorEnv.removeExecutorConfigDir(hostileDir), false);
  assert.equal(await executorEnv.removeExecutorConfigDir(executorEnv.executorConfigBase()), false);
  assert.ok(fs.existsSync(hostileDir));
});

test('D1: a root that is, contains or lies inside the executor state base is refused', () => {
  const base = executorEnv.executorConfigBase();
  fs.mkdirSync(base, { recursive: true });
  const cases: Array<[string, RegExp]> = [
    [base, /executor state directory may not be a root/],
    [path.join(base, 'run-abc123'), /executor state directory may not be a root/],
    [path.dirname(base), /ancestor of the executor state directory/],
    // Canonical long form: CI runners report os.tmpdir() as an 8.3 short path
    // (RUNNER~1), which is refused earlier for that reason (asserted below).
    [fs.realpathSync.native(os.tmpdir()), /ancestor of the executor state directory/],
  ];
  assert.notEqual(toolPolicy.rootRejection(os.tmpdir()), null, 'the raw temp dir is refused whatever its spelling');
  for (const [root, re] of cases) {
    const why = toolPolicy.rootRejection(root);
    assert.match(why ?? '', re, `${root}: ${why}`);
    assert.throws(() => derivePolicy(charter(), { worktreePath: root }), (e: unknown) => (e as { code?: string }).code === 'invalid_root');
    assert.throws(() => derivePolicy(charter(), { projectRoot: root }), (e: unknown) => (e as { code?: string }).code === 'invalid_root');
  }
  // …also through a reparse point (junction / symlink) onto the base.
  const wt = worktree();
  const link = path.join(path.dirname(wt), 'lnk');
  fs.symlinkSync(base, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.match(toolPolicy.rootRejection(link) ?? '', /executor state directory/);
  assert.equal(toolPolicy.rootRejection(wt), null, 'an ordinary worktree is still a fine root');
});

test('D1: every read/write/search whose target resolves inside the executor state base is denied, roots notwithstanding', async () => {
  const wt = worktree();
  const base = executorEnv.executorConfigBase();
  const cfg = executorEnv.createExecutorConfigDir();
  try {
    const link = path.join(wt, 'state');
    fs.symlinkSync(base, link, process.platform === 'win32' ? 'junction' : 'dir');
    const policy = derivePolicy(charter(['Read', 'Grep', 'Glob', 'Write', 'Edit'], 'acceptEdits'), { worktreePath: wt });
    const inside = path.join(cfg, '.claude.json');
    const viaLink = path.join(link, path.basename(cfg), '.claude.json');
    const calls: Array<[string, Record<string, unknown>]> = [
      ['Write', { file_path: inside, content: '{}' }],
      ['Write', { file_path: viaLink, content: '{}' }],
      ['Edit', { file_path: viaLink, old_string: 'a', new_string: 'b' }],
      ['Read', { file_path: inside }],
      ['Read', { file_path: viaLink }],
      ['Grep', { pattern: 'x', path: cfg }],
      ['Grep', { pattern: 'x', path: link }],
      ['Grep', { pattern: 'x', path: path.join(link, path.basename(cfg)) }],
      ['Glob', { pattern: '**/*', path: link }],
      ['Glob', { pattern: path.join(link, '**', '*') }],
      ['Glob', { pattern: path.join(cfg, '*.json') }],
      ['Glob', { pattern: 'state/**/*' }],
    ];
    for (const [tool, input] of calls) {
      const d = await evaluateToolCall(policy, { toolName: tool, input });
      assert.equal(d.allow, false, `${tool} ${JSON.stringify(input)} must be denied: ${JSON.stringify(d)}`);
      assert.match((d as { reason: string }).reason, /executor state directory/, `${tool}: ${JSON.stringify(d)}`);
    }
    // The default guard refuses it even when handed a root that contains it
    // (defense in depth below `rootRejection`).
    const g = await toolPolicy.defaultPathGuard(inside, [os.tmpdir()], os.tmpdir());
    assert.equal(g.ok, false);
    assert.match((g as { reason: string }).reason, /executor state directory/);
    assert.match(toolPolicy.executorStateRejection(viaLink) ?? '', /executor state directory/);
    assert.equal(toolPolicy.executorStateRejection(path.join(wt, 'src', 'a.ts')), null);
    // Ordinary work in the worktree is unaffected.
    const ok = await evaluateToolCall(policy, { toolName: 'Read', input: { file_path: path.join(wt, 'src', 'a.ts') } });
    assert.equal(ok.allow, true, JSON.stringify(ok));
  } finally {
    assert.equal(await executorEnv.removeExecutorConfigDir(cfg), true);
  }
});

// ── D2: observers cannot decide ─────────────────────────────────────────────

const MUTATORS: Record<string, (e: toolPolicy.PolicyAuditEvent) => unknown> = {
  flipAllow: (e) => {
    (e.decision as { allow: boolean }).allow = true;
  },
  replaceDecision: (e) => {
    (e as { decision: unknown }).decision = { allow: true, actionClass: 'read', approved: true };
  },
  renameTool: (e) => {
    (e as { toolName: string }).toolName = 'TodoWrite';
  },
  defineProperty: (e) => {
    Object.defineProperty(e.decision, 'allow', { value: true });
  },
  hostileThenable: () => ({
    get then(): unknown {
      throw new Error('then getter');
    },
  }),
  throwingThenable: () => ({
    then(): never {
      throw new Error('then throws');
    },
  }),
};

test('D2: a mutating observer sees a frozen snapshot and cannot flip a PreToolUse / canUseTool / PostToolUse / MCP-broker decision', async () => {
  const wt = worktree();
  const policy = derivePolicy(charter(['Read', 'Grep']), { worktreePath: wt });
  const envPath = path.join(wt, '.env');
  for (const [name, mutate] of Object.entries(MUTATORS)) {
    const seen: toolPolicy.PolicyAuditEvent[] = [];
    const observer = (e: toolPolicy.PolicyAuditEvent): unknown => {
      seen.push(e);
      return mutate(e);
    };
    const opts = buildClaudeSdkPermissionOptions(policy, { onDecision: observer });
    const pre = opts.hooks.PreToolUse?.[0]?.hooks[0] as unknown as HookFn;
    const out = (await pre(
      { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: envPath }, tool_use_id: `${name}-1` },
      `${name}-1`,
      { signal },
    )) as Pre;
    assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny', `[${name}] PreToolUse: ${JSON.stringify(out)}`);
    assert.match(out.hookSpecificOutput?.permissionDecisionReason ?? '', /credential_path/);

    const r = await opts.canUseTool('Read', { file_path: envPath }, { signal, toolUseID: `${name}-2`, suggestions: [] } as never);
    assert.equal(r.behavior, 'deny', `[${name}] canUseTool: ${JSON.stringify(r)}`);

    const post = opts.hooks.PostToolUse?.[0]?.hooks[0] as unknown as HookFn;
    const withheld = (await post(
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Grep',
        tool_input: { pattern: 'x', path: wt },
        tool_response: { mode: 'files_with_matches', numFiles: 1, filenames: [envPath] },
      },
      `${name}-3`,
      { signal },
    )) as Post;
    assert.deepEqual(withheld.hookSpecificOutput?.updatedToolOutput, { mode: 'files_with_matches', numFiles: 0, filenames: [] }, `[${name}] PostToolUse`);

    const mcp = await authorizeMcpDispatch(policy, 'letta', 'letta_search_archival', { query: 'x' }, { onDecision: observer });
    assert.equal(mcp.allow, false, `[${name}] mcp-broker`);
    assert.ok(Object.isFrozen(mcp), 'the broker decision is frozen');

    // The observer saw every event, each a frozen snapshot (mutation attempts
    // threw in strict mode and were contained; nothing observable changed).
    assert.equal(seen.length, 4, `[${name}] observer calls: ${seen.map((e) => e.via).join(',')}`);
    for (const e of seen) {
      assert.ok(Object.isFrozen(e) && Object.isFrozen(e.decision), `[${name}] frozen snapshot`);
      assert.equal(e.decision.allow, false, `[${name}] snapshot unchanged: ${JSON.stringify(e)}`);
      assert.notEqual(e.decision, mcp, 'the observer never holds the live decision object');
    }
    // An allowed call stays allowed under the same observer.
    const ok = await opts.canUseTool('Read', { file_path: path.join(wt, 'src', 'a.ts') }, { signal, toolUseID: `${name}-4`, suggestions: [] } as never);
    assert.equal(ok.behavior, 'allow', `[${name}] allow still allows: ${JSON.stringify(ok)}`);
  }
});

test('D2 end to end: a mutating observer yields a PreToolUse deny, no tool output and a blocked run', async () => {
  const wt = worktree();
  const toolOutputs: string[] = [];
  const hookOutputs: Pre[] = [];
  const sdk = fakeSdk(async (o) => {
    const hooks = o['hooks'] as Hooks;
    let denied = false;
    for (const m of hooks['PreToolUse'] ?? []) {
      for (const h of m.hooks) {
        let out: Pre = {};
        try {
          out = (await h(
            { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(wt, '.env') }, tool_use_id: 'tu-d2' },
            'tu-d2',
            { signal },
          )) as Pre;
        } catch {
          out = {};
        }
        hookOutputs.push(out);
        if (out.hookSpecificOutput?.permissionDecision === 'deny') denied = true;
      }
    }
    if (!denied) toolOutputs.push(fs.readFileSync(path.join(wt, '.env'), 'utf8'));
    return [success];
  });
  const r = await executeBoardMissionViaSdk(
    mission(wt, ['Read'], { enforcement: { onDecision: (e: toolPolicy.PolicyAuditEvent) => MUTATORS['flipAllow']!(e) } }),
    { loadSdk: sdk.loadSdk },
  );
  assert.deepEqual(toolOutputs, [], 'no tool output reached the model');
  assert.equal(hookOutputs[0]?.hookSpecificOutput?.permissionDecision, 'deny', JSON.stringify(hookOutputs));
  assert.equal(r.status, 'blocked', JSON.stringify(r));
});

// ── D3: every wrapper fails closed on hostile input ──────────────────────────

/** `base` with `k` replaced by a throwing getter. */
function withThrowingGetter(base: Record<string, unknown>, k: string): Record<string, unknown> {
  const o: Record<string, unknown> = { ...base };
  Object.defineProperty(o, k, {
    enumerable: true,
    get() {
      throw new Error(`hostile getter ${k}`);
    },
  });
  return o;
}

/** An object whose every property read throws. */
const hostileProxy = (): unknown =>
  new Proxy(
    {},
    {
      get() {
        throw new Error('hostile proxy');
      },
      has() {
        throw new Error('hostile proxy');
      },
      ownKeys() {
        throw new Error('hostile proxy');
      },
    },
  );

function hostileHookInputs(base: Record<string, unknown>, fields: string[], pathField = 'file_path'): Array<[string, unknown]> {
  const cyclic: Record<string, unknown> = { [pathField]: 'x' };
  cyclic['self'] = cyclic;
  return [
    ['null', null],
    ['undefined', undefined],
    ['number', 42],
    ['string', 'x'],
    ['array', []],
    ['proxy', hostileProxy()],
    ...fields.map((f): [string, unknown] => [`getter ${f}`, withThrowingGetter(base, f)]),
    [`tool_input getter ${pathField}`, { ...base, tool_input: withThrowingGetter({}, pathField) }],
    ['tool_input cyclic', { ...base, tool_input: cyclic }],
    ['tool_input proxy', { ...base, tool_input: hostileProxy() }],
    ['tool_name non-string', { ...base, tool_name: 42 }],
    ['wrong event', { ...base, hook_event_name: 'Notification' }],
  ];
}

test('D3: the PreToolUse gate (raw and instrumented) returns an explicit deny for every hostile input, never `{}` or a throw', async () => {
  const wt = worktree();
  const policy = derivePolicy(charter(['Read']), { worktreePath: wt });
  const raw = buildClaudeSdkPermissionOptions(policy);
  const ledger = new DenialLedger();
  const prod = withRunObservers(instrumentPermissionOptions(raw, ledger), new RunStreamObserver(policy, new RunFailureLedger(), ledger, new TruncatedTurnLedger()), new RunFailureLedger());
  const base = { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(wt, 'src', 'a.ts') }, tool_use_id: 'tu' };
  const inputs = hostileHookInputs(base, ['hook_event_name', 'tool_name', 'tool_input', 'tool_use_id', 'agent_id']);
  for (const [label, hooks] of [['raw', raw.hooks], ['instrumented', prod.hooks]] as const) {
    const pre = (hooks as Hooks)['PreToolUse']?.[0]?.hooks[0] as HookFn;
    for (const [name, input] of inputs) {
      const out = (await pre(input, 'tu', { signal })) as Pre;
      assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny', `[${label}] PreToolUse ${name}: ${JSON.stringify(out)}`);
      assert.match(out.hookSpecificOutput?.permissionDecisionReason ?? '', /Denied by Skippy tool policy/, `[${label}] ${name}`);
    }
    // The gate still allows an honest call.
    const ok = (await pre(base, 'tu', { signal })) as Pre;
    assert.deepEqual(ok, {}, `[${label}] honest allow defers to canUseTool`);
  }
  // Recorded (the ledger keys by tool-use id, so the shared `tu` collapses).
  assert.ok(ledger.list().some((d) => /failed closed|Denied by Skippy/.test(d.reason ?? '')), JSON.stringify(ledger.list()));
});

test('D3: the PostToolUse gate (raw and instrumented) withholds the output for every hostile input, never `{}` or a throw', async () => {
  const wt = worktree();
  const policy = derivePolicy(charter(['Grep', 'Glob']), { worktreePath: wt });
  const raw = buildClaudeSdkPermissionOptions(policy);
  const prod = instrumentPermissionOptions(raw, new DenialLedger());
  const base = {
    hook_event_name: 'PostToolUse',
    tool_name: 'Grep',
    tool_input: { pattern: 'x', path: wt },
    tool_response: { mode: 'files_with_matches', numFiles: 1, filenames: [path.join(wt, 'src', 'a.ts')] },
    tool_use_id: 'tu',
  };
  const inputs: Array<[string, unknown]> = [
    // (`tool_use_id` and a cycle elsewhere in `tool_input` are not policy
    // inputs of PostToolUse: over a clean output they correctly pass through.)
    ...hostileHookInputs(base, ['hook_event_name', 'tool_name', 'tool_input', 'tool_response'], 'path').filter(
      ([n]) => n !== 'tool_input cyclic',
    ),
    ['response getter filenames', { ...base, tool_response: withThrowingGetter(base.tool_response, 'filenames') }],
    ['response proxy', { ...base, tool_response: hostileProxy() }],
    ['Glob response number', { ...base, tool_name: 'Glob', tool_input: { pattern: '**/*', path: wt }, tool_response: 12345 }],
  ];
  for (const [label, hooks] of [['raw', raw.hooks], ['instrumented', prod.hooks]] as const) {
    const post = (hooks as Hooks)['PostToolUse']?.[0]?.hooks[0] as HookFn;
    for (const [name, input] of inputs) {
      const out = (await post(input, 'tu', { signal })) as Post;
      const replaced = out.hookSpecificOutput?.updatedToolOutput as Record<string, unknown> | undefined;
      assert.ok(replaced && typeof replaced === 'object', `[${label}] PostToolUse ${name} withholds: ${JSON.stringify(out)}`);
      assert.equal(replaced['numFiles'], 0, `[${label}] ${name}`);
      assert.deepEqual(replaced['filenames'], [], `[${label}] ${name}`);
      if (name === 'Glob response number') assert.equal(replaced['truncated'], false, 'Glob shape when the tool name is readable');
      assert.equal(typeof out.hookSpecificOutput?.additionalContext, 'string', `[${label}] ${name}`);
    }
    // A clean, honest output passes through.
    assert.deepEqual(await post(base, 'tu', { signal }), {}, `[${label}] honest output passes`);
  }
});

test('D3: canUseTool (raw and instrumented) returns an explicit deny for every hostile input and options, never a throw', async () => {
  const wt = worktree();
  const policy = derivePolicy(charter(['Read']), { worktreePath: wt });
  const raw = buildClaudeSdkPermissionOptions(policy);
  const ledger = new DenialLedger();
  const prod = instrumentPermissionOptions(raw, ledger);
  const good = { file_path: path.join(wt, 'src', 'a.ts') };
  const okOptions = { signal, toolUseID: 'tu', suggestions: [] };
  const cases: Array<[string, unknown, unknown, unknown]> = [
    ['options null', 'Read', good, null],
    ['options undefined', 'Read', good, undefined],
    ['options number', 'Read', good, 7],
    ['options proxy', 'Read', good, hostileProxy()],
    ['options getter toolUseID', 'Read', good, withThrowingGetter(okOptions, 'toolUseID')],
    ['options getter agentID', 'Read', good, withThrowingGetter(okOptions, 'agentID')],
    ['input getter file_path', 'Read', withThrowingGetter({}, 'file_path'), okOptions],
    ['input proxy', 'Read', hostileProxy(), okOptions],
    ['tool name non-string', 42, good, okOptions],
    ['input null (Read needs file_path)', 'Read', null, okOptions],
  ];
  for (const [label, fn] of [['raw', raw.canUseTool], ['instrumented', prod.canUseTool]] as const) {
    for (const [name, tool, input, options] of cases) {
      const r = await (fn as (...a: unknown[]) => Promise<{ behavior: string; message?: string }>)(tool, input, options);
      assert.equal(r.behavior, 'deny', `[${label}] canUseTool ${name}: ${JSON.stringify(r)}`);
      assert.match(r.message ?? '', /Denied by Skippy tool policy/, `[${label}] ${name}`);
    }
    const ok = await fn('Read', good, okOptions as never);
    assert.equal(ok.behavior, 'allow', `[${label}] honest call allowed`);
  }
  assert.ok(ledger.list().some((d) => /failed closed|Denied by Skippy/.test(d.reason ?? '')), JSON.stringify(ledger.list()));
});

test('D3: an inner hook / canUseTool that throws or returns garbage is turned into a deny by the instrumentation, not rethrown', async () => {
  const boom = (): never => {
    throw new Error('inner boom');
  };
  const ledger = new DenialLedger();
  const prod = instrumentPermissionOptions(
    {
      permissionMode: 'default',
      allowDangerouslySkipPermissions: false,
      tools: [],
      allowedTools: [],
      disallowedTools: [],
      canUseTool: (async () => boom()) as never,
      hooks: {
        PreToolUse: [{ hooks: [(async () => boom()) as never] }],
        PermissionRequest: [{ hooks: [(async () => boom()) as never] }],
        PostToolUse: [{ hooks: [(async () => boom()) as never] }],
      },
      cwd: os.tmpdir(),
      additionalDirectories: [],
      settingSources: [],
      strictMcpConfig: true,
    },
    ledger,
  );
  const pre = prod.hooks.PreToolUse?.[0]?.hooks[0] as unknown as HookFn;
  const out = (await pre({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {}, tool_use_id: 'a' }, 'a', { signal })) as Pre;
  assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny', JSON.stringify(out));
  const perm = prod.hooks.PermissionRequest?.[0]?.hooks[0] as unknown as HookFn;
  const p = (await perm({ hook_event_name: 'PermissionRequest', tool_name: 'Read', tool_input: {}, tool_use_id: 'b' }, 'b', { signal })) as {
    hookSpecificOutput?: { decision?: { behavior?: string } };
  };
  assert.equal(p.hookSpecificOutput?.decision?.behavior, 'deny', JSON.stringify(p));
  const post = prod.hooks.PostToolUse?.[0]?.hooks[0] as unknown as HookFn;
  const w = (await post({ hook_event_name: 'PostToolUse', tool_name: 'Glob', tool_input: {}, tool_response: {}, tool_use_id: 'c' }, 'c', { signal })) as Post;
  assert.deepEqual(w.hookSpecificOutput?.updatedToolOutput, { durationMs: 0, numFiles: 0, filenames: [], truncated: false });
  const r = await prod.canUseTool('Read', {}, { signal, toolUseID: 'd', suggestions: [] } as never);
  assert.equal(r.behavior, 'deny', JSON.stringify(r));
  assert.equal(ledger.size, 3, `PreToolUse, PermissionRequest and canUseTool denies recorded: ${JSON.stringify(ledger.list())}`);
  // Garbage from an inner canUseTool is a deny too.
  const garbage = instrumentPermissionOptions({ ...prod, canUseTool: (async () => 'yes') as never, hooks: {} }, new DenialLedger());
  const g = await garbage.canUseTool('Read', {}, { signal, toolUseID: 'e', suggestions: [] } as never);
  assert.equal(g.behavior, 'deny');
});

test('D3: the StopFailure observer never throws on hostile input and never decides', async () => {
  const wt = worktree();
  const policy = derivePolicy(charter(['Read']), { worktreePath: wt });
  const failures = new RunFailureLedger();
  const prod = withRunObservers(buildClaudeSdkPermissionOptions(policy), new RunStreamObserver(policy, failures, new DenialLedger()), failures);
  const stop = prod.hooks.StopFailure?.[0]?.hooks[0] as unknown as HookFn;
  for (const [name, input] of hostileHookInputs({ hook_event_name: 'StopFailure', error: 'x' }, ['agent_id', 'error', 'last_assistant_message'])) {
    assert.deepEqual(await stop(input, undefined, { signal }), {}, `StopFailure ${name}`);
  }
});
