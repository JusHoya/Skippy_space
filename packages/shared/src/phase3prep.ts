// Phase 3-prep contracts — multi-zone work batch dispatched right after the
// Phase 2 RTS UX landed.
//
// Five zones write against this file:
//   • Zone 1 — debug Skippy hang in `agent-runtime/claude.ts`.
//   • Zone 2 — `claude_code_spawn` Tauri command + PTY-backed CLI agents.
//   • Zone 3 — TUI-style command-bar navigation.
//   • Zone 4 — Playwright MCP server registration in `agent_space/`.
//   • Zone 5 — model picker dropdown in the TopBar.
//
// Anything that crosses an IPC boundary (sidecar ↔ shell ↔ renderer) gets a
// Zod schema. Pure intra-renderer shapes stay TS-only.

import { z } from 'zod';
import { AgentIdSchema } from './agents.js';
import { BoardIdSchema } from './envelope.js';

// ── 1. Model picker (Zone 5) ─────────────────────────────────────────────────

/**
 * Available Claude models the user can pick between in the dashboard. The
 * three current Claude 4.x families plus a "default per board charter" sentinel
 * so the user can revert a per-board override to the charter's `defaultModel`.
 *
 * `tier` drives the visual grouping in the dropdown; `label` is the human-
 * readable string shown to the user. `recommendedFor` is a short copy hint —
 * "Skippy", "heavy thinking", "volume work" — to help the user pick.
 */
export const AVAILABLE_MODELS = [
  {
    id: 'claude-opus-4-7',
    label: 'Opus 4.7 (1M)',
    tier: 'opus' as const,
    recommendedFor: 'Skippy / deep reasoning',
  },
  {
    id: 'claude-sonnet-4-6',
    label: 'Sonnet 4.6',
    tier: 'sonnet' as const,
    recommendedFor: 'Engineering / Coding / Design / Finance',
  },
  {
    id: 'claude-haiku-4-5-20251001',
    label: 'Haiku 4.5',
    tier: 'haiku' as const,
    recommendedFor: 'Marketing / Research / Publishing / DevOps',
  },
] as const;

export type ModelId = (typeof AVAILABLE_MODELS)[number]['id'];
export type ModelTier = (typeof AVAILABLE_MODELS)[number]['tier'];

export const ModelIdSchema = z
  .enum(AVAILABLE_MODELS.map((m) => m.id) as unknown as readonly [ModelId, ...ModelId[]]);

/**
 * Scope a `set_model` envelope targets. `skippy` rebinds the orchestrator's
 * model; `board.<id>` rebinds a single captain. There is no "all boards" scope
 * — the user picks per agent, à la SC2 control groups.
 */
export const ModelScopeSchema = z.union([
  z.literal('skippy'),
  z
    .string()
    .startsWith('board.')
    .refine((s) => {
      const id = s.slice(6);
      return ['engineering', 'coding', 'design', 'marketing', 'finance', 'research', 'publishing', 'devops'].includes(id);
    }, { message: 'invalid board scope' }),
]);
export type ModelScope = z.infer<typeof ModelScopeSchema>;

/**
 * Renderer → sidecar (through the shell): "rebind this scope to this model
 * for subsequent calls." The sidecar updates its in-process model binding for
 * the named agent. Already-in-flight calls keep their original model.
 */
export const SetModelEnvelope = z.object({
  type: z.literal('set_model'),
  scope: ModelScopeSchema,
  modelId: ModelIdSchema,
  ts: z.string().datetime({ offset: true }),
});
export type SetModelEnvelope = z.infer<typeof SetModelEnvelope>;

// ── 2. Claude Code subprocess spawn (Zone 2) ─────────────────────────────────

/**
 * Arguments to the `claude_code_spawn` Tauri command. The renderer sends this
 * when the user clicks "Spawn task agent" on a board's CommandCard; the shell
 * starts `claude` in a PTY and replies with the assigned ptyId.
 */
export interface ClaudeCodeSpawnRequest {
  /** The board / Skippy that spawned this task agent. `task.<ulid>` ids are minted by the renderer. */
  parentAgentId: string;
  /** Short brief — passed to `claude` via `-p` flag (one-shot mode) or stdin. */
  taskBrief: string;
  /** Optional model override. Defaults to the parent agent's current model. */
  model?: ModelId;
  /** Optional working dir. Defaults to the project root. */
  cwd?: string;
}

/** Result returned synchronously by the Tauri command. */
export interface ClaudeCodeSpawnResult {
  spawnId: string;
  ptyId: string;
  parentAgentId: string;
  /** Resolved model; matches request.model when supplied, else the parent's default. */
  model: ModelId;
  /** Working dir the subprocess was launched in. */
  cwd: string;
}

/** Envelope the shell broadcasts when a claude-code PTY is opened. */
export const ClaudeCodeSpawnedEnvelope = z.object({
  type: z.literal('claude_code_spawned'),
  spawnId: z.string(),
  ptyId: z.string(),
  parentAgentId: AgentIdSchema,
  model: ModelIdSchema,
  cwd: z.string(),
  ts: z.string().datetime({ offset: true }),
});
export type ClaudeCodeSpawnedEnvelope = z.infer<typeof ClaudeCodeSpawnedEnvelope>;

/** Envelope the shell broadcasts when a claude-code PTY ends. */
export const ClaudeCodeExitedEnvelope = z.object({
  type: z.literal('claude_code_exited'),
  spawnId: z.string(),
  ptyId: z.string(),
  exitCode: z.number().int().nullable(),
  ts: z.string().datetime({ offset: true }),
});
export type ClaudeCodeExitedEnvelope = z.infer<typeof ClaudeCodeExitedEnvelope>;

// ── 3. Agent navigator (Zone 3) ──────────────────────────────────────────────

/**
 * One entry in the TUI-style agent activity list shown when the user presses
 * ↓ from the CommandBar. Ranked by recency × state-weight (working > thinking
 * > speaking > idle). Built reactively from `agentStore.agents` — no envelope
 * needed.
 */
export interface AgentActivityEntry {
  agentId: string;
  /** Lower = higher in the list. */
  rank: number;
  state: import('./states.js').AgentState;
  /** Human-readable summary; usually the agent's last task or last token. */
  summary: string;
  /** ISO-8601 timestamp of the last state change or token. */
  lastSeen: string;
  /** Stable display label — "Skippy", "Engineering Captain", etc. */
  label: string;
  /** Accent color used by the navigator chip — agent's costume color. */
  accentHex: string;
}

// AgentIdSchema + BoardIdSchema are re-exported by `index.ts` from their
// canonical modules (agents.ts / envelope.ts); no need to re-export here.
