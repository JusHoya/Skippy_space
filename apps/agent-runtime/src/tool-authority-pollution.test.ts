// tool-authority-pollution.test.ts — M1 pre-flight final hardening (D-B1,
// D-B2, D-B3, D-A1, D-A2; FR-SEC-01, FR-SEC-02, OQ-22). Offline and portable
// (Linux + Windows; canonical long temp paths).
//
// Threat model (OQ-22): in-process code is trusted; replacing a built-in
// METHOD is out of scope without isolation. What is guaranteed — and fuzzed
// here — is that no prototype POLLUTION (a new property, data or function
// valued, on Object/Array/Function/String/Map/Set.prototype) changes any
// decision of the tool-authority surface:
//
// D-B1 — `checkReadArgs` result records were read through the prototype
//   chain (`f.bad`, `p.bad`, `g.bad`): `Object.prototype.bad = {ok: true}`
//   turned Read outside the roots / Read `.env` / Grep outside / Glob `..`
//   into allows.
// D-B2 — production-shaped parameters (board.ts passes no `enforcement`, and
//   `worktreePath` / `projectRoot` only when assigned) were read through the
//   chain: `enforcement`, `charter`, `projectRoot`, `worktreePath`,
//   `networkAllowedHosts`, charter `tools` / `permission_mode`, the SDK
//   hook matcher `matcher` / `timeout`, the SDK `query()` options the SDK
//   destructures (`extraArgs`, `pathToClaudeCodeExecutable`, …), result
//   message fields (`stop_reason`), `process.env.SKIPPY_PROJECT_ROOT`, and
//   Node's `for…in` over the executor env.
// D-B3 — the production MCP broker `{ policy }` read `broker.hooks` through
//   the chain at every dispatch (`Object.prototype.hooks = {approver}` ran
//   `letta_edit_core`).
// D-A1 — a board could assemble a bare-repo layout (HEAD + objects/ + refs/)
//   that ambient git discovers: `HEAD` is never board-writable, nothing in
//   a directory holding a HEAD entry is, and the executor pins
//   `safe.bareRepository=explicit`.
// D-A2 — a nested `.git` FILE pointing at a gitdir inside the root (not the
//   root's own) left that gitdir's `config` / `info/attributes` writable.
//
// Every pollution is removed in `finally` and again in `after`.
//
// Run: node --import tsx --test src/tool-authority-pollution.test.ts

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { configuredProjectRoot } from './board.js';
import type { Charter } from './charter.js';
import * as executorEnv from './executor-env.js';
import { brokered } from './mcp-registry.js';
import * as sdkBoard from './sdk-board.js';
import { executeBoardMissionViaSdk, resolveBoardPolicy, type ClaudeAgentSdkModule } from './sdk-board.js';
import {
  authorizeMcpDispatch,
  buildClaudeSdkPermissionOptions,
  derivePolicy,
  evaluateToolCall,
  type ExecutionPolicy,
  type ToolCall,
} from './tool-policy.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const isWin = process.platform === 'win32';
const signal = new AbortController().signal;

// ── pollution bookkeeping ────────────────────────────────────────────────────

const PROTOS: ReadonlyArray<readonly [string, object]> = [
  ['Object', Object.prototype],
  ['Array', Array.prototype],
  ['Function', Function.prototype],
  ['String', String.prototype],
  ['Map', Map.prototype],
  ['Set', Set.prototype],
];
const planted = new Set<string>();

function pollute(proto: object, name: string, value: unknown, enumerable = false): void {
  Object.defineProperty(proto, name, { value, configurable: true, writable: true, enumerable });
  planted.add(`${PROTOS.findIndex(([, p]) => p === proto)}\u0000${name}`);
}

function unpollute(proto: object, name: string): void {
  const d = Object.getOwnPropertyDescriptor(proto, name);
  if (d && d.configurable) delete (proto as Record<string, unknown>)[name];
}

function unpolluteAll(): void {
  for (const k of planted) {
    const [i, name] = k.split('\u0000') as [string, string];
    const proto = PROTOS[Number(i)]?.[1];
    if (proto) unpollute(proto, name);
  }
  planted.clear();
}

async function withPollution<T>(proto: object, entries: ReadonlyArray<readonly [string, unknown]>, fn: () => Promise<T>, enumerable = false): Promise<T> {
  for (const [k, v] of entries) pollute(proto, k, v, enumerable);
  try {
    return await fn();
  } finally {
    for (const [k] of entries) unpollute(proto, k);
  }
}

