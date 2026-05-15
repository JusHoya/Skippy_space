import { create } from 'zustand';
import type { BoardId } from '@skippy/shared';

/**
 * Lightweight tracker for delegations issued by Skippy to one of the eight
 * Boards (PRD §5.2). The HUD reads this to render the "active delegations"
 * row in the SelectedPanel when a board sprite is selected.
 *
 * Per CLAUDE.md, this is discrete UI-visible state — not per-frame data —
 * so it lives in Zustand.
 */
export type DelegationStatus =
  | 'pending'
  | 'accepted'
  | 'declined'
  | 'counter_proposed'
  | 'succeeded'
  | 'failed';

export interface DelegationRecord {
  delegationId: string;
  fromAgentId: string;
  toBoardId: BoardId;
  missionBrief: string;
  constraints?: string[];
  deadline?: string;
  status: DelegationStatus;
  counterText?: string;
  summary?: string;
  result?: 'success' | 'failure';
  createdAt: string;
  updatedAt: string;
}

export interface DelegationStore {
  delegations: Record<string, DelegationRecord>;
  upsert: (id: string, patch: Partial<DelegationRecord> & { delegationId: string }) => void;
  setStatus: (id: string, status: DelegationStatus, ts: string, patch?: Partial<DelegationRecord>) => void;
  clear: () => void;
}

export const useDelegationStore = create<DelegationStore>((set) => ({
  delegations: {},
  upsert: (id, patch) =>
    set((s) => {
      const existing = s.delegations[id];
      const now = patch.updatedAt ?? new Date().toISOString();
      const next: DelegationRecord = existing
        ? { ...existing, ...patch, updatedAt: now }
        : {
            fromAgentId: patch.fromAgentId ?? 'skippy',
            toBoardId: patch.toBoardId ?? ('engineering' as BoardId),
            missionBrief: patch.missionBrief ?? '',
            status: patch.status ?? 'pending',
            createdAt: patch.createdAt ?? now,
            ...patch,
            delegationId: id,
            updatedAt: now,
          };
      return { delegations: { ...s.delegations, [id]: next } };
    }),
  setStatus: (id, status, ts, patch) =>
    set((s) => {
      const existing = s.delegations[id];
      if (!existing) return s;
      return {
        delegations: {
          ...s.delegations,
          [id]: { ...existing, status, updatedAt: ts, ...(patch ?? {}) },
        },
      };
    }),
  clear: () => set({ delegations: {} }),
}));
