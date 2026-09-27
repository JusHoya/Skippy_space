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
//      for `bypassPermissions`, which is never granted. Charter keys are
//      compared after normalisation (trim, lowercase, `-` -> `_`): an alias
//      spelling of a known authority key, an unknown authority-looking key at
//      any depth, or an authority key nested below the top level fails closed
//      (red-team N4). Filesystem roots come ONLY from the *execution context*
//      (the assigned worktree and/or an explicitly configured project root),
//      never from charter text and never from the sidecar's ambient
//      `process.cwd()` (red-team N2): no roots => read roots are empty and every
//      built-in filesystem read is denied (the board can still use the brokered
//      vault MCP tools). A root may not be a drive root, the user's home
//      directory or an ancestor of it, a well-known credential location, a
//      dot-directory directly under the home directory, or the profile's
//      `AppData` (`Local`/`Roaming`/`LocalLow`) directory itself. Well-known
//      credential locations (`.ssh/`, `.aws/`, `.env*`, `*.pem`, `*.key`,
//      `id_rsa*`, `.npmrc`, `.netrc`, `.git-credentials`,
//      `.claude/.credentials*`, `.codex/auth*`, the vault's
//      `.skippy/ingest-sidecar.key`, …) are denied even inside the roots as defense in
//      depth (FR-SEC-02). The credential rule is evaluated on the literal
//      argument AND on its canonical long real path (`realpathSync.native` of
//      the nearest existing ancestor, so an 8.3 short name such as `ENV~1`
//      or a junction such as `lnk -> .aws` resolves to the name the rule
//      knows — red-team F2 D1/D3), and any path segment containing
//      `~<digit>` is refused outright as an 8.3 alias (the vault broker's
//      short-name rule). Grep and Glob are search tools whose *results* can
//      reach credential files the arguments never named (F2 D2, F3): before
//      either runs, the exact tree rg will walk (Grep: the interpreted
//      `path`; Glob: the CLI's own single split of the raw pattern,
//      `cliGlobSplit` — for a pattern without a metacharacter that is its
//      `dirname`; as a real long path) is enumerated in full — bounded, long names, reparse points not
//      descended, NO carve-outs — and the call is DENIED when any credential
//      entry exists anywhere in that tree or the bound is hit ("narrow
//      `path`"). Nothing is rewritten and no glob is modelled: a glob can
//      only narrow rg's output, never widen it. As defense in depth a
//      PostToolUse hook withholds any Grep/Glob output in which a credential
//      name appears anywhere at a path-separator boundary, with no caps
//      (see "Search output redaction").
//   2. `evaluateToolCall(policy, call, hooks)` is the single decision function.
//      Hard limits (grant, disallow, known tool, roots, arguments, no
//      grandchildren) are checked first and cannot be overridden by approval.
//      Approval-required action classes then consult an Approver, which by
//      default denies (no approval channel exists yet; FR-SEC-03 is P1).
//   3. `buildClaudeSdkPermissionOptions` translates the policy into the Claude
//      Agent SDK's native controls (verified against the installed
//      @anthropic-ai/claude-agent-sdk 0.3.162 `Options` type): `permissionMode`
//      (never bypass), `tools`, empty `allowedTools`, `disallowedTools`,
//      `canUseTool`, a `PreToolUse` hook, a `PostToolUse` hook, `cwd`,
//      `settingSources: []` and `strictMcpConfig`. The PreToolUse hook fires
//      for every tool call (even ones the CLI would auto-approve), so a
//      denial is enforcement, not observation. Verified live against CLI
//      2.1.162 (F2): `canUseTool` is NOT consulted for the auto-approved
//      read tools (Read/Grep/Glob), so the PreToolUse hook is their only
//      pre-execution gate; a PostToolUse `updatedToolOutput` in the tool's
//      own output shape replaces what the model sees (the CLI validates it
//      with the tool's `outputSchema` and falls back to the original on
//      mismatch). The gates FAIL CLOSED (M0-G07): the CLI turns a hook that
//      throws into `{}` (no objection), so any unexpected error inside a gate
//      is an explicit deny / withheld output, and the `onDecision` audit
//      observer is invoked guarded — its failure never changes a decision.
//      The executor's process environment is an allowlist (executor-env.ts,
//      M0-G06, OQ-22) so ambient variables cannot swap the rg the OQ-18
//      tree gate models.
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
// refused; Glob patterns are refused per brace alternative (the tree rg
// walks is derived once from the raw pattern); `disallowed_tools`
// entries must name catalogued tools.

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
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

/** Every top-level charter key the schema knows (PRD §6.1 + agent_space/
 * CLAUDE.md + the staff/task charter extensions). A key outside this set is
 * tolerated only when it does not look authority-related. */
const KNOWN_CHARTER_KEYS = new Set([
  ...KNOWN_AUTHORITY_KEYS,
  'agent',
  'board',
  'task',
  'role',
  'display_name',
  'codename',
  'costume',
  'model',
  'effort',
  'memory',
  'spawnable_task_agents',
  'ports_from',
  'reports_to',
  'parent_staff',
  'owns_pipeline',
  'execution_profile',
  'placeholder',
  'reason',
  'error',
]);

/** A frontmatter key matching this pattern is treated as an authority field.
 * If it is not in KNOWN_AUTHORITY_KEYS it fails closed rather than being
 * silently ignored (e.g. `allowed_tools`, `dangerously_skip_permissions`,
 * `sandbox`, `network_hosts`, `write_roots`). */
const AUTHORITY_KEY_PATTERN =
  /(permission|allow|bypass|danger|sandbox|network|approv|tool|mcp|root|scope|sudo|trust)/i;

/** Charter mapping keys must be printable ASCII (red-team F2 D5: a Cyrillic
 * `о` in `permissiоn_mode` made the key unknown and therefore ignored). */
const NON_ASCII_KEY = /[^\x20-\x7e]/;

/** A key within this optimal-string-alignment (Damerau-Levenshtein) distance
 * of a known authority key, after normalisation, is a lookalike
 * (`permision_mode`, `tool`, `mcp_server`) and fails closed (F2 D5). */
const AUTHORITY_KEY_MAX_EDIT_DISTANCE = 2;

/** Canonical spelling used to compare charter keys: trimmed, lower-cased,
 * `-` folded to `_`. */
function normalizeCharterKey(key: string): string {
  return key.trim().toLowerCase().replace(/-/g, '_');
}

