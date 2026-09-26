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
//
// Built-in tool arguments (red-team D2/D4 fixes): every catalogued built-in
// has an exact input-field allowlist; every path argument is interpreted the
// way the bundled CLI resolves it (see "Built-in tool arguments" below) and
// environment-dependent forms (`~`, env vars, root-/drive-relative, UNC) are
// refused; Glob patterns are checked per brace alternative; `disallowed_tools`
// entries must name catalogued tools.

import { createHash, randomUUID } from 'node:crypto';
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
  | 'unknown_disallowed_tool'
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
  return Object.hasOwn(TOOL_ALIASES, name) ? (TOOL_ALIASES[name] ?? name) : name;
}

/** Own-property class lookup (never the prototype chain: `toString` is not a tool). */
function builtinClass(name: string): ActionClass | undefined {
  return Object.hasOwn(BUILTIN_TOOL_CLASSES, name) ? BUILTIN_TOOL_CLASSES[name] : undefined;
}

/** True when a `disallowed_tools` entry names something the runtime can
 * actually deny: an exact built-in/alias name, or a catalogued MCP server
 * (`mcp__server`, `mcp__server__*`) or MCP tool (`mcp__server__tool`). */
function isCataloguedDisallowEntry(d: string): boolean {
  if (Object.hasOwn(BUILTIN_TOOL_CLASSES, d) || Object.hasOwn(TOOL_ALIASES, d)) return true;
  if (!d.startsWith('mcp__')) return false;
  const rest = d.slice('mcp__'.length);
  const sep = rest.indexOf('__');
  const server = sep === -1 ? rest : rest.slice(0, sep);
  if (!Object.hasOwn(MCP_TOOL_CLASSES, server)) return false;
  const tools = MCP_TOOL_CLASSES[server];
  if (!tools) return false;
  if (sep === -1) return true;
  const tool = rest.slice(sep + 2);
  return tool === '*' || Object.hasOwn(tools, tool);
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
    if (builtinClass(t) === undefined) {
      fail(
        'unknown_tool',
        charter,
        `tool "${t}" is not a catalogued built-in (known: ${Object.keys(BUILTIN_TOOL_CLASSES).join(', ')})`,
      );
    }
  }
  const charterDisallowed = stringList(charter, 'disallowed_tools', 'invalid_disallowed_tools');
  // Red-team D4: an entry that matches nothing (wrong case, typo, CLI rule
  // syntax such as `Bash(rm:*)`) would silently deny nothing. Fail closed
  // instead of guessing (no case-folding): the charter author must fix it.
  for (const d of charterDisallowed) {
    if (!isCataloguedDisallowEntry(d)) {
      fail(
        'unknown_disallowed_tool',
        charter,
        `disallowed_tools entry "${d}" matches no catalogued tool (exact names: ${[
          ...Object.keys(BUILTIN_TOOL_CLASSES),
          ...Object.keys(TOOL_ALIASES),
        ].join(', ')}; or mcp__<server>, mcp__<server>__*, mcp__<server>__<tool>); refusing rather than denying nothing`,
      );
    }
  }
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

