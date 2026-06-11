import { create } from 'zustand';
import { Envelope, type EnvelopeT } from '@skippy/shared';
import { safeInvoke } from '../lib/tauri';

/**
 * Replay store (PRD §9.5, WS8/D5). Backs the `ReplayScrubber` HUD panel.
 *
 * Each session is a `.jsonl` file written by the sidecar's replay-writer — one
 * envelope per line. The Rust `replay_list_sessions` / `replay_load` commands
 * enumerate + read those files; this store parses the JSONL into a flat
 * `records` array the scrubber can index with a range slider.
 *
 * Per CLAUDE.md this is discrete UI-visible state (the scrubber is open or not,
 * a session is selected or not), so Zustand is the right home — not the
 * per-frame ref-store. Records are loaded on demand, not streamed per frame.
 *
 * Replay records are held to the SAME `Envelope` zod discipline as the live
 * channel (`lib/channel.ts`): each parsed JSONL line is validated against the
 * shared discriminated union and dropped if it doesn't conform, so the scrubber
 * and `reconstructAt` only ever consume well-typed envelopes — never arbitrary
 * untyped JSON off disk.
 */

/** Metadata for one available replay file (mirrors Rust `ReplaySession`). */
export interface ReplaySessionMeta {
  sessionId: string;
  path: string;
  sizeBytes: number;
  modifiedMs: number;
}

/**
 * A parsed replay record: a single validated wire envelope. Same union the live
 * channel dispatches on, so the scrubber gets the same per-`type` narrowing.
 */
export type ReplayRecord = EnvelopeT;

/**
 * The reconstructed view of a single agent at a given scrub index: the most
 * recent state/token it had, and its latest telemetry snapshot, at-or-before
 * the selected record.
 */
export interface AgentReconstruction {
  agentId: string;
  state?: string;
  lastToken?: string;
  task?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Index of the most recent record that touched this agent. */
  lastTouchedIndex: number;
}

export interface ReplayStore {
  open: boolean;
  activeSessionId: string | null;
  sessions: ReplaySessionMeta[];
  records: ReplayRecord[];
  selectedIndex: number;

  openScrubber: () => void;
  closeScrubber: () => void;
  setActiveSession: (id: string) => void;
  /** Fetch the list of available sessions from the Rust shell. */
  listSessions: () => Promise<void>;
  /** Load + parse one session's JSONL into `records`. */
  loadSession: (id: string) => Promise<void>;
  setSelectedIndex: (i: number) => void;
}

/**
 * Extract the `agentId` from an envelope, if its variant carries one.
 *
 * Exported so HUD consumers (e.g. `ReplayScrubber`) can read an envelope's
 * agentId without reaching into `rec.agentId` directly — only some members of
 * the `Envelope` union have that field, so a bare access doesn't type-check.
 */
export function recordAgentId(rec: ReplayRecord): string | null {
  // Not every envelope in the union has an `agentId` (e.g. `user_prompt`,
  // `log`, `replay_session`, `memory_job`). The `in` check narrows to the
  // members that do, so the field access is type-safe.
  if ('agentId' in rec && typeof rec.agentId === 'string') {
    return rec.agentId;
  }
  return null;
}

export const useReplayStore = create<ReplayStore>((set, get) => ({
  open: false,
  activeSessionId: null,
  sessions: [],
  records: [],
  selectedIndex: 0,

  openScrubber: () => {
    set({ open: true });
    // Refresh the session list whenever the panel opens — cheap, and the user
    // may have run a new session since last time.
    void get().listSessions();
  },

  closeScrubber: () => set({ open: false }),

  setActiveSession: (id) => {
    // A live `replay_session: started` envelope arrived. Note the active id;
    // we don't auto-load (the file is still being written), but the scrubber
    // surfaces it as the current session in the picker.
    set({ activeSessionId: id });
  },

  listSessions: async () => {
    const list = await safeInvoke<ReplaySessionMeta[]>('replay_list_sessions');
    set({ sessions: Array.isArray(list) ? list : [] });
  },

  loadSession: async (id) => {
    const text = await safeInvoke<string>('replay_load', { sessionId: id });
    if (text === null) {
      // Outside Tauri or read failed — clear records but remember the selection.
      set({ activeSessionId: id, records: [], selectedIndex: 0 });
      return;
    }
    const records: ReplayRecord[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(trimmed);
      } catch {
        // Skip a torn/partial line (the file may have been mid-write).
        continue;
      }
      // Hold replay records to the same Envelope discipline as the live
      // channel: drop anything that isn't a well-formed wire envelope rather
      // than trusting arbitrary JSON off disk.
      const parsed = Envelope.safeParse(raw);
      if (parsed.success) records.push(parsed.data);
    }
    set({
      activeSessionId: id,
      records,
      selectedIndex: records.length > 0 ? records.length - 1 : 0,
    });
  },

  setSelectedIndex: (i) =>
    set((s) => {
      if (s.records.length === 0) return { selectedIndex: 0 };
      const clamped = Math.max(0, Math.min(s.records.length - 1, Math.floor(i)));
      return { selectedIndex: clamped };
    }),
}));

/**
 * Reconstruct "what each agent knew" at record index `i` (inclusive) for a
 * given record array — the most recent `agent_state` / `agent_token` /
 * `telemetry_span` for each agentId at-or-before `i`. Pure so the scrubber can
 * call it without subscribing to the whole records array each render.
 */
export function reconstructAt(
  records: ReplayRecord[],
  i: number,
): Record<string, AgentReconstruction> {
  const out: Record<string, AgentReconstruction> = {};
  const upTo = Math.max(0, Math.min(records.length - 1, i));
  for (let idx = 0; idx <= upTo && idx < records.length; idx++) {
    const rec = records[idx];
    // `noUncheckedIndexedAccess` widens the element to `Envelope | undefined`;
    // the loop bound guarantees it's present, but guard so the union narrows.
    if (rec === undefined) continue;
    const agentId = recordAgentId(rec);
    if (agentId === null) continue;
    const prev = out[agentId];
    const cur: AgentReconstruction = prev ?? { agentId, lastTouchedIndex: idx };
    cur.lastTouchedIndex = idx;
    switch (rec.type) {
      case 'agent_state':
        if (typeof rec.state === 'string') cur.state = rec.state;
        if (typeof rec.task === 'string') cur.task = rec.task;
        break;
      case 'agent_token':
        cur.state = 'speaking';
        if (typeof rec.text === 'string') cur.lastToken = rec.text;
        break;
      case 'agent_complete':
        cur.state = 'idle';
        break;
      case 'telemetry_span':
        if (typeof rec.model === 'string') cur.model = rec.model;
        if (typeof rec.inputTokens === 'number') cur.inputTokens = rec.inputTokens;
        if (typeof rec.outputTokens === 'number') cur.outputTokens = rec.outputTokens;
        break;
      case 'context_window':
        if (typeof rec.model === 'string') cur.model = rec.model;
        if (typeof rec.usedTokens === 'number') cur.inputTokens = rec.usedTokens;
        break;
      default:
        break;
    }
    out[agentId] = cur;
  }
  return out;
}

/** Convenience selector: reconstruct the agent view at the current selectedIndex. */
export function recordsUpTo(): Record<string, AgentReconstruction> {
  const { records, selectedIndex } = useReplayStore.getState();
  return reconstructAt(records, selectedIndex);
}
