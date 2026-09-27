// sdk-board.ts — gated real-agent execution for Board Captains via the Claude
// Agent SDK (PRD §5.1: boards as root query() processes).
//
// OFF BY DEFAULT. Set PHASE3_AGENTS_ENABLED=1 (and provide ANTHROPIC_API_KEY)
// to route an accepted delegation through a real `query()` — the board's
// charter as the system prompt. Whether a delegation may run live at all is
// decided by `resolveExecutionGate` (execution-gate.ts). This module only
// reports what the executor terminally did (PRD v0.2 FR-RUN-01): a `result`
// `success` message is the ONLY path to `status: 'succeeded'`; a tool-policy
// refusal is `blocked`; a thrown SDK error, an error result subtype, or a
// stream that ends without a result are `failed` with a reason. There is no
// stub fallback — a failure never masquerades as success.
//
// MCP tools (Phase 3.5): the Obsidian (D1) + Letta (D4) MCP servers ARE now
// wired — board.ts builds them from the charter's `mcp_servers:` via
// mcp-registry.ts and passes them in as `mcpServers`. They're constructed with
// agent-runtime's own zod@4 (matching the SDK's bundled v4), scoped so
// @skippy/shared + @skippy/memory stay on zod@3. Live execution still needs an
// API key (and, for full effect, a running Obsidian/Letta) — it cannot run in
// the headless, no-key exit gate.
//
// TOOL AUTHORITY (T02, FR-SEC-01, A02): there is NO permission bypass. The
// board's charter is turned into an ExecutionPolicy (tool-policy.ts) and the
// SDK runs under that policy's native controls — restricted `tools`, empty
// `allowedTools`, `disallowedTools`, a `canUseTool` + `PreToolUse` deny gate,
// an explicit `cwd`, no ambient settings and a strict MCP allowlist. If the
// policy cannot be derived or this adapter cannot enforce it, the mission is
// refused before the SDK is even imported. Filesystem roots come only from the
// explicit execution context (`worktreePath` = the only write root,
// `projectRoot` = an extra read-only root); the sidecar's ambient
// `process.cwd()` is never consulted (red-team N2). Without either, the board
// has NO read roots: every built-in filesystem read is denied and the CLI runs
// in a dedicated empty scratch directory.

import { mkdirSync } from 'node:fs';