// ──────────────────────────────────────────────────────────────────────────────
// Built-in tool arguments (red-team D2; FR-SEC-01 argument validation,
// FR-SEC-02 path forms)
// ──────────────────────────────────────────────────────────────────────────────
//
// Verified against the CLI bundled in @anthropic-ai/claude-agent-sdk-win32-x64
// 0.3.162 (claude.exe, CLI 2.1.162). Its path helper (minified `GK`) is used
// for Read/Write/Edit `file_path`, NotebookEdit `notebook_path`, Grep `path`
// and Glob `path`:
//   p = raw.trim(); '' -> cwd; '~' -> os.homedir(); '~/x' -> join(homedir, x);
//   on Windows /^\/[a-z]\//i ('/c/x') -> 'C:\x'; isAbsolute(p) ? normalize(p)
//   : resolve(cwd, p).
// `backfillObservableInput` (what the PreToolUse hook sees) is applied only to
// `file_path`/`notebook_path`, so Grep/Glob reach the hook with a raw `~`.
// Glob (`Au7`) runs `rg --files --glob <pattern>` in `path`; when the pattern
// is absolute it instead searches the pattern's static prefix (text before the
// first of `*?[{`, cut at the last separator) and ignores `path`. Grep (`call`)
// passes `glob` to `rg --glob` after splitting on whitespace and (outside
// braces) commas. Neither expands environment variables (rg runs via
// execFile, no shell).
//
// Rules, all fail closed:
//   - Every catalogued built-in has an exact input-field allowlist; any other
//     field (which could carry a path the guard never saw) is denied, as is a
//     non-string value in a path field.
//   - Path arguments are interpreted exactly as above, except that forms whose
//     meaning depends on the executor's environment are refused rather than
//     guessed: any leading `~` (`~`, `~/`, `~\`, `~user`; the executor's home
//     is its env, not ours), `%VAR%` / `$VAR` / `${VAR}` / `$(...)`, UNC and
//     device paths, and on Windows drive-relative (`C:x`), root-relative
//     (`\x`, `/x`), colons after the drive (ADS/devices), segments ending in a
//     dot or space (Win32 strips them) and reserved device names.
//   - The interpreted absolute path (never the raw string) goes to the
//     PathGuard, so a replacement guard cannot misread `~` either.
//   - Glob patterns: every brace alternative (nested, capped) AND the raw
//     pattern are checked; each must be free of the forms above and of `..`
//     segments, and its static prefix — absolute, or resolved against `path`
//     — must pass the PathGuard. Unbalanced braces are refused.
//   - Grep `glob` filters must be relative and `..`-free in every alternative.

/** Exact input fields per catalogued built-in (SDK `sdk-tools.d.ts` + the
 * bundled CLI's zod schemas). Agent's `cwd` is deliberately absent: it would
 * re-root the task agent outside the policy's interpretation base. */
const BUILTIN_INPUT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Read: ['file_path', 'offset', 'limit', 'pages'],
  Glob: ['pattern', 'path'],
  Grep: [
    'pattern',
    'path',
    'glob',
    'output_mode',
    '-B',
    '-A',
    '-C',
    'context',
    '-n',
    '-i',
    '-o',
    'type',
    'head_limit',
    'offset',
    'multiline',
  ],
  Edit: ['file_path', 'old_string', 'new_string', 'replace_all'],
  MultiEdit: ['file_path', 'edits'],
  Write: ['file_path', 'content'],
  NotebookEdit: ['notebook_path', 'cell_id', 'new_source', 'cell_type', 'edit_mode'],
  Bash: ['command', 'timeout', 'description', 'run_in_background', 'dangerouslyDisableSandbox'],
  PowerShell: ['command', 'timeout', 'description', 'run_in_background', 'dangerouslyDisableSandbox'],
  TaskOutput: ['task_id', 'block', 'timeout'],
  TaskStop: ['task_id', 'shell_id'],
  WebFetch: ['url', 'prompt'],
  WebSearch: ['query', 'allowed_domains', 'blocked_domains'],
  Agent: ['description', 'prompt', 'subagent_type', 'model', 'run_in_background', 'name', 'team_name', 'mode', 'isolation'],
  TodoWrite: ['todos'],
};

/** The single path-bearing field of each write-class built-in. */
const WRITE_PATH_FIELD: Readonly<Record<string, string>> = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
};

