// tool-policy.ts — charter -> enforced execution policy (T02 "Tool authority").
//
// Traces: FR-SEC-01 (P0) no unconditional bypass; broker validates arguments,
// roots, network destinations, action class and authorization; an adapter that
// cannot enforce the policy is ineligible. FR-BOARD-01 (P1, M0 subset) validate
// charter permission fields and never silently broaden authority. G0 "denied
// tools/paths". Assessment A02.
//
// Model (default deny, fail closed):
//   1. `derivePolicy(charter, ctx)` validates the charter's authority fields
//      (`permission_mode`, `tools`, `disallowed_tools`, `mcp_servers`) and throws
//      a ToolPolicyError for anything unknown or invalid — including a request
//      for `bypassPermissions`, which is never granted. Filesystem roots come
//      from the *execution context* (the worktree the caller assigns), never
//      from charter text; no worktree => no built-in write root at all.
//   2. `evaluateToolCall(policy, call, hooks)` is the single decision function.
//      Hard limits (grant, disallow, known tool, roots, arguments, no
//      grandchildren) are checked first and cannot be overridden by approval.
//      Approval-required action classes then consult an Approver, which by
//      default denies (no approval channel exists yet; FR-SEC-03 is P1).
//   3. `buildClaudeSdkPermissionOptions` translates the policy into the Claude
//      Agent SDK's native controls (verified against the installed
//      @anthropic-ai/claude-agent-sdk 0.3.162 `Options` type): `permissionMode`
//      (never bypass), `tools`, empty `allowedTools`, `disallowedTools`,
//      `canUseTool`, a `PreToolUse` hook, `cwd`, `settingSources: []` and
//      `strictMcpConfig`. The hook fires for every tool call (even ones the CLI
//      would auto-approve), so a denial is enforcement, not observation.
//   4. `assertExecutorEligible` refuses an adapter whose declared capabilities
//      cannot enforce the policy.
//   5. The in-process MCP tools dispatch through `authorizeMcpDispatch` (see
//      mcp-registry.ts), so the custom tools are brokered on their own even if a
//      native gate is misconfigured.
//
// Vault path containment is owned by WS-D (mcp-handlers writeNote / memory
// atomic.ts). Here the vault scope is an *authorization* check on the
// vault-relative argument; the worktree write roots use the pluggable
// `PathGuard` hook (default: lexical + real-ancestor containment).

import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

import type {
  CanUseTool,
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  PermissionMode,
  PermissionResult,
  SettingSource,
} from '@anthropic-ai/claude-agent-sdk';

import type { Charter } from './charter.js';

// ──────────────────────────────────────────────────────────────────────────────
// Vocabulary
// ──────────────────────────────────────────────────────────────────────────────

/** Permission modes a charter may declare. `bypassPermissions` is deliberately
 * absent: it is rejected, never mapped. */
export type CharterPermissionMode = 'ask' | 'default' | 'acceptEdits' | 'plan' | 'dontAsk';

const CHARTER_PERMISSION_MODES: readonly CharterPermissionMode[] = [
  'ask',
  'default',
  'acceptEdits',
  'plan',
  'dontAsk',
];

/** What a tool call does, independent of which tool name expresses it. */
export type ActionClass =
  | 'read' // filesystem read inside read roots
  | 'write' // filesystem mutation inside write roots
  | 'exec' // arbitrary process execution (cannot be root-constrained)
  | 'network' // outbound fetch/search
  | 'spawn' // create a task agent (Board -> Task only)
  | 'meta' // session-local bookkeeping with no external effect
  | 'memory_read' // vault / Letta read or search
  | 'memory_append' // append-only write to the board's own memory
  | 'memory_write' // mutate the board's own core memory
  | 'vault_write'; // mutate a vault note (vault-relative path)

/** Built-in (native Claude Code) tools this runtime knows how to classify. A
 * charter naming any other tool fails closed; a runtime call to any other tool
 * is denied. */
export const BUILTIN_TOOL_CLASSES: Readonly<Record<string, ActionClass>> = {
  Read: 'read',
  Glob: 'read',
  Grep: 'read',
  Edit: 'write',
  MultiEdit: 'write',
  Write: 'write',
  NotebookEdit: 'write',
  Bash: 'exec',
  PowerShell: 'exec',
  TaskOutput: 'exec',
  TaskStop: 'exec',
  WebFetch: 'network',
  WebSearch: 'network',
  Agent: 'spawn',
  TodoWrite: 'meta',
};

/** Legacy / alternate spellings the CLI may emit for the same tool. */
const TOOL_ALIASES: Readonly<Record<string, string>> = {
  Task: 'Agent',
  BashOutput: 'TaskOutput',
  KillShell: 'TaskStop',
  KillBash: 'TaskStop',
};

