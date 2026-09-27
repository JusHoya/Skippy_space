// tool-authority-rt4.test.ts — regression suite for the fourth red-team pass
// on T02 "Tool authority" (FR-SEC-01, FR-SEC-02, FR-BOARD-01, G0).
//
//   N2  the production read root was the sidecar's ambient process.cwd()
//       (home directory => ~/.ssh, ~/.claude/.credentials.json readable)
//   N4  the charter parser dropped hyphenated / quoted / indented authority
//       keys so `derivePolicy` never saw them
//   N5  duplicate charter keys: last value silently won
//   +   credential locations are denied even inside an assigned root
//
// Every test here fails on 956c208 and passes after the fix. The probes
// mirror the red-team's p3-charter.mts / p7-cwd.mts.
//
// Run: node --import tsx --test src/tool-authority-rt4.test.ts

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, readdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as charterMod from './charter.js';
import { clearCharterCache, loadCharter, type Charter, type CharterAgentId } from './charter.js';
import { resolveBoardPolicy } from './sdk-board.js';
import {
  ToolPolicyError,
  derivePolicy,
  evaluateToolCall,
  type ExecutionPolicy,
  type PolicyDecision,
} from './tool-policy.js';

delete process.env.OBSIDIAN_API_KEY;
process.env.OBSIDIAN_API_URL = 'http://127.0.0.1:55555';
process.env.LETTA_DISABLED = '1';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const createdTmpDirs: string[] = [];

async function tmpDir(prefix: string): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  createdTmpDirs.push(dir);
  return dir;
}

after(async () => {
  for (const dir of createdTmpDirs) {
    try {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* best effort */
    }
  }
});

/** Parse charter text with the real parser; on the baseline (no such export)
 * the test fails here rather than at module link time. */
function parseText(text: string): { frontmatter: Record<string, unknown>; body: string } {
  const fn = (charterMod as { parseCharterText?: (t: string) => { frontmatter: Record<string, unknown>; body: string } })
    .parseCharterText;
  assert.ok(typeof fn === 'function', 'charter.ts exports parseCharterText (real YAML parser)');
  return fn(text);
}

function synthetic(frontmatter: Record<string, unknown>, loaded = true): Charter {
  return { agentId: 'board.coding', frontmatter, body: 'synthetic body long enough', loaded, path: '(synthetic)' };
}

function policyFromText(fm: string, ctx: Parameters<typeof derivePolicy>[1] = {}): ExecutionPolicy {
  const { frontmatter } = parseText(`---\n${fm}\n---\nbody`);
  return derivePolicy(synthetic(frontmatter), ctx);
}

function refused(fn: () => unknown): ToolPolicyError | Error {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  assert.fail('expected the charter to be refused');
}

function denied(d: PolicyDecision): Extract<PolicyDecision, { allow: false }> {
  assert.equal(d.allow, false, `expected a denial, got ${JSON.stringify(d)}`);
  return d as Extract<PolicyDecision, { allow: false }>;
}

// ── N2: no ambient cwd root ───────────────────────────────────────────────────

test('N2: with no assigned root, resolveBoardPolicy never uses process.cwd() (chdir to home => no roots)', async () => {
  const home = os.homedir();
  const prev = process.cwd();
  process.chdir(home);
  try {
    const policy = await resolveBoardPolicy({
      boardId: 'coding',
      systemPrompt: '',
      model: 'claude-sonnet-4-6',
      missionBrief: '',
      charter: synthetic({ tools: ['Read', 'Glob', 'Grep'] }),
    });
    assert.deepEqual(policy.readRoots, [], 'no read roots without an explicit worktree/project root');
    assert.deepEqual(policy.writeRoots, []);
    assert.notEqual(path.resolve(policy.cwd).toLowerCase(), path.resolve(home).toLowerCase(), 'cwd is not the home dir');
    for (const f of [
      path.join(home, '.ssh', 'id_ed25519'),
      path.join(home, '.claude', '.credentials.json'),
      path.join(home, 'AppData', 'Roaming', 'Code', 'User', 'settings.json'),
      path.join(policy.cwd, 'anything.txt'),
    ]) {
      const d = denied(await evaluateToolCall(policy, { toolName: 'Read', input: { file_path: f } }));
      assert.ok(d.code === 'path_outside_roots' || d.code === 'credential_path', `${f}: ${d.code}`);
    }
    const g = denied(await evaluateToolCall(policy, { toolName: 'Grep', input: { pattern: 'sk-ant-', output_mode: 'content' } }));
    assert.equal(g.code, 'path_outside_roots');
    const gl = denied(await evaluateToolCall(policy, { toolName: 'Glob', input: { pattern: '**/*' } }));
    assert.equal(gl.code, 'path_outside_roots');
  } finally {
    process.chdir(prev);
  }
});