import type { ExecutorTerminal, ModelId } from '@skippy/shared';
import type {
  CanUseTool,
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  McpServerConfig,
  SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';

import { loadCharter, type Charter, type CharterAgentId } from './charter.js';
import { resolveExecutionGate } from './execution-gate.js';
import { logger } from './logger.js';
import {
  CLAUDE_AGENT_SDK_CAPABILITIES,
  ToolPolicyError,
  assertExecutorEligible,
  buildClaudeSdkPermissionOptions,
  derivePolicy,
  filterMcpServers,
  parseMcpToolName,
  type ClaudeSdkPermissionOptions,
  type ExecutionPolicy,
  type SdkEnforcementHooks,
} from './tool-policy.js';

/** Executor-level terminal result (see `ExecutorTerminal` in @skippy/shared). */
export type SdkBoardResult = ExecutorTerminal;

/** True only when the SDK board path is enabled AND an API key is present
 * (PHASE3_AGENTS_ENABLED=1 + ANTHROPIC_API_KEY, and demo mode is off). */
export function sdkBoardsEnabled(): boolean {
  return resolveExecutionGate().kind === 'live';
}

/** The subset of the SDK module this executor uses; injectable for tests. */
export type ClaudeAgentSdkModule = Pick<typeof import('@anthropic-ai/claude-agent-sdk'), 'query'>;

export interface ExecuteBoardMissionDeps {
  /** Defaults to a dynamic import of `@anthropic-ai/claude-agent-sdk`. */
  loadSdk?: () => Promise<ClaudeAgentSdkModule>;
}

function loadClaudeAgentSdk(): Promise<ClaudeAgentSdkModule> {
  return import('@anthropic-ai/claude-agent-sdk');
}

export interface ExecuteBoardMissionParams {
  boardId: string;
  /** The board's charter body, used verbatim as the SDK system prompt. */
  systemPrompt: string;
  model: ModelId;
  missionBrief: string;
  /** Per-board MCP servers (obsidian/letta) from the charter, wired into query(). */
  mcpServers?: Record<string, McpServerConfig>;
  /** Tool-loop ceiling (R-01 cost guard). */
  maxTurns?: number;
  /** Charter the policy is derived from; loaded from agent_space when omitted. */
  charter?: Charter;
  /** Assigned worktree (absolute): the only built-in write root (and a read
   * root). */
  worktreePath?: string;
  /** Explicitly configured project root (absolute): a read-only root. Must be
   * validated configuration handed in by the runtime, never the sidecar cwd. */
  projectRoot?: string;
  /** Approval + path-guard hooks; default approver denies (no approval channel). */
  enforcement?: SdkEnforcementHooks;
}

/**
 * Derive the enforced policy for a board mission and prove this adapter can
 * enforce it. Throws ToolPolicyError (the mission must be refused). No
 * ambient `process.cwd()` is ever used: roots are exactly the ones the caller
 * assigned; with none, the read roots are empty and the executor's cwd is the
 * dedicated no-root scratch directory (created here so the CLI can start).
 */
export async function resolveBoardPolicy(params: ExecuteBoardMissionParams): Promise<ExecutionPolicy> {
  const charter =
    params.charter ?? (await loadCharter(`board.${params.boardId}` as CharterAgentId));
  const policy = derivePolicy(charter, {
    ...(params.worktreePath ? { worktreePath: params.worktreePath } : {}),
    ...(params.projectRoot ? { projectRoot: params.projectRoot } : {}),
  });
  assertExecutorEligible(policy, CLAUDE_AGENT_SDK_CAPABILITIES);
  if (policy.readRoots.length === 0) {
    mkdirSync(policy.cwd, { recursive: true });
  }
  return policy;
}

/**
 * Map one `result` message from the SDK stream to an executor terminal
 * status (D1, FR-RUN-01, G0 — fail closed).
 *
 * `terminal_reason` (see `TerminalReason` in `@anthropic-ai/claude-agent-sdk`
 * sdk.d.ts, `'blocking_limit' | 'rapid_refill_breaker' | 'prompt_too_long' |
 * 'image_error' | 'model_error' | 'aborted_streaming' | 'aborted_tools' |
 * 'stop_hook_prevented' | 'hook_stopped' | 'tool_deferred' | 'max_turns' |
 * 'completed'`) mapping implemented here:
 *
 *   | condition                                             | outcome     | reason code            |
 *   |--------------------------------------------------------|-------------|-------------------------|
 *   | `permission_denials` present but not an array (N6b)   | failed      | executor_error          |
 *   | non-empty `permission_denials`                        | blocked     | policy_refused          |
 *   | `api_error_status` present (not null)                 | failed      | provider_error          |
 *   | `terminal_reason` in {hook_stopped, stop_hook_prevented}| blocked     | policy_refused          |
 *   | `terminal_reason === 'tool_deferred'` or                | blocked     | approval_required       |
 *   |   `deferred_tool_use` present                          |             |                         |
 *   | `terminal_reason === 'aborted_tools'`                  | interrupted | tool_execution_aborted  |
 *   | `stop_reason === 'refusal'` (N6a)                      | failed      | model_refused           |
 *   | subtype `'success'`, `is_error === false`,             | succeeded   | —                       |
 *   |   `terminal_reason` absent or `'completed'`, and       |             |                         |
 *   |   `stop_reason` absent/null/`end_turn`/`stop_sequence` |             |                         |
 *   | anything else (error subtype, `is_error` on a          | failed      | executor_error          |
 *   |   success subtype, `model_error`, `prompt_too_long`,   |             |                         |
 *   |   `max_turns`, any other/unknown terminal_reason, or   |             |                         |
 *   |   any other stop_reason: `max_tokens`, `pause_turn`,   |             |                         |
 *   |   `tool_use`, `model_context_window_exceeded`, …)     |             |                         |
 *
 * `stop_reason` is typed `string | null` in sdk.d.ts (0.3.162) and carries
 * the final model turn's Messages API stop reason. Only `end_turn` /
 * `stop_sequence` (or no value) mean the model finished normally; every other
 * value is a truncated, paused or refused turn and fails closed.
 *
 * A succeeded result's `summary` is always a string (`result` when it is a
 * string, otherwise {@link NO_SUMMARY}) so the emitted `delegation_complete`
 * envelope satisfies the shared wire schema (N6c).
 *
 * Run-level tool denials that never reach `permission_denials` (task-agent /
 * subagent hook and canUseTool denials, N1) are applied on top of this per-
 * message mapping by `executeBoardMissionViaSdk` — see {@link DenialLedger}.
 * Task-agent provider errors / refusals, which the CLI reports to the parent
 * only as tool_result text under a `success` result (EC1 D1), are likewise
 * applied on top — see {@link RunFailureLedger} and {@link RunStreamObserver}.
 *
 * `terminal_reason` absence is treated as normal completion: the field is
 * optional in the SDK's own type and the SDK does not backfill it on every
 * ordinary success (verified against the installed
 * @anthropic-ai/claude-agent-sdk sdk.d.ts `SDKResultSuccess` type, which
 * declares it `terminal_reason?: TerminalReason`).
 *
 * The checks above run in this order regardless of `subtype`, so a `blocked`
 * or `provider_error` signal on an already-`error_*` subtype result still
 * gets its more specific reason code instead of the generic
 * `executor_error` catch-all.
 */
function mapSdkResultMessage(msg: SDKResultMessage, boardId: string): SdkBoardResult {
  const costUsd = typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : undefined;
  const withCost = (r: SdkBoardResult): SdkBoardResult => {
    if (costUsd !== undefined) r.costUsd = costUsd;
    return r;
  };

  // N6b: the SDK types `permission_denials` as an array. Anything else that
  // is present (object, string, null …) is a malformed result — it must not
  // be read as "no denials".
  const rawDenials: unknown = (msg as { permission_denials?: unknown }).permission_denials;
  if (rawDenials !== undefined && !Array.isArray(rawDenials)) {
    return withCost({
      status: 'failed',
      reason: {
        code: 'executor_error',
        message: `Board ${boardId} executor returned a malformed result (permission_denials is not an array).`,
        detail: `permission_denials: ${describeValue(rawDenials)}`,
      },
    });
  }
  const denials = (rawDenials ?? []) as unknown[];
  if (denials.length > 0) {
    return withCost({
      status: 'blocked',
      reason: {
        code: 'policy_refused',
        message: `Board ${boardId} executor was denied ${denials.length} tool call(s) by policy.`,
        detail: denials.map((d) => denialToolName(d)).join(', '),
      },
    });
  }

  if (msg.subtype === 'success' && msg.api_error_status !== undefined && msg.api_error_status !== null) {
    return withCost({
      status: 'failed',
      reason: {
        code: 'provider_error',
        message: `Board ${boardId} executor hit a provider API error (status ${msg.api_error_status}).`,
        detail: String(msg.api_error_status),
      },
    });
  }

  const terminalReason = msg.terminal_reason;

  if (terminalReason === 'hook_stopped' || terminalReason === 'stop_hook_prevented') {
    return withCost({
      status: 'blocked',
      reason: {
        code: 'policy_refused',
        message: `Board ${boardId} executor was stopped by a policy hook (${terminalReason}).`,
        detail: terminalReason,
      },
    });
  }

  const deferred = msg.subtype === 'success' ? msg.deferred_tool_use : undefined;
  if (terminalReason === 'tool_deferred' || deferred) {
    return withCost({
      status: 'blocked',
      reason: {
        code: 'approval_required',
        message: `Board ${boardId} executor deferred a tool call pending approval that has no channel yet.`,
        detail: deferred ? `${deferred.name} (${deferred.id})` : terminalReason,
      },
    });
  }

  if (terminalReason === 'aborted_tools') {
    return withCost({
      status: 'interrupted',
      reason: {
        code: 'tool_execution_aborted',
        message: `Board ${boardId} executor's tool calls were aborted mid-run.`,
        detail: terminalReason,
      },
    });
  }

  const stopReason: unknown = (msg as { stop_reason?: unknown }).stop_reason;
  const resultText = msg.subtype === 'success' && typeof msg.result === 'string' ? msg.result : undefined;

  if (stopReason === 'refusal') {
    return withCost({
      status: 'failed',
      reason: {
        code: 'model_refused',
        message: `Board ${boardId} executor's model refused the request (stop_reason: refusal).`,
        detail: [msg.subtype, resultText].filter(Boolean).join(': '),
      },
    });
  }

  const normalStop = stopReason === undefined || stopReason === null || NORMAL_STOP_REASONS.has(stopReason);
  const normalCompletion =
    msg.subtype === 'success' &&
    msg.is_error === false &&
    (terminalReason === undefined || terminalReason === 'completed') &&
    normalStop;
  if (normalCompletion) {
    return withCost({ status: 'succeeded', summary: resultText ?? NO_SUMMARY });
  }

  // Fail closed: an error subtype, a "success" subtype flagged is_error, any
  // other terminal_reason (model_error, prompt_too_long, max_turns,
  // blocking_limit, rapid_refill_breaker, aborted_streaming, image_error, or
  // an unrecognised future value) or an abnormal stop_reason (max_tokens,
  // pause_turn, …) never becomes success.
  const suffix = [
    terminalReason ? `terminal_reason: ${terminalReason}` : '',
    normalStop ? '' : `stop_reason: ${describeValue(stopReason)}`,
  ]
    .filter(Boolean)
    .join(', ');
  const errors = Array.isArray((msg as { errors?: unknown }).errors) ? (msg as { errors: unknown[] }).errors : [];
  const detail =
    msg.subtype === 'success'
      ? `success result ${msg.is_error === false ? 'ended abnormally' : 'flagged is_error'}: ${resultText ?? NO_SUMMARY}${suffix ? ` (${suffix})` : ''}`
      : [msg.subtype, terminalReason, normalStop ? '' : `stop_reason: ${describeValue(stopReason)}`, ...errors.map(String)]
          .filter(Boolean)
          .join(': ');
  return withCost({
    status: 'failed',
    reason: {
      code: 'executor_error',
      message: `Board ${boardId} executor ended with an error result (${msg.subtype}).`,
      detail,
    },
  });
}

// ── result-mapping helpers + run-level denial accounting (N1, N6) ───────────

/** Summary of a succeeded result whose `result` text is missing (N6c). The
 * wire schema requires `summary: string`, so it is never `undefined`. */
export const NO_SUMMARY = '(no summary)';

/** Messages API stop reasons meaning the final model turn ended normally. */
const NORMAL_STOP_REASONS: ReadonlySet<unknown> = new Set(['end_turn', 'stop_sequence']);

/** Short, redaction-safe description of an unexpected value for diagnostics. */
function describeValue(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'string') return JSON.stringify(v.length > 80 ? `${v.slice(0, 80)}…` : v);
  return typeof v;
}