/** In-process MCP tools this runtime implements (mcp-registry.ts), with their
 * action class. An MCP tool not listed here is denied even on an allowed
 * server. */
export const MCP_TOOL_CLASSES: Readonly<Record<string, Readonly<Record<string, ActionClass>>>> = {
  obsidian: {
    obsidian_read_note: 'memory_read',
    obsidian_search: 'memory_read',
    obsidian_patch_frontmatter: 'vault_write',
    obsidian_append_block: 'vault_write',
    obsidian_write_note: 'vault_write',
  },
  letta: {
    letta_search_archival: 'memory_read',
    letta_append_archival: 'memory_append',
    letta_edit_core: 'memory_write',
  },
};

/** Charter keys that carry authority and that this module understands. */
const KNOWN_AUTHORITY_KEYS = new Set(['permission_mode', 'tools', 'disallowed_tools', 'mcp_servers']);

/** A frontmatter key matching this pattern is treated as an authority field.
 * If it is not in KNOWN_AUTHORITY_KEYS it fails closed rather than being
 * silently ignored (e.g. `allowed_tools`, `dangerously_skip_permissions`,
 * `sandbox`, `network_hosts`, `write_roots`). */
const AUTHORITY_KEY_PATTERN =
  /(permission|allow|bypass|danger|sandbox|network|approv|tool|mcp|root|scope|sudo|trust)/i;

const MCP_SERVER_NAME = /^[a-z][a-z0-9-]*(?:_[a-z0-9-]+)*$/;

// ──────────────────────────────────────────────────────────────────────────────
// Errors
// ──────────────────────────────────────────────────────────────────────────────

export type ToolPolicyErrorCode =
  | 'charter_not_loaded'
  | 'bypass_forbidden'
  | 'invalid_permission_mode'
  | 'invalid_tools'
  | 'unknown_tool'
  | 'invalid_disallowed_tools'
  | 'invalid_mcp_servers'
  | 'unknown_authority_field'
  | 'invalid_context'
  | 'adapter_ineligible';