test('N2: cwd is never a root — derivePolicy refuses a bare cwd and a cwd outside the roots', async () => {
  const wt = await tmpDir('skippy-rt4-wt-');
  const other = await tmpDir('skippy-rt4-other-');
  const bare = refused(() => derivePolicy(synthetic({ tools: ['Read'] }), { cwd: wt }));
  assert.ok(bare instanceof ToolPolicyError && bare.code === 'invalid_context', String(bare));
  const outside = refused(() => derivePolicy(synthetic({ tools: ['Read'] }), { worktreePath: wt, cwd: other }));
  assert.ok(outside instanceof ToolPolicyError && outside.code === 'invalid_context', String(outside));
  const inside = derivePolicy(synthetic({ tools: ['Read'] }), { worktreePath: wt, cwd: wt });
  assert.deepEqual(inside.readRoots, [wt]);
});

test('N2: a home directory, an ancestor of it, or a drive root is refused as a root', async () => {
  const home = os.homedir();
  const candidates = [home, path.dirname(home), path.parse(home).root];
  for (const root of candidates) {
    for (const ctx of [{ worktreePath: root }, { projectRoot: root }]) {
      const err = refused(() => derivePolicy(synthetic({ tools: ['Read'] }), ctx));
      assert.ok(err instanceof ToolPolicyError && err.code === 'invalid_root', `${JSON.stringify(ctx)}: ${String(err)}`);
    }
  }
  // A configured project root is a read-only root; a worktree is read+write.
  const wt = await tmpDir('skippy-rt4-wt-');
  const proj = await tmpDir('skippy-rt4-proj-');
  const p = derivePolicy(synthetic({ permission_mode: 'acceptEdits', tools: ['Read', 'Write'] }), { worktreePath: wt, projectRoot: proj });
  assert.deepEqual([...p.readRoots].sort(), [wt, proj].sort());
  assert.deepEqual(p.writeRoots, [wt]);
  assert.equal((await evaluateToolCall(p, { toolName: 'Read', input: { file_path: path.join(proj, 'README.md') } })).allow, true);
  assert.equal(denied(await evaluateToolCall(p, { toolName: 'Write', input: { file_path: path.join(proj, 'x.md'), content: 'x' } })).code, 'path_outside_roots');
});