const created: string[] = [];
after(() => {
  unpolluteAll();
  for (const d of created) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function tmpDir(prefix: string): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  created.push(dir);
  return dir;
}

// ── fixture ──────────────────────────────────────────────────────────────────

interface Fixture {
  wt: string;
  outside: string;
}

function fixture(): Fixture {
  const dir = tmpDir('skippy-pollution-');
  const wt = path.join(dir, 'wt');
  const outside = path.join(dir, 'outside');
  fs.mkdirSync(path.join(wt, 'src'), { recursive: true });
  fs.mkdirSync(path.join(wt, '.git'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(wt, '.env'), 'PLACEHOLDER_DUMMY=1\n');
  fs.writeFileSync(path.join(wt, 'src', 'a.txt'), 'hello\n');
  fs.writeFileSync(path.join(outside, 'o.txt'), 'PLACEHOLDER_OUTSIDE\n');
  return { wt, outside };
}

const fullCharter = (): Charter => ({
  agentId: 'board.coding',
  frontmatter: {
    permission_mode: 'acceptEdits',
    tools: ['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'Grep', 'Glob', 'Agent', 'WebFetch', 'TodoWrite'],
    mcp_servers: ['obsidian', 'letta'],
    memory: { vault_subdir: '20_Boards/coding' },
  },
  body: 'synthetic',
  loaded: true,
  path: '(synthetic)',
});

/** A charter WITHOUT the optional authority keys, so an inherited
 * `disallowed_tools` / `mcp_servers` / `memory` / `tools` would show. */
const bareCharter = (): Charter => ({
  agentId: 'board.research',
  frontmatter: { permission_mode: 'ask', tools: ['Read'] },
  body: 'synthetic',
  loaded: true,
  path: '(bare)',
});

function cases(f: Fixture): Array<[string, ToolCall]> {
  const { wt, outside } = f;
  const c = (toolName: string, input: Record<string, unknown>, subagentId?: string): ToolCall =>
    subagentId === undefined ? { toolName, input } : { toolName, input, subagentId };
  return [
    // Denied at baseline.
    ['Read outside', c('Read', { file_path: path.join(outside, 'o.txt') })],
    ['Read .env', c('Read', { file_path: path.join(wt, '.env') })],
    ['Read no file_path', c('Read', {})],
    ['Read extra field', c('Read', { file_path: path.join(wt, 'src', 'a.txt'), evil: path.join(outside, 'o.txt') })],
    ['Grep outside', c('Grep', { pattern: 'x', path: outside })],
    ['Grep tree with .env', c('Grep', { pattern: 'x', path: wt })],
    ['Glob ..', c('Glob', { pattern: '../outside/*' })],
    ['Glob no pattern', c('Glob', { path: path.join(wt, 'src') })],
    ['Write .git/config', c('Write', { file_path: path.join(wt, '.git', 'config'), content: 'x' })],
    ['Write .gitattributes', c('Write', { file_path: path.join(wt, '.gitattributes'), content: 'x' })],
    ['Write HEAD', c('Write', { file_path: path.join(wt, 'HEAD'), content: 'ref: refs/heads/main\n' })],
    ['Write outside', c('Write', { file_path: path.join(outside, 'w.txt'), content: 'x' })],
    ['Edit .env', c('Edit', { file_path: path.join(wt, '.env'), old_string: 'a', new_string: 'b' })],
    ['NotebookEdit outside', c('NotebookEdit', { notebook_path: path.join(outside, 'n.ipynb'), new_source: 'x' })],
    ['Bash', c('Bash', { command: 'echo PLACEHOLDER' })],
    ['Bash no sandbox', c('Bash', { command: 'echo', dangerouslyDisableSandbox: true })],
    ['WebFetch', c('WebFetch', { url: 'https://evil.example/', prompt: 'p' })],
    ['Agent isolation', c('Agent', { description: 'd', prompt: 'p', isolation: 'worktree' })],
    ['Agent grandchild', c('Agent', { description: 'd', prompt: 'p' }, 'sub-1')],
    ['unknown tool', c('Frobnicate', {})],
    ['mcp evil server', c('mcp__evil__x', {})],
    ['mcp letta_edit_core', c('mcp__letta__letta_edit_core', { block: 'persona', value: 'x' })],
    ['mcp write outside scope', c('mcp__obsidian__obsidian_write_note', { path: '10_Atomic/x.md', title: 't', body: 'b' })],
    // Allowed at baseline (a pollution must not deny these either).
    ['Read inside', c('Read', { file_path: path.join(wt, 'src', 'a.txt') })],
    ['Write inside', c('Write', { file_path: path.join(wt, 'src', 'new.txt'), content: 'x' })],
    ['Grep src', c('Grep', { pattern: 'x', path: path.join(wt, 'src') })],
    ['Glob src', c('Glob', { pattern: '*.txt', path: path.join(wt, 'src') })],
    ['Agent plain', c('Agent', { description: 'd', prompt: 'p' })],
    ['TodoWrite', c('TodoWrite', { todos: [] })],
    ['mcp read note', c('mcp__obsidian__obsidian_read_note', { path: '10_Atomic/x.md' })],
    ['mcp write in scope', c('mcp__obsidian__obsidian_write_note', { path: '20_Boards/coding/x.md', title: 't', body: 'b' })],
  ];
}

const sig = (d: { allow: boolean; code?: string }): string => (d.allow ? 'allow' : `deny:${d.code ?? '?'}`);

type Gate = ReturnType<typeof buildClaudeSdkPermissionOptions>;
type HookFn = (input: unknown, id: string | undefined, o: { signal: AbortSignal }) => Promise<unknown>;

let seq = 0;

/** The harness reads results as OWN properties too (it must not be fooled by
 * the pollution it plants). */
const ownOf = (o: unknown, k: string): unknown =>
  o !== null && typeof o === 'object' && Object.hasOwn(o, k) ? (o as Record<string, unknown>)[k] : undefined;

/** The decision of every case on every surface, as one comparable record. */
async function decide(policy: ExecutionPolicy, gate: Gate, all: Array<[string, ToolCall]>): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const pre = (gate.hooks.PreToolUse?.[0]?.hooks[0] as HookFn | undefined) ?? null;
  for (const [name, call] of all) {
    try {
      out[`eval ${name}`] = sig(await evaluateToolCall(policy, call, {}));
    } catch (err) {
      out[`eval ${name}`] = `throw:${String(err)}`;
    }
    const id = `tu-${++seq}`;
    try {
      const opts: Record<string, unknown> = { signal, toolUseID: id, suggestions: [] };
      if (Object.hasOwn(call, 'subagentId')) opts['agentID'] = call.subagentId;
      const r = await gate.canUseTool(call.toolName, call.input, opts as never);
      out[`canUseTool ${name}`] = String(ownOf(r, 'behavior'));
    } catch (err) {
      out[`canUseTool ${name}`] = `throw:${String(err)}`;
    }
    if (pre && !call.toolName.startsWith('mcp__')) {
      const hookInput: Record<string, unknown> = {
        hook_event_name: 'PreToolUse',
        tool_name: call.toolName,
        tool_input: call.input,
        tool_use_id: `h-${id}`,
      };
      if (Object.hasOwn(call, 'subagentId')) hookInput['agent_id'] = call.subagentId;
      try {
        const r = await pre(hookInput, `h-${id}`, { signal });
        out[`PreToolUse ${name}`] = String(ownOf(ownOf(r, 'hookSpecificOutput'), 'permissionDecision') ?? 'defer');
      } catch (err) {
        out[`PreToolUse ${name}`] = `throw:${String(err)}`;
      }
    }
    if (call.toolName.startsWith('mcp__')) {
      const [, server, tool] = call.toolName.split('__') as [string, string, string];
      try {
        out[`broker ${name}`] = sig(await authorizeMcpDispatch(policy, server, tool, call.input));
      } catch (err) {
        out[`broker ${name}`] = `throw:${String(err)}`;
      }
    }
  }
  return out;
}

/** The policy derived INSIDE the pollution window (charter + context +
 * run-parameter reads), summarised. */
async function derived(f: Fixture): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const summary = (p: ExecutionPolicy): string =>
    JSON.stringify([p.agentId, p.permissionMode, p.sdkPermissionMode, p.allowedTools, p.disallowedTools, p.mcpServers, p.cwd, p.readRoots, p.writeRoots, p.vaultWriteScopes, p.networkAllowedHosts]);
  try {
    out['derivePolicy bare'] = summary(derivePolicy(bareCharter(), { worktreePath: f.wt }));
  } catch (err) {
    out['derivePolicy bare'] = `throw:${String(err)}`;
  }
  try {
    out['derivePolicy no roots'] = summary(derivePolicy(bareCharter(), {}));
  } catch (err) {
    out['derivePolicy no roots'] = `throw:${String(err)}`;
  }
  try {
    // Exactly the shape board.ts hands in: no `enforcement`, no `projectRoot`.
    const p = await resolveBoardPolicy({ boardId: 'research', systemPrompt: 's', model: 'claude-sonnet-4-6' as never, missionBrief: 'm', charter: bareCharter(), worktreePath: f.wt });
    out['resolveBoardPolicy'] = summary(p);
  } catch (err) {
    out['resolveBoardPolicy'] = `throw:${String(err)}`;
  }
  return out;
}

function diff(base: Record<string, string>, now: Record<string, string>): string[] {
  const keys = new Set([...Object.keys(base), ...Object.keys(now)]);
  return [...keys].filter((k) => base[k] !== now[k]).map((k) => `${k}: ${base[k]} -> ${now[k]}`);
}

/** Every identifier-like name the decision code reads or writes: property
 * accesses, bracket keys and quoted identifiers in the runtime sources, plus
 * the SDK option keys and the result-record fields. */
function fuzzNames(): string[] {
  const files = ['tool-policy.ts', 'sdk-board.ts', 'executor-env.ts', 'mcp-registry.ts', 'board.ts', 'charter.ts'];
  const names = new Set<string>([
    'bad', 'value', 'present', 'ok', 'allow', 'approved', 'code', 'reason', 'actionClass', 'needed', 'why',
    'approver', 'pathGuard', 'onDecision', 'enforcement', 'hooks', 'policy', 'charter', 'worktreePath', 'projectRoot',
    'cwd', 'noRootCwd', 'networkAllowedHosts', 'tools', 'permission_mode', 'disallowed_tools', 'mcp_servers', 'memory',
    'vault_subdir', 'letta_agent_id', 'loaded', 'frontmatter', 'agentId', 'subagentId', 'agent_id', 'agentID', 'toolUseID',
    'tool_use_id', 'tool_name', 'tool_input', 'tool_response', 'hook_event_name', 'input', 'toolName', 'file_path',
    'notebook_path', 'path', 'pattern', 'glob', 'url', 'command', 'mode', 'isolation', 'team_name',
    'dangerouslyDisableSandbox', 'matcher', 'timeout', 'behavior', 'message', 'updatedInput', 'interrupt',
    'permissionDecision', 'decision', 'hookSpecificOutput', 'stop_reason', 'terminal_reason', 'permission_denials',
    'SKIPPY_PROJECT_ROOT', 'loadSdk', 'executorEnvOverrides', 'maxTurns', 'mcpServers', 'then', 'toJSON',
    // (Tolerates a runtime without the list, so the fuzz also runs against
    // the pre-fix sources.)
    ...((sdkBoard as { SDK_QUERY_OPTION_KEYS?: readonly string[] }).SDK_QUERY_OPTION_KEYS ?? []),
  ]);
  for (const f of files) {
    const src = fs.readFileSync(path.join(here, f), 'utf8');
    for (const m of src.matchAll(/\.([A-Za-z_$][\w$]*)/g)) names.add(m[1] as string);
    for (const m of src.matchAll(/\[\s*'([A-Za-z_$][\w$]*)'\s*\]/g)) names.add(m[1] as string);
    for (const m of src.matchAll(/'([A-Za-z_][\w]*)'/g)) names.add(m[1] as string);
  }
  return [...names].sort();
}

// ── D-B: the fuzz ─────────────────────────────────────────────────────────────

test('D-B fuzz: polluting Object/Array/Function/String/Map/Set.prototype with any name the decision code uses never flips a decision (raw, canUseTool, PreToolUse, MCP broker, policy derivation)', async () => {
  const f = fixture();
  const policy = derivePolicy(fullCharter(), { worktreePath: f.wt });
  const gate = buildClaudeSdkPermissionOptions(policy, {});
  const all = cases(f);
  const baseline = { ...(await decide(policy, gate, all)), ...(await derived(f)) };
  // The baseline itself is the documented policy.
  for (const n of ['Read outside', 'Read .env', 'Grep outside', 'Glob ..', 'Write .git/config', 'Bash', 'WebFetch', 'Agent grandchild', 'mcp letta_edit_core']) {
    assert.match(baseline[`eval ${n}`] ?? '', /^deny:/, `baseline ${n}`);
  }
  for (const n of ['Read inside', 'Write inside', 'Grep src', 'Glob src', 'mcp write in scope']) assert.equal(baseline[`eval ${n}`], 'allow', `baseline ${n}`);

  const names = fuzzNames();
  assert.ok(names.length > 300, `fuzz covers the decision code's names (${names.length})`);
  const root = path.parse(f.wt).root;
  // Data and function values that would widen authority if read: a
  // boolean, a path outside the roots, a root list, one record carrying
  // every result/hook field (ok/allow/approved/approver/pathGuard/…), and a
  // function resolving true.
  const hookish = {
    ok: true,
    allow: true,
    actionClass: 'read',
    approved: true,
    approver: () => Promise.resolve(true),
    pathGuard: () => Promise.resolve({ ok: true }),
  };
  const objectValues: unknown[] = [true, f.outside, [f.wt, f.outside, root], hookish, () => Promise.resolve(true)];
  const run = async (proto: object, entries: ReadonlyArray<readonly [string, unknown]>): Promise<string[]> => {
    const now = await withPollution(proto, entries, async () => ({ ...(await decide(policy, gate, all)), ...(await derived(f)) }));
    return diff(baseline, now);
  };
  const show = (v: unknown): string => (typeof v === 'function' ? 'fn' : JSON.stringify(v));
  const flips = new Set<string>();
  let tried = 0;
  // A group that changes anything is bisected down to the single names
  // responsible, which are reported.
  const bisect = async (pn: string, proto: object, group: string[], v: unknown): Promise<void> => {
    if (group.length === 0) return;
    const d = await run(proto, group.map((n) => [n, v] as const));
    if (d.length === 0) return;
    if (group.length === 1) {
      for (const x of d) flips.add(`${pn}.prototype.${group[0]} = ${show(v)}: ${x}`);
      return;
    }
    const mid = Math.ceil(group.length / 2);
    await bisect(pn, proto, group.slice(0, mid), v);
    await bisect(pn, proto, group.slice(mid), v);
  };
  // SKIPPY_POLLUTION_FUZZ=full pollutes one name at a time (slow); the
  // default pollutes Object.prototype in groups of GROUP names under two
  // independent partitions (consecutive, then strided), so a pollution that
  // narrows a decision cannot mask one that widens it in the same group in
  // both; the other prototypes get every name at once per value.
  const full = process.env['SKIPPY_POLLUTION_FUZZ'] === 'full';
  const GROUP = 16;
  for (const [pn, proto] of PROTOS) {
    // Replacing an EXISTING built-in member is method replacement (out of
    // scope, OQ-22). Engine-level reads, not ours, are excluded too: a
    // function-valued `then` hijacks every promise resolution and a
    // function-valued `toJSON` every JSON.stringify in the process, and
    // `get` / `set` are read by ToPropertyDescriptor in every
    // Object.defineProperty (the test harness's own helpers throw).
    const usable = names.filter((n) => !Object.getOwnPropertyDescriptor(proto, n) && n !== 'get' && n !== 'set');
    const values = pn === 'Object' ? objectValues : [true, hookish, () => Promise.resolve(true)];
    for (const v of values) {
      const eligible = usable.filter((n) => !(typeof v === 'function' && (n === 'then' || n === 'toJSON')));
      tried += eligible.length;
      if (full) {
        for (const n of eligible) await bisect(pn, proto, [n], v);
        continue;
      }
      if (pn !== 'Object') {
        await bisect(pn, proto, eligible, v);
        continue;
      }
      const stride = Math.ceil(eligible.length / GROUP);
      const consecutive = Array.from({ length: stride }, (_, i) => eligible.slice(i * GROUP, (i + 1) * GROUP));
      const strided = Array.from({ length: stride }, (_, i) => eligible.filter((_, j) => j % stride === i));
      for (const g of [...consecutive, ...strided]) await bisect(pn, proto, g, v);
    }
  }
  const found = [...flips];
  assert.ok(tried > 2000, `fuzzed ${tried} (prototype, name, value) combinations`);
  assert.deepEqual(found.slice(0, 40), [], `${found.length} decision flip(s)`);
});

test('D-B1: Object.prototype.bad / value / present never turn a denied Read, Grep or Glob into an allow', async () => {
  const f = fixture();
  const policy = derivePolicy(fullCharter(), { worktreePath: f.wt });
  const probes: Array<[string, ToolCall]> = [
    ['Read outside', { toolName: 'Read', input: { file_path: path.join(f.outside, 'o.txt') } }],
    ['Read .env', { toolName: 'Read', input: { file_path: path.join(f.wt, '.env') } }],
    ['Grep outside', { toolName: 'Grep', input: { pattern: 'x', path: f.outside } }],
    ['Glob ..', { toolName: 'Glob', input: { pattern: '../outside/*' } }],
  ];
  for (const [label, entries] of [
    ['bad = {ok:true}', [['bad', { ok: true }]]],
    ['present/value', [['present', true], ['value', path.join(f.wt, 'src', 'a.txt')]]],
  ] as const) {
    await withPollution(Object.prototype, entries, async () => {
      for (const [name, call] of probes) {
        const d = await evaluateToolCall(policy, call);
        assert.equal(d.allow, false, `${label}: ${name} must stay denied: ${JSON.stringify(d)}`);
      }
    });
  }
});

// ── D-B2: production-shaped params across runs ───────────────────────────────

const success = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'All done, monkeys! Magnificent.',
  stop_reason: 'end_turn',
  terminal_reason: 'completed',
  permission_denials: [],
};

