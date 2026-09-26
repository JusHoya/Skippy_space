// Daily auto-note generator for the Karpathy vault (PRD §8.2, §8.4, §8.5, §8.6).
//
// Writes `{vaultRoot}/40_Daily/YYYY-MM-DD.md` with the canonical daily template.
// Idempotent: if the file already exists, returns `{ created: false }` and does
// NOT touch the file (daily notes are append-only, FR-WIKI-02).
//
// M0 WS-D: the in-house tmp+rename writer and O_EXCL lock sentinel are gone. The
// note is created through the vault broker (`createNote`), which proves the path
// is contained in the vault, holds a proper-lockfile lock across the existence
// check and the write-file-atomic replace, and never overwrites an existing note.
// Later additions to a daily note go through `VaultBroker.appendNote`.

import * as path from 'node:path';
import { ulid } from 'ulid';

import { VaultBroker } from './vault-broker.js';

const BOARDS = [
  'engineering',
  'coding',
  'design',
  'marketing',
  'finance',
  'research',
  'publishing',
  'devops',
] as const;

export interface GenerateDailyNoteOptions {
  /** Date the note is for. Local-time YYYY-MM-DD is used in the filename. */
  date: Date;
  /** Absolute path to the vault root (the folder containing `40_Daily/`). */
  vaultRoot: string;
}

export interface GenerateDailyNoteResult {
  /** Absolute path to the daily note (created or pre-existing). */
  path: string;
  /** True if this call created the file. False if it already existed. */
  created: boolean;
}

/** YYYY-MM-DD in local time. */
function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** ISO-8601 timestamp at the start of the local-time day, in UTC. */
function isoForDate(date: Date): string {
  // Snap to midnight UTC for the note's logical timestamp. The whole-day
  // semantics matches the file naming better than the call-time instant.
  const utc = new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0),
  );
  return utc.toISOString();
}

/** Vault-relative path of the daily note for `date`. */
export function dailyNoteRelPath(date: Date): string {
  return `40_Daily/${formatDate(date)}.md`;
}

export function dailyNotePath(vaultRoot: string, date: Date): string {
  return path.join(vaultRoot, '40_Daily', `${formatDate(date)}.md`);
}

function dailyFrontmatter(date: Date, id: string): Record<string, unknown> {
  const ymd = formatDate(date);
  const iso = isoForDate(date);
  return {
    id,
    title: `Daily — ${ymd}`,
    created_at: iso,
    updated_at: iso,
    type: 'daily',
    status: 'active',
    tags: ['daily'],
    source: 'gen://skippy.staff.memory_manager',
    authored_by: 'skippy.staff.memory_manager',
    confidence: 1.0,
    distilled_from: [],
    supersedes: null,
    contradicts: [],
  };
}

function renderDailyBody(date: Date): string {
  const ymd = formatDate(date);
  const boardList = BOARDS.map((b) => `- [[board-${b}]]`).join('\n');
  return `
# ${ymd}

## Active boards
${boardList}

## Skippy's standing orders
(empty — agents append below)

## Activity
(empty — \`agent_log\`-style appends)

## Notes
(human freeform)
`;
}

/**
 * Generate the daily auto-note for `date` under `{vaultRoot}/40_Daily/`.
 * Idempotent: returns `{ created: false }` if the note already exists or another
 * writer holds its lock (it is creating the same note).
 */
export async function generateDailyNote(
  opts: GenerateDailyNoteOptions,
): Promise<GenerateDailyNoteResult> {
  const finalPath = dailyNotePath(opts.vaultRoot, opts.date);
  const broker = new VaultBroker(opts.vaultRoot);
  const res = await broker.createNote(
    dailyNoteRelPath(opts.date),
    dailyFrontmatter(opts.date, ulid()),
    renderDailyBody(opts.date),
  );
  if (res.ok) return { path: finalPath, created: true };
  // 'exists' or 'locked': someone already has (or is creating) today's note.
  return { path: finalPath, created: false };
}
