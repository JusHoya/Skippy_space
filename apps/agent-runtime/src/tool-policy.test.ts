// tool-policy.test.ts — T02 "Tool authority" regression suite (FR-SEC-01,
// FR-BOARD-01 M0 subset, G0 "denied tools/paths", assessment A02).
//
// Proves, headlessly (no API key, no Obsidian/Letta):
//   - every real board charter derives a policy; none yields a permission bypass
//   - the SDK options carry an enforcing gate (canUseTool + PreToolUse deny),
//     not merely observation, and never `bypassPermissions`
//   - disallowed beats allowed; unknown tools are denied
//   - writes outside the write roots (incl. traversal/UNC/junction) are denied
//   - invalid/unknown charter permission fields fail closed
//   - the MCP broker rejects unauthorized dispatches over the real MCP protocol
//     and a denied vault write leaves no file behind
//   - an adapter that cannot enforce the policy is ineligible
//
// Run: node --import tsx --test src/tool-policy.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, readdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';

import { clearCharterCache, loadCharter, type Charter, type CharterAgentId } from './charter.js';
import { buildMcpServers, brokered } from './mcp-registry.js';
import { executeBoardMissionViaSdk } from './sdk-board.js';
import {
  CLAUDE_AGENT_SDK_CAPABILITIES,
  ToolPolicyError,
  assertExecutorEligible,
  authorizeMcpDispatch,
  buildClaudeSdkPermissionOptions,
  derivePolicy,
  evaluateToolCall,
  type Approver,
  type ExecutionPolicy,
  type PolicyDecision,
} from './tool-policy.js';

// Keep every backing service offline.
delete process.env.OBSIDIAN_API_KEY;
process.env.OBSIDIAN_API_URL = 'http://127.0.0.1:55555';
process.env.LETTA_DISABLED = '1';

const approveAll: Approver = () => Promise.resolve(true);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const BOARD_IDS = readdirSync(path.join(REPO_ROOT, 'agent_space', 'boards'))
  .filter((f) => f.endsWith('.md'))
  .map((f) => f.slice(0, -3))
  .sort();

async function tmpDir(prefix: string): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

function charter(frontmatter: Record<string, unknown>, loaded = true): Charter {
  return {
    agentId: 'board.research',
    frontmatter,
    body: '# Test Captain\nA test charter body, sufficiently long.',
    loaded,
    path: '(synthetic)',
  };
}

function denied(d: PolicyDecision): Extract<PolicyDecision, { allow: false }> {
  assert.equal(d.allow, false, `expected a denial, got ${JSON.stringify(d)}`);
  return d as Extract<PolicyDecision, { allow: false }>;
}

function sdkOpts(policy: ExecutionPolicy, approver?: Approver) {
  return buildClaudeSdkPermissionOptions(policy, approver ? { approver } : {});
}

async function canUse(
  policy: ExecutionPolicy,
  tool: string,
  input: Record<string, unknown>,
  approver?: Approver,
): Promise<PermissionResult> {
  const opts = sdkOpts(policy, approver);
  return opts.canUseTool(tool, input, { signal: new AbortController().signal, toolUseID: `tu_${tool}` });
}

async function preToolUse(policy: ExecutionPolicy, tool: string, input: Record<string, unknown>) {
  const opts = sdkOpts(policy);
  const hook = opts.hooks.PreToolUse?.[0]?.hooks[0];
  assert.ok(hook, 'PreToolUse hook installed');
  return hook(
    {
      hook_event_name: 'PreToolUse',
      session_id: 's',
      transcript_path: 't',
      cwd: policy.cwd,
      tool_name: tool,
      tool_input: input,
      tool_use_id: 'tu_hook',
    },
    'tu_hook',
    { signal: new AbortController().signal },
  );
}

// ── Real charters ────────────────────────────────────────────────────────────

test('all eight real board charters derive a policy and none yields a bypass', async () => {
  assert.deepEqual(BOARD_IDS, [
    'coding',
    'design',
    'devops',
    'engineering',
    'finance',
    'marketing',
    'publishing',
    'research',
  ]);
  clearCharterCache();
  const cwd = await tmpDir('skippy-policy-cwd-');
  for (const id of BOARD_IDS) {
    const c = await loadCharter(`board.${id}` as CharterAgentId);
    assert.equal(c.loaded, true, `${id} charter loaded`);
    const policy = derivePolicy(c, { projectRoot: cwd });
    assert.equal(policy.permissionMode, 'ask', `${id} permission_mode`);
    assert.notEqual(policy.sdkPermissionMode as string, 'bypassPermissions');
    assert.deepEqual(policy.writeRoots, [], `${id}: no worktree => no write root`);
    assert.ok(policy.allowedTools.includes('Read'), `${id} keeps its Read grant`);
    for (const t of policy.allowedTools) {
      assert.ok((c.frontmatter['tools'] as string[]).includes(t), `${id}: ${t} was granted by the charter`);
    }

    const opts = sdkOpts(policy);
    assert.equal(opts.permissionMode, 'default');
    assert.equal(opts.allowDangerouslySkipPermissions, false);
    assert.deepEqual(opts.allowedTools, [], 'nothing auto-approved past canUseTool');
    assert.deepEqual(opts.settingSources, [], 'ambient settings cannot broaden authority');
    assert.equal(opts.strictMcpConfig, true);
    assert.equal(opts.cwd, cwd);
    assert.equal(typeof opts.canUseTool, 'function');
    assert.equal(opts.hooks.PreToolUse?.length, 1);
    assert.ok(!JSON.stringify(opts).includes('bypassPermissions'), `${id}: no bypass anywhere in SDK options`);
    // Not granted by any board charter => natively removed.
    assert.ok(opts.disallowedTools.includes('NotebookEdit'));
    assert.ok(!opts.tools.includes('NotebookEdit'));
    // Eligible on the Claude Agent SDK adapter.
    assertExecutorEligible(policy, CLAUDE_AGENT_SDK_CAPABILITIES);
  }
});

