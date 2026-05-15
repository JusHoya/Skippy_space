// Daily auto-note generator for the Karpathy vault (PRD §8.2, §8.4, §8.5, §8.6).
//
// Writes `{vaultRoot}/40_Daily/YYYY-MM-DD.md` with the canonical daily template.
// Idempotent: if the file already exists, returns `{ created: false }` and does
// NOT touch the file (daily notes are append-only per PRD §8.5).
//
// Atomic-write pattern: write the body to `<final>.<pid>.<rand>.tmp`, then
// `fs.rename()` into place. `rename` is atomic on the same filesystem on both
// NTFS and POSIX. We additionally guard against the create-race by using
// `O_CREAT | O_EXCL` for a lock sentinel (proper-lockfile equivalent) — only
// one process can hold the lock at a time, others bail with `created: false`.
//
// Phase 3 will swap the in-house atomic + lock for `write-file-atomic` +
// `proper-lockfile` per PRD §11.2; the public surface here will stay stable.

import { promises as fs, constants as fsConstants } from 'node:fs';
import * as path from 'node:path';
import { ulid } from 'ulid';

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

export function dailyNotePath(vaultRoot: string, date: Date): string {
  return path.join(vaultRoot, '40_Daily', `${formatDate(date)}.md`);
}

function renderDailyBody(date: Date, id: string): string {
  const ymd = formatDate(date);
  const iso = isoForDate(date);
  const boardList = BOARDS.map((b) => `- [[board-${b}]]`).join('\n');
  return `---
id: ${id}
title: "Daily — ${ymd}"
created_at: ${iso}
updated_at: ${iso}
type: daily
status: active
tags: [daily]
source: gen://skippy.staff.memory_manager
authored_by: skippy.staff.memory_manager
confidence: 1.0
distilled_from: []
supersedes: null
contradicts: []
---

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
 * Acquire an exclusive create-lock by opening `<final>.lock` with O_CREAT|O_EXCL.
 * Returns the file handle (caller must close + unlink) or null if another process
 * holds the lock. Stale locks (>30s old) are reclaimed per PRD §8.6 TTL guidance.
 */
async function acquireLock(finalPath: string): Promise<{ release: () => Promise<void> } | null> {
  const lockPath = `${finalPath}.lock`;
  const LOCK_TTL_MS = 30_000;

  // Best-effort stale-lock reclaim.
  try {
    const st = await fs.stat(lockPath);
    if (Date.now() - st.mtimeMs > LOCK_TTL_MS) {
      await fs.unlink(lockPath).catch(() => {});
    }
  } catch {
    // No existing lock — proceed.
  }

  let handle;
  try {
    // 'wx' = O_CREAT | O_EXCL | O_WRONLY: fails with EEXIST if file exists.
    handle = await fs.open(lockPath, 'wx');
    await handle.writeFile(String(process.pid));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return null;
    throw err;
  }

  return {
    release: async () => {
      try {
        await handle.close();
      } catch {
        /* ignore */
      }
      await fs.unlink(lockPath).catch(() => {});
    },
  };
}

/** Atomic write with EPERM retry-with-backoff (Windows). */
async function atomicWrite(finalPath: string, body: string): Promise<void> {
  const dir = path.dirname(finalPath);
  const base = path.basename(finalPath);
  const tmpPath = path.join(
    dir,
    `.${base}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`,
  );
  await fs.writeFile(tmpPath, body, { encoding: 'utf8' });
  const maxAttempts = 5;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await fs.rename(tmpPath, finalPath);
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') break;
      // Windows transient lock — back off and retry.
      await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
    }
  }
  // Cleanup the orphan tmp.
  await fs.unlink(tmpPath).catch(() => {});
  throw lastErr;
}

/**
 * Generate the daily auto-note for `date` under `{vaultRoot}/40_Daily/`.
 * Idempotent: returns `{ created: false }` if the note already exists.
 */
export async function generateDailyNote(
  opts: GenerateDailyNoteOptions,
): Promise<GenerateDailyNoteResult> {
  const finalPath = dailyNotePath(opts.vaultRoot, opts.date);
  const dailyDir = path.dirname(finalPath);

  // Ensure parent exists.
  await fs.mkdir(dailyDir, { recursive: true });

  // Fast path: file already exists, skip without locking.
  try {
    await fs.access(finalPath, fsConstants.F_OK);
    return { path: finalPath, created: false };
  } catch {
    // Doesn't exist — proceed to locked create.
  }

  const lock = await acquireLock(finalPath);
  if (!lock) {
    // Another process holds the lock; assume it's creating the same file.
    return { path: finalPath, created: false };
  }

  try {
    // Re-check inside the lock to handle the lost-race case.
    try {
      await fs.access(finalPath, fsConstants.F_OK);
      return { path: finalPath, created: false };
    } catch {
      /* still missing — write it */
    }

    const body = renderDailyBody(opts.date, ulid());
    await atomicWrite(finalPath, body);
    return { path: finalPath, created: true };
  } finally {
    await lock.release();
  }
}