/** Optimal string alignment distance (Damerau-Levenshtein with adjacent
 * transpositions). Small inputs only (charter keys). */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const d: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) (d[i] as number[])[0] = i;
  for (let j = 0; j <= n; j++) (d[0] as number[])[j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const row = d[i] as number[];
      const prev = d[i - 1] as number[];
      row[j] = Math.min((prev[j] as number) + 1, (row[j - 1] as number) + 1, (prev[j - 1] as number) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        row[j] = Math.min(row[j] as number, ((d[i - 2] as number[])[j - 2] as number) + 1);
      }
    }
  }
  return (d[m] as number[])[n] as number;
}

/** The known authority key `norm` looks like (edit distance <= 2), or null. */
function lookalikeAuthorityKey(norm: string): string | null {
  for (const k of KNOWN_AUTHORITY_KEYS) {
    if (norm !== k && editDistance(norm, k) <= AUTHORITY_KEY_MAX_EDIT_DISTANCE) return k;
  }
  return null;
}

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
  | 'invalid_charter_key'
  | 'invalid_context'
  | 'invalid_root'
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
  /** Working directory for the executor: inside a root, or — when no root was
   * assigned — a dedicated empty scratch directory that is NOT a read root. */
  readonly cwd: string;
  /** Absolute roots the agent may read with built-in tools (worktree and/or
   * project root). Empty when no root was assigned => all reads denied. */
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
  /** Assigned worktree (absolute). The ONLY built-in write root; also a read
   * root. */
  worktreePath?: string;
  /** Explicitly configured project root (absolute): a read-only root. Must be
   * handed in by the runtime from configuration — never the sidecar cwd. */
  projectRoot?: string;
  /** Executor working directory (absolute). Must lie inside one of the roots.
   * Defaults to the worktree, else the project root, else (no roots) the
   * dedicated no-root scratch directory. It is NOT a root by itself. */
  cwd?: string;
  /** Hostnames WebFetch may reach without approval (from a future execution
   * profile, never from charter text). Default: none. */
  networkAllowedHosts?: readonly string[];
}

/**
 * Working directory handed to an executor that has NO filesystem roots. It is
 * deliberately an empty, dedicated directory (created by the executor adapter
 * before launch) and is never a read root, so a relative path resolved against
 * it is still denied. Overridable for tests via SKIPPY_NO_ROOT_CWD.
 */
export function noRootWorkingDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.SKIPPY_NO_ROOT_CWD;
  if (override && path.isAbsolute(override)) return path.resolve(override);
  return path.join(os.tmpdir(), 'skippy-agent-runtime', 'no-root');
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

/** Profile directories directly under the home directory that are never a
 * root by themselves: they hold every per-user credential store on disk. */
const HOME_PROFILE_DIRS: readonly string[] = ['AppData', 'AppData/Local', 'AppData/Roaming', 'AppData/LocalLow'];

/**
 * Why `root` may not serve as a filesystem root for an agent, or null. A root
 * must be absolute and interpretable (no `~`, env-var, UNC/device, 8.3
 * short-name forms), and may not be a drive/filesystem root, the user's home
 * directory, an ancestor of the home directory, a well-known credential
 * location (or inside one), a dot-directory directly under the home
 * directory (`~/.ssh`, `~/.claude`, `~/.config`, …) or the profile's
 * `AppData` / `AppData/{Local,Roaming,LocalLow}` directory itself — lexically
 * or after resolving reparse points. Such a root would put credential stores
 * in scope (F2 observation).
 */
export function rootRejection(root: string, home: string = os.homedir()): string | null {
  if (typeof root !== 'string' || root.trim() === '') return 'root must be a non-empty string';
  if (!path.isAbsolute(root)) return 'root must be an absolute path';
  const interpreted = interpretToolPath(root, path.parse(path.resolve(root)).root);
  if (!interpreted.ok) return `root refused: ${interpreted.reason}`;
  const abs = path.resolve(interpreted.path);
  if (path.parse(abs).root === abs) return 'a drive or filesystem root may not be a root';
  const homeAbs = path.resolve(home);
  const forms = new Set([key(abs), key(realish(abs))]);
  const homeForms = new Set([key(homeAbs), key(realish(homeAbs))]);
  for (const r of forms) {
    const cred = credentialPathRejection(r);
    if (cred) return `a credential location may not be a root: ${cred}`;
    for (const h of homeForms) {
      if (r === h) return 'the user home directory may not be a root';
      if (contains(r, h)) return 'an ancestor of the user home directory may not be a root';
      if (contains(h, r)) {
        const rel = path.relative(h, r).split(/[\\/]/);
        if (rel[0]?.startsWith('.')) return `a dot-directory under the user home directory (${rel[0]}) may not be a root`;
        const relKey = rel.join('/').toLowerCase();
        if (HOME_PROFILE_DIRS.some((d) => d.toLowerCase() === relKey)) {
          return `the profile directory ${rel.join('/')} may not be a root`;
        }
      }
    }
  }
  return null;
}

function requireRoot(charter: Charter, label: string, p: string | undefined): string | undefined {
  const abs = requireAbsolute(charter, label, p);
  if (abs === undefined) return undefined;
  const why = rootRejection(abs);
  if (why) fail('invalid_root', charter, `${label} ${JSON.stringify(p)} rejected: ${why}`);
  return abs;
}

/**
 * Walk the frontmatter and fail closed on any authority-shaped key that is
 * not exactly a known top-level authority key (FR-BOARD-01, red-team N4, F2
 * D5). The rule, applied to every mapping key at every depth:
 *   - a key containing any non-printable-ASCII character (Cyrillic
 *     lookalikes, zero-width characters) is refused (`invalid_charter_key`);
 *   - a top-level key whose normalised form is a known authority key but whose
 *     spelling differs (`Tools`, `disallowed-tools`, ` tools`) is refused;
 *   - a top-level key outside the charter schema that matches the authority
 *     pattern (`allowed_tools`, `dangerously_skip_permissions`) or lies within
 *     edit distance 2 of a known authority key (`permision_mode`, `toolz`)
 *     is refused rather than silently ignored;
 *   - any nested key (any depth, inside mappings or sequences) that is, looks
 *     like, or is within edit distance 2 of an authority key is refused —
 *     authority is top-level only.
 */