test('skippy and staff charters also derive without bypass', async () => {
  clearCharterCache();
  const cwd = await tmpDir('skippy-policy-cwd-');
  const staff = readdirSync(path.join(REPO_ROOT, 'agent_space', 'staff'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => `staff.${f.slice(0, -3)}` as CharterAgentId);
  for (const id of ['skippy' as CharterAgentId, ...staff]) {
    const policy = derivePolicy(await loadCharter(id), { projectRoot: cwd });
    assert.notEqual(policy.sdkPermissionMode as string, 'bypassPermissions', id);
  }
  // psych-monitor disallows Write/Edit/Bash/Agent: the denial must hold.
  const psych = derivePolicy(await loadCharter('staff.psych-monitor' as CharterAgentId), { projectRoot: cwd });
  assert.ok(!psych.allowedTools.includes('Write'));
  assert.equal(denied(await evaluateToolCall(psych, { toolName: 'Write', input: { file_path: path.join(cwd, 'x') } })).code, 'disallowed');
});

// ── Native gate: canUseTool / PreToolUse enforcement ─────────────────────────

test('a tool the charter does not grant is refused by canUseTool and the PreToolUse hook', async () => {
  clearCharterCache();
  const cwd = await tmpDir('skippy-policy-cwd-');
  const coding = derivePolicy(await loadCharter('board.coding' as CharterAgentId), { projectRoot: cwd });
  // Coding does not grant WebFetch.
  const r = await canUse(coding, 'WebFetch', { url: 'https://example.com', prompt: 'x' }, approveAll);
  assert.equal(r.behavior, 'deny');
  assert.match((r as { message: string }).message, /not_granted|disallowed/);

  const h = await preToolUse(coding, 'WebFetch', { url: 'https://example.com', prompt: 'x' });
  const out = (h as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput;
  assert.equal(out?.permissionDecision, 'deny', 'native PreToolUse deny, not observation');

  // A granted read inside the cwd is allowed (the gate is not deny-everything).
  const ok = await canUse(coding, 'Read', { file_path: path.join(cwd, 'README.md') });
  assert.equal(ok.behavior, 'allow');
  const hookOk = await preToolUse(coding, 'Read', { file_path: path.join(cwd, 'README.md') });
  assert.equal((hookOk as { hookSpecificOutput?: unknown }).hookSpecificOutput, undefined);

  // Reads outside the roots are denied too.
  const outside = await canUse(coding, 'Read', { file_path: path.join(os.homedir(), '.ssh', 'id_rsa') });
  assert.equal(outside.behavior, 'deny');
});

test('approval-required actions are denied by default and the decision is made once per tool use', async () => {
  const cwd = await tmpDir('skippy-policy-cwd-');
  const policy = derivePolicy(charter({ permission_mode: 'ask', tools: ['Bash', 'Read'] }), { worktreePath: cwd });
  // Default approver: none => Bash is refused.
  assert.equal((await canUse(policy, 'Bash', { command: 'echo hi' })).behavior, 'deny');
  // With a concrete approval it is allowed...
  let calls = 0;
  const counting: Approver = () => {
    calls++;
    return Promise.resolve(true);
  };
  const opts = buildClaudeSdkPermissionOptions(policy, { approver: counting });
  const hook = opts.hooks.PreToolUse?.[0]?.hooks[0];
  assert.ok(hook);
  await hook(
    {
      hook_event_name: 'PreToolUse',
      session_id: 's',
      transcript_path: 't',
      cwd,
      tool_name: 'Bash',
      tool_input: { command: 'echo hi' },
      tool_use_id: 'tu_1',
    },
    'tu_1',
    { signal: new AbortController().signal },
  );
  const r = await opts.canUseTool('Bash', { command: 'echo hi' }, { signal: new AbortController().signal, toolUseID: 'tu_1' });
  assert.equal(r.behavior, 'allow');
  assert.equal(calls, 1, 'hook and canUseTool share one decision per tool-use id');
  // ...but approval never overrides a hard limit.
  const sandboxOff = await evaluateToolCall(
    policy,
    { toolName: 'Bash', input: { command: 'rm -rf /', dangerouslyDisableSandbox: true } },
    { approver: approveAll },
  );
  assert.equal(denied(sandboxOff).code, 'invalid_arguments');
});

// ── Disallowed / unknown ─────────────────────────────────────────────────────

test('disallowed_tools beats tools', async () => {
  const wt = await tmpDir('skippy-policy-wt-');
  const policy = derivePolicy(
    charter({ permission_mode: 'acceptEdits', tools: ['Read', 'Write', 'Edit'], disallowed_tools: ['Write'] }),
    { worktreePath: wt },
  );
  assert.ok(!policy.allowedTools.includes('Write'));
  const d = denied(await evaluateToolCall(policy, { toolName: 'Write', input: { file_path: path.join(wt, 'a.txt'), content: 'x' } }, { approver: approveAll }));
  assert.equal(d.code, 'disallowed');
  const opts = sdkOpts(policy, approveAll);
  assert.ok(opts.disallowedTools.includes('Write'));
  assert.ok(!opts.tools.includes('Write'));
  assert.equal((await opts.canUseTool('Write', { file_path: path.join(wt, 'a.txt'), content: 'x' }, { signal: new AbortController().signal, toolUseID: 'w' })).behavior, 'deny');
  // Edit (granted, not disallowed) still works inside the worktree.
  const edit = await evaluateToolCall(policy, { toolName: 'Edit', input: { file_path: path.join(wt, 'a.txt'), old_string: 'a', new_string: 'b' } });
  assert.equal(edit.allow, true);
  // Server-level MCP disallow.
  const p2 = derivePolicy(charter({ mcp_servers: ['obsidian'], disallowed_tools: ['mcp__obsidian'] }), { projectRoot: wt });
  assert.equal(denied(await evaluateToolCall(p2, { toolName: 'mcp__obsidian__obsidian_search', input: { query: 'x' } })).code, 'disallowed');
});

test('unknown tools are denied at runtime and fail closed in a charter', async () => {
  const cwd = await tmpDir('skippy-policy-cwd-');
  const policy = derivePolicy(charter({ tools: ['Read'], mcp_servers: ['obsidian'] }), { projectRoot: cwd });
  for (const toolName of ['CronCreate', 'EnterWorktree', 'RemoteTrigger', 'Teleport', 'mcp__obsidian__obsidian_delete_vault']) {
    assert.equal(denied(await evaluateToolCall(policy, { toolName, input: {} }, { approver: approveAll })).code, 'unknown_tool', toolName);
  }
  assert.equal((await canUse(policy, 'Teleport', {}, approveAll)).behavior, 'deny');
  assert.throws(
    () => derivePolicy(charter({ tools: ['Read', 'Teleport'] }), { projectRoot: cwd }),
    (e: unknown) => e instanceof ToolPolicyError && e.code === 'unknown_tool',
  );
});

// ── Write roots ──────────────────────────────────────────────────────────────

test('writes outside the write roots are denied by the policy path hook', async () => {
  const wt = await tmpDir('skippy-policy-wt-');
  const outside = await tmpDir('skippy-policy-outside-');
  const policy = derivePolicy(charter({ permission_mode: 'acceptEdits', tools: ['Write', 'Edit', 'Read'] }), { worktreePath: wt });
  const write = (file_path: string) =>
    evaluateToolCall(policy, { toolName: 'Write', input: { file_path, content: 'x' } }, { approver: approveAll });

  assert.equal((await write(path.join(wt, 'src', 'new.ts'))).allow, true, 'inside the worktree');
  assert.equal(denied(await write(path.join(outside, 'x.ts'))).code, 'path_outside_roots');
  assert.equal(denied(await write(path.join(wt, '..', path.basename(outside), 'x.ts'))).code, 'path_outside_roots');
  assert.equal(denied(await write('\\\\evil-host\\share\\x.ts')).code, 'path_outside_roots');
  if (process.platform === 'win32') {
    assert.equal(denied(await write('C:x.ts')).code, 'path_outside_roots', 'drive-relative');
    // Case variation of the root still counts as inside.
    assert.equal((await write(path.join(wt.toUpperCase(), 'ok.ts'))).allow, true);
  }

  // A junction/symlink inside the worktree that points outside is not a way out.
  const link = path.join(wt, 'escape');
  let linked = false;
  try {
    await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    linked = true;
  } catch {
    // Link creation unsupported here; lexical cases above still hold.
  }
  if (linked) {
    assert.equal(denied(await write(path.join(link, 'x.ts'))).code, 'path_outside_roots', 'junction escape');
  }

  // canUseTool (native gate) denies the same escape.
  const r = await canUse(policy, 'Write', { file_path: path.join(outside, 'x.ts'), content: 'x' }, approveAll);
  assert.equal(r.behavior, 'deny');

  // No worktree assigned => read-only: every built-in write is refused.
  const ro = derivePolicy(charter({ permission_mode: 'acceptEdits', tools: ['Write'] }), { projectRoot: wt });
  assert.equal(denied(await evaluateToolCall(ro, { toolName: 'Write', input: { file_path: path.join(wt, 'a'), content: 'x' } }, { approver: approveAll })).code, 'path_outside_roots');

  // A replacement guard (e.g. WS-D's FR-SEC-02 broker) is honored.
  const strict = await evaluateToolCall(
    policy,
    { toolName: 'Write', input: { file_path: path.join(wt, 'a.ts'), content: 'x' } },
    { approver: approveAll, pathGuard: () => Promise.resolve({ ok: false, reason: 'external guard says no' }) },
  );
  assert.match(denied(strict).reason, /external guard says no/);

  // A guard that throws is a denial at the native gate, not a pass-through.
  const throwing = buildClaudeSdkPermissionOptions(policy, {
    approver: approveAll,
    pathGuard: () => Promise.reject(new Error('guard exploded')),
  });
  const boom = await throwing.canUseTool('Write', { file_path: path.join(wt, 'a.ts'), content: 'x' }, { signal: new AbortController().signal, toolUseID: 'boom' });
  assert.equal(boom.behavior, 'deny');

  // In 'ask' mode an in-root write still needs approval (default: denied).
  const ask = derivePolicy(charter({ permission_mode: 'ask', tools: ['Write'] }), { worktreePath: wt });
  assert.equal(denied(await evaluateToolCall(ask, { toolName: 'Write', input: { file_path: path.join(wt, 'a'), content: 'x' } })).code, 'approval_required');
});

// ── Charter validation (fail closed) ─────────────────────────────────────────

test('invalid or unknown charter permission fields fail closed', async () => {
  const cwd = await tmpDir('skippy-policy-cwd-');
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ permission_mode: 'bypassPermissions' }, 'bypass_forbidden'],
    [{ permission_mode: 'yolo' }, 'invalid_permission_mode'],
    [{ permission_mode: 'auto' }, 'invalid_permission_mode'],
    [{ permission_mode: 7 }, 'invalid_permission_mode'],
    [{ tools: 'Read, Write' }, 'invalid_tools'],
    [{ tools: ['Read', 3] }, 'invalid_tools'],
    [{ disallowed_tools: 'Write' }, 'invalid_disallowed_tools'],
    [{ mcp_servers: ['obsidian', 'bad name'] }, 'invalid_mcp_servers'],
    [{ mcp_servers: 'obsidian' }, 'invalid_mcp_servers'],
    [{ allowed_tools: ['Bash'] }, 'unknown_authority_field'],
    [{ dangerously_skip_permissions: true }, 'unknown_authority_field'],
    [{ network_hosts: ['*'] }, 'unknown_authority_field'],
    [{ write_roots: ['C:\\'] }, 'unknown_authority_field'],
  ];
  for (const [fm, code] of cases) {
    assert.throws(
      () => derivePolicy(charter({ tools: ['Read'], ...fm }), { projectRoot: cwd }),
      (e: unknown) => e instanceof ToolPolicyError && e.code === code,
      `${JSON.stringify(fm)} -> ${code}`,
    );
  }
  // A placeholder (missing file) charter grants nothing.
  assert.throws(
    () => derivePolicy(charter({ placeholder: true }, false), { projectRoot: cwd }),
    (e: unknown) => e instanceof ToolPolicyError && e.code === 'charter_not_loaded',
  );
  // Relative roots are rejected.
  assert.throws(
    () => derivePolicy(charter({}), { worktreePath: 'relative/wt' }),
    (e: unknown) => e instanceof ToolPolicyError && e.code === 'invalid_context',
  );

  // A bypass charter never reaches the SDK: the mission is refused up front
  // (no API key needed — the SDK is not even imported).
  const r = await executeBoardMissionViaSdk({
    boardId: 'research',
    systemPrompt: 'x',
    model: 'claude-haiku-4-5-20251001' as never,
    missionBrief: 'do things',
    charter: charter({ permission_mode: 'bypassPermissions', tools: ['Read'] }),
  });
  // FR-RUN-01: a policy refusal is a non-success terminal outcome (blocked).
  assert.equal(r.status, 'blocked');
  assert.equal(r.status === 'blocked' && r.reason.code, 'policy_refused');
  assert.match(r.status === 'blocked' ? (r.reason.detail ?? '') : '', /bypass_forbidden/);

  // And an invalid charter gets no MCP servers at all.
  const vault = await tmpDir('skippy-policy-vault-');
  assert.deepEqual(
    Object.keys(await buildMcpServers(charter({ permission_mode: 'bypassPermissions', mcp_servers: ['obsidian'] }), vault)),
    [],
  );
});

