// sdk-board.ts — gated real-agent execution for Board Captains via the Claude
// Agent SDK (PRD §5.1: boards as root query() processes).
//
// OFF BY DEFAULT. The eight boards otherwise run as the Phase-1 keyword stub
// (board.ts). Set PHASE3_AGENTS_ENABLED=1 (and provide ANTHROPIC_API_KEY) to
// route an accepted delegation through a real `query()` — the board's charter
// as the system prompt — instead of the stub. ANY failure (no key, SDK error,
// the R-01 cold-start, a permission hang) is caught and the caller falls back
// to the stub summary, so enabling the flag can never wedge a delegation.
//
// MCP tools (Phase 3.5): the Obsidian (D1) + Letta (D4) MCP servers ARE now
// wired — board.ts builds them from the charter's `mcp_servers:` via
// mcp-registry.ts and passes them in as `mcpServers`. They're constructed with
// agent-runtime's own zod@4 (matching the SDK's bundled v4), scoped so
// @skippy/shared + @skippy/memory stay on zod@3. Live execution still needs an
// API key (and, for full effect, a running Obsidian/Letta) — it cannot run in
// the headless, no-key exit gate.

import type { ModelId } from '@skippy/shared';
import type { McpServerConfig, PermissionMode } from '@anthropic-ai/claude-agent-sdk';

import type { CharterPermissions } from './charter.js';
import { logger } from './logger.js';

export interface SdkBoardResult {
  ok: boolean;
  /** Final assistant text (the mission outcome), or an error note when !ok. */
  summary: string;
  /** Total cost the SDK reported for the run, if any. */
  costUsd?: number;
}

/** True only when the SDK board path is enabled AND an API key is present. */
export function sdkBoardsEnabled(): boolean {
  return (
    process.env.PHASE3_AGENTS_ENABLED === '1' && Boolean(process.env.ANTHROPIC_API_KEY)
  );
}

export interface ExecuteBoardMissionParams {
  boardId: string;
  /** The board's charter body, used verbatim as the SDK system prompt. */
  systemPrompt: string;
  model: ModelId;
  missionBrief: string;
  /** Per-board MCP servers (obsidian/letta) from the charter, wired into query(). */
  mcpServers?: Record<string, McpServerConfig>;
  /** The charter's permission contract (permission_mode / tools / disallowed_tools).
   * Honored verbatim — `ask` is the safe default; bypass requires an env opt-in. */
  permissions?: CharterPermissions;
  /** Tool-loop ceiling (R-01 cost guard). */
  maxTurns?: number;
}

/**
 * Resolve the SDK `permissionMode` from the charter's `permission_mode`.
 *
 * The charter author's `ask` has no direct headless equivalent — the SDK's
 * prompting mode (`default`) cannot prompt a human in this non-interactive
 * sidecar, so an `ask` board would hang on the first tool call. We therefore
 * downgrade `ask` to the *narrowest* automatic mode, `acceptEdits` (edits +
 * MCP tools auto-approved, but NOT the full unattended Bash/file surface that
 * `bypassPermissions` grants). `bypassPermissions` is NEVER reached from a
 * charter value alone: it requires the explicit `SKIPPY_BYPASS_PERMISSIONS=1`
 * env opt-in, and we log loudly when it is honored (agent_space/CLAUDE.md's
 * "safety rails are welded shut" doctrine).
 */
export function resolvePermissionMode(
  boardId: string,
  charterMode: CharterPermissions['permissionMode'],
): PermissionMode {
  const bypassOptIn = process.env.SKIPPY_BYPASS_PERMISSIONS === '1';

  if (charterMode === 'bypassPermissions') {
    if (bypassOptIn) {
      logger.warn({
        msg: 'HONORING permission_mode=bypassPermissions (SKIPPY_BYPASS_PERMISSIONS=1) — safety rails OFF',
        boardId,
      });
      return 'bypassPermissions';
    }
    // Charter asks for bypass but the operator has not opted in: refuse to
    // widen, fall back to the narrowest automatic mode instead.
    logger.warn({
      msg: 'charter permission_mode=bypassPermissions ignored; set SKIPPY_BYPASS_PERMISSIONS=1 to honor it. Falling back to acceptEdits.',
      boardId,
    });
    return 'acceptEdits';
  }

  if (charterMode === 'plan') return 'plan';
  if (charterMode === 'acceptEdits') return 'acceptEdits';
  // `ask` (the default): downgrade to acceptEdits for the headless run — never
  // bypass — so MCP tools work without a prompt nobody can answer.
  return 'acceptEdits';
}