interface Captured {
  options: Record<string, unknown> | undefined;
  bash: string | undefined;
  readEnv: string | undefined;
  readOutside: string | undefined;
}

/** One production-shaped run (what board.ts passes: no `enforcement`, no
 * `projectRoot`) through a fake SDK that exercises the real gate. */
async function productionRun(f: Fixture, extra: Record<string, unknown> = {}, messages: unknown[] = [success], probe = true) {
  const cap: Captured = { options: undefined, bash: undefined, readEnv: undefined, readOutside: undefined };
  const query = ((args: { options: Record<string, unknown> }) => {
    const options = args.options;
    cap.options = options;
    return (async function* () {
      if (!probe) {
        for (const m of messages) yield await Promise.resolve(m);
        return;
      }
      const canUseTool = options['canUseTool'] as Gate['canUseTool'];
      const bash = (await canUseTool('Bash', { command: 'echo PLACEHOLDER' }, { signal, toolUseID: 'b1', suggestions: [] } as never)) as { behavior: string };
      cap.bash = bash.behavior;
      const hooks = options['hooks'] as Record<string, Array<{ hooks: HookFn[] }>>;
      const pre = hooks['PreToolUse']?.[0]?.hooks[0] as HookFn;
      const out = (await pre({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(f.wt, '.env') }, tool_use_id: 'r1' }, 'r1', { signal })) as {
        hookSpecificOutput?: { permissionDecision?: string };
      };
      cap.readEnv = out.hookSpecificOutput?.permissionDecision ?? 'defer';
      const o2 = (await canUseTool('Read', { file_path: path.join(f.outside, 'o.txt') }, { signal, toolUseID: 'r2', suggestions: [] } as never)) as { behavior: string };
      cap.readOutside = o2.behavior;
      for (const m of messages) yield await Promise.resolve(m);
    })();
  }) as unknown as ClaudeAgentSdkModule['query'];
  const charter: Charter = {
    agentId: 'board.coding',
    frontmatter: { permission_mode: 'ask', tools: ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob', 'Agent'] },
    body: 's',
    loaded: true,
    path: '(coding)',
  };
  const r = await executeBoardMissionViaSdk(
    { boardId: 'coding', systemPrompt: 'MOCKMARK', model: 'claude-sonnet-4-6' as never, missionBrief: 'm', charter, worktreePath: f.wt, ...extra },
    { loadSdk: () => Promise.resolve({ query }) },
  );
  return { r, cap };
}