export class ToolPolicyError extends Error {
  readonly code: ToolPolicyErrorCode;
  readonly agentId: string;
  constructor(code: ToolPolicyErrorCode, agentId: string, message: string) {
    super(`[tool-policy:${code}] ${agentId}: ${message}`);
    this.name = 'ToolPolicyError';
    this.code = code;
    this.agentId = agentId;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Policy
// ──────────────────────────────────────────────────────────────────────────────

export interface ExecutionPolicy {
  readonly version: 1;
  readonly agentId: string;
  /** Normalized charter mode (`default` is folded into `ask`). */
  readonly permissionMode: Exclude<CharterPermissionMode, 'default'>;
  /** Native SDK mode. Never `bypassPermissions`, `acceptEdits` or `auto`:
   * edit auto-acceptance is decided by this policy, not delegated to the CLI. */
  readonly sdkPermissionMode: Extract<PermissionMode, 'default' | 'plan'>;
  /** Effective built-in tool grants (charter `tools` minus `disallowed_tools`). */
  readonly allowedTools: readonly string[];
  /** Charter `disallowed_tools` (explicit denials; always win over grants). */
  readonly disallowedTools: readonly string[];
  /** MCP servers this agent may reach (charter `mcp_servers`). */
  readonly mcpServers: readonly string[];
  /** Working directory for the executor. */
  readonly cwd: string;
  /** Absolute roots the agent may read with built-in tools. */
  readonly readRoots: readonly string[];
  /** Absolute roots the agent may write with built-in tools (the assigned
   * worktree only; empty when no worktree was assigned => read-only). */
  readonly writeRoots: readonly string[];
  /** Vault-relative prefixes the agent may mutate via MCP (charter
   * `memory.vault_subdir`). Authorization scope only — containment is WS-D. */
  readonly vaultWriteScopes: readonly string[];
  /** Hostnames WebFetch may reach without approval (execution context only). */
  readonly networkAllowedHosts: readonly string[];
}

export interface PolicyContext {
  /** Executor working directory (absolute). Defaults to the worktree. */
  cwd?: string;
  /** Assigned worktree (absolute). The ONLY built-in write root. */
  worktreePath?: string;
  /** Hostnames WebFetch may reach without approval (from a future execution
   * profile, never from charter text). Default: none. */
  networkAllowedHosts?: readonly string[];
}

function fail(code: ToolPolicyErrorCode, charter: Charter, msg: string): never {
  throw new ToolPolicyError(code, charter.agentId, `${msg} (charter: ${charter.path})`);
}

function stringList(
  charter: Charter,
  key: string,
  code: ToolPolicyErrorCode,
): string[] {
  const raw = charter.frontmatter[key];
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) fail(code, charter, `\`${key}\` must be a list, got ${JSON.stringify(raw)}`);
  const out: string[] = [];
  for (const item of raw as unknown[]) {
    if (typeof item !== 'string' || item.trim() === '') {
      fail(code, charter, `\`${key}\` entries must be non-empty strings, got ${JSON.stringify(item)}`);
    }
    out.push(item.trim());
  }
  return out;
}

function canonicalTool(name: string): string {
  return TOOL_ALIASES[name] ?? name;
}

function parsePermissionMode(charter: Charter): Exclude<CharterPermissionMode, 'default'> {
  const raw = charter.frontmatter['permission_mode'];
  // Missing => the restrictive interactive mode ('ask'): approval-required
  // classes are denied until an approver grants them.
  if (raw === undefined || raw === null) return 'ask';
  if (typeof raw !== 'string') {
    fail('invalid_permission_mode', charter, `permission_mode must be a string, got ${JSON.stringify(raw)}`);
  }
  if (raw === 'bypassPermissions' || /bypass/i.test(raw)) {
    fail(
      'bypass_forbidden',
      charter,
      `permission_mode "${raw}" is never granted (FR-SEC-01: no unconditional permission bypass). Use ask, acceptEdits, plan or dontAsk`,
    );
  }
  if (!(CHARTER_PERMISSION_MODES as readonly string[]).includes(raw)) {
    fail(
      'invalid_permission_mode',
      charter,
      `unknown permission_mode "${raw}" (expected one of ${CHARTER_PERMISSION_MODES.join(', ')})`,
    );
  }
  return raw === 'default' ? 'ask' : (raw as Exclude<CharterPermissionMode, 'default'>);
}

function vaultScopes(charter: Charter): string[] {
  const mem = charter.frontmatter['memory'];
  if (!mem || typeof mem !== 'object' || Array.isArray(mem)) return [];
  const sub = (mem as Record<string, unknown>)['vault_subdir'];
  if (typeof sub !== 'string' || sub.trim() === '') return [];
  const norm = normalizeVaultRelative(sub);
  return norm === null || norm === '' ? [] : [norm.endsWith('/') ? norm : `${norm}/`];
}

function requireAbsolute(charter: Charter, label: string, p: string | undefined): string | undefined {
  if (p === undefined) return undefined;
  if (typeof p !== 'string' || p === '' || !path.isAbsolute(p)) {
    fail('invalid_context', charter, `${label} must be an absolute path, got ${JSON.stringify(p)}`);
  }
  return path.resolve(p);
}

/**
 * Derive the enforced execution policy for a charter. Throws ToolPolicyError
 * on any unknown/invalid authority field — callers must treat that as
 * "ineligible to run", never as "run unrestricted".
 */
export function derivePolicy(charter: Charter, ctx: PolicyContext = {}): ExecutionPolicy {
  if (!charter.loaded) {
    fail('charter_not_loaded', charter, 'charter file was not loaded; a placeholder charter grants no authority');
  }

  for (const key of Object.keys(charter.frontmatter)) {
    if (!KNOWN_AUTHORITY_KEYS.has(key) && AUTHORITY_KEY_PATTERN.test(key)) {
      fail(
        'unknown_authority_field',
        charter,
        `unrecognized authority field \`${key}\`; refusing rather than silently ignoring it (FR-BOARD-01)`,
      );
    }
  }

  const permissionMode = parsePermissionMode(charter);

  const requestedTools = stringList(charter, 'tools', 'invalid_tools');
  for (const t of requestedTools) {
    if (!(t in BUILTIN_TOOL_CLASSES)) {
      fail(
        'unknown_tool',
        charter,
        `tool "${t}" is not a catalogued built-in (known: ${Object.keys(BUILTIN_TOOL_CLASSES).join(', ')})`,
      );
    }
  }
  const charterDisallowed = stringList(charter, 'disallowed_tools', 'invalid_disallowed_tools');
  const disallowedCanonical = new Set(charterDisallowed.map(canonicalTool));
  const allowedTools = [...new Set(requestedTools)].filter((t) => !disallowedCanonical.has(t));

  const mcpServers = [...new Set(stringList(charter, 'mcp_servers', 'invalid_mcp_servers'))];
  for (const s of mcpServers) {
    if (!MCP_SERVER_NAME.test(s) || s.includes('__')) {
      fail('invalid_mcp_servers', charter, `invalid MCP server name "${s}"`);
    }
  }

  const worktree = requireAbsolute(charter, 'worktreePath', ctx.worktreePath);
  const cwd = requireAbsolute(charter, 'cwd', ctx.cwd) ?? worktree;
  if (cwd === undefined) {
    fail('invalid_context', charter, 'an absolute cwd or worktreePath is required');
  }
  const writeRoots = worktree ? [worktree] : [];
  const readRoots = [...new Set([cwd, ...writeRoots])];

  const hosts = (ctx.networkAllowedHosts ?? []).map((h) => h.trim().toLowerCase());
  for (const h of hosts) {
    if (h === '' || h === '*' || h.includes('/') || h.includes('*')) {
      fail('invalid_context', charter, `network host "${h}" must be an explicit hostname (no wildcards)`);
    }
  }

  const disallowedTools = [...new Set(charterDisallowed)];

  return Object.freeze({
    version: 1 as const,
    agentId: charter.agentId,
    permissionMode,
    sdkPermissionMode: permissionMode === 'plan' ? 'plan' : 'default',
    allowedTools: Object.freeze(allowedTools),
    disallowedTools: Object.freeze(disallowedTools),
    mcpServers: Object.freeze(mcpServers),
    cwd,
    readRoots: Object.freeze(readRoots),
    writeRoots: Object.freeze(writeRoots),
    vaultWriteScopes: Object.freeze(vaultScopes(charter)),
    networkAllowedHosts: Object.freeze(hosts),
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Decision function
// ──────────────────────────────────────────────────────────────────────────────

export interface ToolCall {
  /** Tool name as the executor emits it (built-in, alias or `mcp__server__tool`). */
  toolName: string;
  input: Record<string, unknown>;
  /** Present when the call originates inside a spawned task agent. */
  subagentId?: string | undefined;
}

export type DenyCode =
  | 'disallowed'
  | 'not_granted'
  | 'unknown_tool'
  | 'mcp_server_not_allowed'
  | 'mode_forbids'
  | 'invalid_arguments'
  | 'path_outside_roots'
  | 'path_outside_vault_scope'
  | 'network_destination_denied'
  | 'no_grandchildren'
  | 'approval_required';

export type PolicyDecision =
  | { allow: true; actionClass: ActionClass; approved: boolean }
  | { allow: false; code: DenyCode; reason: string; actionClass?: ActionClass };

export interface ApprovalRequest {
  agentId: string;
  toolName: string;
  actionClass: ActionClass;
  input: Record<string, unknown>;
  why: string;
}

/** Decides approval-required actions. Must resolve `true` only for a concrete
 * approval (FR-SEC-03). */
export type Approver = (req: ApprovalRequest) => Promise<boolean>;

/** The M0 default: no approval channel exists, so nothing is approved. */
export const denyAllApprover: Approver = () => Promise.resolve(false);

export type PathGuardResult = { ok: true } | { ok: false; reason: string };

/** Containment check for built-in filesystem paths. Replaceable so the WS-D
 * vault/path broker (FR-SEC-02) can be plugged in without touching policy. */
export type PathGuard = (target: string, roots: readonly string[], base: string) => Promise<PathGuardResult>;

export interface EnforcementHooks {
  approver?: Approver;
  pathGuard?: PathGuard;
}

function deny(code: DenyCode, reason: string, actionClass?: ActionClass): PolicyDecision {
  return actionClass ? { allow: false, code, reason, actionClass } : { allow: false, code, reason };
}

/** Split `mcp__server__tool` into its parts; null when not an MCP tool name. */
export function parseMcpToolName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith('mcp__')) return null;
  const rest = name.slice('mcp__'.length);
  const sep = rest.indexOf('__');
  if (sep <= 0 || sep + 2 >= rest.length) return null;
  return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) };
}