function denialToolName(d: unknown): string {
  const name = d && typeof d === 'object' ? (d as { tool_name?: unknown }).tool_name : undefined;
  return typeof name === 'string' && name.length > 0 ? name : '(unknown tool)';
}

type DenialSource =
  | 'PreToolUse'
  | 'PermissionRequest'
  | 'canUseTool'
  | 'permission_denials'
  | 'policy-audit'
  // `system/permission_denied` stream message (SDKPermissionDeniedMessage).
  | 'permission_denied'
  // A call to a tool the executor was never offered (EC1 D2): the CLI answers
  // `is_error` "No such tool available" before the policy gate ever runs.
  | 'unavailable_tool';

interface ObservedDenial {
  toolName: string;
  source: DenialSource;
  reason?: string;
  /** Set when the denied call came from a spawned task agent (subagent). */
  agentId?: string;
}

const MAX_DENIALS_IN_DETAIL = 20;

/**
 * Every tool denial observed during one SDK run (N1, FR-RUN-01, G0).
 *
 * The CLI's result `permission_denials` omits denials of calls made inside a
 * spawned task agent, so the policy gate's own deny outcomes (PreToolUse hook
 * and canUseTool, main thread AND subagents) are recorded here as they
 * happen, unioned with every result message's `permission_denials`. Entries
 * are keyed by tool-use id, so the same call reported by the hook, by
 * canUseTool and by `permission_denials` counts once. Any entry forces the
 * run's terminal status to `blocked(policy_refused)`.
 */
export class DenialLedger {
  private readonly byToolUseId = new Map<string, ObservedDenial>();
  /** Audit-callback denials (no tool-use id): a fallback, never double counted. */
  private readonly audit: ObservedDenial[] = [];
  private anon = 0;