test('D-B2 cross-run: a first run whose observer pollutes Object.prototype cannot widen a later production-shaped run (enforcement, roots, charter, hosts, tools)', async () => {
  const f = fixture();
  const control = await productionRun(f);
  assert.equal(control.cap.bash, 'deny', 'control: Bash denied');
  assert.equal(control.cap.readEnv, 'deny', 'control: Read .env denied');
  assert.equal(control.cap.readOutside, 'deny', 'control: Read outside denied');
  const controlCwd = control.cap.options?.['cwd'];
  const controlDirs = JSON.stringify(control.cap.options?.['additionalDirectories']);

  const pollution: Array<readonly [string, unknown]> = [
    ['enforcement', { approver: () => Promise.resolve(true), pathGuard: () => Promise.resolve({ ok: true }) }],
    ['projectRoot', f.outside],
    ['networkAllowedHosts', ['evil.example']],
    ['tools', ['Read', 'Write', 'Bash', 'WebFetch']],
    ['permission_mode', 'acceptEdits'],
    ['approver', () => Promise.resolve(true)],
    ['hooks', { approver: () => Promise.resolve(true) }],
    ['matcher', 'NoSuchToolAnywhere'],
    ['timeout', 0.001],
    ['extraArgs', { 'dangerously-skip-permissions': null }],
    ['pathToClaudeCodeExecutable', path.join(f.outside, 'evil-claude')],
  ];
  // Run 1: an audit observer (observes, "never decides") pollutes.
  let polluted = false;
  const run1 = await productionRun(f, {
    enforcement: {
      onDecision: () => {
        if (polluted) return;
        polluted = true;
        for (const [k, v] of pollution) pollute(Object.prototype, k, v);
      },
    },
  });
  assert.ok(polluted, 'run 1 observer polluted Object.prototype');
  assert.equal(run1.cap.bash, 'deny');
  try {
    // Run 2: production-shaped params (no enforcement, no projectRoot).
    const run2 = await productionRun(f);
    assert.equal(run2.cap.bash, 'deny', 'run 2: Bash still denied (no inherited approver)');
    assert.equal(run2.cap.readEnv, 'deny', 'run 2: Read .env still denied');
    assert.equal(run2.cap.readOutside, 'deny', 'run 2: Read outside still denied (no inherited projectRoot)');
    const o = run2.cap.options as Record<string, unknown>;
    assert.equal(o['cwd'], controlCwd, 'cwd unchanged');
    assert.equal(JSON.stringify(o['additionalDirectories']), controlDirs, 'no inherited read root');
    assert.deepEqual(o['tools'], ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob', 'Agent'], 'tool grant unchanged');
    assert.equal(o['permissionMode'], 'default', 'mode unchanged');
    // Every SDK option key is an OWN property (the SDK's rest-copy would
    // otherwise inherit `extraArgs`, `pathToClaudeCodeExecutable`, …).
    for (const k of sdkBoard.SDK_QUERY_OPTION_KEYS) assert.ok(Object.hasOwn(o, k), `query option ${k} is an own property`);
    assert.equal(o['extraArgs'], undefined);
    assert.equal(o['pathToClaudeCodeExecutable'], undefined);
    assert.equal(o['spawnClaudeCodeProcess'], sdkBoard.spawnExecutorProcess, 'the null-prototype env spawner is used');
    // Hook matchers carry OWN matcher/timeout, so the SDK's serialisation
    // `{matcher: m.matcher, timeout: m.timeout}` never inherits them.
    const hooks = o['hooks'] as Record<string, Array<Record<string, unknown>>>;
    for (const [event, matchers] of Object.entries(hooks)) {
      for (const m of matchers) {
        assert.ok(Object.hasOwn(m, 'matcher') && Object.hasOwn(m, 'timeout'), `${event} matcher/timeout are own properties`);
        assert.notEqual(m['matcher'], 'NoSuchToolAnywhere', `${event} matcher not inherited`);
        assert.notEqual(m['timeout'], 0.001, `${event} timeout not inherited`);
      }
    }
    assert.equal((hooks['PreToolUse']?.[0] as Record<string, unknown>)['matcher'], undefined, 'PreToolUse matches every tool');
    assert.equal(run2.r.status, control.r.status, 'same terminal status as the control (blocked by the probed denials)');
  } finally {
    for (const [k] of pollution) unpollute(Object.prototype, k);
  }
});

test('D-B2: each run parameter read is own-property: inherited charter / worktreePath / projectRoot / networkAllowedHosts grant nothing', async () => {
  const f = fixture();
  const base = derivePolicy(bareCharter(), { worktreePath: f.wt });
  await withPollution(Object.prototype, [['projectRoot', f.outside], ['networkAllowedHosts', ['evil.example']], ['cwd', f.outside], ['noRootCwd', f.outside]], async () => {
    const p = derivePolicy(bareCharter(), { worktreePath: f.wt });
    assert.deepEqual([...p.readRoots], [...base.readRoots], 'no inherited project root');
    assert.deepEqual([...p.networkAllowedHosts], [], 'no inherited host allowlist');
    assert.equal(p.cwd, base.cwd, 'no inherited cwd');
  });
  await withPollution(Object.prototype, [['worktreePath', f.outside]], async () => {
    const p = await resolveBoardPolicy({ boardId: 'research', systemPrompt: 's', model: 'claude-sonnet-4-6' as never, missionBrief: 'm', charter: bareCharter() });
    assert.deepEqual([...p.writeRoots], [], 'no inherited write root');
  });
  await withPollution(Object.prototype, [['tools', ['Read', 'Write', 'Bash']], ['permission_mode', 'acceptEdits'], ['mcp_servers', ['letta']], ['memory', { vault_subdir: '' }], ['disallowed_tools', ['Nope']]], async () => {
    const charter: Charter = { agentId: 'board.research', frontmatter: {}, body: 's', loaded: true, path: '(empty)' };
    const p = derivePolicy(charter, { worktreePath: f.wt });
    assert.deepEqual([...p.allowedTools], [], 'no inherited tools');
    assert.equal(p.permissionMode, 'ask', 'no inherited mode');
    assert.deepEqual([...p.mcpServers], [], 'no inherited MCP servers');
  });
  await withPollution(Object.prototype, [['charter', fullCharter()]], async () => {
    // No own charter: the board's charter is loaded from disk (a placeholder
    // for a board without one), never the inherited full grant.
    const r = await resolveBoardPolicy({ boardId: 'coding', systemPrompt: 's', model: 'claude-sonnet-4-6' as never, missionBrief: 'm' }).then(
      (p) => JSON.stringify(p.allowedTools),
      (err: unknown) => `refused: ${String(err)}`,
    );
    assert.notEqual(r, JSON.stringify(fullCharter().frontmatter['tools']), `inherited charter must not apply (${r})`);
  });
  await withPollution(Object.prototype, [['loaded', true]], async () => {
    const placeholder = { agentId: 'board.coding', frontmatter: { tools: ['Bash'] }, body: 's', path: '(no loaded flag)' } as unknown as Charter;
    assert.throws(() => derivePolicy(placeholder, {}), /charter_not_loaded/, 'an inherited `loaded` is not loaded');
  });
});

test('D-B2: an SDK result message field is never inherited: a truncated success stays failed under Object.prototype.stop_reason pollution', async () => {
  const f = fixture();
  const truncated = { type: 'result', subtype: 'success', is_error: false, result: 'partial', terminal_reason: 'completed', permission_denials: [] };
  const control = await productionRun(f, {}, [truncated], false);
  assert.equal(control.r.status, 'failed', `control: ${JSON.stringify(control.r)}`);
  await withPollution(Object.prototype, [['stop_reason', 'end_turn']], async () => {
    const run = await productionRun(f, {}, [truncated], false);
    assert.equal(run.r.status, 'failed', `an inherited stop_reason must not make a truncated stream succeed: ${JSON.stringify(run.r)}`);
  });
});

test('D-B2: process.env pollution cannot supply SKIPPY_PROJECT_ROOT', async () => {
  const saved = process.env['SKIPPY_PROJECT_ROOT'];
  delete process.env['SKIPPY_PROJECT_ROOT'];
  try {
    await withPollution(Object.prototype, [['SKIPPY_PROJECT_ROOT', os.tmpdir()]], () => {
      assert.equal(configuredProjectRoot(), undefined, 'process.env reads fall back to Object.prototype; the read is own-property');
      return Promise.resolve();
    });
  } finally {
    if (saved !== undefined) process.env['SKIPPY_PROJECT_ROOT'] = saved;
  }
});

test('D-B2: SDK_QUERY_OPTION_KEYS covers every option the installed SDK reads (sdk.d.ts Options + the query builder)', () => {
  const sdkDir = path.dirname(fileURLToPath(import.meta.resolve('@anthropic-ai/claude-agent-sdk')));
  const dts = fs.readFileSync(path.join(sdkDir, 'sdk.d.ts'), 'utf8');
  const start = dts.indexOf('export declare type Options = {');
  assert.ok(start >= 0, 'sdk.d.ts declares Options');
  const body = dts.slice(start, dts.indexOf('\n};', start)).replace(/\/\*[\s\S]*?\*\//g, '');
  const declared = [...body.matchAll(/^ {4}([A-Za-z_$][\w$]*)\??:/gm)].map((m) => m[1] as string);
  assert.ok(declared.length > 40, `parsed ${declared.length} declared options`);
  const mjs = fs.readFileSync(path.join(sdkDir, 'sdk.mjs'), 'utf8');
  const destructure = /let\{systemPrompt:[^}]*\.\.\.(\w+)\}=\$\?\?\{\}/.exec(mjs);
  assert.ok(destructure, 'the query builder rest-copies the options');
  const restVar = destructure[1] as string;
  const firstKeys = [...(destructure[0].matchAll(/([A-Za-z_$][\w$]*):/g) ?? [])].map((m) => m[1] as string);
  const second = new RegExp(`let\\{(abortController:[\\s\\S]*?)\\}=${restVar.replace(/\$/g, '\\$')}\\b`).exec(mjs);
  assert.ok(second, 'the query builder destructures the rest copy');
  const secondKeys = [...(second[1] as string).matchAll(/(?:^|,)([A-Za-z_$][\w$]*):/g)].map((m) => m[1] as string);
  const fnStart = mjs.lastIndexOf('function', destructure.index);
  const fnText = mjs.slice(fnStart, destructure.index + 6000);
  const dotted = [...fnText.matchAll(new RegExp(`\\b${restVar.replace(/\$/g, '\\$')}\\.([A-Za-z_$][\\w$]*)`, 'g'))].map((m) => m[1] as string);
  const known = new Set(sdkBoard.SDK_QUERY_OPTION_KEYS);
  const missing = [...new Set([...declared, ...firstKeys, ...secondKeys, ...dotted])].filter((k) => !known.has(k));
  assert.deepEqual(missing, [], 'every option key the SDK reads must be listed (re-audit on SDK bump)');
});

test('D-B2: the real SDK builds the same CLI command line from hardened options under Object.prototype pollution', async () => {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const capture = async (): Promise<string> => {
    let got = '';
    const options = sdkBoard.hardenedQueryOptions({
      model: 'claude-sonnet-4-6',
      maxTurns: 2,
      permissionMode: 'default',
      allowDangerouslySkipPermissions: false,
      tools: ['Read'],
      allowedTools: [],
      disallowedTools: ['Bash'],
      settingSources: [],
      strictMcpConfig: true,
      cwd: os.tmpdir(),
      env: { PATH: process.env['PATH'] ?? '' },
      systemPrompt: 's',
      canUseTool: () => Promise.resolve({ behavior: 'deny', message: 'x' }),
      spawnClaudeCodeProcess: (o: { command: string; args: string[]; env: Record<string, string> }) => {
        got = JSON.stringify({ c: o.command, a: o.args, e: Object.keys(o.env).sort() });
        throw new Error('captured');
      },
    });
    try {
      for await (const m of query({ prompt: 'x', options: options as never })) void m;
    } catch {
      /* the capturing spawner throws on purpose */
    }
    return got;
  };
  const clean = await capture();
  assert.match(clean, /--permission-prompt-tool/, `captured the command line: ${clean.slice(0, 200)}`);
  const hostile: Array<readonly [string, unknown]> = [
    ['extraArgs', { 'dangerously-skip-permissions': null, 'add-dir': os.tmpdir() }],
    ['pathToClaudeCodeExecutable', path.join(os.tmpdir(), 'evil-claude')],
    ['executable', 'node'],
    ['executableArgs', ['--evil']],
    ['settings', '{"permissions":{"allow":["Bash"]}}'],
    ['plugins', [{ type: 'local', path: os.tmpdir() }]],
    ['agents', { evil: { description: 'd', prompt: 'p' } }],
    ['additionalDirectories', [os.tmpdir()]],
    ['resume', 'evil-session'],
    ['continue', true],
    ['fallbackModel', 'evil'],
    ['permissionPromptToolName', 'evil'],
    ['sandbox', { enabled: false }],
    ['managedSettings', { permissions: { allow: ['Bash'] } }],
  ];
  const polluted = await withPollution(Object.prototype, hostile, capture);
  assert.equal(polluted, clean, 'no inherited SDK option reaches the CLI command line');
});

test('D-B2: the executor spawner hands the child a null-prototype env (an enumerable Object.prototype property is not inherited by the CLI process)', async () => {
  const run = (): Promise<string> =>
    new Promise((resolve, reject) => {
      const child = sdkBoard.spawnExecutorProcess({
        command: process.execPath,
        args: ['-e', 'process.stdout.write(JSON.stringify({p: process.env.SKIPPY_POLLUTED_ENV ?? null, a: process.env.SKIPPY_OWN_ENV ?? null}))'],
        env: { PATH: process.env['PATH'], SystemRoot: process.env['SystemRoot'], SKIPPY_OWN_ENV: 'own' },
        signal,
      } as never);
      let out = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString()));
      child.on('error', reject);
      child.on('exit', () => setTimeout(() => resolve(out), 50));
      child.stdin.end();
    });
  const polluted = await withPollution(Object.prototype, [['SKIPPY_POLLUTED_ENV', 'inherited']], run, true);
  assert.deepEqual(JSON.parse(polluted), { p: null, a: 'own' });
});