// ── MCP broker ───────────────────────────────────────────────────────────────

async function connect(server: unknown): Promise<Client> {
  const instance = (server as { instance: McpServer }).instance;
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await instance.connect(serverT);
  const client = new Client({ name: 'tool-policy-test', version: '0.0.0' });
  await client.connect(clientT);
  return client;
}

function textOf(r: unknown): string {
  return ((r as { content?: { text?: string }[] }).content ?? []).map((c) => c.text ?? '').join('');
}

test('broker rejects unauthorized MCP dispatches over the real MCP protocol', async () => {
  const vault = await tmpDir('skippy-policy-vault-');
  const research = charter({
    permission_mode: 'ask',
    mcp_servers: ['obsidian', 'letta'],
    memory: { letta_agent_id: 'bd_test_v1', vault_subdir: '50_Agents/research/' },
  });
  const servers = await buildMcpServers(research, vault);
  assert.deepEqual(Object.keys(servers).sort(), ['letta', 'obsidian']);

  // 'ask' + no approval channel: a vault write is refused and nothing is written.
  const obsidian = await connect(servers.obsidian);
  const res = await obsidian.callTool({
    name: 'obsidian_write_note',
    arguments: { path: '50_Agents/research/x.md', title: 'X', body: 'hi', source: 'ref://t' },
  });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /Denied by Skippy tool policy \(approval_required\)/);
  await assert.rejects(fs.access(path.join(vault, '50_Agents', 'research', 'x.md')), 'denied write left no file');

  // Letta core edit also requires approval.
  const letta = await connect(servers.letta);
  const edit = await letta.callTool({ name: 'letta_edit_core', arguments: { block: 'persona', value: 'pwned' } });
  assert.equal(edit.isError, true);
  assert.match(textOf(edit), /approval_required/);

  // A server the charter does not list is never built, and the broker denies it.
  const onlyObsidian = charter({ mcp_servers: ['obsidian'], memory: { letta_agent_id: 'bd_x' } });
  const p = derivePolicy(onlyObsidian, { projectRoot: vault });
  assert.equal(denied(await authorizeMcpDispatch(p, 'letta', 'letta_search_archival', { query: 'x' })).code, 'mcp_server_not_allowed');
  assert.deepEqual(Object.keys(await buildMcpServers(research, vault, { policy: p })), ['obsidian']);
});

