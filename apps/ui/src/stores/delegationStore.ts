import { create } from 'zustand';
import {
  RECORDED_OUTCOMES,
  type BoardId,
  type ExecutionMode,
  type OutcomeReason,
  type RecordedOutcome,
  type ValidationDisposition,
} from '@skippy/shared';

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
  | 'running'
  | 'declined'
  | 'counter_proposed'
  // Terminal outcomes (PRD v0.2 FR-RUN-01) + reader-only legacy `unverified`.
  | RecordedOutcome;

const TERMINAL_STATUSES: ReadonlySet<DelegationStatus> = new Set<DelegationStatus>([
  ...RECORDED_OUTCOMES,
  'declined',
  'counter_proposed',
]);

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
  /** Terminal outcome fields from `delegation_complete` (FR-RUN-01). */
  mode?: ExecutionMode;
  validation?: ValidationDisposition;
  reason?: OutcomeReason;
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
      // A terminal outcome is final: a late lifecycle pulse must not
      // overwrite it (FR-RUN-05).
      if (TERMINAL_STATUSES.has(existing.status)) return s;
      return {
        delegations: {
          ...s.delegations,
          [id]: { ...existing, status, updatedAt: ts, ...(patch ?? {}) },
        },
      };
    }),
  clear: () => set({ delegations: {} }),
}));

/** Visual tone for a delegation status. Only `succeeded` gets the success
 * tone; simulated/blocked/failed/interrupted/unverified are always distinct
 * (G0: zero false success). */
export type DelegationTone = 'success' | 'progress' | 'simulated' | 'failure' | 'neutral';

export interface DelegationStatusView {
  label: string;
  tone: DelegationTone;
  color: string;
}

const TONE_COLOR: Record<DelegationTone, string> = {
  success: '#3fb950',
  progress: 'var(--c-neon-cyan)',
  simulated: '#d29922',
  failure: '#f85149',
  neutral: 'var(--c-text-dim)',
};

export function delegationStatusView(status: DelegationStatus): DelegationStatusView {
  const view = (label: string, tone: DelegationTone): DelegationStatusView => ({
    label,
    tone,
    color: TONE_COLOR[tone],
  });
  switch (status) {
    case 'succeeded':
      return view('Succeeded', 'success');
    case 'pending':
      return view('Pending', 'progress');
    case 'accepted':
      return view('Accepted (not done)', 'progress');
    case 'running':
      return view('Running', 'progress');
    case 'simulated':
      return view('SIMULATED (demo, no work done)', 'simulated');
    case 'blocked':
      return view('Blocked (not executed)', 'failure');
    case 'failed':
      return view('Failed', 'failure');
    case 'interrupted':
      return view('Interrupted', 'failure');
    case 'cancelled':
      return view('Cancelled', 'neutral');
    case 'unverified':
      return view('Unverified (legacy)', 'neutral');
    case 'declined':
      return view('Declined', 'neutral');
    case 'counter_proposed':
      return view('Counter-proposed', 'neutral');
  }
}
