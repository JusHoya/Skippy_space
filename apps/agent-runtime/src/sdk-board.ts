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
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';

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
  /** Tool-loop ceiling (R-01 cost guard). */
  maxTurns?: number;
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
    const q = sdk.query({
      prompt: params.missionBrief,
      options: {
        model: params.model,
        systemPrompt: params.systemPrompt,
        maxTurns: params.maxTurns ?? 8,
        permissionMode: 'bypassPermissions',
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