function checkCharterKeys(charter: Charter): void {
  const visit = (value: unknown, depth: number, trail: string): void => {
    if (Array.isArray(value)) {
      value.forEach((v, i) => visit(v, depth + 1, `${trail}[${i}]`));
      return;
    }
    if (value === null || typeof value !== 'object') return;
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      const norm = normalizeCharterKey(key);
      const label = trail ? `${trail}.${key}` : key;
      if (NON_ASCII_KEY.test(key)) {
        fail(
          'invalid_charter_key',
          charter,
          `charter key ${JSON.stringify(key)} (${label}) contains non-ASCII characters; keys must be printable ASCII (FR-BOARD-01)`,
        );
      }
      const lookalike = lookalikeAuthorityKey(norm);
      if (depth === 0) {
        if (KNOWN_AUTHORITY_KEYS.has(norm) && key !== norm) {
          fail(
            'unknown_authority_field',
            charter,
            `authority field \`${key}\` must be spelled exactly \`${norm}\`; refusing an alias spelling (FR-BOARD-01)`,
          );
        }
        if (!KNOWN_CHARTER_KEYS.has(norm) && (AUTHORITY_KEY_PATTERN.test(norm) || lookalike)) {
          fail(
            'unknown_authority_field',
            charter,
            `unrecognized authority field \`${key}\`${lookalike ? ` (looks like \`${lookalike}\`)` : ''}; refusing rather than silently ignoring it (FR-BOARD-01)`,
          );
        }
      } else if (KNOWN_AUTHORITY_KEYS.has(norm) || AUTHORITY_KEY_PATTERN.test(norm) || lookalike) {
        fail(
          'unknown_authority_field',
          charter,
          `authority-shaped field \`${label}\` is nested; authority fields are top-level only (FR-BOARD-01)`,
        );
      }
      visit(v, depth + 1, label);
    }
  };
  visit(charter.frontmatter, 0, '');
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

  checkCharterKeys(charter);

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

  // Roots come only from the execution context. There is deliberately no
  // fallback to process.cwd(): the sidecar's ambient directory (Tauri's launch
  // dir, a home directory, …) is never a root (red-team N2).
  const worktree = requireRoot(charter, 'worktreePath', ctx.worktreePath);
  const project = requireRoot(charter, 'projectRoot', ctx.projectRoot);
  const writeRoots = worktree ? [worktree] : [];
  const readRoots = [...new Set([...writeRoots, ...(project ? [project] : [])])];
  const explicitCwd = requireAbsolute(charter, 'cwd', ctx.cwd);
  let cwd: string;
  if (explicitCwd !== undefined) {
    if (!readRoots.some((r) => contains(r, explicitCwd) && contains(realish(r), realish(explicitCwd)))) {
      fail('invalid_context', charter, `cwd ${JSON.stringify(ctx.cwd)} must lie inside an assigned root (a cwd is never a root by itself)`);
    }
    cwd = explicitCwd;
  } else {
    cwd = worktree ?? project ?? noRootWorkingDirectory();
  }

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
  | 'credential_path'
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
// Glob (`Au7`) runs `rg --files --glob <pattern> … <path>`; when the pattern
// is absolute it instead searches the pattern's split base (`b3f`: the text
// before the first of `*?[{`, cut at the last separator — or, with no
// metacharacter, the pattern's `dirname`) and ignores `path`; see
// `cliGlobSplit` for the transcribed code. Grep (`call`)
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
//     — must pass the PathGuard. Unbalanced braces are refused. Separately,
//     the tree rg walks (`cliGlobSplit` of the raw pattern) must pass the
//     PathGuard and the search-tree credential gate.
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
/** `~<digit>` anywhere in a segment: the Win32 8.3 short-name form. */
const SHORT_NAME_SEGMENT = /~\d/;
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
    for (const seg of p.split(/[\\/]/)) {
      if (seg === '' || seg === '.' || seg === '..') continue;
      // F2 D1: `ENV~1`, `AWS~1`, `PROGRA~1` alias a long name the deny list
      // knows; refused outright (both literal paths and glob alternatives).
      if (SHORT_NAME_SEGMENT.test(seg)) return `segment "${seg}" looks like an 8.3 short name (aliases another name)`;
      if (!names) continue;
      if (/[. ]$/.test(seg)) return `segment "${seg}" ends in a dot or space (Win32 strips it, aliasing another name)`;
      if (WIN_RESERVED_NAME.test(seg)) return `segment "${seg}" is a reserved device name`;
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

// ──────────────────────────────────────────────────────────────────────────────
// Credential locations (FR-SEC-02 "credentials belong in OS or
// provider-managed stores"; red-team N2 defense in depth)
// ──────────────────────────────────────────────────────────────────────────────
//
// Even inside an assigned root, built-in filesystem tools may not touch the
// well-known places credentials live. This is a name-based deny list applied
// to every interpreted path argument and to every Glob / Grep-glob
// alternative (each segment is tested, so `*.pem`, `.env*` or `.ssh/**` as a
// pattern is refused just like the literal file). It is deliberately broad —
// a false positive costs one denied read; a false negative leaks a secret.

/** Directory names that are credential stores wherever they appear. */
const CREDENTIAL_DIR_SEGMENTS: ReadonlySet<string> = new Set([
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
  '.azure',
  '.docker',
]);

/** Basename patterns (tested case-insensitively) of well-known credential
 * files. `.env*` is literal: ANY basename starting with `.env` (`.env`,
 * `.env.local`, `.envrc`, `.env-prod`, `.env_local`, and yes `.envelope.md`)
 * is a credential name — there is no safe-name exception list to get wrong
 * (F3). */
const CREDENTIAL_BASENAME_PATTERNS: readonly RegExp[] = [
  /^\.env/i, // `.env*`
  /\.(?:pem|key|p12|pfx|jks|keystore|ppk)$/i,
  // The per-vault ingest-sidecar HMAC key (`vault/.skippy/ingest-sidecar.key`,
  // @skippy/memory H4): whoever reads it can forge ingest sidecars. Already
  // covered by `*.key`; pinned by name so the suffix rule can never be
  // relaxed out from under it.
  /^ingest-sidecar\.key$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)/i, // id_rsa, id_rsa.pub, id_ed25519*
  /^\.npmrc$/i,
  /^\.?_?netrc$/i, // .netrc, _netrc, netrc
  /^\.pypirc$/i,
  /^\.git-credentials$/i,
  /^\.htpasswd$/i,
  /^\.credentials/i, // .claude/.credentials.json
  /credentials\.json$/i, // application_default_credentials.json
];

/** `<dir>/<basename-prefix>*` pairs: `.codex/auth*`, `.claude/.credentials*`. */
const CREDENTIAL_DIR_PREFIX: readonly (readonly [string, string])[] = [
  ['.codex', 'auth'],
  ['.claude', '.credentials'],
];

/**
 * Why `p` (an interpreted absolute path, or a glob alternative) names a
 * well-known credential location, or null.
 */
export function credentialPathRejection(p: string): string | null {
  const segs = p.split(/[\\/]/).filter((s) => s !== '' && s !== '.');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i] as string;
    const lower = seg.toLowerCase();
    if (CREDENTIAL_DIR_SEGMENTS.has(lower)) {
      return `"${seg}" is a credential store directory`;
    }
    for (const [dir, prefix] of CREDENTIAL_DIR_PREFIX) {
      const next = segs[i + 1];
      if (lower === dir && next !== undefined && next.toLowerCase().startsWith(prefix)) {
        return `"${dir}/${next}" is a credential file`;
      }
    }
  }
  const last = segs[segs.length - 1];
  if (last !== undefined && CREDENTIAL_BASENAME_PATTERNS.some((re) => re.test(last))) {
    return `"${last}" matches a credential file pattern`;
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────────
// The CLI's own Glob/Grep search-root derivation (EC2; FR-SEC-01/02)
// ──────────────────────────────────────────────────────────────────────────────
//
// Transcribed from the CLI bundled in @anthropic-ai/claude-agent-sdk-win32-x64
// 0.3.162 (claude.exe, CLI 2.1.162). `Zl`/`mk` are `require("path")` (win32 on
// Windows), `x8()` is the session cwd (the SDK `cwd` option), `o8()` the
// platform:
//
//   Glob.getPath({path:H}){return H?GK(H):x8()}
//   Glob.call: Au7(H.pattern, tC.getPath(H), …)
//   function b3f(H){let q=/[*?[{]/,$=H.match(q);
//     if(!$||$.index===void 0){let z=Zl.dirname(H),Y=Zl.basename(H);
//       return{baseDir:z,relativePattern:Y}}
//     let K=H.slice(0,$.index),_=Math.max(K.lastIndexOf("/"),K.lastIndexOf(Zl.sep));
//     if(_===-1)return{baseDir:"",relativePattern:H};
//     let f=K.slice(0,_),A=H.slice(_+1);if(f===""&&_===0)f="/";
//     if(o8()==="windows"&&/^[A-Za-z]:$/.test(f))f=f+Zl.sep;
//     return{baseDir:f,relativePattern:A}}
//   async function Au7(H,q,…){let A=q,z=H;
//     if(Zl.isAbsolute(H)){let{baseDir:L,relativePattern:Z}=b3f(H);if(L)A=L,z=Z}
//     … j=["--files","--glob",z,"--sort=modified","--no-ignore","--hidden",…];
//     D=await o6H(j,A,_) …}
//   zz7 (rg runner): execFile(rg, [...rgArgs, ...j, A], {cwd: x8(), …})
//   Grep.call: J=q?GK(q):x8(); … o6H(L,J,…)   (rg positional = J, cwd = x8())
//   function GK(H,q){let $=q??x8();…let K=H.trim();if(!K)return mk.normalize($);
//     if(K==="~")return homedir();if(K.startsWith("~/"))return mk.join(homedir(),K.slice(2));
//     let _=K;if(o8()==="windows"&&K.match(/^\/[a-z]\//i))_=OVH(K);
//     if(mk.isAbsolute(_))return mk.normalize(_);return mk.resolve($,_)}
//   OVH (for `/c/…`): K[1].toUpperCase()+":"+K.slice(2).replaceAll("/","\\")
//
// So the tree rg walks is the LAST positional argument: for Glob the raw
// pattern is split ONCE (never per brace alternative) — a pattern without a
// metacharacter walks its `dirname` with its `basename` as the glob, which
// matches that name at ANY depth — and for Grep it is the interpreted `path`.
// `--glob` values only filter within that tree.

/** The CLI's `GK` path helper, verbatim (no refusals: callers validate the
 * argument with `interpretToolPath` first). */
function cliToolPath(raw: string, cwd: string): string {
  const k = raw.trim();
  if (!k) return path.normalize(cwd);
  if (k === '~') return os.homedir();
  if (k.startsWith('~/')) return path.join(os.homedir(), k.slice(2));
  let p = k;
  if (onWindows() && /^\/[a-z]\//i.test(k)) p = `${k.charAt(1).toUpperCase()}:${k.slice(2).replace(/\//g, '\\')}`;
  if (path.isAbsolute(p)) return path.normalize(p);
  return path.resolve(cwd, p);
}

/** The CLI's Glob `b3f` split of an (absolute) pattern, verbatim. */
function cliSplitAbsolutePattern(pattern: string): { baseDir: string; relativePattern: string } {
  const m = GLOB_META.exec(pattern);
  if (!m) return { baseDir: path.dirname(pattern), relativePattern: path.basename(pattern) };
  const head = pattern.slice(0, m.index);
  const cut = Math.max(head.lastIndexOf('/'), head.lastIndexOf(path.sep));
  if (cut === -1) return { baseDir: '', relativePattern: pattern };
  let baseDir = head.slice(0, cut);
  const relativePattern = pattern.slice(cut + 1);
  if (baseDir === '' && cut === 0) baseDir = '/';
  if (onWindows() && /^[A-Za-z]:$/.test(baseDir)) baseDir = baseDir + path.sep;
  return { baseDir, relativePattern };
}

/**
 * Exactly what the bundled CLI hands rg for a Glob call (`Au7`): `baseDir` is
 * rg's positional search path (the tree it walks; rg's cwd is the session
 * `cwd`) and `relativePattern` its `--glob`. `pathArg` is the raw Glob `path`
 * input (an empty/absent value means the session cwd), `cwd` the session cwd.
 */
export function cliGlobSplit(
  pattern: string,
  pathArg: string | undefined,
  cwd: string,
): { baseDir: string; relativePattern: string } {
  let baseDir = pathArg ? cliToolPath(pathArg, cwd) : cwd;
  let relativePattern = pattern;
  if (path.isAbsolute(pattern)) {
    const split = cliSplitAbsolutePattern(pattern);
    if (split.baseDir) {
      baseDir = split.baseDir;
      relativePattern = split.relativePattern;
    }
  }
  return { baseDir, relativePattern };
}

/** Static prefix of one absolute glob alternative, used only to REFUSE an
 * alternative that names a place outside the roots or a credential location
 * (never to decide what rg walks: that is `cliGlobSplit` on the raw
 * pattern). */
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

// ──────────────────────────────────────────────────────────────────────────────
// Search-tree credential gate (red-team F2 D2, F3; FR-SEC-01 "observing tool
// events is not enforcement", FR-SEC-02)
// ──────────────────────────────────────────────────────────────────────────────
//
// Grep and Glob return whatever rg finds under their search root, so the
// name-based deny list on the *arguments* proves nothing about the *results*.
// Two earlier designs tried to keep such searches running by modelling rg's
// filtering — anchored negative globs (F2) and per-line prefix parsing of the
// output — and both were defeated (F3: rg evaluates `--glob` against ITS cwd,
// not the `path`; the prefix parser stopped at 64 boundaries). This design
// models nothing about filtering:
//
//   The tree rg will walk is enumerated in full and the call is denied if a
//   credential entry exists anywhere in it.
//
// - The tree is rg's positional search path: the interpreted `path` (Grep;
//   Glob with a relative pattern) or — for an absolute Glob pattern — the
//   CLI's single split of the raw pattern (`cliGlobSplit`; a pattern with no
//   metacharacter walks its `dirname`, and a brace pattern is cut at its
//   first `{`, never per alternative). It is normalised and resolved to its
//   real long path first.
// - `readdirSync` returns long names; reparse points (symlinks, junctions)
//   are judged by name and NOT descended, matching rg without `--follow`.
// - There is NO carve-out: `node_modules`, `.git` and every other directory
//   count. rg additionally honours `.gitignore` and VCS excludes, so what we
//   enumerate is a superset of what rg can return.
// - The enumeration is bounded (MAX_SCAN_ENTRIES / MAX_SCAN_DEPTH); hitting
//   a bound is a denial ("narrow `path`"), never an approximation.
// - A Grep `glob` / Glob `pattern` can only narrow rg's output within that
//   tree, never widen it, so it is not modelled for safety at all (it is
//   still refused when it escapes the root or names a credential).
//
// Cost: a search whose tree holds any credential-named entry — or more than
// MAX_SCAN_ENTRIES entries (a pnpm `node_modules`) — is denied and the model
// is told to narrow `path` to a subtree without credential files (OQ-18).

export const MAX_SCAN_ENTRIES = 25_000;
export const MAX_SCAN_DEPTH = 40;

export interface CredentialScan {
  /** Credential-matching directories (relative, `/`-separated); their
   * contents are still enumerated into `files`. */
  dirs: string[];
  /** Credential-matching files and reparse points (relative, `/`-separated),
   * including those under a credential directory. */
  files: string[];
  entries: number;
}

export type CredentialScanResult = { ok: true; scan: CredentialScan } | { ok: false; reason: string };

/**
 * Enumerate `root` (a directory) for credential-matching entries. A root
 * that is not an existing directory yields an empty scan (a file root was
 * already judged by `checkPathArg`; a missing root has nothing to leak).
 */
export function scanForCredentials(root: string): CredentialScanResult {
  let isDir = false;
  try {
    isDir = statSync(root).isDirectory();
  } catch {
    isDir = false;
  }
  const scan: CredentialScan = { dirs: [], files: [], entries: 0 };
  if (!isDir) return { ok: true, scan };
  const stack: Array<{ abs: string; rel: string; depth: number; inCredDir: boolean }> = [
    { abs: root, rel: '', depth: 0, inCredDir: false },
  ];
  while (stack.length > 0) {
    const cur = stack.pop() as { abs: string; rel: string; depth: number; inCredDir: boolean };
    if (cur.depth > MAX_SCAN_DEPTH) {
      return { ok: false, reason: `search tree under ${root} is deeper than ${MAX_SCAN_DEPTH}; narrow \`path\`` };
    }
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(cur.abs, { withFileTypes: true });
    } catch (err) {
      return { ok: false, reason: `cannot enumerate ${cur.abs}: ${String(err)}` };
    }
    for (const e of entries) {
      scan.entries++;
      if (scan.entries > MAX_SCAN_ENTRIES) {
        return { ok: false, reason: `search tree under ${root} exceeds ${MAX_SCAN_ENTRIES} entries; narrow \`path\`` };
      }
      const rel = cur.rel === '' ? e.name : `${cur.rel}/${e.name}`;
      const cred = cur.inCredDir || credentialPathRejection(e.name) !== null;
      if (e.isDirectory() && !e.isSymbolicLink()) {
        const credDir = !cur.inCredDir && cred;
        if (credDir) scan.dirs.push(rel);
        stack.push({ abs: path.join(cur.abs, e.name), rel, depth: cur.depth + 1, inCredDir: cur.inCredDir || credDir });
        continue;
      }
      // Files and reparse points (never descended): judged by name only.
      if (cred) scan.files.push(rel);
    }
  }
  return { ok: true, scan };
}

/** The real long path of the directory rg will walk for `abs`. */
function effectiveSearchRoot(abs: string): string {
  return realish(path.normalize(abs));
}

/**
 * Why a search rooted at `abs` (tool `label`) may not run, or null: the tree
 * holds a credential entry, or it could not be enumerated within bounds.
 */
function searchTreeRejection(label: string, abs: string): string | null {
  const root = effectiveSearchRoot(abs);
  const scanned = scanForCredentials(root);
  if (!scanned.ok) return `${label} refused: ${scanned.reason}`;
  const hits = scanned.scan.dirs.length + scanned.scan.files.length;
  if (hits === 0) return null;
  // The count only: the reason reaches the model verbatim, and where the
  // credential files are is not something a denied search should reveal.
  return (
    `${label} refused: the search tree under ${root} contains ${hits} well-known credential ` +
    `${hits === 1 ? 'entry' : 'entries'}; narrow \`path\` to a subtree without credential files (FR-SEC-02)`
  );
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

/** Why the interpreted absolute path `p` — literally or through its
 * canonical long real path (nearest existing ancestor resolved, so 8.3 short
 * names and junctions/symlinks resolve to the name the deny list knows) —
 * names a credential location, or null (F2 D1/D3). */
export function credentialTargetRejection(p: string): string | null {
  const literal = credentialPathRejection(p);
  if (literal) return literal;
  const real = realish(p);
  if (key(real) === key(p)) return null;
  const viaReal = credentialPathRejection(real);
  return viaReal ? `resolves to ${real}: ${viaReal}` : null;
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
  const cred = credentialTargetRejection(r.path);
  if (cred) return { ok: false, code: 'credential_path', reason: `${label} "${raw}" (${r.path}) denied: ${cred}` };
  const g = await guard(r.path, roots, base);
  if (!g.ok) return { ok: false, code: 'path_outside_roots', reason: `${label} "${raw}" (${r.path}) denied: ${g.reason}` };
  return argOk;
}

/** Glob `pattern` (+ optional `path`) must stay inside the read roots.
 * `pathArg` is the raw Glob `path` (already validated by `checkPathArg`),
 * `cwd` the session cwd, `searchBase` the interpreted `path` (or `cwd`). */
async function checkGlobPattern(
  pattern: string,
  pathArg: string | undefined,
  cwd: string,
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
    const cred = credentialPathRejection(alt);
    if (cred) return { ok: false, code: 'credential_path', reason: `glob pattern "${pattern}" refused: alternative "${alt}": ${cred}` };
    const root = globRootFor(alt, searchBase);
    const rootCred = credentialTargetRejection(root);
    if (rootCred) return { ok: false, code: 'credential_path', reason: `glob pattern "${pattern}" refused: searches ${root}: ${rootCred}` };
    const g = await guard(root, roots, searchBase);
    if (!g.ok) return bad(`alternative "${alt}" searches ${root}: ${g.reason}`);
  }
  // F2 D2 / F3 / EC2: the tree rg walks is exactly the CLI's split of the RAW
  // pattern (`cliGlobSplit`: one split, never per brace alternative; a
  // pattern without a metacharacter walks its `dirname`). That tree is
  // root-checked and enumerated in full; a credential entry anywhere in it
  // denies the call. The relative pattern is not modelled (it only narrows).
  const split = cliGlobSplit(pattern, pathArg, cwd);
  const baseWhy = pathAmbiguity(split.baseDir, true);
  if (baseWhy) return bad(`rg would search "${split.baseDir}": ${baseWhy}`);
  const rgRoot = path.resolve(cwd, split.baseDir);
  const rgRootCred = credentialTargetRejection(rgRoot);
  if (rgRootCred) return { ok: false, code: 'credential_path', reason: `glob pattern "${pattern}" refused: searches ${rgRoot}: ${rgRootCred}` };
  const g = await guard(rgRoot, roots, cwd);
  if (!g.ok) return bad(`rg would search ${rgRoot}: ${g.reason}`);
  const why = searchTreeRejection(`glob pattern "${pattern}"`, rgRoot);
  if (why) return { ok: false, code: 'credential_path', reason: why };
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
      const cred = credentialPathRejection(alt);
      if (cred) return { ok: false, code: 'credential_path', reason: `grep glob "${glob}" refused: "${alt}": ${cred}` };
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
      return checkGlobPattern(pattern, p.value, base, searchBase, roots, guard);
    }
    case 'Grep': {
      if (typeof input['pattern'] !== 'string') {
        return { ok: false, code: 'invalid_arguments', reason: 'Grep requires a string pattern' };
      }
      const p = pathField('path');
      if (p.bad) return p.bad;
      // No `path` => rg searches the executor cwd; that implicit base must
      // pass the same root check (with no roots assigned it is denied).
      const c = await checkPathArg('path', p.value ?? '', roots, base, guard);
      if (!c.ok) return c;
      const g = pathField('glob');
      if (g.bad) return g.bad;
      if (g.value !== undefined) {
        const gc = checkGrepGlob(g.value);
        if (!gc.ok) return gc;
      }
      // F2 D2 / F3: the whole tree rg walks under the search root is
      // enumerated; a credential entry anywhere in it denies the call. The
      // `glob` filter is not modelled (it can only narrow rg's output).
      const searchRoot = interpretToolPath(p.value ?? '', base);
      if (!searchRoot.ok) return { ok: false, code: 'path_outside_roots', reason: `path refused: ${searchRoot.reason}` };
      const why = searchTreeRejection('Grep', searchRoot.path);
      if (why) return { ok: false, code: 'credential_path', reason: why };
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
  const allow = (approved: boolean): PolicyDecision => ({ allow: true, actionClass, approved });
  const need = networkPreapproved ? { needed: false, why: '' } : approvalNeeded(policy, actionClass);
  if (!need.needed) return allow(false);
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
    ? allow(true)
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
  via: 'PreToolUse' | 'PostToolUse' | 'canUseTool' | 'mcp-broker';
}

// ──────────────────────────────────────────────────────────────────────────────
// Search output redaction (F2 D2 / F3 defense in depth)
// ──────────────────────────────────────────────────────────────────────────────
//
// After Grep/Glob ran, the PostToolUse hook inspects the tool's own result
// object (`tool_response`; shapes verified against the bundled CLI 2.1.162:
// Grep `{mode?, numFiles, filenames[], content?, numLines?, numMatches?, …}`,
// Glob `{durationMs, numFiles, filenames[], truncated}`) and withholds the
// ENTIRE output when any credential name appears anywhere in it. The
// pre-execution gate makes this unreachable except through a race (a
// credential created after the gate ran, before rg did); it is kept because
// a leak here reaches the model directly.
//
// The rule is deliberately dumb and uncapped (the F3 finding was a 64-prefix
// cap that let a path with 66 dashes through): every line is cut at EVERY
// path-separator boundary (line start, after each `/` or `\`) and EVERY end
// boundary (before each `/`, `\`, `:`, `-`, whitespace, and line end), and
// every such substring goes through the same `credentialPathRejection` the
// deny list uses — there is no second copy of the list to drift. Listed
// filenames and the `path:` prefix of each content line are additionally
// resolved to their real long path (a relative one against the session cwd,
// as the CLI prints it, and the search root). The search root itself (Grep
// `path`; Glob `cliGlobSplit` base) is re-resolved at PostToolUse time and
// the output withheld when it now names a credential location — a Grep over
// a single file prints no filename, so a TOCTOU swap of that `path` is only
// visible this way (D2). Output that cannot be judged within
// bounds (oversized, malformed shape, a line with too many boundaries) is
// withheld too. A false positive costs one redacted search; a false
// negative leaks a secret.

const SEARCH_REDACTION_NOTICE =
  '[Skippy tool policy: search results withheld because they included a well-known credential location (FR-SEC-02); narrow `path` to a subtree without credential files]';
/** Output larger than this is withheld unjudged (fail closed). */
export const MAX_REDACTION_BYTES = 4 * 1024 * 1024;
/** A single line with more start×end boundary pairs than this is withheld
 * unjudged (fail closed) rather than partially scanned. */
export const MAX_BOUNDARY_PAIRS_PER_LINE = 16_384;

const END_BOUNDARY = /[\\/:\s-]/;

/**
 * Why `line` names a credential location, or null. Every substring that
 * starts at a path-separator boundary and ends at an end boundary is judged
 * by the deny list; the `path:` prefix is also judged through its real path.
 * Returns a reason string when the line cannot be judged within bounds.
 */
export function lineCredentialRejection(line: string, searchRoot: string, cliCwd?: string): string | null {
  if (line === '') return null;
  const starts: number[] = [0];
  const ends: number[] = [];
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string;
    if (c === '/' || c === '\\') starts.push(i + 1);
    if (END_BOUNDARY.test(c)) ends.push(i);
  }
  ends.push(line.length);
  if (starts.length * ends.length > MAX_BOUNDARY_PAIRS_PER_LINE) {
    return `line has ${starts.length * ends.length} boundary pairs (over ${MAX_BOUNDARY_PAIRS_PER_LINE}); withheld unjudged`;
  }
  for (const s of starts) {
    for (const e of ends) {
      if (e <= s) continue;
      const why = credentialPathRejection(line.slice(s, e));
      if (why) return `"${line.slice(s, Math.min(e, s + 80))}": ${why}`;
    }
  }
  // The rg `path:` prefix (a Windows path holds no colon after the drive),
  // resolved to its real long path (junction / 8.3 aliases).
  const drive = /^[A-Za-z]:/.test(line) ? 2 : 0;
  const colon = line.indexOf(':', drive);
  const prefix = (colon === -1 ? line : line.slice(0, colon)).trim();
  if (prefix !== '') {
    // The CLI prints a relative prefix relative to its session cwd (`JBH`:
    // `path.relative(x8(), p)` unless that climbs out); `searchRoot` is kept
    // as a second base (defense in depth).
    const bases = cliCwd === undefined || key(cliCwd) === key(searchRoot) ? [searchRoot] : [cliCwd, searchRoot];
    for (const b of bases) {
      const abs = path.isAbsolute(prefix) ? path.normalize(prefix) : path.resolve(b, prefix);
      const why = credentialTargetRejection(abs);
      if (why) return `"${prefix.slice(0, 80)}": ${why}`;
    }
  }
  return null;
}