test('broker enforces the board vault scope and lets an in-scope write through', async () => {
  const vault = await tmpDir('skippy-policy-vault-');
  const c = charter({
    permission_mode: 'acceptEdits',
    mcp_servers: ['obsidian'],
    memory: { letta_agent_id: 'bd_test_v1', vault_subdir: '50_Agents/research/' },
  });
  const servers = await buildMcpServers(c, vault);
  const client = await connect(servers.obsidian);

  const outOfScope = await client.callTool({
    name: 'obsidian_write_note',
    arguments: { path: '10_Atomic/other-board.md', title: 'O', body: 'x', source: 'ref://t' },
  });
  assert.equal(outOfScope.isError, true);
  assert.match(textOf(outOfScope), /path_outside_vault_scope/);
  await assert.rejects(fs.access(path.join(vault, '10_Atomic', 'other-board.md')));

  const traversal = await client.callTool({
    name: 'obsidian_write_note',
    arguments: { path: '50_Agents/research/../../escape.md', title: 'E', body: 'x', source: 'ref://t' },
  });
  assert.equal(traversal.isError, true);
  assert.match(textOf(traversal), /invalid_arguments/);

  const inScope = await client.callTool({
    name: 'obsidian_write_note',
    arguments: { path: '50_Agents/research/ok.md', title: 'OK', body: 'links [[x]]', source: 'ref://t' },
  });
  assert.notEqual(inScope.isError, true, textOf(inScope));
  await fs.access(path.join(vault, '50_Agents', 'research', 'ok.md'));

  // Plan mode forbids every mutation, even in scope.
  const plan = derivePolicy(charter({ permission_mode: 'plan', mcp_servers: ['obsidian'], memory: { vault_subdir: '50_Agents/research/' } }), { projectRoot: vault });
  let ran = false;
  const handler = brokered({ policy: plan }, 'obsidian', 'obsidian_append_block', () => {
    ran = true;
    return Promise.resolve({ content: [{ type: 'text', text: 'ran' }] });
  });
  const r = await handler({ path: '50_Agents/research/ok.md', markdown: 'x' });
  assert.equal(r.isError, true);
  assert.equal(ran, false, 'denied handler never executes');
});

