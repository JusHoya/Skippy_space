// tool-authority-git-surface.test.ts — M1 pre-flight, final M0-G06/M0-G07
// round (FR-SEC-01, FR-SEC-02, OQ-22). Offline and portable (Linux +
// Windows; canonical long temp paths; junctions on Windows, symlinks on
// POSIX).
//
// D-A — git metadata is never board-writable: the CLI runs `git status` in
//   the worktree at startup and the repo configuration decides what that
//   executes. A `.git` segment at any depth (directory or gitdir FILE), the
//   gitdir a write root's `.git` file/link points to and its `commondir`,
//   `.gitattributes`, `.gitmodules` and `.gitconfig` are denied for every
//   write-class built-in, on the literal and on the real path. `.gitignore`
//   and reads stay allowed.
// D-B — enforcement hooks are own-property reads captured once: polluting
//   `Object.prototype` / `Function.prototype` (by an observer, or anywhere in
//   the process), inheriting a hook through a prototype, or mutating the
//   hooks object after construction never changes a later decision — raw
//   gate, PreToolUse + canUseTool, and the MCP broker. Observer snapshots are
//   frozen null-prototype copies (no `constructor` route).
// No-root cwd — a board with no roots runs in a fresh per-execution
//   directory inside the executor state base (never a root, gone after the
//   run); `SKIPPY_NO_ROOT_CWD` is ignored; a policy derived without one gets
//   an uncreated placeholder inside the base.
// Env — the executor's git is neutralised (`CLAUDE_CODE_DISABLE_GIT_
//   INSTRUCTIONS`, `GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL` = empty file,
//   `GIT_CONFIG_COUNT` overrides, empty hooks dir).
// Sweep — stale `run-*` directories and the legacy persistent directories
//   are removed; junctions/symlinks named like a run are skipped (never
//   followed); fresh and active runs are kept; foreign names are untouched.
//
// Run: node --import tsx --test src/tool-authority-git-surface.test.ts

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Charter } from './charter.js';
import * as executorEnv from './executor-env.js';
import { executeBoardMissionViaSdk, type ClaudeAgentSdkModule } from './sdk-board.js';
import {
  authorizeMcpDispatch,
  buildClaudeSdkPermissionOptions,
  derivePolicy,
  evaluateToolCall,
  gitDirTargets,
  gitMetadataRejection,
  rootRejection,
  unassignedNoRootCwd,
  type PolicyDecision,
} from './tool-policy.js';