/** An empty Grep/Glob result in the tool's own output shape (so the CLI's
 * `outputSchema` check accepts it as the replacement). */
function withheldSearchReplacement(tool: 'Grep' | 'Glob', mode?: unknown): Record<string, unknown> {
  if (tool === 'Glob') return { durationMs: 0, numFiles: 0, filenames: [], truncated: false };
  const m = typeof mode === 'string' ? mode : 'files_with_matches';
  const replacement: Record<string, unknown> = { mode: m, numFiles: 0, filenames: [] };
  if (m === 'content') {
    replacement['content'] = SEARCH_REDACTION_NOTICE;
    replacement['numLines'] = 1;
  } else if (m === 'count') {
    replacement['content'] = '';
    replacement['numMatches'] = 0;
  }
  return replacement;
}

/**
 * Judge a Grep/Glob result. Returns the replacement output (same shape) and
 * the reason when the result names a credential path or cannot be judged,
 * else null.
 */
export function redactSearchOutput(
  policy: ExecutionPolicy,
  toolName: string,
  toolInput: unknown,
  toolResponse: unknown,
): { replacement: Record<string, unknown>; reason: string } | null {
  const canonical = canonicalTool(toolName);
  if (canonical !== 'Grep' && canonical !== 'Glob') return null;
  const input = toolInput && typeof toolInput === 'object' ? (toolInput as Record<string, unknown>) : {};
  const pathArg = typeof input['path'] === 'string' ? input['path'] : undefined;
  const root = interpretToolPath(pathArg ?? '', policy.cwd);
  let searchRoot = root.ok ? root.path : policy.cwd;
  if (canonical === 'Glob' && typeof input['pattern'] === 'string' && root.ok) {
    // The tree the CLI actually handed rg (see `cliGlobSplit`).
    searchRoot = path.resolve(policy.cwd, cliGlobSplit(input['pattern'], pathArg, policy.cwd).baseDir);
  }
  const withhold = (reason: string, mode?: unknown): { replacement: Record<string, unknown>; reason: string } => ({
    replacement: withheldSearchReplacement(canonical, mode),
    reason: `${canonical} output withheld (search root ${searchRoot}): ${reason}`,
  });
  // Anything but the documented object shape (or a plain string, which the
  // CLI uses for tool errors) cannot be judged: withheld.
  let res: Record<string, unknown>;
  if (typeof toolResponse === 'string') res = { content: toolResponse };
  else if (toolResponse && typeof toolResponse === 'object' && !Array.isArray(toolResponse)) res = toolResponse as Record<string, unknown>;
  else return withhold(`unrecognised tool_response shape (${Array.isArray(toolResponse) ? 'array' : typeof toolResponse})`);
  const mode = res['mode'];
  // D2 TOCTOU: the search root is re-resolved NOW. A Grep over a single file
  // prints content lines without a filename, so a `path` swapped (junction /
  // symlink) to a credential location after the gate ran is only visible
  // here.
  const rootNow = credentialTargetRejection(searchRoot);
  if (rootNow) return withhold(`search root now resolves to a credential location: ${rootNow}`, mode);
  const outputBases = key(policy.cwd) === key(searchRoot) ? [searchRoot] : [policy.cwd, searchRoot];
  let bytes = 0;
  const lines: string[] = [];
  if (Object.hasOwn(res, 'filenames') && res['filenames'] !== undefined) {
    if (!Array.isArray(res['filenames'])) return withhold('`filenames` is not an array', mode);
    for (const f of res['filenames'] as unknown[]) {
      if (typeof f !== 'string') return withhold('`filenames` holds a non-string entry', mode);
      bytes += f.length;
      lines.push(f);
      // A listed path is judged whole (literal and real) as well as by line;
      // a relative one is relative to the session cwd (CLI `JBH`).
      for (const b of outputBases) {
        const abs = path.isAbsolute(f) ? path.normalize(f) : path.resolve(b, f);
        const why = credentialTargetRejection(abs);
        if (why) return withhold(`listed path "${f.slice(0, 80)}": ${why}`, mode);
      }
    }
  }
  if (Object.hasOwn(res, 'content') && res['content'] !== undefined) {
    if (typeof res['content'] !== 'string') return withhold('`content` is not a string', mode);
    bytes += res['content'].length;
    lines.push(...res['content'].split(/\r?\n/));
  }
  if (bytes > MAX_REDACTION_BYTES) return withhold(`output is ${bytes} characters (over ${MAX_REDACTION_BYTES}); withheld unjudged`, mode);
  for (const line of lines) {
    const why = lineCredentialRejection(line, searchRoot, policy.cwd);
    if (why) return withhold(why, mode);
  }
  return null;
}