  record(toolUseId: string | undefined, d: ObservedDenial): void {
    const key = typeof toolUseId === 'string' && toolUseId.length > 0 ? toolUseId : `anon:${++this.anon}`;
    const prev = this.byToolUseId.get(key);
    if (!prev) {
      this.byToolUseId.set(key, d);
      return;
    }
    // Same call seen twice: keep the first report, filling in missing context.
    const merged: ObservedDenial = { toolName: prev.toolName, source: prev.source };
    const reason = prev.reason ?? d.reason;
    const agentId = prev.agentId ?? d.agentId;
    if (reason !== undefined) merged.reason = reason;
    if (agentId !== undefined) merged.agentId = agentId;
    this.byToolUseId.set(key, merged);
  }

  /** A deny reported only through the policy audit callback (defense in
   * depth: counts only when no gate-level denial was captured). */
  noteAudit(d: ObservedDenial): void {
    this.audit.push(d);
  }

  list(): ObservedDenial[] {
    return this.byToolUseId.size > 0 ? [...this.byToolUseId.values()] : [...this.audit];
  }

  get size(): number {
    return this.list().length;
  }

  toReason(boardId: string): { code: 'policy_refused'; message: string; detail: string } {
    const all = this.list();
    const subagent = all.filter((d) => d.agentId !== undefined).length;
    const shown = all.slice(0, MAX_DENIALS_IN_DETAIL).map((d) => {
      const who = d.agentId !== undefined ? ` [task agent ${d.agentId}]` : '';
      const why = d.reason ? `: ${d.reason.length > 200 ? `${d.reason.slice(0, 200)}…` : d.reason}` : '';
      return `${d.toolName}${who}${why}`;
    });
    if (all.length > shown.length) shown.push(`…and ${all.length - shown.length} more`);
    return {
      code: 'policy_refused',
      message:
        `Board ${boardId} executor was denied ${all.length} tool call(s) by policy` +
        (subagent > 0 ? ` (${subagent} in task agents).` : '.'),
      detail: shown.join('; '),
    };
  }
}

/** Deny reason carried by a permission-hook output, or null when it allows. */
function hookOutputDenial(event: string, out: unknown): { reason?: string } | null {
  if (!out || typeof out !== 'object') return null;
  const o = out as Record<string, unknown>;
  const hso = o.hookSpecificOutput && typeof o.hookSpecificOutput === 'object'
    ? (o.hookSpecificOutput as Record<string, unknown>)
    : undefined;
  if (event === 'PreToolUse') {
    if (hso?.permissionDecision === 'deny') {
      const r = hso.permissionDecisionReason;
      return typeof r === 'string' ? { reason: r } : {};
    }
    if (o.decision === 'block') return typeof o.reason === 'string' ? { reason: o.reason } : {};
  }
  if (event === 'PermissionRequest' && hso?.decision && typeof hso.decision === 'object') {
    const dec = hso.decision as { behavior?: unknown; message?: unknown };
    if (dec.behavior === 'deny') return typeof dec.message === 'string' ? { reason: dec.message } : {};
  }
  return null;
}

function instrumentHook(cb: HookCallback, ledger: DenialLedger): HookCallback {
  return async (input, toolUseID, options) => {
    const event = input.hook_event_name;
    const rec = input as unknown as Record<string, unknown>;
    const toolName = typeof rec.tool_name === 'string' ? rec.tool_name : `(${event} hook)`;
    const id = typeof rec.tool_use_id === 'string' ? rec.tool_use_id : toolUseID;
    const base: ObservedDenial = {
      toolName,
      source: event === 'PermissionRequest' ? 'PermissionRequest' : 'PreToolUse',
    };
    if (typeof rec.agent_id === 'string') base.agentId = rec.agent_id;
    const gates = event === 'PreToolUse' || event === 'PermissionRequest';
    let out: Awaited<ReturnType<HookCallback>>;
    try {
      out = await cb(input, toolUseID, options);
    } catch (err) {
      // A policy gate that throws is never an allow for accounting purposes.
      if (gates) ledger.record(id, { ...base, reason: `policy hook threw: ${String(err)}` });
      throw err;
    }
    const denied = gates ? hookOutputDenial(event, out) : null;
    if (denied) ledger.record(id, denied.reason !== undefined ? { ...base, reason: denied.reason } : base);
    return out;
  };
}

/**
 * Wrap the policy gate's `canUseTool` and permission hooks so that every
 * deny outcome — including those for calls inside spawned task agents
 * (`agentID` / `agent_id` set) — is recorded in `ledger`. The gate's
 * decisions and return values are passed through unchanged.
 */
export function instrumentPermissionOptions(
  permission: ClaudeSdkPermissionOptions,
  ledger: DenialLedger,
): ClaudeSdkPermissionOptions {
  const inner = permission.canUseTool;
  const canUseTool: CanUseTool = async (toolName, input, options) => {
    const base: ObservedDenial = { toolName, source: 'canUseTool' };
    if (typeof options.agentID === 'string') base.agentId = options.agentID;
    let result: Awaited<ReturnType<CanUseTool>>;
    try {
      result = await inner(toolName, input, options);
    } catch (err) {
      ledger.record(options.toolUseID, { ...base, reason: `permission callback threw: ${String(err)}` });
      throw err;
    }
    if (result.behavior !== 'allow') {
      const message = (result as { message?: unknown }).message;
      ledger.record(options.toolUseID, typeof message === 'string' ? { ...base, reason: message } : base);
    }
    return result;
  };
  const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};
  for (const [event, matchers] of Object.entries(permission.hooks) as Array<
    [HookEvent, HookCallbackMatcher[] | undefined]
  >) {
    if (!matchers) continue;
    hooks[event] = matchers.map((m) => ({ ...m, hooks: m.hooks.map((cb) => instrumentHook(cb, ledger)) }));
  }
  return { ...permission, canUseTool, hooks };
}

/**
 * Apply run-level denials to the run's terminal status: any observed denial
 * makes the run `blocked(policy_refused)` (N1). A non-denial failure the run
 * also hit is kept in the detail so it is not lost.
 */