/**
 * Build the `allowedTools` auto-approve list. Even under `acceptEdits` the SDK
 * may prompt for non-edit tool calls; in a headless sidecar there is no one to
 * answer, so the board's charter-declared `tools:` AND its MCP server tools must
 * be explicitly auto-approved. The `mcp__<server>` wildcards keep the D1/D4
 * Obsidian + Letta tools available (the assignment's hard requirement) without
 * granting anything the charter did not declare.
 */
export function buildAllowedTools(
  charterTools: string[] | undefined,
  mcpServerNames: string[],
): string[] | undefined {
  const mcpWildcards = mcpServerNames.map((name) => `mcp__${name}`);
  const merged = [...(charterTools ?? []), ...mcpWildcards];
  return merged.length > 0 ? merged : undefined;
}

/**
 * Execute one board mission through the Claude Agent SDK. Dynamically imports
 * the SDK so it never touches the module-load path unless the gated flag is on.
 * Returns `{ ok:false }` on any failure so the board can fall back to the stub.
 */
export async function executeBoardMissionViaSdk(
  params: ExecuteBoardMissionParams,
): Promise<SdkBoardResult> {
  try {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');

    // Charter-driven permissions (PRD §6.1) — NOT a hardcoded bypass. The
    // charter's `permission_mode` is honored (with `ask` downgraded to the
    // narrowest automatic mode for this headless run), and its `tools` /
    // `disallowed_tools` become the allow/deny lists.
    const permissions = params.permissions ?? { permissionMode: 'ask' as const };
    const permissionMode = resolvePermissionMode(params.boardId, permissions.permissionMode);
    const mcpServerNames = params.mcpServers ? Object.keys(params.mcpServers) : [];
    const allowedTools = buildAllowedTools(permissions.allowedTools, mcpServerNames);

    // Operator visibility: `allowedTools` are auto-approved WITHOUT prompting, so
    // if the charter lists Bash/Write they still run unattended even though we no
    // longer use bypassPermissions. Log the effective surface so this isn't a
    // silent trust grant (see docs/REVIEW-2026-06-10.md §2).
    logger.info(
      { boardId: params.boardId, permissionMode, autoApprovedTools: allowedTools ?? [] },
      'sdk board permission surface',
    );

    const q = sdk.query({
      prompt: params.missionBrief,
      options: {
        model: params.model,
        systemPrompt: params.systemPrompt,
        maxTurns: params.maxTurns ?? 8,
        permissionMode,
        // bypassPermissions is a guarded path: it can only be reached via the
        // SKIPPY_BYPASS_PERMISSIONS opt-in (resolvePermissionMode), and the SDK
        // further requires this explicit flag — set it only when we truly bypass.
        ...(permissionMode === 'bypassPermissions'
          ? { allowDangerouslySkipPermissions: true }
          : {}),
        ...(allowedTools ? { allowedTools } : {}),
        ...(permissions.disallowedTools ? { disallowedTools: permissions.disallowedTools } : {}),
        ...(params.mcpServers ? { mcpServers: params.mcpServers } : {}),
      },
    });

    let summary = '';
    let costUsd: number | undefined;
    for await (const msg of q) {
      if (msg.type === 'result' && msg.subtype === 'success') {
        summary = msg.result;
        costUsd = msg.total_cost_usd;
      }
    }

    if (summary.trim().length > 0) {
      const out: SdkBoardResult = { ok: true, summary };
      if (costUsd !== undefined) out.costUsd = costUsd;
      return out;
    }
    return { ok: false, summary: '' };
  } catch (err) {
    logger.warn({
      msg: 'SDK board execution failed; falling back to stub',
      boardId: params.boardId,
      err: String(err),
    });
    return { ok: false, summary: `SDK board execution failed: ${String(err)}` };
  }
}