export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

function isDisallowed(policy: ExecutionPolicy, name: string, canonical: string): boolean {
  const mcp = parseMcpToolName(name);
  return policy.disallowedTools.some((d) => {
    if (d === name || canonicalTool(d) === canonical) return true;
    // `mcp__server` or `mcp__server__*` disallows the whole server.
    if (mcp && (d === `mcp__${mcp.server}` || d === `mcp__${mcp.server}__*`)) return true;
    return false;
  });
}

function str(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  return typeof v === 'string' ? v : undefined;
}

/** Normalize a vault-relative path; null when it is absolute, drive-qualified,
 * UNC or escapes upward. */
export function normalizeVaultRelative(p: string): string | null {
  if (typeof p !== 'string' || p.includes('\0')) return null;
  const s = p.replace(/\\/g, '/');
  if (s.startsWith('/') || /^[a-zA-Z]:/.test(s)) return null;
  const parts: string[] = [];
  for (const seg of s.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return null;
    parts.push(seg);
  }
  const joined = parts.join('/');
  return s.endsWith('/') && joined !== '' ? `${joined}/` : joined;
}

function withinVaultScope(policy: ExecutionPolicy, rel: string): boolean {
  const cmp = (x: string): string => x.toLowerCase();
  return policy.vaultWriteScopes.some((scope) => cmp(rel).startsWith(cmp(scope)));
}