export interface SdkEnforcementHooks extends EnforcementHooks {
  /** Audit observer. It observes, never decides: a throw (or a rejected
   * promise) is swallowed and cannot change the decision (M0-G07). */
  onDecision?: (e: PolicyAuditEvent) => void;
}

/** Invoke the audit observer; its failure never changes a decision. */
function notifyDecision(hooks: SdkEnforcementHooks, e: PolicyAuditEvent): void {
  try {
    const r: unknown = (hooks.onDecision as ((e: PolicyAuditEvent) => unknown) | undefined)?.(e);
    if (r && typeof (r as { then?: unknown }).then === 'function') {
      (r as Promise<unknown>).then(undefined, () => undefined);
    }
  } catch {
    /* an observer error is not a policy input */
  }
}

/** `String(err)` that cannot itself throw. */
function describeError(err: unknown): string {
  try {
    return String(err);
  } catch {
    return '(unprintable error)';
  }
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
      return deny('invalid_arguments', `policy evaluation failed: ${describeError(err)}`);
    }
  };

  // FAIL CLOSED (M0-G07): the CLI turns a hook that throws into `{}` — a
  // pass-through, and for the auto-approved read tools `canUseTool` is never
  // consulted — so no exception may escape a gate. Every observer call goes
  // through `notifyDecision` (its failure cannot change the decision), and
  // any unexpected error inside a gate is an explicit deny / withheld output.
  const preToolUseDeny = (decision: PolicyDecision & { allow: false }) => ({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse' as const,
      permissionDecision: 'deny' as const,
      permissionDecisionReason: `Denied by Skippy tool policy (${decision.code}): ${decision.reason}`,
    },
  });

  const preToolUse: HookCallback = async (hookInput, toolUseID) => {
    try {
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
      notifyDecision(hooks, { agentId: policy.agentId, toolName: hookInput.tool_name, decision, via: 'PreToolUse' });
      if (decision.allow) return {}; // defer to the normal permission flow (canUseTool)
      return preToolUseDeny(decision);
    } catch (err) {
      return preToolUseDeny({ allow: false, code: 'invalid_arguments', reason: `policy gate failed: ${describeError(err)}` });
    }
  };

  const postToolUse: HookCallback = async (hookInput) => {
    const raw = hookInput as unknown as Record<string, unknown> | null | undefined;
    const rawToolName = typeof raw?.['tool_name'] === 'string' ? raw['tool_name'] : '(unknown)';
    let verdict: { replacement: Record<string, unknown>; reason: string } | null;
    try {
      if (hookInput.hook_event_name !== 'PostToolUse') return {};
      verdict = redactSearchOutput(policy, hookInput.tool_name, hookInput.tool_input, hookInput.tool_response);
    } catch (err) {
      // An output that could not be judged is withheld, never passed through.
      let tool: 'Grep' | 'Glob' = 'Grep';
      let mode: unknown;
      try {
        if (canonicalTool(rawToolName) === 'Glob') tool = 'Glob';
        const res = raw?.['tool_response'];
        if (res && typeof res === 'object') mode = (res as Record<string, unknown>)['mode'];
      } catch {
        /* keep the Grep default */
      }
      verdict = { replacement: withheldSearchReplacement(tool, mode), reason: `output could not be judged: ${describeError(err)}` };
    }
    if (!verdict) return {};
    notifyDecision(hooks, {
      agentId: policy.agentId,
      toolName: rawToolName,
      decision: deny('credential_path', verdict.reason, 'read'),
      via: 'PostToolUse',
    });
    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        updatedToolOutput: verdict.replacement,
        additionalContext: SEARCH_REDACTION_NOTICE,
      },
    };
  };

  const canUseTool: CanUseTool = async (toolName, input, options): Promise<PermissionResult> => {
    try {
      const cached = decided.get(options.toolUseID);
      decided.delete(options.toolUseID);
      let decision =
        cached && cached.fingerprint === callFingerprint(toolName, input, options.agentID) ? cached.decision : undefined;
      if (!decision) {
        decision = await safeEvaluate({ toolName, input, subagentId: options.agentID });
        notifyDecision(hooks, { agentId: policy.agentId, toolName, decision, via: 'canUseTool' });
      }
      return decision.allow
        ? { behavior: 'allow', updatedInput: input, toolUseID: options.toolUseID }
        : {
            behavior: 'deny',
            message: `Denied by Skippy tool policy (${decision.code}): ${decision.reason}`,
            toolUseID: options.toolUseID,
          };
    } catch (err) {
      const toolUseID = (options as { toolUseID?: unknown } | undefined)?.toolUseID;
      return {
        behavior: 'deny',
        message: `Denied by Skippy tool policy (invalid_arguments): policy gate failed: ${describeError(err)}`,
        ...(typeof toolUseID === 'string' ? { toolUseID } : {}),
      };
    }
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
    hooks: {
      PreToolUse: [{ hooks: [preToolUse] }],
      PostToolUse: [{ matcher: 'Grep|Glob', hooks: [postToolUse] }],
    },
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
  let decision: PolicyDecision;
  try {
    decision = await evaluateToolCall(policy, { toolName, input: args }, hooks);
  } catch (err) {
    decision = deny('invalid_arguments', `policy evaluation failed: ${describeError(err)}`);
  }
  notifyDecision(hooks, { agentId: policy.agentId, toolName, decision, via: 'mcp-broker' });
  return decision;
}
