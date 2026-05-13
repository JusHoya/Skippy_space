import { create } from 'zustand';
import type { AgentId, AgentState } from '@skippy/shared';

/**
 * Discrete-state snapshot for each agent (Skippy, the eight Boards, staff
 * officers, and ephemeral task agents).
 *
 * Per CLAUDE.md, this store ONLY carries state with UI-visible discrete
 * changes — e.g., the agent transitioning from `thinking` to `speaking`, or
 * its current task assignment. Per-frame sprite positions, animation phases,
 * and tween progress live in the scene's transient ref-store (Agent P).
 */
export interface AgentSnapshot {
  state: AgentState;
  /** Most recent streamed token — kept for the "lastToken" peek in the side panel. */
  lastToken?: string;
  /** Human-readable current task description, or null when idle. */
  task?: string | null;
  /** ISO-8601 timestamp from the producing envelope. */
  updatedAt?: string;
}

export interface AgentStore {
  agents: Record<string, AgentSnapshot>;
  setAgent: (id: AgentId, patch: Partial<AgentSnapshot>) => void;
  removeAgent: (id: AgentId) => void;
  reset: () => void;
}

export const useAgentStore = create<AgentStore>((set) => ({
  agents: {
    // Skippy is always present; Boards populate as their query() processes warm up.
    skippy: { state: 'idle' },
  },
  setAgent: (id, patch) =>
    set((s) => ({
      agents: {
        ...s.agents,
        [id]: { ...(s.agents[id] ?? { state: 'idle' }), ...patch },
      },
    })),
  removeAgent: (id) =>
    set((s) => {
      const next = { ...s.agents };
      delete next[id];
      return { agents: next };
    }),
  reset: () => set({ agents: { skippy: { state: 'idle' } } }),
}));