// ── Network, spawn, plan ─────────────────────────────────────────────────────

test('network destinations are validated and spawning is limited to Board -> Task', async () => {
  const cwd = await tmpDir('skippy-policy-cwd-');
  const c = charter({ tools: ['WebFetch', 'WebSearch', 'Agent', 'Read'] });
  const noHosts = derivePolicy(c, { projectRoot: cwd });
  assert.equal(denied(await evaluateToolCall(noHosts, { toolName: 'WebFetch', input: { url: 'https://example.com/a', prompt: 'x' } })).code, 'approval_required');
  assert.equal(denied(await evaluateToolCall(noHosts, { toolName: 'WebSearch', input: { query: 'x' } })).code, 'approval_required');

  const hosts = derivePolicy(c, { projectRoot: cwd, networkAllowedHosts: ['example.com'] });
  assert.equal((await evaluateToolCall(hosts, { toolName: 'WebFetch', input: { url: 'https://docs.example.com/a', prompt: 'x' } })).allow, true);
  assert.equal(denied(await evaluateToolCall(hosts, { toolName: 'WebFetch', input: { url: 'https://example.com.evil.net/', prompt: 'x' } })).code, 'approval_required');
  assert.equal(denied(await evaluateToolCall(hosts, { toolName: 'WebFetch', input: { url: 'file:///etc/passwd', prompt: 'x' } }, { approver: approveAll })).code, 'network_destination_denied');
  assert.throws(() => derivePolicy(c, { projectRoot: cwd, networkAllowedHosts: ['*'] }), ToolPolicyError);

  // Board may spawn a task agent; a task agent may not spawn (no grandchildren).
  assert.equal((await evaluateToolCall(noHosts, { toolName: 'Agent', input: { description: 'd', prompt: 'p' } })).allow, true);
  assert.equal(denied(await evaluateToolCall(noHosts, { toolName: 'Agent', input: { description: 'd', prompt: 'p' }, subagentId: 'sub1' })).code, 'no_grandchildren');
  assert.equal(denied(await evaluateToolCall(noHosts, { toolName: 'Task', input: { description: 'd', prompt: 'p', mode: 'bypassPermissions' } }, { approver: approveAll })).code, 'invalid_arguments');

  const plan = derivePolicy(charter({ permission_mode: 'plan', tools: ['Read', 'Write'] }), { worktreePath: cwd });
  assert.equal(plan.sdkPermissionMode, 'plan');
  assert.equal(denied(await evaluateToolCall(plan, { toolName: 'Write', input: { file_path: path.join(cwd, 'a'), content: 'x' } }, { approver: approveAll })).code, 'mode_forbids');

  const dontAsk = derivePolicy(charter({ permission_mode: 'dontAsk', tools: ['Bash'] }), { projectRoot: cwd });
  assert.equal(denied(await evaluateToolCall(dontAsk, { toolName: 'Bash', input: { command: 'ls' } }, { approver: approveAll })).code, 'approval_required');
});

// ── Adapter eligibility ──────────────────────────────────────────────────────

