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
// refused before the SDK is even imported. Without an assigned worktree the
// board runs read-only (no built-in write root).

import type { ExecutorTerminal, ModelId } from '@skippy/shared';
import type { McpServerConfig, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';

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
  /** Assigned worktree (absolute): the only built-in write root. Omitted =>
   * read-only execution rooted at the process cwd. */
  worktreePath?: string;
  /** Approval + path-guard hooks; default approver denies (no approval channel). */
  enforcement?: SdkEnforcementHooks;
}

/**
 * Derive the enforced policy for a board mission and prove this adapter can
 * enforce it. Throws ToolPolicyError (the mission must be refused).
 */
export async function resolveBoardPolicy(params: ExecuteBoardMissionParams): Promise<ExecutionPolicy> {
  const charter =
    params.charter ?? (await loadCharter(`board.${params.boardId}` as CharterAgentId));
  const policy = derivePolicy(charter, {
    cwd: params.worktreePath ?? process.cwd(),
    ...(params.worktreePath ? { worktreePath: params.worktreePath } : {}),
  });
  assertExecutorEligible(policy, CLAUDE_AGENT_SDK_CAPABILITIES);
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
 *   | non-empty `permission_denials`                        | blocked     | policy_refused          |
 *   | `api_error_status` present (not null)                 | failed      | provider_error          |
 *   | `terminal_reason` in {hook_stopped, stop_hook_prevented}| blocked     | policy_refused          |
 *   | `terminal_reason === 'tool_deferred'` or                | blocked     | approval_required       |
 *   |   `deferred_tool_use` present                          |             |                         |
 *   | `terminal_reason === 'aborted_tools'`                  | interrupted | tool_execution_aborted  |
 *   | subtype `'success'`, `!is_error`, and                  | succeeded   | —                       |
 *   |   `terminal_reason` absent or `'completed'`            |             |                         |
 *   | anything else (error subtype, `is_error` on a          | failed      | executor_error          |
 *   |   success subtype, `model_error`, `prompt_too_long`,   |             |                         |
 *   |   `max_turns`, or any other/unknown terminal_reason)   |             |                         |
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

  const denials = msg.permission_denials ?? [];
  if (denials.length > 0) {
    return withCost({
      status: 'blocked',
      reason: {
        code: 'policy_refused',
        message: `Board ${boardId} executor was denied ${denials.length} tool call(s) by policy.`,
        detail: denials.map((d) => d.tool_name).join(', '),
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

  const normalCompletion =
    msg.subtype === 'success' &&
    !msg.is_error &&
    (terminalReason === undefined || terminalReason === 'completed');
  if (normalCompletion) {
    return withCost({ status: 'succeeded', summary: msg.result });
  }

  // Fail closed: an error subtype, a "success" subtype flagged is_error, or
  // any other terminal_reason (model_error, prompt_too_long, max_turns,
  // blocking_limit, rapid_refill_breaker, aborted_streaming, image_error, or
  // an unrecognised future value) never becomes success.
  const detail =
    msg.subtype === 'success'
      ? `success result flagged is_error: ${msg.result}${terminalReason ? ` (terminal_reason: ${terminalReason})` : ''}`
      : [msg.subtype, terminalReason, ...(msg.errors ?? [])].filter(Boolean).join(': ');
  return withCost({
    status: 'failed',
    reason: {
      code: 'executor_error',
      message: `Board ${boardId} executor ended with an error result (${msg.subtype}).`,
      detail,
    },
  });
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

  try {
    const sdk = await (deps.loadSdk ?? loadClaudeAgentSdk)();
    const permission = buildClaudeSdkPermissionOptions(policy, {
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
        }
        params.enforcement?.onDecision?.(e);
      },
    });
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
    let terminal: SdkBoardResult | null = null;
    let sawNonSuccessResult = false;
    for await (const msg of q) {
      if (msg.type !== 'result') continue;
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
      return {
        status: 'failed',
        reason: {
          code: 'no_terminal_result',
          message: `Board ${params.boardId} executor stream ended without a terminal result.`,
        },
      };
    }
    return terminal;
  } catch (err) {
    logger.warn({
      msg: 'SDK board execution failed',
      boardId: params.boardId,
      err: String(err),
    });
    return {
      status: 'failed',
      reason: {
        code: 'provider_error',
        message: `Board ${params.boardId} executor failed before a terminal result.`,
        detail: String(err),
      },
    };
  }
}