function applyRunDenials(base: SdkBoardResult, ledger: DenialLedger, boardId: string): SdkBoardResult {
  if (ledger.size === 0) return base;
  const reason = ledger.toReason(boardId);
  if (base.status !== 'succeeded' && !(base.status === 'blocked' && base.reason.code === 'policy_refused')) {
    reason.detail = `${reason.detail} | run also ended ${base.status}(${base.reason.code}): ${base.reason.detail ?? base.reason.message}`;
  }
  const out: SdkBoardResult = { status: 'blocked', reason };
  if (base.costUsd !== undefined) out.costUsd = base.costUsd;
  return out;
}

// ── run-level task-agent failure accounting (EC1 D1/D2, FR-RUN-01, G0) ──────
//
// Verified against the bundled CLI 2.1.162 (@anthropic-ai/claude-agent-sdk
// 0.3.162) with a local mock Messages API: when a task agent (subagent) hits a
// provider error (401/400) or a refusal, the parent run still ends with a
// `success` result (`is_error: false`, `api_error_status: null`,
// `permission_denials: []`), the `task_notification` says `status:
// "completed"` and the Agent tool's `tool_result` is NOT flagged `is_error` —
// the failure is only the CLI's text in that tool_result. The structured
// signals that DO exist are:
//
//   1. The `StopFailure` hook fires for the task agent with `agent_id` and a
//      typed `error: SDKAssistantMessageError` (`authentication_failed`,
//      `invalid_request`, …). Registered by {@link withRunObservers}.
//   2. With `forwardSubagentText: true`, the CLI forwards the task agent's
//      synthetic terminal assistant message (`model: "<synthetic>"`) with
//      `parent_tool_use_id` set and the typed top-level `error` field; for a
//      refusal its `message.stop_reason` is `"refusal"` (the hook reports only
//      `invalid_request`, so this is what classifies it `model_refused`).
//      Without `forwardSubagentText` the CLI forwards only tool_use/tool_result
//      blocks of a task agent, so neither message is visible.
//   3. `task_notification` status `failed`/`stopped` and `task_updated`
//      `patch.status` `failed`/`killed` for an agent task (not seen for the
//      provider-error cases above, which report `completed`, but typed).
//   4. An Agent tool `tool_result` with `is_error: true` on the main thread.
//
// No free-form text (model prose or CLI error text) is pattern-matched.
// Normal forwarded subagent messages carry `stop_reason: null` (verified: a
// sub turn that hit `max_tokens` and was recovered by the CLI is forwarded
// with `null`), so only `refusal` or an `error` flag count — a recovered
// truncation is not a failure.

type RunFailureCode = 'provider_error' | 'model_refused' | 'executor_error';

/** Higher wins when two signals describe the same task agent (e.g. the hook's
 * `invalid_request` and the forwarded message's `stop_reason: refusal`). */
const FAILURE_PRIORITY: Readonly<Record<RunFailureCode, number>> = {
  model_refused: 3,
  provider_error: 2,
  executor_error: 1,
};

interface ObservedFailure {
  code: RunFailureCode;
  /** Human label for the task agent (id + type + description when known). */
  agent: string;
  /** Structured signals that reported it (deduplicated, in arrival order). */
  signals: string[];
}

const MAX_FAILURES_IN_DETAIL = 10;

/** SDKAssistantMessageError values that are not provider/API faults. */
const NON_PROVIDER_ERRORS: ReadonlySet<string> = new Set(['max_output_tokens']);

/** Map a typed `SDKAssistantMessageError` (+ stop reason) to a reason code. */
function classifyTaskAgentError(error: unknown, stopReason?: unknown): RunFailureCode {
  if (stopReason === 'refusal') return 'model_refused';
  if (typeof error === 'string' && NON_PROVIDER_ERRORS.has(error)) return 'executor_error';
  return 'provider_error';
}

/**
 * Every task-agent (subagent) failure observed during one SDK run (EC1 D1).
 * Keyed by task-agent id (the CLI's `task_id` == hook `agent_id`), so the hook
 * and the forwarded message for the same agent count once, keeping the most
 * specific reason code. Any entry fails the run (see {@link applyRunFailures}).
 */
export class RunFailureLedger {
  private readonly byKey = new Map<string, ObservedFailure>();

  record(key: string, f: ObservedFailure): void {
    const prev = this.byKey.get(key);
    if (!prev) {
      this.byKey.set(key, { ...f, signals: [...f.signals] });
      return;
    }
    const code = FAILURE_PRIORITY[f.code] > FAILURE_PRIORITY[prev.code] ? f.code : prev.code;
    const signals = [...prev.signals];
    for (const s of f.signals) if (!signals.includes(s)) signals.push(s);
    this.byKey.set(key, { code, agent: prev.agent, signals });
  }

  list(): ObservedFailure[] {
    return [...this.byKey.values()];
  }

  get size(): number {
    return this.byKey.size;
  }

  toReason(boardId: string): { code: RunFailureCode; message: string; detail: string } {
    const all = this.list();
    const first = all[0]!;
    const what: Record<RunFailureCode, string> = {
      provider_error: 'hit a provider API error',
      model_refused: 'was refused by the model',
      executor_error: 'ended abnormally',
    };
    const shown = all
      .slice(0, MAX_FAILURES_IN_DETAIL)
      .map((f) => `${f.code} [task agent ${f.agent}]: ${f.signals.join('; ')}`);
    if (all.length > shown.length) shown.push(`…and ${all.length - shown.length} more`);
    return {
      code: first.code,
      message:
        `Board ${boardId} task agent ${first.agent} ${what[first.code]}` +
        (all.length > 1 ? ` (${all.length} task agents failed).` : '.'),
      detail: shown.join(' | '),
    };
  }
}

