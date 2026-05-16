import { create } from 'zustand';
import type {
  ClaudeCodeSpawnedEnvelope,
  ClaudeCodeExitedEnvelope,
} from '@skippy/shared';

/**
 * Tracks active and recently-exited claude-code PTYs spawned by Skippy /
 * board captains (PRD §5.1 + §10). The TerminalCluster reads this to render
 * one tab per active spawn.
 *
 * Per CLAUDE.md, this is discrete UI-visible state — not per-frame data — so
 * it lives in Zustand alongside `agentStore`, `delegationStore`, etc.
 *
 * Exit metadata is preserved on the entry so the terminal can grey out / show
 * an exit code once the subprocess ends; the user closes the tab manually
 * (the PTY-close affordance), which calls `remove(spawnId)`.
 */
export interface ClaudeCodeSpawnEntry {
  spawnId: string;
  ptyId: string;
  parentAgentId: string;
  model: string;
  cwd: string;
  taskBrief?: string;
  spawnedAt: string;
  /** Set once a `claude_code_exited` envelope arrives. `null` exit code = wait failed. */
  exitedAt?: string;
  exitCode?: number | null;
}

export interface ClaudeCodeStore {
  spawns: Record<string, ClaudeCodeSpawnEntry>;
  /** Upsert a spawn from a `claude_code_spawned` envelope. Idempotent. */
  upsertFromSpawned: (env: ClaudeCodeSpawnedEnvelope, taskBrief?: string) => void;
  /** Mark a spawn exited from a `claude_code_exited` envelope. No-op if unknown. */
  markExited: (env: ClaudeCodeExitedEnvelope) => void;
  /** Drop a spawn entirely — the renderer-side close-tab affordance. */
  remove: (spawnId: string) => void;
  /** Renderer-only: stash the task brief at request time so we can use it as the tab label even before the envelope round-trips. */
  setTaskBrief: (spawnId: string, taskBrief: string) => void;
  clear: () => void;
}

export const useClaudeCodeStore = create<ClaudeCodeStore>((set) => ({
  spawns: {},
  upsertFromSpawned: (env, taskBrief) =>
    set((s) => {
      const existing = s.spawns[env.spawnId];
      // Prefer an existing brief (set at request time) over the envelope,
      // which doesn't include the brief itself.
      const resolvedBrief = existing?.taskBrief ?? taskBrief;
      // Build the entry with conditional spreads so optional fields are
      // omitted (rather than =undefined) — required by tsconfig's
      // `exactOptionalPropertyTypes: true`.
      const entry: ClaudeCodeSpawnEntry = {
        spawnId: env.spawnId,
        ptyId: env.ptyId,
        parentAgentId: env.parentAgentId,
        model: env.model,
        cwd: env.cwd,
        spawnedAt: env.ts,
        ...(resolvedBrief !== undefined ? { taskBrief: resolvedBrief } : {}),
        ...(existing?.exitedAt !== undefined ? { exitedAt: existing.exitedAt } : {}),
        ...(existing?.exitCode !== undefined ? { exitCode: existing.exitCode } : {}),
      };
      return {
        spawns: { ...s.spawns, [env.spawnId]: entry },
      };
    }),
  markExited: (env) =>
    set((s) => {
      const existing = s.spawns[env.spawnId];
      if (!existing) return s;
      return {
        spawns: {
          ...s.spawns,
          [env.spawnId]: {
            ...existing,
            exitedAt: env.ts,
            exitCode: env.exitCode,
          },
        },
      };
    }),
  remove: (spawnId) =>
    set((s) => {
      if (!(spawnId in s.spawns)) return s;
      const next = { ...s.spawns };
      delete next[spawnId];
      return { spawns: next };
    }),
  setTaskBrief: (spawnId, taskBrief) =>
    set((s) => {
      const existing = s.spawns[spawnId];
      if (existing) {
        return {
          spawns: {
            ...s.spawns,
            [spawnId]: { ...existing, taskBrief },
          },
        };
      }
      // No envelope yet — stash a placeholder entry so the brief survives.
      return {
        spawns: {
          ...s.spawns,
          [spawnId]: {
            spawnId,
            ptyId: '',
            parentAgentId: '',
            model: '',
            cwd: '',
            taskBrief,
            spawnedAt: new Date().toISOString(),
          },
        },
      };
    }),
  clear: () => set({ spawns: {} }),
}));