test('an executor that cannot enforce the policy is ineligible', async () => {
  const cwd = await tmpDir('skippy-policy-cwd-');
  const policy = derivePolicy(charter({ tools: ['Read', 'Bash'], mcp_servers: ['obsidian'] }), { projectRoot: cwd });
  assert.doesNotThrow(() => assertExecutorEligible(policy, CLAUDE_AGENT_SDK_CAPABILITIES));
  const observeOnly = { ...CLAUDE_AGENT_SDK_CAPABILITIES, adapter: 'observe-only', preExecutionToolGate: false };
  assert.throws(
    () => assertExecutorEligible(policy, observeOnly),
    (e: unknown) => e instanceof ToolPolicyError && e.code === 'adapter_ineligible' && /preExecutionToolGate/.test(e.message),
  );
  const ambientMcp = { ...CLAUDE_AGENT_SDK_CAPABILITIES, adapter: 'ambient-mcp', mcpAllowlist: false };
  assert.throws(() => assertExecutorEligible(policy, ambientMcp), ToolPolicyError);
});

// ── Red-team D2: path arguments are interpreted the way the CLI will ─────────
//
// The bundled CLI (claude-agent-sdk-win32-x64 0.3.162, claude.exe) resolves the
// Grep/Glob `path` and the Read/Write/Edit `file_path` via one helper that
// trims, expands `~` and `~/` to the executor's home, maps `/c/...` to `C:\...`
// on Windows, then `path.resolve(cwd, p)`. Its `backfillObservableInput` only
// expands `file_path`/`notebook_path`, so the PreToolUse hook sees a raw `~` on
// Grep/Glob. The policy must therefore interpret (or refuse) every path-bearing
// argument itself.

const isWin = process.platform === 'win32';

/** Run a call through the real native gate: PreToolUse hook, then canUseTool
 * with the same tool-use id (the order the CLI uses). */
async function gate(
  policy: ExecutionPolicy,
  tool: string,
  input: Record<string, unknown>,
  approver: Approver = approveAll,
): Promise<{ hookDenied: boolean; canUse: PermissionResult }> {
  const opts = buildClaudeSdkPermissionOptions(policy, { approver });
  const hook = opts.hooks.PreToolUse?.[0]?.hooks[0];
  assert.ok(hook);
  const h = await hook(
    { hook_event_name: 'PreToolUse', session_id: 's', transcript_path: 't', cwd: policy.cwd, tool_name: tool, tool_input: input, tool_use_id: 'tu_gate' },
    'tu_gate',
    { signal: new AbortController().signal },
  );
  const out = (h as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput;
  const canUse = await opts.canUseTool(tool, input, { signal: new AbortController().signal, toolUseID: 'tu_gate' });
  return { hookDenied: out?.permissionDecision === 'deny', canUse };
}

async function assertDeniedEverywhere(
  policy: ExecutionPolicy,
  tool: string,
  input: Record<string, unknown>,
  code: string,
): Promise<void> {
  const label = `${tool} ${JSON.stringify(input)}`;
  const d = await evaluateToolCall(policy, { toolName: tool, input }, { approver: approveAll });
  assert.equal(d.allow, false, `${label}: expected deny, got ${JSON.stringify(d)}`);
  assert.equal((d as { code: string }).code, code, `${label}: code`);
  const g = await gate(policy, tool, input);
  assert.equal(g.hookDenied, true, `${label}: PreToolUse must deny natively`);
  assert.equal(g.canUse.behavior, 'deny', `${label}: canUseTool must deny`);
}

async function assertAllowed(policy: ExecutionPolicy, tool: string, input: Record<string, unknown>): Promise<void> {
  const d = await evaluateToolCall(policy, { toolName: tool, input }, { approver: approveAll });
  assert.equal(d.allow, true, `${tool} ${JSON.stringify(input)}: expected allow, got ${JSON.stringify(d)}`);
}

function fsPolicy(wt: string): ExecutionPolicy {
  return derivePolicy(
    charter({ permission_mode: 'acceptEdits', tools: ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'NotebookEdit', 'Agent'] }),
    { worktreePath: wt },
  );
}

test('D2: home-relative and env-var paths are refused on Grep/Glob/Read/Write (hook + canUseTool)', async () => {
  const wt = await tmpDir('skippy-policy-wt-');
  const policy = fsPolicy(wt);
  const paths = [
    '~',
    '~/',
    '~\\',
    ' ~ ',
    '~/.ssh',
    '~\\.ssh',
    '~/.ssh/id_rsa',
    '~other',
    '~other/.ssh/id_rsa',
    '~+/x',
    '%USERPROFILE%',
    '%USERPROFILE%\\.ssh\\id_rsa',
    '$HOME',
    '$HOME/.ssh/id_rsa',
    '${HOME}/.ssh',
  ];
  for (const p of paths) {
    await assertDeniedEverywhere(policy, 'Grep', { pattern: 'API_KEY', path: p }, 'path_outside_roots');
    await assertDeniedEverywhere(policy, 'Glob', { pattern: '*', path: p }, 'path_outside_roots');
    await assertDeniedEverywhere(policy, 'Read', { file_path: p }, 'path_outside_roots');
    await assertDeniedEverywhere(policy, 'Write', { file_path: p, content: 'x' }, 'path_outside_roots');
    await assertDeniedEverywhere(policy, 'Edit', { file_path: p, old_string: 'a', new_string: 'b' }, 'path_outside_roots');
  }
  // `~` inside a later segment is a literal name, not a home reference.
  await assertAllowed(policy, 'Read', { file_path: path.join(wt, 'a~b', '~', 'x.txt') });
  // Plain in-root forms still work (the guard is not deny-everything).
  await assertAllowed(policy, 'Grep', { pattern: 'API_KEY' });
  await assertAllowed(policy, 'Grep', { pattern: 'API_KEY', path: 'src' });
  await assertAllowed(policy, 'Grep', { pattern: 'API_KEY', path: ` ${wt} ` });
  await assertAllowed(policy, 'Glob', { pattern: '**/*.ts', path: wt });
  await assertAllowed(policy, 'Read', { file_path: path.join(wt, 'README.md') });
});