// ── D-B3: MCP broker ─────────────────────────────────────────────────────────

test('D-B3: the production MCP broker `{ policy }` never inherits hooks: letta_edit_core stays denied under Object.prototype.hooks / approver pollution', async () => {
  const charter: Charter = {
    agentId: 'board.coding',
    frontmatter: { permission_mode: 'ask', tools: ['Read'], mcp_servers: ['obsidian', 'letta'] },
    body: 's',
    loaded: true,
    path: '(s)',
  };
  const broker = { policy: derivePolicy(charter, {}) }; // exactly mcp-registry.ts buildMcpServers
  let ran = 0;
  const edit = brokered(broker, 'letta', 'letta_edit_core', () => {
    ran++;
    return Promise.resolve({ content: [{ type: 'text' as const, text: 'EDITED' }] });
  });
  const control = await edit({ block: 'persona', value: 'x' });
  assert.equal(control.isError, true, 'control: denied');
  for (const entries of [
    [['hooks', { approver: () => Promise.resolve(true) }]],
    [['approver', () => Promise.resolve(true)]],
    [['policy', derivePolicy({ ...charter, frontmatter: { ...charter.frontmatter, permission_mode: 'acceptEdits' } }, {})]],
  ] as Array<Array<readonly [string, unknown]>>) {
    await withPollution(Object.prototype, entries, async () => {
      const r = await edit({ block: 'persona', value: 'x' });
      assert.equal(r.isError, true, `${entries[0]?.[0]}: letta_edit_core must stay denied`);
    });
  }
  assert.equal(ran, 0, 'the handler never ran');
  // A broker with no own policy denies everything.
  const orphan = brokered({} as never, 'obsidian', 'obsidian_read_note', () => {
    ran++;
    return Promise.resolve({ content: [{ type: 'text' as const, text: 'x' }] });
  });
  await withPollution(Object.prototype, [['policy', broker.policy]], async () => {
    const r = await orphan({ path: '10_Atomic/x.md' });
    assert.equal(r.isError, true, 'an inherited policy is not a policy');
  });
  assert.equal(ran, 0);
});

