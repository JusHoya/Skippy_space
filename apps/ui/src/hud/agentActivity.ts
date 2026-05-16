// Pure helper that ranks `AgentSnapshot` entries into `AgentActivityEntry` rows
// for the TUI-style Agent Navigator overlay (PRD Phase 3-prep, Zone 3).
//
// Sorted by `state-weight × recency`:
//   state weights:  working=4, thinking=3, speaking=3, spawning=2, error=2,
//                   idle=1, completed=0, despawning=0
//   recency:        (now - updatedAt) seconds, capped at 300s (5 min)
//   final rank:     -weight*60 + recencySeconds  (ascending)
//
// Display label + accent are derived from the canonical id patterns:
//   skippy            → "Skippy" + neon cyan
//   board.<id>        → BOARD_META[id].displayName + BOARD_META[id].accentHex
//   staff.<id>        → titlecased id + muted cyan
//   task.<id>         → "Task " + short id (last 6 chars) + starlight
//
// Summary preference: snap.task → snap.lastToken → '—'.

import { BOARD_META, BOARDS, type AgentState } from '@skippy/shared';
import type { AgentSnapshot } from '../stores/agentStore';
import type { AgentActivityEntry } from '@skippy/shared';

const STATE_WEIGHT: Record<AgentState, number> = {
  working: 4,
  thinking: 3,
  speaking: 3,
  spawning: 2,
  error: 2,
  idle: 1,
  completed: 0,
  despawning: 0,
};

const RECENCY_CAP_SECONDS = 300;

const SKIPPY_ACCENT = '#66FCF1'; // neon cyan
const STAFF_ACCENT = '#45A29E'; // muted cyan
const TASK_ACCENT = '#C5C6C7'; // starlight

/** Title-case "agent-creator" → "Agent Creator". */
function titleCase(s: string): string {
  return s
    .split(/[._-]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

interface Resolved {
  label: string;
  accentHex: string;
}

function resolveLabelAndAccent(agentId: string): Resolved {
  if (agentId === 'skippy') {
    return { label: 'Skippy', accentHex: SKIPPY_ACCENT };
  }
  if (agentId.startsWith('board.')) {
    const tail = agentId.slice(6);
    if ((BOARDS as readonly string[]).includes(tail)) {
      const meta = BOARD_META[tail as (typeof BOARDS)[number]];
      return { label: meta.displayName, accentHex: meta.accentHex };
    }
    return { label: titleCase(tail), accentHex: STAFF_ACCENT };
  }
  if (agentId.startsWith('staff.')) {
    return { label: titleCase(agentId.slice(6)), accentHex: STAFF_ACCENT };
  }
  if (agentId.startsWith('task.')) {
    const id = agentId.slice(5);
    const short = id.length > 6 ? id.slice(-6) : id;
    return { label: `Task ${short}`, accentHex: TASK_ACCENT };
  }
  return { label: agentId, accentHex: TASK_ACCENT };
}

function summaryFor(snap: AgentSnapshot): string {
  if (snap.task && snap.task.length > 0) return snap.task;
  if (snap.lastToken && snap.lastToken.length > 0) return snap.lastToken;
  return '—';
}

/** Parses an ISO timestamp; falls back to `now` so unknown timestamps push to the bottom. */
function parseIsoMs(iso: string | undefined, nowMs: number): number {
  if (!iso) return nowMs - RECENCY_CAP_SECONDS * 1000;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return nowMs - RECENCY_CAP_SECONDS * 1000;
  return ms;
}

/**
 * Build the ranked activity list for the navigator. Pure — same input always
 * produces the same output for a fixed `nowMs`.
 */
export function buildAgentActivity(
  agents: Record<string, AgentSnapshot>,
  nowMs: number = Date.now(),
): AgentActivityEntry[] {
  const out: AgentActivityEntry[] = [];

  for (const [agentId, snap] of Object.entries(agents)) {
    if (!snap) continue;
    const weight = STATE_WEIGHT[snap.state] ?? 0;
    const updatedMs = parseIsoMs(snap.updatedAt, nowMs);
    const recencySec = Math.min(
      RECENCY_CAP_SECONDS,
      Math.max(0, (nowMs - updatedMs) / 1000),
    );
    const rank = -weight * 60 + recencySec;
    const { label, accentHex } = resolveLabelAndAccent(agentId);
    out.push({
      agentId,
      rank,
      state: snap.state,
      summary: summaryFor(snap),
      lastSeen: snap.updatedAt ?? new Date(updatedMs).toISOString(),
      label,
      accentHex,
    });
  }

  out.sort((a, b) => a.rank - b.rank);
  return out.slice(0, 12);
}

/** Human-friendly relative time: "2s ago", "3m ago", "1h ago". */
export function relativeTime(iso: string, nowMs: number = Date.now()): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '—';
  const deltaSec = Math.max(0, Math.round((nowMs - ms) / 1000));
  if (deltaSec < 60) return `${deltaSec}s ago`;
  const deltaMin = Math.round(deltaSec / 60);
  if (deltaMin < 60) return `${deltaMin}m ago`;
  const deltaHr = Math.round(deltaMin / 60);
  if (deltaHr < 24) return `${deltaHr}h ago`;
  const deltaDay = Math.round(deltaHr / 24);
  return `${deltaDay}d ago`;
}