test('D2: Windows path forms are interpreted like the CLI or refused', { skip: !isWin }, async () => {
  const wt = await tmpDir('skippy-policy-wt-');
  const policy = fsPolicy(wt);
  // CLI maps `/c/...` to `C:\...` (msys form): an in-root msys path is allowed,
  // an out-of-root one is denied.
  const msys = `/${wt[0]!.toLowerCase()}/${wt.slice(3).replace(/\\/g, '/')}/x.txt`;
  await assertAllowed(policy, 'Read', { file_path: msys });
  await assertDeniedEverywhere(policy, 'Read', { file_path: '/c/Windows/win.ini' }, 'path_outside_roots');
  // Root-relative (depends on the executor's current drive), drive-relative,
  // UNC/device, ADS and trailing-dot aliases are refused.
  for (const p of [
    '\\Windows\\win.ini',
    '/Windows/win.ini',
    '/cygdrive/c/Windows/win.ini',
    'C:Windows\\win.ini',
    '\\\\?\\C:\\Windows\\win.ini',
    '\\\\.\\PhysicalDrive0',
    '//server/share/x',
    path.join(wt, 'a.txt:secret'),
    path.join(wt, 'sub.', 'x.txt'),
    path.join(wt, 'CON'),
  ]) {
    await assertDeniedEverywhere(policy, 'Read', { file_path: p }, 'path_outside_roots');
    await assertDeniedEverywhere(policy, 'Grep', { pattern: 'x', path: p }, 'path_outside_roots');
  }
});

test('D2: Glob patterns — braces, absolute patterns, `..` and pattern+path are all contained', async () => {
  const wt = await tmpDir('skippy-policy-wt-');
  const outside = await tmpDir('skippy-policy-outside-');
  const policy = fsPolicy(wt);
  const fwd = (p: string) => p.replace(/\\/g, '/');
  const sysDir = isWin ? 'C:/Windows/System32' : '/etc';
  const deniedPatterns: Array<Record<string, unknown>> = [
    { pattern: `{${sysDir},src}/*.dll` }, // brace-first: every alternative is checked
    { pattern: `{src,${sysDir}}/*` },
    { pattern: `{src,{lib,${sysDir}}}/*` }, // nested
    { pattern: `src/{a,../..}/*` }, // traversal hidden in an alternative
    { pattern: `{src/*` }, // unbalanced: meaning unprovable
    { pattern: `${sysDir}/*.dll` }, // absolute
    { pattern: `${fwd(outside)}/**/*` },
    { pattern: `${fwd(wt)}/../${path.basename(outside)}/*` },
    { pattern: '../*' },
    { pattern: 'src/../../*' },
    { pattern: '**/../../*' },
    { pattern: 'src/**/..' },
    { pattern: '~/*' },
    { pattern: '$HOME/*' },
    { pattern: '%USERPROFILE%/*' },
    { pattern: '*.ts', path: outside }, // pattern combined with an outside path
    { pattern: `{../${path.basename(outside)},src}/*`, path: wt },
    { pattern: 7 },
    {},
  ];
  if (isWin) deniedPatterns.push({ pattern: '/c/Windows/*' }, { pattern: '\\Windows\\*' }, { pattern: 'C:*.dll' }, { pattern: '//host/share/*' });
  for (const input of deniedPatterns) {
    const d = await evaluateToolCall(policy, { toolName: 'Glob', input }, { approver: approveAll });
    assert.equal(d.allow, false, `Glob ${JSON.stringify(input)} should be denied, got ${JSON.stringify(d)}`);
    const g = await gate(policy, 'Glob', input);
    assert.equal(g.canUse.behavior, 'deny', `Glob ${JSON.stringify(input)} canUseTool`);
  }
  for (const input of [
    { pattern: '**/*.ts' },
    { pattern: 'src/{a,b}/*.{ts,tsx}' },
    { pattern: `${fwd(wt)}/src/**/*.ts` },
    { pattern: `${wt}${path.sep}*.md` },
    { pattern: '*.ts', path: path.join(wt, 'src') },
    { pattern: 'a..b/*.ts' }, // `..` inside a name is not traversal
  ]) {
    await assertAllowed(policy, 'Glob', input);
  }
});

test('D2: Grep glob filters cannot smuggle absolute, traversal or home forms', async () => {
  const wt = await tmpDir('skippy-policy-wt-');
  const policy = fsPolicy(wt);
  for (const glob of ['../../*', '~/.ssh/*', isWin ? 'C:/Windows/**' : '/etc/**', '{*.ts,../../**}', '*.ts ../x/*', '$HOME/*']) {
    await assertDeniedEverywhere(policy, 'Grep', { pattern: 'x', glob }, 'path_outside_roots');
  }
  for (const glob of ['*.{ts,tsx}', '*.ts *.js', '!**/node_modules/**', 'src/**/*.ts']) {
    await assertAllowed(policy, 'Grep', { pattern: 'x', glob });
  }
});