export type PathInterpretation = { ok: true; path: string } | { ok: false; reason: string };

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const ENV_VAR_FORM = /%[^%\\/]+%|\$(?:\{|\(|[A-Za-z_])/;
const WIN_RESERVED_NAME = /^(?:con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3]|conin\$|conout\$)(?:\..*)?$/i;
/** Exactly the CLI's static-prefix cut set (Glob `b3f`), so the directory we
 * guard is the directory rg is handed. */
const GLOB_META = /[*?[{]/;
const MAX_BRACE_ALTERNATIVES = 256;

function onWindows(): boolean {
  return process.platform === 'win32';
}

/**
 * Why `p` cannot be interpreted without guessing, or null. `names` also
 * checks per-segment Win32 aliasing (literal paths, not glob patterns).
 */
function pathAmbiguity(p: string, names: boolean): string | null {
  if (CONTROL_CHARS.test(p)) return 'control characters (including NUL) are not permitted';
  if (p.startsWith('~')) {
    return "home-relative paths (~, ~/, ~\\, ~user) are expanded against the executor's own home directory; use an absolute path";
  }
  if (ENV_VAR_FORM.test(p)) {
    return 'environment-variable references (%VAR%, $VAR, ${VAR}, $(...)) are not permitted; use an absolute path';
  }
  if (/^[\\/]{2}/.test(p)) return 'UNC/device paths are not permitted';
  if (onWindows()) {
    if (/^[a-zA-Z]:(?![\\/])/.test(p)) return 'drive-relative paths are not permitted';
    if (/^[\\/]/.test(p)) return "root-relative paths depend on the executor's current drive; use a drive-qualified path";
    if (p.includes(':', /^[a-zA-Z]:/.test(p) ? 2 : 0)) {
      return 'a colon after the drive prefix (alternate data stream / device) is not permitted';
    }
    if (names) {
      for (const seg of p.split(/[\\/]/)) {
        if (seg === '' || seg === '.' || seg === '..') continue;
        if (/[. ]$/.test(seg)) return `segment "${seg}" ends in a dot or space (Win32 strips it, aliasing another name)`;
        if (WIN_RESERVED_NAME.test(seg)) return `segment "${seg}" is a reserved device name`;
      }
    }
  }
  return null;
}

/**
 * Interpret a built-in tool's path argument the way the bundled CLI will
 * (trim, msys `/c/` form, resolve against `base`), refusing every form whose
 * meaning depends on the executor's environment. Returns an absolute path.
 */
export function interpretToolPath(raw: unknown, base: string): PathInterpretation {
  if (typeof raw !== 'string') return { ok: false, reason: 'path must be a string' };
  let p = raw.trim();
  if (p === '') return { ok: true, path: path.resolve(base) };
  if (onWindows() && /^\/[a-z]\//i.test(p)) {
    p = `${p.charAt(1).toUpperCase()}:\\${p.slice(3).replace(/\//g, '\\')}`;
  }
  const why = pathAmbiguity(p, true);
  if (why) return { ok: false, reason: why };
  return { ok: true, path: path.isAbsolute(p) ? path.normalize(p) : path.resolve(base, p) };
}

/**
 * Expand `{a,b}` alternatives (nested). Returns null when braces are
 * unbalanced or the expansion exceeds MAX_BRACE_ALTERNATIVES: an unprovable
 * pattern is refused, not approximated.
 */
export function expandBraces(pattern: string): string[] | null {
  const open = pattern.indexOf('{');
  if (open === -1) return pattern.includes('}') ? null : [pattern];
  if (pattern.slice(0, open).includes('}')) return null;
  let depth = 0;
  let close = -1;
  const commas: number[] = [];
  for (let i = open; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    } else if (c === ',' && depth === 1) commas.push(i);
  }
  if (close === -1) return null;
  const pre = pattern.slice(0, open);
  const post = pattern.slice(close + 1);
  const parts: string[] = [];
  let start = open + 1;
  for (const c of commas) {
    parts.push(pattern.slice(start, c));
    start = c + 1;
  }
  parts.push(pattern.slice(start, close));
  const out: string[] = [];
  for (const part of parts) {
    const sub = expandBraces(pre + part + post);
    if (sub === null) return null;
    out.push(...sub);
    if (out.length > MAX_BRACE_ALTERNATIVES) return null;
  }
  return out;
}

function hasDotDotSegment(p: string): boolean {
  return p.split(/[\\/]/).some((s) => s === '..');
}

/** Directory rg will enumerate for one glob alternative: the text before the
 * first glob metacharacter, cut after the last separator (the CLI's Glob
 * `b3f` split), or the whole literal when there is no metacharacter. */
function globRootFor(alt: string, searchBase: string): string {
  const idx = alt.search(GLOB_META);
  let prefix: string;
  if (idx === -1) {
    prefix = alt;
  } else {
    const head = alt.slice(0, idx);
    const cut = Math.max(head.lastIndexOf('/'), head.lastIndexOf('\\'));
    prefix = cut === -1 ? '' : head.slice(0, cut + 1);
  }
  if (path.isAbsolute(alt)) return path.normalize(prefix === '' ? alt : prefix);
  return path.resolve(searchBase, prefix === '' ? '.' : prefix);
}

type ArgCheck = { ok: true } | { ok: false; code: DenyCode; reason: string };

const argOk: ArgCheck = { ok: true };

/** Exact-field allowlist for a catalogued built-in. */
function checkInputFields(canonical: string, input: Record<string, unknown>): ArgCheck {
  const known = BUILTIN_INPUT_FIELDS[canonical];
  if (!known) return { ok: false, code: 'invalid_arguments', reason: `no input schema is catalogued for ${canonical}` };
  for (const k of Object.keys(input)) {
    if (!known.includes(k)) {
      return {
        ok: false,
        code: 'invalid_arguments',
        reason: `unknown input field "${k}" for ${canonical}; the policy cannot prove it does not carry a path`,
      };
    }
  }
  return argOk;
}

/** Interpret one path argument and run it through the PathGuard. */
async function checkPathArg(
  label: string,
  raw: string,
  roots: readonly string[],
  base: string,
  guard: PathGuard,
): Promise<ArgCheck> {
  const r = interpretToolPath(raw, base);
  if (!r.ok) return { ok: false, code: 'path_outside_roots', reason: `${label} "${raw}" refused: ${r.reason}` };
  const g = await guard(r.path, roots, base);
  if (!g.ok) return { ok: false, code: 'path_outside_roots', reason: `${label} "${raw}" (${r.path}) denied: ${g.reason}` };
  return argOk;
}

/** Glob `pattern` (+ optional `path`) must stay inside the read roots. */
async function checkGlobPattern(
  pattern: string,
  searchBase: string,
  roots: readonly string[],
  guard: PathGuard,
): Promise<ArgCheck> {
  const bad = (reason: string): ArgCheck => ({ ok: false, code: 'path_outside_roots', reason: `glob pattern "${pattern}" refused: ${reason}` });
  const alts = expandBraces(pattern);
  if (alts === null) return bad(`unbalanced braces or more than ${MAX_BRACE_ALTERNATIVES} alternatives`);
  for (const alt of new Set([pattern, ...alts])) {
    const why = pathAmbiguity(alt, false);
    if (why) return bad(`alternative "${alt}": ${why}`);
    if (hasDotDotSegment(alt)) return bad(`alternative "${alt}" contains a ".." segment`);
    const root = globRootFor(alt, searchBase);
    const g = await guard(root, roots, searchBase);
    if (!g.ok) return bad(`alternative "${alt}" searches ${root}: ${g.reason}`);
  }
  return argOk;
}

/** Grep `glob` is an rg filter relative to the search root: every
 * alternative must be relative and free of `..`/home/env/device forms. */
function checkGrepGlob(glob: string): ArgCheck {
  const bad = (reason: string): ArgCheck => ({ ok: false, code: 'path_outside_roots', reason: `grep glob "${glob}" refused: ${reason}` });
  const tokens: string[] = [];
  for (const t of glob.split(/\s+/)) {
    if (t === '') continue;
    if (t.includes('{') && t.includes('}')) tokens.push(t);
    else tokens.push(...t.split(',').filter(Boolean));
  }
  for (const token of tokens) {
    const body = token.startsWith('!') ? token.slice(1) : token;
    const alts = expandBraces(body);
    if (alts === null) return bad(`"${token}" has unbalanced braces or too many alternatives`);
    for (const alt of new Set([body, ...alts])) {
      const why = pathAmbiguity(alt, false);
      if (why) return bad(`"${alt}": ${why}`);
      if (path.isAbsolute(alt) || /^[a-zA-Z]:/.test(alt)) return bad(`"${alt}" is absolute`);
      if (hasDotDotSegment(alt)) return bad(`"${alt}" contains a ".." segment`);
    }
  }
  return argOk;
}

/** All path-bearing arguments of a read-class built-in (Read/Glob/Grep). */
async function checkReadArgs(
  policy: ExecutionPolicy,
  canonical: string,
  input: Record<string, unknown>,
  guard: PathGuard,
): Promise<ArgCheck> {
  const roots = policy.readRoots;
  const base = policy.cwd;
  const pathField = (k: string): { present: boolean; value?: string; bad?: ArgCheck } => {
    if (!Object.hasOwn(input, k) || input[k] === undefined) return { present: false };
    const v = input[k];
    if (typeof v !== 'string') {
      return { present: true, bad: { ok: false, code: 'invalid_arguments', reason: `${canonical} \`${k}\` must be a string` } };
    }
    return { present: true, value: v };
  };
  switch (canonical) {
    case 'Read': {
      const f = pathField('file_path');
      if (f.bad) return f.bad;
      if (!f.present || f.value === undefined || f.value.trim() === '') {
        return { ok: false, code: 'invalid_arguments', reason: 'Read requires a non-empty file_path' };
      }
      return checkPathArg('file_path', f.value, roots, base, guard);
    }
    case 'Glob': {
      const pattern = input['pattern'];
      if (typeof pattern !== 'string' || pattern === '') {
        return { ok: false, code: 'invalid_arguments', reason: 'Glob requires a string pattern' };
      }
      const p = pathField('path');
      if (p.bad) return p.bad;
      let searchBase = base;
      if (p.value !== undefined) {
        const c = await checkPathArg('path', p.value, roots, base, guard);
        if (!c.ok) return c;
        const r = interpretToolPath(p.value, base);
        if (r.ok) searchBase = r.path;
      }
      return checkGlobPattern(pattern, searchBase, roots, guard);
    }
    case 'Grep': {
      if (typeof input['pattern'] !== 'string') {
        return { ok: false, code: 'invalid_arguments', reason: 'Grep requires a string pattern' };
      }
      const p = pathField('path');
      if (p.bad) return p.bad;
      if (p.value !== undefined) {
        const c = await checkPathArg('path', p.value, roots, base, guard);
        if (!c.ok) return c;
      }
      const g = pathField('glob');
      if (g.bad) return g.bad;
      if (g.value !== undefined) return checkGrepGlob(g.value);
      return argOk;
    }
    default:
      return { ok: false, code: 'invalid_arguments', reason: `no read-argument rule for ${canonical}` };
  }
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
    const serverTools = Object.hasOwn(MCP_TOOL_CLASSES, mcp.server) ? MCP_TOOL_CLASSES[mcp.server] : undefined;
    const cls = serverTools && Object.hasOwn(serverTools, mcp.tool) ? serverTools[mcp.tool] : undefined;
    if (!cls) return deny('unknown_tool', `MCP tool "${name}" is not a catalogued tool`);
    actionClass = cls;
  } else {
    const cls = builtinClass(canonical);
    if (!cls) return deny('unknown_tool', `tool "${name}" is not a catalogued tool`);
    if (!policy.allowedTools.includes(canonical)) {
      return deny('not_granted', `tool "${name}" is not granted by ${policy.agentId}'s charter`, cls);
    }
    actionClass = cls;
    // Hard limit: no input field the policy does not understand (D2).
    const fields = checkInputFields(canonical, input);
    if (!fields.ok) return deny(fields.code, fields.reason, cls);
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
      const r = await checkReadArgs(policy, canonical, input, guard);
      if (!r.ok) return deny(r.code, r.reason, actionClass);
      break;
    }
    case 'write': {
      const field = WRITE_PATH_FIELD[canonical];
      const target = field === undefined ? undefined : input[field];
      if (typeof target !== 'string' || target.trim() === '') {
        return deny('invalid_arguments', `${name} requires a string ${field ?? 'file path'}`, actionClass);
      }
      if (policy.writeRoots.length === 0) {
        return deny('path_outside_roots', `no write root assigned to ${policy.agentId} (read-only execution)`, actionClass);
      }
      const r = await checkPathArg(field ?? 'path', target, policy.writeRoots, policy.cwd, guard);
      if (!r.ok) return deny(r.code, r.reason, actionClass);
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
 * Default containment: interprets the target with `interpretToolPath` (so a
 * raw `~`, env-var, UNC/device, drive-relative or root-relative form is
 * refused even when the guard is called directly), resolves `..`, and compares
 * both lexical and real-ancestor forms case-insensitively on Windows.
 * `evaluateToolCall` always hands a guard the interpreted absolute path.
 * WS-D's FR-SEC-02 broker can replace it.
 */
export const defaultPathGuard: PathGuard = (target, roots, base) => {
  if (typeof target !== 'string' || target === '' || target.includes('\0')) {
    return Promise.resolve({ ok: false, reason: 'empty or NUL-containing path' });
  }
  const interpreted = interpretToolPath(target, base);
  if (!interpreted.ok) return Promise.resolve({ ok: false, reason: interpreted.reason });
  if (roots.length === 0) return Promise.resolve({ ok: false, reason: 'no roots assigned' });
  const lexical = interpreted.path;
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

/** Canonical (sorted-key) JSON of a value; throws on cycles/BigInt. */
function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'undefined';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(',')}}`;
}

/** Hash identifying exactly which call a cached decision was made for. An
 * unhashable input gets a unique value, so it can never match (re-evaluate). */
function callFingerprint(toolName: string, input: unknown, subagentId: string | undefined): string {
  try {
    return createHash('sha256')
      .update(canonicalJson({ toolName, input, subagentId: subagentId ?? null }))
      .digest('hex');
  } catch {
    return `unhashable:${randomUUID()}`;
  }
}

/**
 * Build the SDK permission options for `policy`. Every tool call is decided by
 * `evaluateToolCall`: the PreToolUse hook decides (and denies natively);
 * `canUseTool` reuses that decision only when the tool-use id AND the
 * fingerprint of (tool name, input, subagent) match what the hook evaluated,
 * and otherwise decides afresh.
 */
export function buildClaudeSdkPermissionOptions(
  policy: ExecutionPolicy,
  hooks: SdkEnforcementHooks = {},
): ClaudeSdkPermissionOptions {
  // Keyed by tool-use id, and only reused when the tool name, input and
  // subagent are byte-identical (canonical JSON hash) to what the hook
  // evaluated. Anything else is re-evaluated, never a stale allow (D2).
  const decided = new Map<string, { fingerprint: string; decision: PolicyDecision }>();
  const remember = (id: string | undefined, fingerprint: string, d: PolicyDecision): void => {
    if (!id) return;
    if (decided.size > 1024) decided.clear();
    decided.set(id, { fingerprint, decision: d });
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
    remember(
      hookInput.tool_use_id ?? toolUseID,
      callFingerprint(hookInput.tool_name, input, hookInput.agent_id),
      decision,
    );
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
    const cached = decided.get(options.toolUseID);
    decided.delete(options.toolUseID);
    let decision =
      cached && cached.fingerprint === callFingerprint(toolName, input, options.agentID) ? cached.decision : undefined;
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

  const builtins = policy.allowedTools.filter((t) => builtinClass(t) !== undefined);
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