/** Short, redaction-safe excerpt of CLI-provided text for diagnostics only. */
function excerpt(v: unknown, max = 160): string | undefined {
  if (typeof v !== 'string' || v.length === 0) return undefined;
  return JSON.stringify(v.length > max ? `${v.slice(0, max)}…` : v);
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** Local mirror of tool-policy.ts's CLI alias table (kept private there). */
const TOOL_NAME_ALIASES: Readonly<Record<string, string>> = {
  Task: 'Agent',
  BashOutput: 'TaskOutput',
  KillShell: 'TaskStop',
  KillBash: 'TaskStop',
};
const canonicalToolName = (n: string): string => TOOL_NAME_ALIASES[n] ?? n;

interface TaskInfo {
  toolUseId?: string;
  description?: string;
  subagentType?: string;
  taskType?: string;
}

/**
 * Watches every SDK stream message for task-agent failures (→ `failures`)
 * and for calls to tools the executor was never offered (→ `denials`, D2).
 * Stateless with respect to the result mapping: it only records.
 */
export class RunStreamObserver {
  private readonly tasks = new Map<string, TaskInfo>();
  private readonly taskByToolUse = new Map<string, string>();
  /** tool_use id → tool name, main thread and task agents. */
  private readonly toolNames = new Map<string, string>();
  /** Tools the CLI offered (system/init `tools`), canonicalized. */
  private offered: Set<string> | null = null;

  constructor(
    private readonly policy: Pick<ExecutionPolicy, 'allowedTools' | 'mcpServers'>,
    private readonly failures: RunFailureLedger,
    private readonly denials: DenialLedger,
  ) {}

  /** Key + label for a task agent referenced by id (hook `agent_id`, `task_id`). */
  agentKey(agentId: string): { key: string; label: string } {
    const t = this.tasks.get(agentId);
    const extra = t ? [t.subagentType, t.description ? JSON.stringify(t.description) : undefined].filter(Boolean) : [];
    return { key: agentId, label: extra.length > 0 ? `${agentId} (${extra.join(': ')})` : agentId };
  }

  /** Key + label for a task agent referenced by its spawning Agent tool_use id. */
  private agentByToolUse(toolUseId: string): { key: string; label: string } {
    const taskId = this.taskByToolUse.get(toolUseId);
    return taskId ? this.agentKey(taskId) : { key: `tool_use:${toolUseId}`, label: `spawned by ${toolUseId}` };
  }

  private isAgentTask(taskId: string): boolean {
    const t = this.tasks.get(taskId);
    // Unknown task ids fail closed (treated as agent tasks); background shell
    // tasks (`local_bash`) whose command exits non-zero are ordinary tool
    // outcomes the agent may react to, not task-agent failures.
    if (!t) return true;
    return t.subagentType !== undefined || (t.taskType !== undefined && /agent/i.test(t.taskType));
  }

  private isOffered(name: string): boolean {
    const canonical = canonicalToolName(name);
    if (this.offered?.has(canonical)) return true;
    if (this.policy.allowedTools.includes(canonical)) return true;
    // MCP tools of an allowed server may be deferred (absent from init); the
    // policy gate decides those, so they never count as "not offered".
    const mcp = parseMcpToolName(name);
    return mcp !== null && this.policy.mcpServers.includes(mcp.server);
  }

  observe(raw: unknown): void {
    const msg = asRecord(raw);
    if (!msg) return;
    if (msg.type === 'system') this.observeSystem(msg);
    else if (msg.type === 'assistant') this.observeAssistant(msg);
    else if (msg.type === 'user') this.observeUser(msg);
  }

  private observeSystem(msg: Record<string, unknown>): void {
    const str = (k: string): string | undefined => (typeof msg[k] === 'string' ? (msg[k] as string) : undefined);
    switch (msg.subtype) {
      case 'init': {
        if (Array.isArray(msg.tools)) {
          this.offered = new Set(msg.tools.filter((t): t is string => typeof t === 'string').map(canonicalToolName));
        }
        return;
      }
      case 'task_started': {
        const taskId = str('task_id');
        if (!taskId) return;
        const info: TaskInfo = {};
        const toolUseId = str('tool_use_id');
        if (toolUseId) {
          info.toolUseId = toolUseId;
          this.taskByToolUse.set(toolUseId, taskId);
        }
        const description = str('description');
        const subagentType = str('subagent_type');
        const taskType = str('task_type');
        if (description !== undefined) info.description = description;
        if (subagentType !== undefined) info.subagentType = subagentType;
        if (taskType !== undefined) info.taskType = taskType;
        this.tasks.set(taskId, info);
        return;
      }
      case 'task_notification': {
        const taskId = str('task_id');
        const status = msg.status;
        if (!taskId || status === 'completed' || !this.isAgentTask(taskId)) return;
        const { key, label } = this.agentKey(taskId);
        this.failures.record(key, {
          code: 'executor_error',
          agent: label,
          signals: [`task_notification status=${describeValue(status)}`],
        });
        return;
      }
      case 'task_updated': {
        const taskId = str('task_id');
        const status = asRecord(msg.patch)?.status;
        if (!taskId || (status !== 'failed' && status !== 'killed') || !this.isAgentTask(taskId)) return;
        const { key, label } = this.agentKey(taskId);
        this.failures.record(key, { code: 'executor_error', agent: label, signals: [`task_updated status=${status}`] });
        return;
      }
      case 'permission_denied': {
        const toolName = str('tool_name') ?? '(unknown tool)';
        const d: ObservedDenial = { toolName, source: 'permission_denied' };
        const reason = str('decision_reason') ?? str('message');
        const agentId = str('agent_id');
        if (reason !== undefined) d.reason = reason;
        if (agentId !== undefined) d.agentId = agentId;
        this.denials.record(str('tool_use_id'), d);
        return;
      }
      default:
        return;
    }
  }

  private observeAssistant(msg: Record<string, unknown>): void {
    const message = asRecord(msg.message);
    const content = Array.isArray(message?.content) ? (message.content as unknown[]) : [];
    for (const b of content) {
      const block = asRecord(b);
      if (block?.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        this.toolNames.set(block.id, block.name);
      }
    }
    // Task-agent terminal failure (signal 2). Main-thread assistant errors are
    // covered by the result message mapping and are not recorded here.
    const parent = msg.parent_tool_use_id;
    if (typeof parent !== 'string' || parent.length === 0) return;
    const error = msg.error;
    const stopReason = message?.stop_reason;
    const hasError = error !== undefined && error !== null;
    if (!hasError && stopReason !== 'refusal') return;
    const { key, label } = this.agentByToolUse(parent);
    const signals = [
      [
        'assistant',
        hasError ? `error=${describeValue(error)}` : '',
        typeof stopReason === 'string' ? `stop_reason=${stopReason}` : '',
        message?.model === '<synthetic>' ? 'model=<synthetic>' : '',
      ]
        .filter(Boolean)
        .join(' '),
    ];
    const text = content
      .map((b) => asRecord(b))
      .find((b) => b?.type === 'text' && typeof b.text === 'string')?.text;
    const ex = message?.model === '<synthetic>' ? excerpt(text) : undefined;
    if (ex) signals.push(`cli: ${ex}`);
    this.failures.record(key, { code: classifyTaskAgentError(error, stopReason), agent: label, signals });
  }

  private observeUser(msg: Record<string, unknown>): void {
    const message = asRecord(msg.message);
    const content = Array.isArray(message?.content) ? (message.content as unknown[]) : [];
    const mainThread = msg.parent_tool_use_id === null || msg.parent_tool_use_id === undefined;
    for (const b of content) {
      const block = asRecord(b);
      if (block?.type !== 'tool_result' || block.is_error !== true) continue;
      const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined;
      const name = id ? this.toolNames.get(id) : undefined;
      if (name === undefined) continue;
      // D2: the CLI rejected a call to a tool it never offered ("No such tool
      // available") before any policy hook ran — a policy refusal, not an
      // ordinary tool error the agent may recover from.
      if (!this.isOffered(name)) {
        const d: ObservedDenial = { toolName: name, source: 'unavailable_tool', reason: 'tool not granted to this executor' };
        if (!mainThread && typeof msg.parent_tool_use_id === 'string') {
          const taskId = this.taskByToolUse.get(msg.parent_tool_use_id);
          if (taskId) d.agentId = taskId;
        }
        this.denials.record(id, d);
        continue;
      }
      // Signal 4: the board's own Agent tool call failed.
      if (mainThread && canonicalToolName(name) === 'Agent' && id) {
        const { key, label } = this.agentByToolUse(id);
        this.failures.record(key, { code: 'executor_error', agent: label, signals: ['Agent tool_result is_error'] });
      }
    }
  }
}

/**
 * Add the run observers the SDK needs to surface task-agent failures:
 * a `StopFailure` hook (signal 1) and `forwardSubagentText: true` (signal 2).
 * Returned as part of the permission options object so the executor's query
 * options literal is unchanged; neither affects tool authority (the hook
 * always returns `{}` — it observes, never decides).
 */
export function withRunObservers<T extends ClaudeSdkPermissionOptions>(
  permission: T,
  observer: RunStreamObserver,
  failures: RunFailureLedger,
): T & { forwardSubagentText: true } {
  const stopFailure: HookCallback = (input) => {
    try {
      const rec = input as unknown as Record<string, unknown>;
      const agentId = rec.agent_id;
      // Main-thread StopFailure also ends the run with an error result, which
      // mapSdkResultMessage handles; only task agents are recorded here.
      if (typeof agentId === 'string' && agentId.length > 0) {
        const { key, label } = observer.agentKey(agentId);
        const code = classifyTaskAgentError(rec.error);
        const signals = [`StopFailure error=${describeValue(rec.error)}`];
        // For API errors the last message is the CLI's synthetic error text;
        // otherwise it may be model prose, which is not copied into the detail.
        const ex = code === 'provider_error' ? excerpt(rec.last_assistant_message) : undefined;
        if (ex) signals.push(`cli: ${ex}`);
        failures.record(key, { code, agent: label, signals });
      }
    } catch {
      /* observing must never break the run; the stream signals remain */
    }
    return Promise.resolve({});
  };
  const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = { ...permission.hooks };
  hooks.StopFailure = [...(hooks.StopFailure ?? []), { hooks: [stopFailure] }];
  return { ...permission, hooks, forwardSubagentText: true };
}

/**
 * Apply task-agent failures to the run's terminal status (EC1 D1): a run
 * whose task agent failed is never `succeeded`. `succeeded`, `interrupted`
 * and `cancelled` become `failed` with the task agent's reason; an already
 * `failed` or `blocked` run keeps its code and gains the task-agent detail.
 * Denials are applied afterwards by {@link applyRunDenials}, so a recorded
 * denial still wins as `blocked(policy_refused)`.
 */
function applyRunFailures(base: SdkBoardResult, failures: RunFailureLedger, boardId: string): SdkBoardResult {
  if (failures.size === 0) return base;
  const reason = failures.toReason(boardId);
  if (base.status === 'failed' || base.status === 'blocked') {
    const out: SdkBoardResult = {
      ...base,
      reason: {
        ...base.reason,
        detail: `${base.reason.detail ?? base.reason.message} | task agents also failed: ${reason.detail}`,
      },
    };
    return out;
  }
  if (base.status !== 'succeeded') {
    reason.detail = `${reason.detail} | run also ended ${base.status}(${base.reason.code}): ${base.reason.detail ?? base.reason.message}`;
  }
  const out: SdkBoardResult = { status: 'failed', reason };
  if (base.costUsd !== undefined) out.costUsd = base.costUsd;
  return out;
}

/** Final run status: task-agent failures, then denials (denial wins). */
function applyRunLedgers(
  base: SdkBoardResult,
  failures: RunFailureLedger,
  denials: DenialLedger,
  boardId: string,
): SdkBoardResult {
  return applyRunDenials(applyRunFailures(base, failures, boardId), denials, boardId);
}

/**
 * Execute one board mission through the Claude Agent SDK and await its
 * terminal result. Dynamically imports the SDK so it never touches the
 * module-load path unless the live gate is open. Never throws: a policy
 * refusal is returned as `blocked`, every other failure as `failed`.
 */
export async function executeBoardMissionViaSdk(
  params: ExecuteBoardMissionParams,
  deps: ExecuteBoardMissionDeps = {},
): Promise<SdkBoardResult> {
  let policy: ExecutionPolicy;
  try {
    policy = await resolveBoardPolicy(params);
  } catch (err) {
    const reason = err instanceof ToolPolicyError ? err.message : String(err);
    logger.warn({ msg: 'SDK board refused: tool policy', boardId: params.boardId, err: reason });
    if (err instanceof ToolPolicyError) {
      // The charter's authority cannot be enforced: refuse before execution.
      return {
        status: 'blocked',
        reason: {
          code: 'policy_refused',
          message: `Board ${params.boardId} mission refused by tool policy before execution.`,
          detail: reason,
        },
      };
    }
    return {
      status: 'failed',
      reason: {
        code: 'runtime_error',
        message: `Board ${params.boardId} tool policy could not be derived; mission not executed.`,
        detail: reason,
      },
    };
  }

  // Every deny the policy gate issues during this run, main thread and task
  // agents alike (N1); any entry makes the run `blocked`, never `succeeded`.
  const denials = new DenialLedger();
  // Every task-agent failure observed in the stream (EC1 D1); any entry makes
  // the run `failed`, never `succeeded` (a denial still wins as `blocked`).
  const failures = new RunFailureLedger();
  // Hoisted so a stream that throws AFTER yielding a non-success result (the
  // SDK throws "returned an error result" after an is_error result) keeps
  // that result's specific reason instead of a generic provider_error.
  let terminal: SdkBoardResult | null = null;
  try {
    const sdk = await (deps.loadSdk ?? loadClaudeAgentSdk)();
    const gate = buildClaudeSdkPermissionOptions(policy, {
      ...params.enforcement,
      onDecision: (e) => {
        if (!e.decision.allow) {
          logger.warn({
            msg: 'tool call denied by policy',
            boardId: params.boardId,
            tool: e.toolName,
            code: e.decision.code,
            via: e.via,
          });
          denials.noteAudit({ toolName: e.toolName, source: 'policy-audit', reason: `${e.decision.code}: ${e.decision.reason}` });
        }
        params.enforcement?.onDecision?.(e);
      },
    });
    const observer = new RunStreamObserver(policy, failures, denials);
    const permission = withRunObservers(instrumentPermissionOptions(gate, denials), observer, failures);
    const q = sdk.query({
      prompt: params.missionBrief,
      options: {
        model: params.model,
        systemPrompt: params.systemPrompt,
        maxTurns: params.maxTurns ?? 8,
        ...permission,
        mcpServers: filterMcpServers(policy, params.mcpServers),
      },
    });

    // Await the terminal `result` message(s). Normally the last one observed
    // wins, but a non-success result anywhere in the stream permanently
    // disqualifies a later "success" from being reported (D1): once the
    // stream has shown failure/blocked/interrupted, a subsequent success
    // message cannot un-fail the mission.
    let sawNonSuccessResult = false;
    for await (const msg of q) {
      observer.observe(msg);
      if (msg.type !== 'result') continue;
      const reported: unknown = (msg as { permission_denials?: unknown }).permission_denials;
      if (Array.isArray(reported)) {
        for (const d of reported as unknown[]) {
          const id = d && typeof d === 'object' ? (d as { tool_use_id?: unknown }).tool_use_id : undefined;
          denials.record(typeof id === 'string' ? id : undefined, {
            toolName: denialToolName(d),
            source: 'permission_denials',
          });
        }
      }
      const mapped = mapSdkResultMessage(msg, params.boardId);
      if (mapped.status === 'succeeded' && sawNonSuccessResult) {
        logger.warn({
          msg: 'SDK board: later success result ignored after an earlier non-success result',
          boardId: params.boardId,
        });
        continue;
      }
      terminal = mapped;
      if (mapped.status !== 'succeeded') sawNonSuccessResult = true;
    }

    if (!terminal) {
      return applyRunLedgers(
        {
          status: 'failed',
          reason: {
            code: 'no_terminal_result',
            message: `Board ${params.boardId} executor stream ended without a terminal result.`,
          },
        },
        failures,
        denials,
        params.boardId,
      );
    }
    return applyRunLedgers(terminal, failures, denials, params.boardId);
  } catch (err) {
    logger.warn({
      msg: 'SDK board execution failed',
      boardId: params.boardId,
      err: String(err),
    });
    // A non-success result already observed is the more specific truth.
    const observed: SdkBoardResult | null = terminal;
    if (observed && observed.status !== 'succeeded') {
      return applyRunLedgers(observed, failures, denials, params.boardId);
    }
    return applyRunLedgers(
      {
        status: 'failed',
        reason: {
          code: 'provider_error',
          message: `Board ${params.boardId} executor failed before a terminal result.`,
          detail: String(err),
        },
      },
      failures,
      denials,
      params.boardId,
    );
  }
}
