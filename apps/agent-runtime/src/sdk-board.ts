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
import { isNormalStopReason, TRUNCATED_STREAM_DETAIL } from '@skippy/shared';
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
import { buildClaudeExecutorEnv, createExecutorConfigDir, removeExecutorConfigDir } from './executor-env.js';
import { logger } from './logger.js';
import {
  CLAUDE_AGENT_SDK_CAPABILITIES,
  ToolPolicyError,
  assertExecutorEligible,
  buildClaudeSdkPermissionOptions,
  derivePolicy,
  failClosedHookOutput,
  failClosedPermissionResult,
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
  /** TEST-ONLY: applied over the executor's scrubbed environment
   * (executor-env.ts). Production never passes it. It cannot set
   * `CLAUDE_CONFIG_DIR`: the per-execution directory is forced after it. */
  executorEnvOverrides?: Readonly<Record<string, string>>;
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
 *   | subtype `'success'`, `is_error === false`,             | failed      | provider_error          |
 *   |   `terminal_reason` absent or `'completed'`, and       |             |   (truncated, OQ-20)    |
 *   |   `stop_reason` null/absent, OR the stream shows the   |             |                         |
 *   |   final main-thread turn never got a stop reason       |             |                         |
 *   | subtype `'success'`, `is_error === false`,             | succeeded   | —                       |
 *   |   `terminal_reason` absent or `'completed'`, and       |             |                         |
 *   |   `stop_reason` `end_turn`/`stop_sequence`             |             |                         |
 *   | anything else (error subtype, `is_error` on a          | failed      | executor_error          |
 *   |   success subtype, `model_error`, `prompt_too_long`,   |             |                         |
 *   |   `max_turns`, any other/unknown terminal_reason, or   |             |                         |
 *   |   any other stop_reason: `max_tokens`, `pause_turn`,   |             |                         |
 *   |   `tool_use`, `model_context_window_exceeded`, …)     |             |                         |
 *
 * `stop_reason` is typed `string | null` in sdk.d.ts (0.3.162) and carries
 * the final model turn's Messages API stop reason. Only `end_turn` /
 * `stop_sequence` mean the model finished normally; every other value is a
 * truncated, paused or refused turn and fails closed.
 *
 * A missing stop reason is a truncated provider stream, not a normal stop
 * (OQ-20, FR-RUN-01, G0). Verified live with the bundled CLI 2.1.162 against a
 * local mock: a main-thread SSE stream that sends `message_start` + a text
 * block and ends without `message_delta`/`message_stop` yields `subtype:
 * "success"`, `is_error: false`, `terminal_reason: "completed"`, `stop_reason:
 * null` and the partial text as `result`; every complete run (including CLI
 * max_tokens recovery, 529/429 retries and the non-streaming fallback after a
 * dropped stream) carries `end_turn`/`stop_sequence`. The result's
 * `stop_reason` is the last main-thread `message_delta` of the segment, so a
 * truncated final turn after a `tool_use` turn reports a stale `"tool_use"`;
 * `stream` (the {@link RunStreamObserver}'s view of the final main-thread
 * turn, from `includePartialMessages` stream events) catches that case and
 * any stale normal value, and a final turn whose stop reason arrived with a
 * content block never closed (D3). Forwarded streamed `assistant` messages
 * (emitted at `content_block_stop`) carry `message_start`'s `stop_reason`
 * (null from the real API), so they are not a signal on their own. Earlier
 * main-thread turns judged truncated when a later turn superseded them (a
 * background wake-up segment needs no `result` in between) are applied on top
 * — see {@link TruncatedTurnLedger}. Superseded turns that ended abnormally
 * and main-thread terminal errors inside a result-less segment (M0-G01) are
 * applied through the {@link RunFailureLedger}.
 *
 * A succeeded result's `summary` is always a non-blank string (`result` when
 * it is one, otherwise {@link NO_SUMMARY}) so the emitted `delegation_complete`
 * envelope satisfies the shared wire schema (N6c) and never carries "".
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
function mapSdkResultMessage(
  msg: SDKResultMessage,
  boardId: string,
  stream: FinalTurnEvidence = {},
): SdkBoardResult {
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

  const missingStop = stopReason === undefined || stopReason === null;
  const cleanSuccess =
    msg.subtype === 'success' &&
    msg.is_error === false &&
    (terminalReason === undefined || terminalReason === 'completed');

  // OQ-20: a "success" whose provider stream never reported a stop reason is a
  // truncated turn (the partial text is the `result`), never success.
  if (cleanSuccess && (missingStop || stream.truncated !== undefined)) {
    const evidence = [
      `result stop_reason: ${describeValue(stopReason ?? null)}`,
      stream.truncated,
      resultText !== undefined ? `partial result: ${describeValue(resultText)}` : '',
    ]
      .filter(Boolean)
      .join('; ');
    return withCost({
      status: 'failed',
      reason: {
        code: 'provider_error',
        message: `Board ${boardId} executor's ${TRUNCATED_STREAM_DETAIL}.`,
        detail: `${TRUNCATED_STREAM_DETAIL}: ${evidence}`,
      },
    });
  }

  const normalStop = isNormalStopReason(stopReason);
  if (cleanSuccess && normalStop) {
    // A blank `result` (e.g. the CLI dropped a never-closed text block, D3) is
    // no summary at all; the envelope never carries "".
    const summary = resultText !== undefined && resultText.trim().length > 0 ? resultText : NO_SUMMARY;
    return withCost({ status: 'succeeded', summary });
  }

  // Fail closed: an error subtype, a "success" subtype flagged is_error, any
  // other terminal_reason (model_error, prompt_too_long, max_turns,
  // blocking_limit, rapid_refill_breaker, aborted_streaming, image_error, or
  // an unrecognised future value) or an abnormal stop_reason (max_tokens,
  // pause_turn, …) never becomes success.
  const abnormalStop = !missingStop && !normalStop;
  const suffix = [
    terminalReason ? `terminal_reason: ${terminalReason}` : '',
    abnormalStop ? `stop_reason: ${describeValue(stopReason)}` : '',
  ]
    .filter(Boolean)
    .join(', ');
  const errors = Array.isArray((msg as { errors?: unknown }).errors) ? (msg as { errors: unknown[] }).errors : [];
  const detail =
    msg.subtype === 'success'
      ? `success result ${msg.is_error === false ? 'ended abnormally' : 'flagged is_error'}: ${resultText ?? NO_SUMMARY}${suffix ? ` (${suffix})` : ''}`
      : [msg.subtype, terminalReason, abnormalStop ? `stop_reason: ${describeValue(stopReason)}` : '', ...errors.map(String)]
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

/** `String(err)` that cannot itself throw. */
function describeError(err: unknown): string {
  try {
    return String(err);
  } catch {
    return '(unprintable error)';
  }
}

/** Own-property string read that cannot throw (hostile getters, non-objects). */
function safeString(o: unknown, k: string): string | undefined {
  try {
    if (!o || typeof o !== 'object') return undefined;
    const v = (o as Record<string, unknown>)[k];
    return typeof v === 'string' ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Wrap one hook so every deny it returns is recorded, and so that NOTHING
 * escapes it (M0-G07 D3): the whole body — the input reads for accounting
 * included — runs inside one try, and any exception (the inner hook's, or a
 * hostile input's getter) yields the fail-closed output for the event
 * (`failClosedHookOutput`: PreToolUse deny, PermissionRequest deny,
 * PostToolUse withheld) instead of the `{}` the CLI makes of a throw.
 */
function instrumentHook(event: HookEvent, cb: HookCallback, ledger: DenialLedger): HookCallback {
  const gates = event === 'PreToolUse' || event === 'PermissionRequest';
  return async (input, toolUseID, options) => {
    let base: ObservedDenial = { toolName: `(${event} hook)`, source: event === 'PermissionRequest' ? 'PermissionRequest' : 'PreToolUse' };
    let id: string | undefined = typeof toolUseID === 'string' ? toolUseID : undefined;
    try {
      const toolName = safeString(input, 'tool_name');
      if (toolName !== undefined) base = { ...base, toolName };
      const agentId = safeString(input, 'agent_id');
      if (agentId !== undefined) base.agentId = agentId;
      id = safeString(input, 'tool_use_id') ?? id;
      if (!input || typeof input !== 'object') throw new Error('hook input is not an object');
      const out = await cb(input, toolUseID, options);
      const denied = gates ? hookOutputDenial(event, out) : null;
      if (denied) ledger.record(id, denied.reason !== undefined ? { ...base, reason: denied.reason } : base);
      return out;
    } catch (err) {
      // A gate that throws is a deny — for accounting AND for the CLI.
      const reason = `policy hook failed closed: ${describeError(err)}`;
      try {
        if (gates) ledger.record(id, { ...base, reason });
      } catch {
        /* accounting must not stop the deny */
      }
      return failClosedHookOutput(event, input, err) as Awaited<ReturnType<HookCallback>>;
    }
  };
}

/**
 * Wrap the policy gate's `canUseTool` and permission hooks so that every
 * deny outcome — including those for calls inside spawned task agents
 * (`agentID` / `agent_id` set) — is recorded in `ledger`. The gate's
 * decisions and return values are passed through unchanged; a wrapper that
 * cannot complete (an exception anywhere, hostile inputs) returns an explicit
 * deny, never throws (M0-G07 D3).
 */
export function instrumentPermissionOptions(
  permission: ClaudeSdkPermissionOptions,
  ledger: DenialLedger,
): ClaudeSdkPermissionOptions {
  const inner = permission.canUseTool;
  const canUseTool: CanUseTool = async (toolName, input, options) => {
    let base: ObservedDenial = { toolName: '(tool)', source: 'canUseTool' };
    let toolUseID: string | undefined;
    try {
      base = { toolName: typeof toolName === 'string' ? toolName : '(tool)', source: 'canUseTool' };
      const agentID = safeString(options, 'agentID');
      if (agentID !== undefined) base.agentId = agentID;
      toolUseID = safeString(options, 'toolUseID');
      const result = await inner(toolName, input, options);
      if (!result || typeof result !== 'object') throw new Error('permission callback returned a non-object');
      if (result.behavior !== 'allow') {
        const message = (result as { message?: unknown }).message;
        ledger.record(toolUseID, typeof message === 'string' ? { ...base, reason: message } : base);
      }
      return result;
    } catch (err) {
      try {
        ledger.record(toolUseID, { ...base, reason: `permission callback failed closed: ${describeError(err)}` });
      } catch {
        /* accounting must not stop the deny */
      }
      return failClosedPermissionResult(options, err);
    }
  };
  const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};
  for (const [event, matchers] of Object.entries(permission.hooks) as Array<
    [HookEvent, HookCallbackMatcher[] | undefined]
  >) {
    if (!matchers) continue;
    hooks[event] = matchers.map((m) => ({ ...m, hooks: m.hooks.map((cb) => instrumentHook(event, cb, ledger)) }));
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
//
// The board's MAIN thread uses the same ledger (M0-G01). While a background
// task agent runs, CLI 2.1.162 emits no `result` between the board's
// segments, so a main-thread request that fails terminally there is reported
// ONLY by (a) a main-thread `<synthetic>` assistant message with the typed
// `error` field and (b) a main-thread `StopFailure` hook (no `agent_id`); the
// next segment can still end with `result: success`. Verified live
// (m_bgMid401/400/500/Destroy/Refusal/MaxTokAll): both signals appear for
// every terminal failure. A retry the CLI recovers from (529/500/ECONNRESET
// with CLAUDE_CODE_MAX_RETRIES>0, or the non-streaming fallback) emits only
// `system/api_retry` — never a synthetic message or `StopFailure` — so only
// terminal failures are recorded. When the same segment ends with an error
// `result`, that result already reports the failure and the main-thread
// entries of the segment are dropped (no doubled reason).

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
  /** `main`: the board's own main thread failed (M0-G01), not a task agent. */
  scope?: 'main';
  /** Structured signals that reported it (deduplicated, in arrival order). */
  signals: string[];
}

const failureSubject = (f: ObservedFailure): string => (f.scope === 'main' ? 'main thread' : `task agent ${f.agent}`);

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
 * Every task-agent (subagent) failure observed during one SDK run (EC1 D1),
 * plus main-thread failures that no `result` reports (M0-G01). Keyed by
 * task-agent id (the CLI's `task_id` == hook `agent_id`) or by a main-thread
 * failure key, so the hook and the stream message for the same failure count
 * once, keeping the most specific reason code. Any entry fails the run (see
 * {@link applyRunFailures}).
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
    const merged: ObservedFailure = { code, agent: prev.agent, signals };
    if (prev.scope) merged.scope = prev.scope;
    this.byKey.set(key, merged);
  }

  /** Drop an entry another signal already reports (an error `result`). */
  delete(key: string): void {
    this.byKey.delete(key);
  }

  list(): ObservedFailure[] {
    return [...this.byKey.values()];
  }

  get size(): number {
    return this.byKey.size;
  }

  /** Who failed, for "… also failed" details. */
  subjects(): string {
    const all = this.list();
    const main = all.some((f) => f.scope === 'main');
    const task = all.some((f) => f.scope !== 'main');
    return main && task ? 'main thread and task agents' : main ? 'main thread' : 'task agents';
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
      .map((f) => `${f.code} [${failureSubject(f)}]: ${f.signals.join('; ')}`);
    if (all.length > shown.length) shown.push(`…and ${all.length - shown.length} more`);
    const count = all.every((f) => f.scope !== 'main') ? `${all.length} task agents failed` : `${all.length} failures`;
    return {
      code: first.code,
      message: `Board ${boardId} ${failureSubject(first)} ${what[first.code]}` + (all.length > 1 ? ` (${count}).` : '.'),
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
 * What the stream showed about the final main-thread model turn before a
 * `result` (OQ-20). `truncated` is set, with the evidence, when that turn
 * never received a stop reason; absent when complete or not observable.
 */
export interface FinalTurnEvidence {
  truncated?: string;
}

/** The latest main-thread model turn, from `stream_event` messages. */
interface MainTurn {
  id: string | undefined;
  /** `message_delta` stop reason (or a non-streamed message's); null = none yet. */
  stopReason: string | null;
  source: 'stream' | 'non-streamed';
  /** Content evidence seen (block start/stop events, streamed assistant messages). */
  content: number;
  /** Indexes of streamed content blocks started but never stopped. */
  openBlocks: Set<number>;
  /** tool_use ids of this turn's closed (forwarded) tool_use blocks — streamed
   * or non-streamed (M0-G02). */
  toolUseIds: Set<string>;
  /** The CLI returned a main-thread tool_result for one of `toolUseIds`. */
  ranTools: boolean;
  /** …and at least one of them was not `is_error` (M0-G03): a call the CLI
   * rejected (invalid input, unknown tool, denial) proves nothing about the
   * rest of a cut turn. */
  executed: boolean;
  /** A new main-thread API request began (`system/status: requesting`) after
   * this turn's `message_start` — the turn can no longer be completed by the
   * non-streaming fallback of its own request. */
  requestAfter: boolean;
  /** A new segment began (`system/init`, e.g. a background-task wake-up)
   * after this turn: the CLI's own query loop ended without continuing it. */
  segmentAfter: boolean;
  /** Ledger key of a main-thread terminal failure (synthetic error message)
   * the CLI reported for this turn's own request (M0-G01). */
  failureKey?: string;
  /** `message_start`'s own stop_reason (null from the real API). The CLI copies
   * it into the turn's streamed assistant messages (verified live,
   * `t_startStopEndTrunc`), so it is never a completion signal. */
  startStop: string | null;
}

function newMainTurn(
  id: string | undefined,
  source: MainTurn['source'],
  stopReason: string | null = null,
  startStop: string | null = null,
): MainTurn {
  return {
    id,
    stopReason,
    source,
    content: 0,
    openBlocks: new Set(),
    toolUseIds: new Set(),
    ranTools: false,
    executed: false,
    requestAfter: false,
    segmentAfter: false,
    startStop,
  };
}

const stopReasonOf = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

function addToolUseIds(turn: MainTurn, content: unknown): void {
  if (!Array.isArray(content)) return;
  for (const b of content as unknown[]) {
    const block = asRecord(b);
    if (block?.type === 'tool_use' && typeof block.id === 'string') turn.toolUseIds.add(block.id);
  }
}

/**
 * Why a main-thread turn is truncated (OQ-20), or undefined when complete.
 * A turn is complete when it got a stop reason with every streamed content
 * block closed, or — lacking a stop reason — when every block it opened was
 * closed and the CLI executed one of its tool_use blocks without error (the
 * CLI accepted the turn and continued; verified live, `t_toolBlockCut`,
 * `z_nsToolNullStop` for a non-streamed turn). A block left open means
 * content was lost even if an earlier tool ran (`t_twoToolsCutMid1`: the CLI
 * ran tool #0 and silently dropped the half-streamed tool #1). A tool_use the
 * CLI rejected with an `is_error` result (`x_invalidToolCut`) is no evidence.
 */
function truncationOf(t: MainTurn): string | undefined {
  const open = t.openBlocks.size;
  const openNote = open > 0 ? `${open} content block(s) never closed` : '';
  if (t.stopReason === null) {
    if (t.executed && open === 0) return undefined;
    const how =
      t.source === 'stream'
        ? 'message_start without a message_delta stop reason'
        : 'non-streamed message with stop_reason null';
    return `got no stop reason (${[how, openNote].filter(Boolean).join('; ')})`;
  }
  if (t.source === 'stream' && open > 0) {
    return `ended (stop_reason ${JSON.stringify(t.stopReason)}) with ${openNote}`;
  }
  return undefined;
}

/**
 * A superseded main-thread turn that got a stop reason but did not end
 * normally (OQ-20, M0-G01), or undefined. Judged only after
 * {@link truncationOf} found the turn complete:
 *
 *   - `end_turn` / `stop_sequence` ({@link isNormalStopReason}): normal.
 *   - `tool_use`: normal when the CLI returned a tool_result (error or not)
 *     for one of the turn's tool_use blocks, or the turn had none (nothing to
 *     run; the CLI simply continued). A tool_use turn whose tools never ran
 *     was abandoned → `executor_error`.
 *   - `refusal` → `model_refused`.
 *   - anything else (`max_tokens`, `pause_turn`,
 *     `model_context_window_exceeded`, unknown): normal only when the CLI
 *     continued it inside the same segment (its max_tokens recovery; verified
 *     live, `mainmaxtok`, `m_bgMidMaxTokAll` turns 1–3). Superseded across a
 *     segment boundary (a background wake-up) the CLI never recovered it →
 *     `executor_error` (`m_bgMidPause`). A recovery the CLI gives up on is
 *     also reported by its synthetic error message (`max_output_tokens`).
 */
function abnormalStopOf(t: MainTurn): { code: RunFailureCode; why: string } | undefined {
  const stop = t.stopReason;
  if (stop === null || isNormalStopReason(stop)) return undefined;
  const tag = `stop_reason ${JSON.stringify(stop)}`;
  if (stop === 'tool_use') {
    if (t.ranTools || t.toolUseIds.size === 0) return undefined;
    return { code: 'executor_error', why: `ended with ${tag} but none of its tool calls ran` };
  }
  if (stop === 'refusal') return { code: 'model_refused', why: `was refused (${tag})` };
  if (!t.segmentAfter) return undefined;
  return { code: 'executor_error', why: `ended with ${tag} and the CLI did not continue it before the next segment` };
}

const MAX_TRUNCATIONS_IN_DETAIL = 10;

/**
 * Every main-thread turn judged truncated before the `result` it belongs to
 * was mapped (OQ-20, FR-RUN-01, G0): a turn superseded by a later turn without
 * a stop reason. The CLI 2.1.162 emits no `result` between the segments of a
 * run whose background task is still running (verified: `t_bgTwoWakes`, four
 * main requests and one result), so a truncated non-final turn is only
 * visible here. Any entry fails the run, whatever the later results say.
 */
export class TruncatedTurnLedger {
  private readonly turns: string[] = [];

  record(detail: string): void {
    this.turns.push(detail);
  }

  get size(): number {
    return this.turns.length;
  }

  detail(): string {
    const shown = this.turns.slice(0, MAX_TRUNCATIONS_IN_DETAIL);
    if (this.turns.length > shown.length) shown.push(`…and ${this.turns.length - shown.length} more`);
    return shown.join(' | ');
  }
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
  /** The main-thread turn currently tracked (OQ-20); judged when it is
   * superseded by another turn or when its segment's `result` is mapped. */
  private mainTurn: MainTurn | null = null;
  /** Main-thread `stream_event`s seen, i.e. partial messages are flowing. */
  private streamEvents = false;
  /** Main-thread terminal failures reported by synthetic error messages and
   * by `StopFailure` hooks so far (M0-G01). The CLI reports each one once by
   * each signal, in order, so the n-th of either shares one ledger key. */
  private mainErrorMessages = 0;
  private mainStopFailures = 0;
  /** Main-thread failure keys recorded in the current segment; dropped when
   * the segment's own `result` reports an error (it already carries it). */
  private readonly segmentMainKeys = new Set<string>();
  /** Turns without a message id judged abnormal (unique ledger keys). */
  private anonTurns = 0;

  constructor(
    private readonly policy: Pick<ExecutionPolicy, 'allowedTools' | 'mcpServers'>,
    private readonly failures: RunFailureLedger,
    private readonly denials: DenialLedger,
    private readonly truncations: TruncatedTurnLedger = new TruncatedTurnLedger(),
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
    else if (msg.type === 'stream_event') this.observeStreamEvent(msg);
    else if (msg.type === 'result') this.observeResult(msg);
  }

  /**
   * A main-thread `StopFailure` hook call (no `agent_id`): the CLI gave up on
   * a main-thread request (M0-G01). Recorded whether or not a `result`
   * follows; see {@link observeResult} for the dedupe.
   */
  recordMainStopFailure(error: unknown, lastAssistantMessage: unknown): void {
    const code = classifyTaskAgentError(error);
    const signals = [`StopFailure error=${describeValue(error)}`];
    const ex = code === 'provider_error' ? excerpt(lastAssistantMessage) : undefined;
    if (ex) signals.push(`cli: ${ex}`);
    this.recordMain(`main:failure#${++this.mainStopFailures}`, code, signals);
  }

  private recordMain(key: string, code: RunFailureCode, signals: string[]): void {
    this.failures.record(key, { code, agent: 'main thread', scope: 'main', signals });
    this.segmentMainKeys.add(key);
  }

  /**
   * A `result` that itself reports a failure (error subtype, `is_error`, an
   * API error status, an abnormal/missing stop reason or terminal reason) is
   * always mapped non-success, and a non-success result is never overridden
   * by a later success; the main-thread failures of its segment are then
   * already reported and are dropped so the reason is not doubled. After a
   * clean result they stay: a later segment cannot un-fail them.
   */
  private observeResult(msg: Record<string, unknown>): void {
    const tr = msg.terminal_reason;
    const reportsFailure =
      msg.subtype !== 'success' ||
      msg.is_error !== false ||
      (msg.api_error_status !== undefined && msg.api_error_status !== null) ||
      !isNormalStopReason(msg.stop_reason) ||
      (tr !== undefined && tr !== 'completed');
    if (reportsFailure) for (const key of this.segmentMainKeys) this.failures.delete(key);
    this.segmentMainKeys.clear();
  }

  /** A main-thread assistant message carrying the typed `error` field: the
   * CLI's synthetic terminal error message (M0-G01). */
  private observeMainError(msg: Record<string, unknown>, message: Record<string, unknown> | undefined): void {
    const error = msg.error;
    if (error === undefined || error === null) return;
    const key = `main:failure#${++this.mainErrorMessages}`;
    // The failed request's own streamed turn (e.g. a refusal, or the last of
    // the CLI's max_tokens recoveries) shares the key when it is judged later.
    const turn = this.mainTurn;
    if (turn && !turn.requestAfter && turn.failureKey === undefined) turn.failureKey = key;
    const stopReason = message?.stop_reason;
    const signals = [
      [
        'assistant',
        `error=${describeValue(error)}`,
        typeof stopReason === 'string' ? `stop_reason=${stopReason}` : '',
        message?.model === '<synthetic>' ? 'model=<synthetic>' : '',
      ]
        .filter(Boolean)
        .join(' '),
    ];
    if (message?.model === '<synthetic>') {
      const content = Array.isArray(message.content) ? (message.content as unknown[]) : [];
      const text = content.map((b) => asRecord(b)).find((b) => b?.type === 'text' && typeof b.text === 'string')?.text;
      const ex = excerpt(text);
      if (ex) signals.push(`cli: ${ex}`);
    }
    this.recordMain(key, classifyTaskAgentError(error, stopReason), signals);
  }

  /**
   * Evidence about the final main-thread turn for the `result` being mapped
   * now; resets for the next result segment (a background task can wake the
   * board and produce another result). With `includePartialMessages` the CLI
   * forwards the main thread's raw SSE events (verified, CLI 2.1.162); see
   * {@link truncationOf} for when a turn is truncated. Without stream events
   * nothing is claimed and the result's own `stop_reason` decides.
   */
  takeFinalTurnEvidence(): FinalTurnEvidence {
    const turn = this.mainTurn;
    this.mainTurn = null;
    const why = turn ? truncationOf(turn) : undefined;
    return turn && why ? { truncated: `final main-thread turn ${turn.id ?? '(no id)'} ${why}` } : {};
  }

  /**
   * Judge the tracked main-thread turn now that it is superseded by `next`
   * (OQ-20). Only a turn's own non-streaming fallback may replace it without
   * a stop reason; that case never reaches here (see observeMainAssistant).
   * A truncated turn goes to the truncation ledger; a complete turn that
   * ended abnormally (see {@link abnormalStopOf}) to the failure ledger.
   */
  private supersede(next: string): void {
    const turn = this.mainTurn;
    if (!turn) return;
    const label = `main-thread turn ${turn.id ?? '(no id)'}`;
    const why = truncationOf(turn);
    if (why) {
      this.truncations.record(`${label} ${why}, superseded by ${next}`);
      return;
    }
    const abnormal = abnormalStopOf(turn);
    if (abnormal) {
      const key = turn.failureKey ?? `main:turn:${turn.id ?? `#${++this.anonTurns}`}`;
      this.failures.record(key, {
        code: abnormal.code,
        agent: 'main thread',
        scope: 'main',
        signals: [`${label} ${abnormal.why}, superseded by ${next}`],
      });
    }
  }

  /**
   * Main-thread SSE events only: the CLI does not forward a task agent's
   * stream events (verified: none with `parent_tool_use_id` set), so task-
   * agent turns are not tracked here.
   */
  private observeStreamEvent(msg: Record<string, unknown>): void {
    const parent = msg.parent_tool_use_id;
    if (typeof parent === 'string' && parent.length > 0) return;
    const ev = asRecord(msg.event);
    if (!ev) return;
    this.streamEvents = true;
    const turn = this.mainTurn;
    if (ev.type === 'message_start') {
      const started = asRecord(ev.message);
      const id = typeof started?.id === 'string' ? started.id : undefined;
      // A second message_start with no content and no new API request in
      // between belongs to the same response (a stray/duplicate start), not a
      // new turn. Anything else supersedes the tracked turn: the CLI begins a
      // new streamed turn only after the previous one completed, was retried
      // through a non-streamed fallback (which completes it first), or was
      // abandoned — e.g. a segment cut short while a background task still
      // runs, where CLI 2.1.162 emits no `result` before the next segment.
      const sameResponse =
        turn?.source === 'stream' && turn.stopReason === null && turn.content === 0 && !turn.requestAfter;
      if (!sameResponse) this.supersede(`main-thread turn ${id ?? '(no id)'} (message_start)`);
      this.mainTurn = newMainTurn(id, 'stream', null, stopReasonOf(started?.stop_reason));
      return;
    }
    if (!turn || turn.source !== 'stream') return;
    const index = typeof ev.index === 'number' ? ev.index : undefined;
    if (ev.type === 'content_block_start') {
      turn.content++;
      if (index !== undefined) turn.openBlocks.add(index);
    } else if (ev.type === 'content_block_stop') {
      turn.content++;
      if (index !== undefined) turn.openBlocks.delete(index);
    } else if (ev.type === 'message_delta') {
      const stop = stopReasonOf(asRecord(ev.delta)?.stop_reason);
      if (stop !== null) turn.stopReason = stop;
    }
  }

  /**
   * Main-thread assistant messages. A streamed turn's messages (emitted at
   * `content_block_stop`, carrying `message_start`'s stop_reason — null from
   * the real API) carry the tracked turn's id and only add content. A message
   * with its own stop reason for the same id, or any message no
   * `message_start` announced, is the CLI's
   * non-streaming fallback for the tracked turn's request (verified: sent
   * right after the dropped stream, with no `system/status: requesting` in
   * between, under a new id or the same one): it completes that turn with its
   * own `stop_reason` (D2). If a new API request began since the tracked
   * turn's `message_start`, that turn was abandoned and is judged first. A
   * non-streamed turn's tool_use ids are tracked like a streamed turn's
   * (M0-G02). The CLI's `<synthetic>` error messages are not turns; the ones
   * carrying `error` are recorded by {@link observeMainError}.
   */
  private observeMainAssistant(message: Record<string, unknown> | undefined): void {
    if (!this.streamEvents || !message || message.model === '<synthetic>') return;
    const id = typeof message.id === 'string' ? message.id : undefined;
    const stop = stopReasonOf(message.stop_reason);
    const turn = this.mainTurn;
    if (turn?.source === 'stream' && id === turn.id && (stop === null || stop === turn.startStop)) {
      turn.content++;
      addToolUseIds(turn, message.content);
      return;
    }
    // Another content message of the same non-streamed response.
    if (turn?.source === 'non-streamed' && id !== undefined && id === turn.id && !turn.requestAfter && stop === turn.stopReason) {
      turn.content++;
      addToolUseIds(turn, message.content);
      return;
    }
    if (turn?.requestAfter) {
      this.supersede(`non-streamed main-thread message ${id ?? '(no id)'} of a later request`);
    }
    this.mainTurn = newMainTurn(id, 'non-streamed', stop);
    addToolUseIds(this.mainTurn, message.content);
  }

  private observeSystem(msg: Record<string, unknown>): void {
    const str = (k: string): string | undefined => (typeof msg[k] === 'string' ? (msg[k] as string) : undefined);
    switch (msg.subtype) {
      case 'status': {
        // CLI 2.1.162 emits `status: requesting` before every main-thread
        // streamed API request (never for task agents or for the non-
        // streaming fallback — verified live), i.e. a request boundary.
        if (msg.status === 'requesting' && this.mainTurn) this.mainTurn.requestAfter = true;
        return;
      }
      case 'init': {
        // CLI 2.1.162 starts every segment (the first one and each
        // background-task wake-up) with `system/init`.
        if (this.mainTurn) this.mainTurn.segmentAfter = true;
        this.segmentMainKeys.clear();
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
    // Task-agent terminal failure (signal 2). A main-thread terminal error is
    // recorded too (M0-G01): no `result` follows it inside a segment that a
    // background task keeps open.
    const parent = msg.parent_tool_use_id;
    if (typeof parent !== 'string' || parent.length === 0) {
      this.observeMainError(msg, message);
      this.observeMainAssistant(message);
      return;
    }
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
    const turn = this.mainTurn;
    for (const b of content) {
      const block = asRecord(b);
      if (block?.type !== 'tool_result') continue;
      // OQ-20: the CLI ran a tool_use of the tracked main-thread turn; only a
      // non-error result proves it executed (M0-G03).
      const toolUseId = block.tool_use_id;
      if (mainThread && turn && typeof toolUseId === 'string' && turn.toolUseIds.has(toolUseId)) {
        turn.ranTools = true;
        if (block.is_error !== true) turn.executed = true;
      }
      if (block.is_error !== true) continue;
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
 * a `StopFailure` hook (signal 1) and `forwardSubagentText: true` (signal 2),
 * plus `includePartialMessages: true` so the main thread's raw SSE events
 * reveal a truncated final turn (OQ-20). Returned as part of the permission
 * options object so the executor's query options literal is unchanged; none
 * affects tool authority (the hook always returns `{}` — it observes, never
 * decides).
 */
export function withRunObservers<T extends ClaudeSdkPermissionOptions>(
  permission: T,
  observer: RunStreamObserver,
  failures: RunFailureLedger,
): T & { forwardSubagentText: true; includePartialMessages: true } {
  const stopFailure: HookCallback = (input) => {
    try {
      const rec = input as unknown as Record<string, unknown>;
      const agentId = rec.agent_id;
      if (typeof agentId !== 'string' || agentId.length === 0) {
        // Main thread (M0-G01): no error `result` follows inside a segment a
        // background task keeps open; deduped against one that does.
        observer.recordMainStopFailure(rec.error, rec.last_assistant_message);
      } else {
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
  return { ...permission, hooks, forwardSubagentText: true, includePartialMessages: true };
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
        detail: `${base.reason.detail ?? base.reason.message} | ${failures.subjects()} also failed: ${reason.detail}`,
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

/**
 * Apply main-thread turns judged truncated mid-run (OQ-20, FR-RUN-01, G0): a
 * run with one is never `succeeded`, however its later segments ended.
 * `succeeded`, `interrupted` and `cancelled` become `failed(provider_error)`;
 * an already `failed` or `blocked` run keeps its code and gains the detail.
 */
function applyRunTruncations(
  base: SdkBoardResult,
  truncations: TruncatedTurnLedger,
  boardId: string,
): SdkBoardResult {
  if (truncations.size === 0) return base;
  const turns = `${TRUNCATED_STREAM_DETAIL}: ${truncations.detail()}`;
  if (base.status === 'failed' || base.status === 'blocked') {
    return { ...base, reason: { ...base.reason, detail: `${base.reason.detail ?? base.reason.message} | ${turns}` } };
  }
  const also =
    base.status === 'succeeded'
      ? ''
      : ` | run also ended ${base.status}(${base.reason.code}): ${base.reason.detail ?? base.reason.message}`;
  const out: SdkBoardResult = {
    status: 'failed',
    reason: {
      code: 'provider_error',
      message: `Board ${boardId} executor's ${TRUNCATED_STREAM_DETAIL} in ${truncations.size} main-thread turn(s).`,
      detail: `${turns}${also}`,
    },
  };
  if (base.costUsd !== undefined) out.costUsd = base.costUsd;
  return out;
}

/** Final run status: truncated turns, task-agent failures, then denials (denial wins). */
function applyRunLedgers(
  base: SdkBoardResult,
  failures: RunFailureLedger,
  denials: DenialLedger,
  boardId: string,
  truncations: TruncatedTurnLedger,
): SdkBoardResult {
  const truncated = applyRunTruncations(base, truncations, boardId);
  return applyRunDenials(applyRunFailures(truncated, failures, boardId), denials, boardId);
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
  // Main-thread turns judged truncated before their result (OQ-20); any entry
  // makes the run `failed(provider_error)`, never `succeeded`.
  const truncations = new TruncatedTurnLedger();
  // Hoisted so a stream that throws AFTER yielding a non-success result (the
  // SDK throws "returned an error result" after an is_error result) keeps
  // that result's specific reason instead of a generic provider_error.
  let terminal: SdkBoardResult | null = null;
  // The CLI's config directory for THIS run only: fresh, random, empty,
  // outside every tool root, deleted on every exit path (M0-G06 D1; see
  // executor-env.ts).
  let configDir: string | undefined;
  try {
    return await runMission();
  } finally {
    if (configDir !== undefined) {
      const removed = await removeExecutorConfigDir(configDir);
      if (!removed) {
        logger.warn({ msg: 'executor config dir could not be removed', boardId: params.boardId, dir: configDir });
      }
    }
  }

  async function runMission(): Promise<SdkBoardResult> {
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
      const observer = new RunStreamObserver(policy, failures, denials, truncations);
      const permission = withRunObservers(instrumentPermissionOptions(gate, denials), observer, failures);
      // An explicit, allowlisted environment: `env` REPLACES the CLI's
      // environment, so nothing ambient (RIPGREP_CONFIG_PATH, a falsy
      // USE_BUILTIN_RIPGREP, CLAUDE_CODE_* toggles, …) reaches the executor,
      // and `CLAUDE_CONFIG_DIR` is a fresh private directory nothing could
      // have planted into (M0-G06, FR-SEC-01, OQ-18, OQ-22; executor-env.ts).
      configDir = createExecutorConfigDir();
      const env = buildClaudeExecutorEnv(process.env, configDir, deps.executorEnvOverrides);
      const q = sdk.query({
        prompt: params.missionBrief,
        options: {
          model: params.model,
          systemPrompt: params.systemPrompt,
          maxTurns: params.maxTurns ?? 8,
          ...permission,
          mcpServers: filterMcpServers(policy, params.mcpServers),
          env,
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
        const mapped = mapSdkResultMessage(msg, params.boardId, observer.takeFinalTurnEvidence());
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
          truncations,
        );
      }
      return applyRunLedgers(terminal, failures, denials, params.boardId, truncations);
    } catch (err) {
      logger.warn({
        msg: 'SDK board execution failed',
        boardId: params.boardId,
        err: String(err),
      });
      // A non-success result already observed is the more specific truth.
      const observed: SdkBoardResult | null = terminal;
      if (observed && observed.status !== 'succeeded') {
        return applyRunLedgers(observed, failures, denials, params.boardId, truncations);
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
        truncations,
      );
    }
  }
}