const isWin = process.platform === 'win32';
const created: string[] = [];
after(() => {
  for (const d of created) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function tmpDir(prefix: string): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  created.push(dir);
  return dir;
}

/** A worktree on the canonical long temp path with a plain `.git` directory. */
function worktree(): string {
  const wt = path.join(tmpDir('skippy-gitsurf-'), 'wt');
  fs.mkdirSync(path.join(wt, 'src'), { recursive: true });
  fs.mkdirSync(path.join(wt, '.git', 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(wt, '.git', 'info'), { recursive: true });
  fs.writeFileSync(path.join(wt, '.git', 'config'), '[core]\n\tbare = false\n');
  fs.writeFileSync(path.join(wt, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(wt, 'src', 'a.ts'), 'PLACEHOLDER\n');
  fs.writeFileSync(path.join(wt, '.gitignore'), 'dist/\n');
  return wt;
}

function link(target: string, at: string): void {
  fs.symlinkSync(target, at, isWin ? 'junction' : 'dir');
}

const charter = (tools: string[], mode = 'acceptEdits'): Charter => ({
  agentId: 'board.coding',
  frontmatter: { permission_mode: mode, tools },
  body: 'synthetic',
  loaded: true,
  path: '(synthetic)',
});

const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

function writeCall(tool: string, target: string): { toolName: string; input: Record<string, unknown> } {
  switch (tool) {
    case 'Write':
      return { toolName: tool, input: { file_path: target, content: 'x' } };
    case 'Edit':
      return { toolName: tool, input: { file_path: target, old_string: 'a', new_string: 'b' } };
    case 'MultiEdit':
      return { toolName: tool, input: { file_path: target, edits: [{ old_string: 'a', new_string: 'b' }] } };
    default:
      return { toolName: 'NotebookEdit', input: { notebook_path: target, new_source: 'x' } };
  }
}

function denied(d: PolicyDecision): Extract<PolicyDecision, { allow: false }> {
  assert.equal(d.allow, false, `expected a denial, got ${JSON.stringify(d)}`);
  return d as Extract<PolicyDecision, { allow: false }>;
}

// ── D-A: git metadata is never board-writable ─────────────────────────────────

test('D-A: every write-class built-in is denied on git metadata at any depth (literal path), and ordinary files stay writable', async () => {
  const wt = worktree();
  const policy = derivePolicy(charter([...WRITE_TOOLS, 'Read']), { worktreePath: wt });
  const metadata = [
    path.join(wt, '.git'),
    path.join(wt, '.git', 'config'),
    path.join(wt, '.GIT', 'config'),
    path.join(wt, '.Git', 'CONFIG'),
    path.join(wt, '.git', 'hooks', 'pre-commit'),
    path.join(wt, '.git', 'info', 'attributes'),
    path.join(wt, '.git', 'modules', 'sub', 'config'),
    path.join(wt, '.git', 'config.worktree'),
    path.join(wt, 'sub', '.git'), // a NEW .git entry (file or dir)
    path.join(wt, 'sub', 'deeper', '.git', 'config'),
    path.join(wt, '.gitattributes'),
    path.join(wt, 'src', '.gitattributes'),
    path.join(wt, '.gitmodules'),
    path.join(wt, '.gitconfig'),
    path.join(wt, 'src', '.GitModules'),
    'src/../.git/config', // relative to the cwd (the worktree)
    '.gitattributes',
  ];
  for (const target of metadata) {
    for (const tool of WRITE_TOOLS) {
      const d = denied(await evaluateToolCall(policy, writeCall(tool, target)));
      assert.equal(d.code, 'git_metadata', `${tool} ${target}: ${JSON.stringify(d)}`);
      assert.match(d.reason, /never board-writable/, d.reason);
    }
  }
  // Credential-named git files stay credential denials (already covered).
  const cred = denied(await evaluateToolCall(policy, writeCall('Write', path.join(wt, '.git-credentials'))));
  assert.equal(cred.code, 'credential_path');
  // Positive controls: not metadata.
  for (const ok of [
    path.join(wt, '.gitignore'),
    path.join(wt, 'src', '.gitignore'),
    path.join(wt, 'src', 'a.ts'),
    path.join(wt, 'git', 'config'),
    path.join(wt, '.github', 'workflows', 'ci.yml'),
    path.join(wt, 'src', '.gitkeep'),
    path.join(wt, 'gitattributes.txt'),
    path.join(wt, 'a.git', 'x.txt'), // `a.git` is not the `.git` segment
  ]) {
    const d = await evaluateToolCall(policy, writeCall('Write', ok));
    assert.equal(d.allow, true, `${ok}: ${JSON.stringify(d)}`);
  }
  // Reads of git metadata stay allowed (the repo is in the read scope).
  const read = await evaluateToolCall(policy, { toolName: 'Read', input: { file_path: path.join(wt, '.git', 'config') } });
  assert.equal(read.allow, true, JSON.stringify(read));
});

test('D-A: git metadata reached through a junction/symlink is denied on the real path', async () => {
  const wt = worktree();
  const policy = derivePolicy(charter(WRITE_TOOLS), { worktreePath: wt });
  link(path.join(wt, '.git'), path.join(wt, 'meta'));
  link(path.join(wt, '.git', 'hooks'), path.join(wt, 'src', 'h'));
  for (const target of [path.join(wt, 'meta', 'config'), path.join(wt, 'meta', 'hooks', 'pre-commit'), path.join(wt, 'src', 'h', 'post-checkout')]) {
    const d = denied(await evaluateToolCall(policy, writeCall('Write', target)));
    assert.equal(d.code, 'git_metadata', `${target}: ${JSON.stringify(d)}`);
    assert.match(d.reason, /\.git/);
  }
  assert.match(gitMetadataRejection(path.join(wt, 'meta', 'config'), [wt]) ?? '', /\.git/);
  assert.equal(gitMetadataRejection(path.join(wt, 'src', 'b.ts'), [wt]), null);
});

test('D-A: a `.git` FILE (gitdir: …) or `.git` link makes its gitdir and commondir unwritable, wherever they are named', async () => {
  const dir = tmpDir('skippy-gitdir-');
  // wt: `.git` is a file pointing at `.g2`, whose `commondir` names `.shared`.
  const wt = path.join(dir, 'wt');
  fs.mkdirSync(path.join(wt, '.g2', 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(wt, '.shared', 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(wt, '.g2x'), { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), 'gitdir: .g2\n');
  fs.writeFileSync(path.join(wt, '.g2', 'config'), '');
  fs.writeFileSync(path.join(wt, '.g2', 'commondir'), '../.shared\n');
  fs.writeFileSync(path.join(wt, '.shared', 'config'), '');
  fs.writeFileSync(path.join(wt, 'a.txt'), 'x\n');
  const targets = gitDirTargets(wt).map((p) => p.toLowerCase());
  assert.ok(targets.includes(path.join(wt, '.g2').toLowerCase()), targets.join(','));
  assert.ok(targets.includes(path.join(wt, '.shared').toLowerCase()), targets.join(','));
  const policy = derivePolicy(charter(WRITE_TOOLS), { worktreePath: wt });
  for (const target of [
    path.join(wt, '.git'),
    path.join(wt, '.g2'),
    path.join(wt, '.g2', 'config'),
    path.join(wt, '.g2', 'hooks', 'fsmonitor-watchman'),
    path.join(wt, '.g2', 'info', 'attributes'),
    path.join(wt, '.shared', 'config'),
    path.join(wt, '.shared', 'hooks', 'pre-commit'),
  ]) {
    for (const tool of WRITE_TOOLS) {
      const d = denied(await evaluateToolCall(policy, writeCall(tool, target)));
      assert.equal(d.code, 'git_metadata', `${tool} ${target}: ${JSON.stringify(d)}`);
    }
  }
  // Only the designated directories: a sibling that merely shares a prefix,
  // and ordinary files, remain writable.
  for (const ok of [path.join(wt, '.g2x', 'config'), path.join(wt, 'a.txt')]) {
    const d = await evaluateToolCall(policy, writeCall('Write', ok));
    assert.equal(d.allow, true, `${ok}: ${JSON.stringify(d)}`);
  }
  // wt3: `.git` is a reparse point onto a directory inside the root.
  const wt3 = path.join(dir, 'wt3');
  fs.mkdirSync(path.join(wt3, '.g3'), { recursive: true });
  fs.writeFileSync(path.join(wt3, '.g3', 'config'), '');
  link(path.join(wt3, '.g3'), path.join(wt3, '.git'));
  const p3 = derivePolicy(charter(WRITE_TOOLS), { worktreePath: wt3 });
  const d3 = denied(await evaluateToolCall(p3, writeCall('Write', path.join(wt3, '.g3', 'config'))));
  assert.equal(d3.code, 'git_metadata', JSON.stringify(d3));
  assert.match(d3.reason, /git directory/);
  // A gitdir OUTSIDE the root is denied by root containment anyway.
  const wt4 = path.join(dir, 'wt4');
  fs.mkdirSync(wt4, { recursive: true });
  fs.mkdirSync(path.join(dir, 'g4'));
  fs.writeFileSync(path.join(wt4, '.git'), `gitdir: ${path.join(dir, 'g4')}\n`);
  const p4 = derivePolicy(charter(WRITE_TOOLS), { worktreePath: wt4 });
  const d4 = denied(await evaluateToolCall(p4, writeCall('Write', path.join(dir, 'g4', 'config'))));
  assert.ok(d4.code === 'git_metadata' || d4.code === 'path_outside_roots', JSON.stringify(d4));
});

test('D-A: Win32 aliases of `.git` (8.3 short name, trailing dot/space, ADS) are refused as paths', { skip: !isWin }, async () => {
  const wt = worktree();
  const policy = derivePolicy(charter(['Write']), { worktreePath: wt });
  for (const target of [path.join(wt, 'GIT~1', 'config'), path.join(wt, '.git.', 'config'), path.join(wt, '.git ', 'config'), `${path.join(wt, '.git')}:stream`]) {
    const d = denied(await evaluateToolCall(policy, writeCall('Write', target)));
    assert.ok(d.code === 'path_outside_roots' || d.code === 'git_metadata', `${target}: ${JSON.stringify(d)}`);
  }
});

// ── D-B: prototype pollution cannot substitute a hook ─────────────────────────

const PROTO_KEYS = ['pathGuard', 'approver', 'onDecision'] as const;
function pollute(): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const permissiveGuard = async (): Promise<{ ok: true }> => {
    calls.push('pathGuard');
    return { ok: true };
  };
  const yesApprover = async (): Promise<boolean> => {
    calls.push('approver');
    return true;
  };
  const observer = (): void => {
    calls.push('onDecision');
  };
  const protos: object[] = [Object.prototype, Function.prototype, Array.prototype];
  for (const proto of protos) {
    Object.defineProperty(proto, 'pathGuard', { value: permissiveGuard, configurable: true, writable: true, enumerable: false });
    Object.defineProperty(proto, 'approver', { value: yesApprover, configurable: true, writable: true, enumerable: false });
    Object.defineProperty(proto, 'onDecision', { value: observer, configurable: true, writable: true, enumerable: false });
  }
  return {
    calls,
    restore: () => {
      for (const proto of protos) for (const k of PROTO_KEYS) delete (proto as Record<string, unknown>)[k];
    },
  };
}

function outsideFile(wt: string): string {
  const outside = path.join(path.dirname(wt), 'outside');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'o.txt'), 'OUTSIDE\n');
  return path.join(outside, 'o.txt');
}

test('D-B (raw gate): Object/Function/Array prototype pollution never supplies a guard, approver or observer to evaluateToolCall', async () => {
  const wt = worktree();
  const outside = outsideFile(wt);
  const policy = derivePolicy(charter(['Read', 'Bash'], 'ask'), { worktreePath: wt });
  const p = pollute();
  try {
    for (const hooks of [{}, undefined, Object.create({ pathGuard: async () => ({ ok: true }), approver: async () => true }) as object]) {
      const read = denied(await evaluateToolCall(policy, { toolName: 'Read', input: { file_path: outside } }, hooks as never));
      assert.equal(read.code, 'path_outside_roots', JSON.stringify(read));
      const bash = denied(await evaluateToolCall(policy, { toolName: 'Bash', input: { command: 'echo 1' } }, hooks as never));
      assert.equal(bash.code, 'approval_required', JSON.stringify(bash));
    }
    assert.deepEqual(p.calls, [], 'no polluted hook was ever invoked');
  } finally {
    p.restore();
  }
});

test('D-B (SDK gate): an observer that pollutes Object.prototype / Function.prototype cannot change the next PreToolUse or canUseTool decision; the snapshot has no prototype', async () => {
  const wt = worktree();
  const outside = outsideFile(wt);
  const policy = derivePolicy(charter(['Read', 'Bash'], 'ask'), { worktreePath: wt });
  const seen: unknown[] = [];
  let polluter: { calls: string[]; restore: () => void } | undefined;
  const hooks = {
    onDecision: (e: unknown) => {
      seen.push(e);
      const ev = e as { constructor?: unknown; decision?: { allow?: boolean } };
      // No `constructor` route: the snapshot is a null-prototype copy.
      assert.equal(Object.getPrototypeOf(e), null);
      assert.equal(ev.constructor, undefined);
      assert.ok(Object.isFrozen(e));
      assert.ok(Object.isFrozen(ev.decision));
      // So the observer pollutes the real prototypes directly.
      polluter ??= pollute();
      // …and tries to mutate the hooks object it handed in.
      (hooks as Record<string, unknown>)['pathGuard'] = async () => ({ ok: true });
      (hooks as Record<string, unknown>)['approver'] = async () => true;
    },
  };
  const gate = buildClaudeSdkPermissionOptions(policy, hooks);
  const pre = gate.hooks.PreToolUse?.[0]?.hooks[0];
  assert.ok(pre);
  const sig = { signal: new AbortController().signal };
  try {
    const call = (id: string) =>
      pre({ hook_event_name: 'PreToolUse', session_id: 's', transcript_path: 't', cwd: wt, tool_name: 'Read', tool_input: { file_path: outside }, tool_use_id: id } as never, id, sig);
    const first = (await call('a1')) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
    assert.equal(first.hookSpecificOutput?.permissionDecision, 'deny');
    assert.ok(polluter, 'the observer ran and polluted the prototypes');
    const second = (await call('a2')) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
    assert.equal(second.hookSpecificOutput?.permissionDecision, 'deny', JSON.stringify(second));
    assert.match(second.hookSpecificOutput?.permissionDecisionReason ?? '', /path_outside_roots/);
    const cu = await gate.canUseTool('Read', { file_path: outside }, { ...sig, toolUseID: 'a3' } as never);
    assert.equal(cu.behavior, 'deny', JSON.stringify(cu));
    const bash1 = await gate.canUseTool('Bash', { command: 'echo 1' }, { ...sig, toolUseID: 'b1' } as never);
    assert.equal(bash1.behavior, 'deny', JSON.stringify(bash1));
    const bash2 = await gate.canUseTool('Bash', { command: 'echo 2' }, { ...sig, toolUseID: 'b2' } as never);
    assert.equal(bash2.behavior, 'deny', JSON.stringify(bash2));
    assert.match((bash2 as { message?: string }).message ?? '', /approval_required/);
    assert.deepEqual(polluter?.calls, [], 'no polluted hook was ever invoked');
    assert.ok(seen.length >= 4, `the observer kept observing (${seen.length})`);
  } finally {
    polluter?.restore();
  }
});

test('D-B (MCP broker): pollution and an inherited approver never approve a vault write', async () => {
  const wt = worktree();
  const charterWithVault: Charter = {
    ...charter([], 'ask'),
    frontmatter: { permission_mode: 'ask', tools: [], mcp_servers: ['obsidian'], memory: { vault_subdir: 'boards/coding' } },
  };
  const policy = derivePolicy(charterWithVault, { worktreePath: wt });
  const p = pollute();
  try {
    const inherited = Object.create({ approver: async () => true }) as object;
    for (const hooks of [{}, inherited]) {
      const d = denied(await authorizeMcpDispatch(policy, 'obsidian', 'obsidian_write_note', { path: 'boards/coding/x.md', content: 'y' }, hooks));
      assert.equal(d.code, 'approval_required', JSON.stringify(d));
    }
    // An OWN approver is honoured (so the previous denials are the rule, not
    // a broken approval path).
    const own = await authorizeMcpDispatch(policy, 'obsidian', 'obsidian_write_note', { path: 'boards/coding/x.md', content: 'y' }, { approver: async () => true });
    assert.equal(own.allow, true, JSON.stringify(own));
    assert.deepEqual(p.calls, []);
  } finally {
    p.restore();
  }
});

// ── Per-run no-root cwd + git-neutralising env ────────────────────────────────

const success = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'All done, monkeys! Magnificent.',
  stop_reason: 'end_turn',
  terminal_reason: 'completed',
  permission_denials: [],
};

function fakeSdk(body: (options: Record<string, unknown>) => unknown[]): { loadSdk: () => Promise<ClaudeAgentSdkModule> } {
  const query = ((args: { options: Record<string, unknown> }) => {
    return (async function* () {
      for (const m of body(args.options)) yield m;
    })();
  }) as unknown as ClaudeAgentSdkModule['query'];
  return { loadSdk: () => Promise.resolve({ query }) };
}

test('no-root cwd: a board with no roots runs in a fresh per-execution directory inside the executor state base, gone afterwards; SKIPPY_NO_ROOT_CWD is ignored', async () => {
  const hostile = tmpDir('skippy-hostile-cwd-');
  const savedEnv = process.env.SKIPPY_NO_ROOT_CWD;
  process.env.SKIPPY_NO_ROOT_CWD = hostile;
  const seen: Array<{ cwd: string; cfg: string; existed: boolean; entries: string[] }> = [];
  try {
    for (let i = 0; i < 2; i++) {
      const sdk = fakeSdk((o) => {
        const cwd = o['cwd'] as string;
        const cfg = (o['env'] as Record<string, string>)['CLAUDE_CONFIG_DIR'] as string;
        seen.push({ cwd, cfg, existed: fs.existsSync(cwd), entries: fs.existsSync(cwd) ? fs.readdirSync(cwd) : ['(missing)'] });
        return [success];
      });
      const r = await executeBoardMissionViaSdk(
        { boardId: 'coding', systemPrompt: 'x', model: 'claude-sonnet-4-6' as never, missionBrief: 'm', charter: charter(['Read'], 'ask') },
        { loadSdk: sdk.loadSdk },
      );
      assert.equal(r.status, 'succeeded', JSON.stringify(r));
    }
  } finally {
    if (savedEnv === undefined) delete process.env.SKIPPY_NO_ROOT_CWD;
    else process.env.SKIPPY_NO_ROOT_CWD = savedEnv;
  }
  assert.equal(seen.length, 2);
  const [a, b] = seen as [(typeof seen)[0], (typeof seen)[0]];
  assert.notEqual(a.cwd, b.cwd, 'a different directory per run');
  for (const s of seen) {
    assert.equal(s.cwd, executorEnv.noRootWorkingDirectory(s.cfg), 'the run support directory beside the config dir');
    assert.ok(s.existed, 'exists while the CLI runs');
    assert.deepEqual(s.entries, [], 'empty');
    assert.equal(fs.existsSync(s.cwd), false, 'gone after the run');
    assert.equal(fs.existsSync(executorEnv.executorSupportDir(s.cfg)), false, 'support dir gone after the run');
    assert.notEqual(s.cwd.toLowerCase(), hostile.toLowerCase(), 'the environment did not choose it');
    assert.match(rootRejection(s.cwd) ?? '', /executor state directory/, 'can never be a root');
  }
  // A policy derived WITHOUT a per-run cwd gets an uncreated placeholder
  // inside the base; one with a cwd outside the base is refused.
  const bare = derivePolicy(charter(['Read'], 'ask'));
  assert.equal(bare.cwd, unassignedNoRootCwd());
  assert.equal(fs.existsSync(bare.cwd), false);
  assert.match(rootRejection(bare.cwd) ?? '', /executor state directory/);
  assert.throws(() => derivePolicy(charter(['Read'], 'ask'), { noRootCwd: hostile }), (e: unknown) => (e as { code?: string }).code === 'invalid_context');
  // With a root, the cwd is the root, whatever noRootCwd says.
  const wt = worktree();
  assert.equal(derivePolicy(charter(['Read'], 'ask'), { worktreePath: wt, noRootCwd: hostile }).cwd, wt);
});

test('env: the executor env neutralises git (startup status off, no system/global config, pinned code-running keys, empty hooks dir)', () => {
  const cfg = executorEnv.createExecutorConfigDir();
  try {
    const env = executorEnv.buildClaudeExecutorEnv({ GIT_CONFIG_COUNT: '9', GIT_CONFIG_GLOBAL: '/x', GIT_DIR: '/y', GIT_CONFIG_PARAMETERS: "'core.fsmonitor=true'" }, cfg);
    assert.equal(env['CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS'], '1');
    assert.equal(env['GIT_CONFIG_NOSYSTEM'], '1');
    assert.equal(env['GIT_TERMINAL_PROMPT'], '0');
    assert.equal(env['GIT_DIR'], undefined, 'ambient GIT_* is not copied');
    assert.equal(env['GIT_CONFIG_PARAMETERS'], undefined);
    const global = env['GIT_CONFIG_GLOBAL'] as string;
    assert.equal(global, executorEnv.executorGitPaths(cfg).config);
    assert.ok(fs.statSync(global).isFile());
    assert.equal(fs.readFileSync(global, 'utf8'), '', 'the global config is empty');
    const n = Number(env['GIT_CONFIG_COUNT']);
    assert.equal(n, executorEnv.EXECUTOR_GIT_CONFIG_OVERRIDES.length);
    const pairs = new Map<string, string>();
    for (let i = 0; i < n; i++) pairs.set(env[`GIT_CONFIG_KEY_${i}`] as string, env[`GIT_CONFIG_VALUE_${i}`] as string);
    assert.equal(pairs.get('core.fsmonitor'), 'false');
    assert.equal(pairs.get('core.untrackedCache'), 'false');
    assert.equal(pairs.get('core.pager'), 'cat');
    const hooks = pairs.get('core.hooksPath') as string;
    assert.equal(hooks, executorEnv.executorGitPaths(cfg).hooks);
    assert.ok(fs.statSync(hooks).isDirectory());
    assert.deepEqual(fs.readdirSync(hooks), [], 'the hooks dir is empty');
    // Everything per-run lives beside the config dir, which stays empty.
    assert.deepEqual(fs.readdirSync(cfg), []);
    assert.ok(fs.statSync(executorEnv.noRootWorkingDirectory(cfg)).isDirectory());
    // The support dir is not itself a config dir, and a config dir without
    // its support dir is refused.
    assert.equal(executorEnv.isExecutorConfigDir(executorEnv.executorSupportDir(cfg)), false);
    assert.throws(() => executorEnv.buildClaudeExecutorEnv({}, executorEnv.executorSupportDir(cfg)), /not a per-execution directory/);
  } finally {
    void executorEnv.removeExecutorConfigDir(cfg);
  }
});

// ── Sweep ─────────────────────────────────────────────────────────────────────

test('sweep: stale run dirs and the legacy persistent dirs are removed; junctions named like a run are skipped (never followed); fresh, active and foreign entries are kept', async () => {
  const root = tmpDir('skippy-sweep-');
  const tmp = path.join(root, 'tmp');
  const base = path.join(tmp, 'skippy-agent-runtime', 'executor-config');
  fs.mkdirSync(base, { recursive: true });
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const mk = (p: string, stale: boolean): string => {
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, 'x.txt'), 'x');
    if (stale) fs.utimesSync(p, old, old);
    return p;
  };
  const staleRun = mk(path.join(base, 'run-old123'), true);
  const staleSupport = mk(path.join(base, 'run-old123.support'), true);
  const freshRun = mk(path.join(base, 'run-fresh1'), false);
  const foreign = mk(path.join(base, 'other-dir'), true);
  fs.writeFileSync(path.join(base, 'run-file'), 'not a dir');
  fs.utimesSync(path.join(base, 'run-file'), old, old);
  // A junction named like a stale run pointing at a victim directory.
  const victim = mk(path.join(root, 'victim'), true);
  link(victim, path.join(base, 'run-x'));
  fs.utimesSync(victim, old, old);
  // Legacy persistent directories (real) and one that is a junction.
  const legacyCfg = mk(path.join(tmp, 'skippy-agent-runtime', 'claude-config'), false);
  fs.writeFileSync(path.join(legacyCfg, '.claude.json'), '{}');
  const legacyNoRoot = mk(path.join(tmp, 'skippy-agent-runtime', 'no-root'), false);
  fs.mkdirSync(path.join(legacyNoRoot, '.git'));
  const result = executorEnv.sweepExecutorState({ base, tmp });
  const removed = result.removed.map((p) => p.toLowerCase()).sort();
  assert.deepEqual(removed, [staleRun, staleSupport, legacyCfg, legacyNoRoot].map((p) => p.toLowerCase()).sort());
  assert.equal(fs.existsSync(staleRun), false);
  assert.equal(fs.existsSync(staleSupport), false);
  assert.equal(fs.existsSync(legacyCfg), false);
  assert.equal(fs.existsSync(legacyNoRoot), false);
  assert.ok(fs.existsSync(freshRun), 'a fresh run is kept');
  assert.ok(fs.existsSync(foreign) && fs.existsSync(path.join(foreign, 'x.txt')), 'a foreign name is untouched');
  assert.ok(fs.existsSync(path.join(base, 'run-file')), 'a file is untouched');
  assert.ok(fs.lstatSync(path.join(base, 'run-x')).isSymbolicLink(), 'the junction is left in place');
  assert.ok(fs.existsSync(path.join(victim, 'x.txt')), 'the junction target is intact');
  assert.ok(result.skipped.some((p) => p.toLowerCase() === path.join(base, 'run-x').toLowerCase()));
  // A legacy path that is a junction is skipped too.
  fs.rmSync(path.join(base, 'run-x'));
  link(victim, path.join(tmp, 'skippy-agent-runtime', 'claude-config'));
  const again = executorEnv.sweepExecutorState({ base, tmp });
  assert.deepEqual(again.removed, []);
  assert.ok(fs.existsSync(path.join(victim, 'x.txt')));
  // An ACTIVE run of this process is never swept, however old it looks.
  const active = executorEnv.createExecutorConfigDir();
  try {
    fs.utimesSync(active, old, old);
    fs.utimesSync(executorEnv.executorSupportDir(active), old, old);
    const live = executorEnv.sweepExecutorState();
    assert.ok(fs.existsSync(active), 'active run kept');
    assert.ok(fs.existsSync(executorEnv.executorSupportDir(active)), 'active support dir kept');
    assert.ok(!live.removed.some((p) => p.toLowerCase() === active.toLowerCase()));
  } finally {
    assert.equal(await executorEnv.removeExecutorConfigDir(active), true);
  }
  // …and a run whose recorded owner process is gone is swept once stale
  // (in the private base: other test processes sweep the real one too).
  const orphan = mk(path.join(base, 'run-orphan1'), true);
  const orphanSupport = mk(path.join(base, 'run-orphan1.support'), true);
  fs.writeFileSync(path.join(orphanSupport, 'pid'), '2147483647\n');
  fs.utimesSync(orphanSupport, old, old);
  const after = executorEnv.sweepExecutorState({ base, tmp });
  assert.ok(after.removed.some((p) => p.toLowerCase() === orphan.toLowerCase()), after.removed.join(','));
  assert.equal(fs.existsSync(orphan), false);
  assert.equal(fs.existsSync(orphanSupport), false);
  // …while a stale-looking run whose recorded owner is THIS process is kept
  // even by a sweep that does not hold it in its active set (another
  // process's view).
  const foreignOwned = mk(path.join(base, 'run-owned1'), true);
  const foreignSupport = mk(path.join(base, 'run-owned1.support'), true);
  fs.writeFileSync(path.join(foreignSupport, 'pid'), `${process.pid}\n`);
  fs.utimesSync(foreignSupport, old, old);
  executorEnv.sweepExecutorState({ base, tmp });
  assert.ok(fs.existsSync(foreignOwned) && fs.existsSync(foreignSupport), 'a run with a live owner pid is kept');
});