test('N2: well-known credential locations are denied even inside an assigned worktree (defense in depth)', async () => {
  const wt = await tmpDir('skippy-rt4-wt-');
  await fs.mkdir(path.join(wt, '.ssh'), { recursive: true });
  await fs.mkdir(path.join(wt, '.claude'), { recursive: true });
  await fs.mkdir(path.join(wt, '.codex'), { recursive: true });
  await fs.mkdir(path.join(wt, 'src'), { recursive: true });
  const files = [
    '.ssh/id_ed25519',
    '.aws/credentials',
    '.claude/.credentials.json',
    '.codex/auth.json',
    '.env',
    '.env.local',
    'src/server.pem',
    'src/private.key',
    'id_rsa',
    '.npmrc',
    '.netrc',
    '.git-credentials',
  ];
  for (const rel of files) {
    await fs.mkdir(path.dirname(path.join(wt, rel)), { recursive: true });
    await fs.writeFile(path.join(wt, rel), 'SECRET');
  }
  await fs.writeFile(path.join(wt, 'src', 'index.ts'), 'export {};');
  const policy = derivePolicy(
    synthetic({ permission_mode: 'acceptEdits', tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit'] }),
    { worktreePath: wt },
  );
  // The worktree itself is readable/writable.
  assert.equal((await evaluateToolCall(policy, { toolName: 'Read', input: { file_path: path.join(wt, 'src', 'index.ts') } })).allow, true);
  assert.equal((await evaluateToolCall(policy, { toolName: 'Write', input: { file_path: path.join(wt, 'src', 'new.ts'), content: 'x' } })).allow, true);
  for (const rel of files) {
    const abs = path.join(wt, rel);
    assert.equal(denied(await evaluateToolCall(policy, { toolName: 'Read', input: { file_path: abs } })).code, 'credential_path', `Read ${rel}`);
    assert.equal(denied(await evaluateToolCall(policy, { toolName: 'Edit', input: { file_path: abs, old_string: 'a', new_string: 'b' } })).code, 'credential_path', `Edit ${rel}`);
    assert.equal(denied(await evaluateToolCall(policy, { toolName: 'Grep', input: { pattern: 'x', path: abs } })).code, 'credential_path', `Grep path ${rel}`);
  }
  // Glob / Grep-glob patterns naming credential files or stores are refused too.
  for (const pattern of ['.ssh/*', '**/.aws/**', '*.pem', '.env*', 'src/**/*.key', '{src,.ssh}/*', 'id_rsa*']) {
    assert.equal(denied(await evaluateToolCall(policy, { toolName: 'Glob', input: { pattern } })).code, 'credential_path', `Glob ${pattern}`);
    assert.equal(denied(await evaluateToolCall(policy, { toolName: 'Grep', input: { pattern: 'x', glob: pattern } })).code, 'credential_path', `Grep glob ${pattern}`);
  }
  assert.equal(denied(await evaluateToolCall(policy, { toolName: 'Glob', input: { pattern: '*', path: path.join(wt, '.ssh') } })).code, 'credential_path');
  // F3: the tree rg walks decides, not the pattern — a Glob from the
  // credential-bearing root is denied even for `src/**/*.ts`; the same
  // search from a clean subtree runs.
  await fs.mkdir(path.join(wt, 'clean'), { recursive: true });
  await fs.writeFile(path.join(wt, 'clean', 'index.ts'), 'export {};');
  const fromRoot = denied(await evaluateToolCall(policy, { toolName: 'Glob', input: { pattern: 'src/**/*.ts' } }));
  assert.equal(fromRoot.code, 'credential_path');
  assert.match(fromRoot.reason, /narrow `path`/);
  assert.equal((await evaluateToolCall(policy, { toolName: 'Glob', input: { pattern: '**/*.ts', path: path.join(wt, 'clean') } })).allow, true);
});

// ── N4: charter authority keys cannot be smuggled past the parser ────────────

test('N4: hyphenated, quoted and mis-indented authority keys are honoured or refused, never dropped', () => {
  // A quoted key IS the key: the denial applies.
  const quoted = policyFromText('tools: [Read, Bash]\n"disallowed_tools": [Bash]');
  assert.deepEqual([...quoted.allowedTools], ['Read']);
  // An alias spelling of a known authority key is refused (never silently ignored).
  for (const fm of [
    'tools: [Read, Bash]\ndisallowed-tools: [Bash]',
    'Tools: [Bash]',
    'tools: [Read]\nDisallowed_Tools: [Read]',
    '"permission-mode": acceptEdits\ntools: [Write]',
    'MCP-Servers: [obsidian]',
    '" tools": [Bash]',
  ]) {
    const err = refused(() => policyFromText(fm));
    assert.ok(err instanceof ToolPolicyError && err.code === 'unknown_authority_field', `${JSON.stringify(fm)}: ${String(err)}`);
  }
  // A mis-indented top-level key is a YAML error => the charter is not loaded.
  const indented = refused(() => parseText('---\ntools: [Read, Bash]\n  disallowed_tools: [Bash]\n---\nbody'));
  assert.equal(indented.name, 'CharterParseError', String(indented));
  // An authority key nested below the top level is refused at any depth.
  for (const fm of ['memory:\n  tools: [Bash]', 'memory:\n  vault_subdir: x/\n  permission_mode: acceptEdits', 'costume:\n  extra:\n    - allowed_tools: [Bash]']) {
    const err = refused(() => policyFromText(fm));
    assert.ok(err instanceof ToolPolicyError && err.code === 'unknown_authority_field', `${JSON.stringify(fm)}: ${String(err)}`);
  }
  // Unknown authority-looking top-level keys still fail closed after normalisation.
  for (const fm of ['allowed-tools: [Bash]', 'Dangerously-Skip-Permissions: true', 'sandbox: false']) {
    const err = refused(() => policyFromText(fm));
    assert.ok(err instanceof ToolPolicyError && err.code === 'unknown_authority_field', `${JSON.stringify(fm)}: ${String(err)}`);
  }
});

test('N4: anchors, aliases, merge keys, non-mapping documents and bypass modes are refused', () => {
  for (const fm of [
    'base: &b [Read, Bash]\ntools: *b',
    'tools: [Read]\ndisallowed_tools: &d []',
    'x: {a: 1}\n<<: {tools: [Bash]}',
    '- tools\n- Bash',
    'tools: [Read,\n  Bash',
  ]) {
    const err = refused(() => parseText(`---\n${fm}\n---\nbody`));
    assert.equal(err.name, 'CharterParseError', `${JSON.stringify(fm)}: ${String(err)}`);
  }
  // Quoted scalars may contain `&`, `*` and `<<` freely.
  const ok = parseText('---\ndisplay_name: "R&D *lead* <<fast>>"\nmemory:\n  core_memory_facts:\n    - \'I *never* bypass & I know it\'\n---\nbody');
  assert.equal(ok.frontmatter['display_name'], 'R&D *lead* <<fast>>');
  // The BOM and CRLF forms parse like the plain form.
  const bom = parseText('﻿---\r\ntools: [Read, Bash]\r\ndisallowed_tools: [Bash]\r\n---\r\nbody');
  assert.deepEqual(bom.frontmatter, { tools: ['Read', 'Bash'], disallowed_tools: ['Bash'] });
  for (const fm of ['"permission_mode": bypassPermissions\ntools: [Read]', 'permission_mode: bypassPermissions']) {
    const err = refused(() => policyFromText(fm));
    assert.ok(err instanceof ToolPolicyError && err.code === 'bypass_forbidden', String(err));
  }
  // Multi-line flow sequences and block sequences with comments are real YAML.
  const flow = policyFromText('tools: [Read,\n  Bash]\ndisallowed_tools: [Bash]');
  assert.deepEqual([...flow.allowedTools], ['Read']);
  const block = policyFromText('tools:\n  - Read\n  - Bash  # allowed\ndisallowed_tools: [Bash]');
  assert.deepEqual([...block.allowedTools], ['Read']);
});

// ── N5: duplicate keys ────────────────────────────────────────────────────────

test('N5: duplicate authority keys are a parse error (last value never silently wins)', () => {
  for (const fm of [
    'permission_mode: plan\ntools: [Read, Write]\npermission_mode: acceptEdits',
    'tools: [Read, Bash]\ndisallowed_tools: [Bash]\ndisallowed_tools: []',
    'tools: [Read]\ntools: [Read, Bash, Write]',
    'mcp_servers: [obsidian]\nmcp_servers: [obsidian, letta]',
    'display_name: a\ndisplay_name: b',
  ]) {
    const err = refused(() => parseText(`---\n${fm}\n---\nbody`));
    assert.equal(err.name, 'CharterParseError', `${JSON.stringify(fm)}: ${String(err)}`);
    assert.match(err.message, /duplicated mapping key/i);
  }
});

// ── Every real charter still loads and derives a policy ──────────────────────

test('all real charters (skippy, boards, staff, tasks) parse with the real YAML parser and derive without bypass', async () => {
  clearCharterCache();
  const boards = readdirSync(path.join(REPO_ROOT, 'agent_space', 'boards')).filter((f) => f.endsWith('.md'));
  const staff = readdirSync(path.join(REPO_ROOT, 'agent_space', 'staff')).filter((f) => f.endsWith('.md'));
  const ids: CharterAgentId[] = [
    'skippy',
    ...boards.map((f) => `board.${f.slice(0, -3)}` as CharterAgentId),
    ...staff.map((f) => `staff.${f.slice(0, -3)}` as CharterAgentId),
  ];
  assert.equal(boards.length, 8);
  for (const id of ids) {
    const c = await loadCharter(id);
    assert.equal(c.loaded, true, `${id} loaded (${JSON.stringify(c.frontmatter['error'] ?? '')})`);
    assert.ok(typeof c.frontmatter['permission_mode'] === 'string', `${id} has permission_mode`);
    assert.ok(Array.isArray(c.frontmatter['tools']), `${id} has tools`);
    const policy = derivePolicy(c, {});
    assert.notEqual(policy.sdkPermissionMode as string, 'bypassPermissions');
    assert.deepEqual(policy.readRoots, [], `${id}: no roots without an execution context`);
  }
  // Task charters are not addressable by CharterAgentId yet; parse them directly.
  const tasksDir = path.join(REPO_ROOT, 'agent_space', 'tasks');
  const tasks = readdirSync(tasksDir).filter((f) => f.endsWith('.md'));
  assert.ok(tasks.length >= 4);
  for (const f of tasks) {
    const text = await fs.readFile(path.join(tasksDir, f), 'utf8');
    const parsed = parseText(text);
    assert.equal(parsed.frontmatter['task'], f.slice(0, -3), `${f}: task id`);
    const policy = derivePolicy({ agentId: 'board.coding', frontmatter: parsed.frontmatter, body: parsed.body, loaded: true, path: f }, {});
    assert.notEqual(policy.sdkPermissionMode as string, 'bypassPermissions', f);
  }
});