/** Leading non-glob portion of a glob pattern. */
function globStaticPrefix(pattern: string): string {
  const idx = pattern.search(/[*?[{]/);
  const head = idx === -1 ? pattern : pattern.slice(0, idx);
  const cut = Math.max(head.lastIndexOf('/'), head.lastIndexOf('\\'));
  return cut === -1 ? '' : head.slice(0, cut + 1);
}

function approvalNeeded(
  policy: ExecutionPolicy,
  actionClass: ActionClass,
): { needed: boolean; why: string } {
  switch (actionClass) {
    case 'read':
    case 'meta':
    case 'memory_read':
    case 'memory_append':
    case 'spawn':
      return { needed: false, why: '' };
    case 'write':
    case 'vault_write':
      return policy.permissionMode === 'acceptEdits'
        ? { needed: false, why: '' }
        : { needed: true, why: `${actionClass} requires approval in permission_mode ${policy.permissionMode}` };
    case 'memory_write':
      return { needed: true, why: 'core-memory edits require approval' };
    case 'exec':
      return { needed: true, why: 'process execution cannot be root-constrained; it always requires approval' };
    case 'network':
      return { needed: true, why: 'network destination is not on the execution allowlist' };
  }
}

/**
 * Decide one tool call. Hard limits first (not overridable by approval), then
 * approval for approval-required classes. Pure apart from the injected hooks.
 */
export async function evaluateToolCall(
  policy: ExecutionPolicy,
  call: ToolCall,
  hooks: EnforcementHooks = {},
): Promise<PolicyDecision> {
  const name = call.toolName;
  const canonical = canonicalTool(name);
  const input = call.input && typeof call.input === 'object' ? call.input : {};
  const guard = hooks.pathGuard ?? defaultPathGuard;

  if (isDisallowed(policy, name, canonical)) {
    return deny('disallowed', `tool "${name}" is disallowed for ${policy.agentId}`);
  }

  let actionClass: ActionClass;
  const mcp = parseMcpToolName(name);
  if (mcp) {
    if (!policy.mcpServers.includes(mcp.server)) {
      return deny('mcp_server_not_allowed', `MCP server "${mcp.server}" is not in ${policy.agentId}'s charter`);
    }
    const cls = MCP_TOOL_CLASSES[mcp.server]?.[mcp.tool];
    if (!cls) return deny('unknown_tool', `MCP tool "${name}" is not a catalogued tool`);
    actionClass = cls;
  } else {
    const cls = BUILTIN_TOOL_CLASSES[canonical];
    if (!cls) return deny('unknown_tool', `tool "${name}" is not a catalogued tool`);
    if (!policy.allowedTools.includes(canonical)) {
      return deny('not_granted', `tool "${name}" is not granted by ${policy.agentId}'s charter`, cls);
    }
    actionClass = cls;
  }

  if (
    policy.permissionMode === 'plan' &&
    actionClass !== 'read' &&
    actionClass !== 'memory_read' &&
    actionClass !== 'meta'
  ) {
    return deny('mode_forbids', `permission_mode plan forbids ${actionClass}`, actionClass);
  }

  // ── Class-specific argument / root validation (hard limits) ────────────────
  let networkPreapproved = false;
  switch (actionClass) {
    case 'read': {
      const targets: string[] = [];
      for (const k of ['file_path', 'path', 'notebook_path']) {
        const v = str(input, k);
        if (v !== undefined && v !== '') targets.push(v);
      }
      if (canonical === 'Glob') {
        const pattern = str(input, 'pattern') ?? '';
        const prefix = globStaticPrefix(pattern);
        if (prefix !== '' || pattern.includes('..')) {
          const base = str(input, 'path') ?? policy.cwd;
          targets.push(path.resolve(base, prefix === '' ? pattern : prefix));
        }
      }
      for (const t of targets) {
        const r = await guard(t, policy.readRoots, policy.cwd);
        if (!r.ok) return deny('path_outside_roots', `read of "${t}" denied: ${r.reason}`, actionClass);
      }
      break;
    }
    case 'write': {
      const target = str(input, 'file_path') ?? str(input, 'notebook_path');
      if (target === undefined || target === '') {
        return deny('invalid_arguments', `${name} requires a file path`, actionClass);
      }
      if (policy.writeRoots.length === 0) {
        return deny('path_outside_roots', `no write root assigned to ${policy.agentId} (read-only execution)`, actionClass);
      }
      const r = await guard(target, policy.writeRoots, policy.cwd);
      if (!r.ok) return deny('path_outside_roots', `write to "${target}" denied: ${r.reason}`, actionClass);
      break;
    }
    case 'exec': {
      if (input['dangerouslyDisableSandbox'] === true) {
        return deny('invalid_arguments', 'dangerouslyDisableSandbox is never permitted', actionClass);
      }
      break;
    }
    case 'network': {
      if (canonical === 'WebFetch') {
        const raw = str(input, 'url');
        let url: URL;
        try {
          url = new URL(raw ?? '');
        } catch {
          return deny('invalid_arguments', `WebFetch requires a valid URL, got ${JSON.stringify(raw)}`, actionClass);
        }
        if (url.protocol !== 'https:' && url.protocol !== 'http:') {
          return deny('network_destination_denied', `scheme ${url.protocol} is not permitted`, actionClass);
        }
        const host = url.hostname.toLowerCase();
        networkPreapproved = policy.networkAllowedHosts.some((h) => host === h || host.endsWith(`.${h}`));
      }
      break;
    }
    case 'spawn': {
      if (call.subagentId) {
        return deny('no_grandchildren', 'task agents may not spawn agents (Skippy -> Board -> Task limit)', actionClass);
      }
      const mode = input['mode'];
      if (mode !== undefined && mode !== 'default' && mode !== 'plan') {
        return deny('invalid_arguments', `task agent mode "${String(mode)}" would broaden authority`, actionClass);
      }
      if (input['isolation'] !== undefined || input['team_name'] !== undefined) {
        return deny('invalid_arguments', 'isolation/team spawning is outside the authorized graph', actionClass);
      }
      break;
    }
    case 'vault_write': {
      const rel = normalizeVaultRelative(str(input, 'path') ?? '');
      if (rel === null || rel === '') {
        return deny('invalid_arguments', 'vault writes require a vault-relative path', actionClass);
      }
      if (!withinVaultScope(policy, rel)) {
        return deny(
          'path_outside_vault_scope',
          `vault path "${rel}" is outside ${policy.agentId}'s scope (${policy.vaultWriteScopes.join(', ') || 'none'})`,
          actionClass,
        );
      }
      break;
    }
    default:
      break;
  }

  // ── Approval ───────────────────────────────────────────────────────────────
  const need = networkPreapproved ? { needed: false, why: '' } : approvalNeeded(policy, actionClass);
  if (!need.needed) return { allow: true, actionClass, approved: false };
  if (policy.permissionMode === 'dontAsk') {
    return deny('approval_required', `${need.why}; permission_mode dontAsk never asks`, actionClass);
  }
  const approver = hooks.approver ?? denyAllApprover;
  let approved = false;
  try {
    approved = await approver({ agentId: policy.agentId, toolName: name, actionClass, input, why: need.why });
  } catch {
    approved = false;
  }
  return approved === true
    ? { allow: true, actionClass, approved: true }
    : deny('approval_required', `${need.why}; no approval was granted`, actionClass);
}

// ──────────────────────────────────────────────────────────────────────────────
// Default path guard (built-in filesystem tools)
// ──────────────────────────────────────────────────────────────────────────────

const isWin = process.platform === 'win32';

function key(p: string): string {
  return isWin ? p.toLowerCase() : p;
}

/** Resolve symlinks/junctions of the nearest existing ancestor, then re-append
 * the not-yet-existing tail (new files). */
function realish(p: string): string {
  let cur = p;
  const tail: string[] = [];
  for (let i = 0; i < 64; i++) {
    if (existsSync(cur)) {
      try {
        return path.join(realpathSync.native(cur), ...tail.reverse());
      } catch {
        return path.join(cur, ...tail.reverse());
      }
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    tail.push(path.basename(cur));
    cur = parent;
  }
  return p;
}

function contains(root: string, target: string): boolean {
  const rel = path.relative(key(root), key(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Default containment: rejects NUL, Windows device/UNC/drive-relative forms,
 * resolves `..`, and compares both lexical and real-ancestor forms
 * case-insensitively on Windows. WS-D's FR-SEC-02 broker can replace it.
 */
export const defaultPathGuard: PathGuard = (target, roots, base) => {
  if (typeof target !== 'string' || target === '' || target.includes('\0')) {
    return Promise.resolve({ ok: false, reason: 'empty or NUL-containing path' });
  }
  if (/^[\\/]{2}/.test(target)) {
    return Promise.resolve({ ok: false, reason: 'UNC/device paths are not permitted' });
  }
  if (/^[a-zA-Z]:(?![\\/])/.test(target)) {
    return Promise.resolve({ ok: false, reason: 'drive-relative paths are not permitted' });
  }
  if (roots.length === 0) return Promise.resolve({ ok: false, reason: 'no roots assigned' });
  const lexical = path.resolve(base, target);
  const real = realish(lexical);
  const ok = roots.some((root) => {
    const r = path.resolve(root);
    return contains(r, lexical) && contains(realish(r), real);
  });
  return Promise.resolve(ok ? { ok: true } : { ok: false, reason: `outside roots [${roots.join(', ')}]` });
};

// ──────────────────────────────────────────────────────────────────────────────
// Executor eligibility (FR-SEC-01: an incapable adapter is ineligible)
// ──────────────────────────────────────────────────────────────────────────────

export interface ExecutorCapabilities {
  readonly adapter: string;
  /** Can refuse a tool call BEFORE it executes (not just observe it). */
  readonly preExecutionToolGate: boolean;
  /** Honors an explicit working directory. */
  readonly workingDirectoryScope: boolean;
  /** Runs only the MCP servers it is handed (ignores ambient config). */
  readonly mcpAllowlist: boolean;
  /** Restricts outbound network at the process level. */
  readonly networkEgressControl: boolean;
  /** Confines shell commands to the write roots at the OS level. */
  readonly shellSandbox: boolean;
}

/** Claude Agent SDK 0.3.x, as wired by `buildClaudeSdkPermissionOptions`:
 * `canUseTool` + `PreToolUse` deny (gate), `cwd`, `strictMcpConfig`. The CLI
 * sandbox is not enabled (unsupported on Windows), so no egress/shell
 * confinement is claimed. */
export const CLAUDE_AGENT_SDK_CAPABILITIES: ExecutorCapabilities = Object.freeze({
  adapter: 'claude-agent-sdk@0.3',
  preExecutionToolGate: true,
  workingDirectoryScope: true,
  mcpAllowlist: true,
  networkEgressControl: false,
  shellSandbox: false,
});

/** Capabilities an executor must have to run `policy` safely. */
export function requiredCapabilities(policy: ExecutionPolicy): (keyof Omit<ExecutorCapabilities, 'adapter'>)[] {
  const req: (keyof Omit<ExecutorCapabilities, 'adapter'>)[] = ['preExecutionToolGate', 'workingDirectoryScope'];
  if (policy.mcpServers.length > 0) req.push('mcpAllowlist');
  // Exec is always approval-gated by this policy. If a future mode ever
  // auto-allows it, the executor must confine it natively.
  if (policy.allowedTools.some((t) => BUILTIN_TOOL_CLASSES[t] === 'exec') && approvalNeeded(policy, 'exec').needed === false) {
    req.push('shellSandbox', 'networkEgressControl');
  }
  return req;
}

/** Throw `adapter_ineligible` unless `caps` can enforce `policy`. */
export function assertExecutorEligible(policy: ExecutionPolicy, caps: ExecutorCapabilities): void {
  const missing = requiredCapabilities(policy).filter((c) => caps[c] !== true);
  if (missing.length > 0) {
    throw new ToolPolicyError(
      'adapter_ineligible',
      policy.agentId,
      `executor ${caps.adapter} cannot enforce the policy (missing: ${missing.join(', ')}); refusing to run rather than run unrestricted`,
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Claude Agent SDK translation
// ──────────────────────────────────────────────────────────────────────────────

/** The subset of SDK `Options` this module owns. Field names/types verified
 * against @anthropic-ai/claude-agent-sdk 0.3.162 `sdk.d.ts`. */
export interface ClaudeSdkPermissionOptions {
  permissionMode: PermissionMode;
  allowDangerouslySkipPermissions: false;
  tools: string[];
  allowedTools: string[];
  disallowedTools: string[];
  canUseTool: CanUseTool;
  hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  cwd: string;
  additionalDirectories: string[];
  settingSources: SettingSource[];
  strictMcpConfig: true;
}

export interface PolicyAuditEvent {
  agentId: string;
  toolName: string;
  decision: PolicyDecision;
  via: 'PreToolUse' | 'canUseTool' | 'mcp-broker';
}

export interface SdkEnforcementHooks extends EnforcementHooks {
  onDecision?: (e: PolicyAuditEvent) => void;
}

/**
 * Build the SDK permission options for `policy`. Every tool call is decided by
 * `evaluateToolCall` exactly once per tool-use id: the PreToolUse hook decides
 * (and denies natively); `canUseTool` reuses that decision when the CLI also
 * asks, or decides itself if the hook did not run.
 */
export function buildClaudeSdkPermissionOptions(
  policy: ExecutionPolicy,
  hooks: SdkEnforcementHooks = {},
): ClaudeSdkPermissionOptions {
  const decided = new Map<string, PolicyDecision>();
  const remember = (id: string | undefined, d: PolicyDecision): void => {
    if (!id) return;
    if (decided.size > 1024) decided.clear();
    decided.set(id, d);
  };

  // An evaluation error is a denial, never a pass-through.
  const safeEvaluate = async (call: ToolCall): Promise<PolicyDecision> => {
    try {
      return await evaluateToolCall(policy, call, hooks);
    } catch (err) {
      return deny('invalid_arguments', `policy evaluation failed: ${String(err)}`);
    }
  };

  const preToolUse: HookCallback = async (hookInput, toolUseID) => {
    if (hookInput.hook_event_name !== 'PreToolUse') return {};
    const input =
      hookInput.tool_input && typeof hookInput.tool_input === 'object'
        ? (hookInput.tool_input as Record<string, unknown>)
        : {};
    const decision = await safeEvaluate({
      toolName: hookInput.tool_name,
      input,
      subagentId: hookInput.agent_id,
    });
    remember(hookInput.tool_use_id ?? toolUseID, decision);
    hooks.onDecision?.({ agentId: policy.agentId, toolName: hookInput.tool_name, decision, via: 'PreToolUse' });
    if (decision.allow) return {}; // defer to the normal permission flow (canUseTool)
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `Denied by Skippy tool policy (${decision.code}): ${decision.reason}`,
      },
    };
  };

  const canUseTool: CanUseTool = async (toolName, input, options): Promise<PermissionResult> => {
    let decision = decided.get(options.toolUseID);
    decided.delete(options.toolUseID);
    if (!decision) {
      decision = await safeEvaluate({ toolName, input, subagentId: options.agentID });
      hooks.onDecision?.({ agentId: policy.agentId, toolName, decision, via: 'canUseTool' });
    }
    return decision.allow
      ? { behavior: 'allow', updatedInput: input, toolUseID: options.toolUseID }
      : {
          behavior: 'deny',
          message: `Denied by Skippy tool policy (${decision.code}): ${decision.reason}`,
          toolUseID: options.toolUseID,
        };
  };

  const builtins = policy.allowedTools.filter((t) => t in BUILTIN_TOOL_CLASSES);
  return {
    permissionMode: policy.sdkPermissionMode,
    allowDangerouslySkipPermissions: false,
    // Restrict the native tool set to the grant (`[]` disables all built-ins).
    tools: [...builtins],
    // Nothing is auto-approved past canUseTool.
    allowedTools: [],
    // Explicit denials plus every catalogued built-in the charter did not grant.
    disallowedTools: [
      ...new Set([
        ...policy.disallowedTools,
        ...Object.keys(BUILTIN_TOOL_CLASSES).filter((t) => !policy.allowedTools.includes(t)),
      ]),
    ],
    canUseTool,
    hooks: { PreToolUse: [{ hooks: [preToolUse] }] },
    cwd: policy.cwd,
    additionalDirectories: policy.readRoots.filter((r) => r !== policy.cwd),
    // Ignore user/project/local settings so ambient `permissions.allow` rules
    // cannot broaden the charter.
    settingSources: [],
    // Only the MCP servers handed in by this runtime.
    strictMcpConfig: true,
  };
}

/** Drop any MCP server not on the policy allowlist (defense in depth). */
export function filterMcpServers<T>(policy: ExecutionPolicy, servers: Record<string, T> | undefined): Record<string, T> {
  const out: Record<string, T> = {};
  if (!servers) return out;
  for (const [name, cfg] of Object.entries(servers)) {
    if (policy.mcpServers.includes(name)) out[name] = cfg;
  }
  return out;
}

/**
 * Broker check for an in-process MCP tool dispatch (custom-loop tools,
 * FR-SEC-01). Called by mcp-registry.ts before a handler runs.
 */
export async function authorizeMcpDispatch(
  policy: ExecutionPolicy,
  server: string,
  tool: string,
  args: Record<string, unknown>,
  hooks: SdkEnforcementHooks = {},
): Promise<PolicyDecision> {
  const toolName = mcpToolName(server, tool);
  const decision = await evaluateToolCall(policy, { toolName, input: args }, hooks);
  hooks.onDecision?.({ agentId: policy.agentId, toolName, decision, via: 'mcp-broker' });
  return decision;
}