test('D2: unknown or malformed path-bearing fields fail closed', async () => {
  const wt = await tmpDir('skippy-policy-wt-');
  const outside = await tmpDir('skippy-policy-outside-');
  const policy = fsPolicy(wt);
  const inside = path.join(wt, 'a.txt');
  const cases: Array<[string, Record<string, unknown>]> = [
    ['Read', { file_path: inside, path: outside }],
    ['Read', { file_path: inside, dir: outside }],
    ['Write', { file_path: inside, content: 'x', target_path: outside }],
    ['Edit', { file_path: inside, old_string: 'a', new_string: 'b', cwd: outside }],
    ['Glob', { pattern: '*', path: wt, cwd: outside }],
    ['Grep', { pattern: 'x', paths: [outside] }],
    ['NotebookEdit', { notebook_path: path.join(wt, 'n.ipynb'), new_source: 'x', file_path: outside }],
    ['Agent', { description: 'd', prompt: 'p', cwd: outside }],
    ['Grep', { pattern: 'x', path: [outside] }], // non-string path
    ['Read', { file_path: { toString: () => outside } }],
    ['Read', {}], // missing required path
  ];
  for (const [tool, input] of cases) {
    const d = await evaluateToolCall(policy, { toolName: tool, input }, { approver: approveAll });
    assert.equal(d.allow, false, `${tool} ${JSON.stringify(input)} should be denied`);
    assert.equal((d as { code: string }).code, 'invalid_arguments', `${tool} ${JSON.stringify(input)} code`);
    assert.equal((await gate(policy, tool, input)).canUse.behavior, 'deny');
  }
});

test('D2: canUseTool never reuses a cached allow for a different input or tool', async () => {
  const wt = await tmpDir('skippy-policy-wt-');
  const outside = await tmpDir('skippy-policy-outside-');
  const policy = fsPolicy(wt);
  const opts = buildClaudeSdkPermissionOptions(policy, { approver: approveAll });
  const hook = opts.hooks.PreToolUse?.[0]?.hooks[0];
  assert.ok(hook);
  const runHook = (tool: string, input: Record<string, unknown>, id: string) =>
    hook(
      { hook_event_name: 'PreToolUse', session_id: 's', transcript_path: 't', cwd: wt, tool_name: tool, tool_input: input, tool_use_id: id },
      id,
      { signal: new AbortController().signal },
    );
  const sig = () => new AbortController().signal;

  // Hook allowed an in-root read; canUseTool is then asked about an outside read.
  await runHook('Read', { file_path: path.join(wt, 'a.txt') }, 'tu_swap');
  const swapped = await opts.canUseTool('Read', { file_path: path.join(outside, 'secret') }, { signal: sig(), toolUseID: 'tu_swap' });
  assert.equal(swapped.behavior, 'deny', 'changed input must be re-evaluated');

  // Same id, different tool name.
  await runHook('Read', { file_path: path.join(wt, 'a.txt') }, 'tu_tool');
  const otherTool = await opts.canUseTool('Write', { file_path: path.join(outside, 'x'), content: 'x' }, { signal: sig(), toolUseID: 'tu_tool' });
  assert.equal(otherTool.behavior, 'deny', 'changed tool must be re-evaluated');

  // Unchanged input (key order irrelevant) still reuses the hook decision.
  await runHook('Read', { file_path: path.join(wt, 'a.txt'), limit: 5 }, 'tu_same');
  const same = await opts.canUseTool('Read', { limit: 5, file_path: path.join(wt, 'a.txt') }, { signal: sig(), toolUseID: 'tu_same' });
  assert.equal(same.behavior, 'allow');
  if (same.behavior === 'allow') {
    assert.deepEqual(same.updatedInput, { limit: 5, file_path: path.join(wt, 'a.txt') }, 'allow carries the evaluated input');
  }
});

// ── Red-team D4: disallowed_tools is validated against the catalogue ─────────

test('D4: misspelled or unknown disallowed_tools entries fail closed', async () => {
  const cwd = await tmpDir('skippy-policy-cwd-');
  for (const bad of [['edit', 'write'], ['Wirte'], ['bash'], ['mcp__obsidain'], ['mcp__obsidian__obsidian_nuke'], ['Bash(rm:*)'], ['*']]) {
    assert.throws(
      () => derivePolicy(charter({ tools: ['Read', 'Edit', 'Write'], disallowed_tools: bad }), { projectRoot: cwd }),
      (e: unknown) => e instanceof ToolPolicyError && (e.code as string) === 'unknown_disallowed_tool',
      JSON.stringify(bad),
    );
  }
  for (const ok of [['Edit', 'Write'], ['Task', 'KillShell'], ['mcp__obsidian'], ['mcp__obsidian__*'], ['mcp__letta__letta_edit_core'], []]) {
    assert.doesNotThrow(() => derivePolicy(charter({ tools: ['Read'], disallowed_tools: ok }), { projectRoot: cwd }), JSON.stringify(ok));
  }
  // Every shipped charter (boards, staff, skippy, task agents) still derives.
  const tasksDir = path.join(REPO_ROOT, 'agent_space', 'tasks');
  for (const f of readdirSync(tasksDir).filter((x) => x.endsWith('.md'))) {
    const text = await fs.readFile(path.join(tasksDir, f), 'utf8');
    const list = (key: string): string[] => {
      const m = new RegExp(`^${key}:\\s*\\[([^\\]]*)\\]`, 'm').exec(text);
      return m ? m[1]!.split(',').map((s) => s.trim()).filter(Boolean) : [];
    };
    assert.doesNotThrow(
      () => derivePolicy(charter({ tools: list('tools'), disallowed_tools: list('disallowed_tools') }), { projectRoot: cwd }),
      `task charter ${f}`,
    );
  }
});