// ── D-A1 / D-A2: bare-repo layouts and nested gitdirs ────────────────────────

async function writeDecision(policy: ExecutionPolicy, file: string): Promise<string> {
  return sig(await evaluateToolCall(policy, { toolName: 'Write', input: { file_path: file, content: 'x' } }));
}

test('D-A1: a board cannot assemble a bare-repo layout: HEAD is never writable, nor anything inside a directory that holds a HEAD entry', async () => {
  const f = fixture();
  const policy = derivePolicy(fullCharter(), { worktreePath: f.wt });
  for (const rel of ['HEAD', 'head', 'Head', path.join('sub', 'HEAD'), path.join('deep', 'er', 'HEAD')]) {
    assert.equal(await writeDecision(policy, path.join(f.wt, rel)), 'deny:git_metadata', `Write ${rel}`);
  }
  // Ordinary files (and `objects/` / `refs/` / `config` with no HEAD beside
  // them) stay writable: they are not a git directory.
  for (const rel of [path.join('src', 'b.txt'), path.join('objects', 'x'), path.join('refs', 'heads', 'x'), 'config', 'HEADER.md', path.join('docs', 'head.txt')]) {
    assert.equal(await writeDecision(policy, path.join(f.wt, rel)), 'allow', `Write ${rel}`);
  }
  // A directory that already holds a HEAD entry (planted by an operator, a
  // tool, or a partial layout) is a git directory in waiting: nothing inside
  // it is writable — config, info/attributes, hooks, objects, refs.
  const meta = path.join(f.wt, 'meta');
  fs.mkdirSync(meta, { recursive: true });
  fs.writeFileSync(path.join(meta, 'HEAD'), 'ref: refs/heads/main\n');
  for (const rel of ['config', path.join('info', 'attributes'), path.join('hooks', 'pre-commit'), path.join('objects', 'info', 'x'), path.join('refs', 'heads', 'main'), 'commondir']) {
    assert.equal(await writeDecision(policy, path.join(meta, rel)), 'deny:git_metadata', `Write meta/${rel}`);
  }
  // The root itself holding HEAD (the probe's layout) makes the whole root
  // read-only for writes.
  fs.writeFileSync(path.join(f.wt, 'HEAD'), 'ref: refs/heads/main\n');
  assert.equal(await writeDecision(policy, path.join(f.wt, 'config')), 'deny:git_metadata', 'root with HEAD: config');
  assert.equal(await writeDecision(policy, path.join(f.wt, 'src', 'c.txt')), 'deny:git_metadata', 'root with HEAD: any file');
});

test('D-A2: a nested `.git` FILE pointing at a gitdir inside the root leaves that gitdir unwritable (config, info/attributes)', async () => {
  const f = fixture();
  const meta2 = path.join(f.wt, 'meta2');
  fs.mkdirSync(path.join(meta2, 'objects'), { recursive: true });
  fs.mkdirSync(path.join(meta2, 'refs', 'heads'), { recursive: true });
  fs.mkdirSync(path.join(meta2, 'info'), { recursive: true });
  fs.writeFileSync(path.join(meta2, 'HEAD'), 'ref: refs/heads/main\n');
  fs.mkdirSync(path.join(f.wt, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(f.wt, 'nested', '.git'), `gitdir: ${meta2.split(path.sep).join('/')}\n`);
  const policy = derivePolicy(fullCharter(), { worktreePath: f.wt });
  for (const rel of ['config', path.join('info', 'attributes'), path.join('hooks', 'post-checkout'), 'HEAD']) {
    assert.equal(await writeDecision(policy, path.join(meta2, rel)), 'deny:git_metadata', `Write meta2/${rel}`);
  }
  assert.equal(await writeDecision(policy, path.join(f.wt, 'nested', '.git')), 'deny:git_metadata', 'the .git file itself');
  assert.equal(await writeDecision(policy, path.join(f.wt, 'nested', 'code.ts')), 'allow', 'the nested work tree stays writable');
});

test('D-A1: the executor env pins safe.bareRepository=explicit, and git (when installed) refuses an implicit bare layout under it while normal repos keep working', async () => {
  const pins = new Map(executorEnv.EXECUTOR_GIT_CONFIG_OVERRIDES.map(([k, v]) => [k, v]));
  assert.equal(pins.get('safe.bareRepository'), 'explicit');
  const cfg = executorEnv.createExecutorConfigDir();
  try {
    const env = executorEnv.gitNeutralisationEnv(cfg);
    const n = Number(env['GIT_CONFIG_COUNT']);
    const pairs = Array.from({ length: n }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]);
    assert.ok(pairs.some(([k, v]) => k === 'safe.bareRepository' && v === 'explicit'), JSON.stringify(pairs));
    const git = spawnSync('git', ['--version'], { encoding: 'utf8' });
    if (git.status !== 0) return; // git not installed: the pin itself is asserted above
    const dir = tmpDir('skippy-bare-');
    const bare = path.join(dir, 'bare');
    fs.mkdirSync(path.join(bare, 'objects', 'info'), { recursive: true });
    fs.mkdirSync(path.join(bare, 'refs', 'heads'), { recursive: true });
    fs.writeFileSync(path.join(bare, 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(bare, 'config'), '[core]\n\trepositoryformatversion = 0\n\tbare = true\n[remote "origin"]\n\turl = https://example.invalid/placeholder\n');
    const run = (cwd: string, args: string[], extra: Record<string, string>) =>
      spawnSync('git', args, { cwd, encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', SystemRoot: process.env['SystemRoot'] ?? '', HOME: dir, USERPROFILE: dir, ...extra } });
    const ambient = run(bare, ['config', '--get', 'remote.origin.url'], { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(cfg + executorEnv.EXECUTOR_SUPPORT_DIR_SUFFIX, 'git', 'config') });
    assert.equal(ambient.status, 0, `sensitivity: ambient git discovers the implicit bare repo (${ambient.stderr})`);
    const pinned = run(bare, ['config', '--get', 'remote.origin.url'], env);
    assert.notEqual(pinned.status, 0, `the pinned executor git does not load the bare layout's config: ${pinned.stdout}`);
    const revParse = run(bare, ['rev-parse', '--git-dir'], env);
    assert.notEqual(revParse.status, 0, 'rev-parse refuses the implicit bare repo');
    assert.match(revParse.stderr, /safe\.bareRepository|bare repository/i);
    const repo = path.join(dir, 'repo');
    assert.equal(run(dir, ['init', '-q', repo], env).status, 0);
    assert.equal(run(repo, ['status', '--short'], env).status, 0, 'a normal repository still works under the pin');
  } finally {
    await executorEnv.removeExecutorConfigDir(cfg);
  }
});

test('portability: the fixtures use canonical long temp paths', () => {
  const f = fixture();
  assert.equal(fs.realpathSync.native(f.wt), f.wt);
  if (isWin) assert.doesNotMatch(f.wt, /~\d/);
});
