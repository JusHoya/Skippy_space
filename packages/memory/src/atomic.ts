// atomic.ts — the single audited write path into the Karpathy vault.
//
// Phase 3 (WS1). Replaces the Phase-0 stub. PRD §8.6:
//   - atomic writes via `write-file-atomic` (tmp + rename, Windows EPERM retry
//     handled inside the lib);
//   - per-file `proper-lockfile` for the contention path;
//   - `agent_log` + `daily` notes are append-only (separate code path);
//   - wikilinks only ([[note]]), never relative markdown links.
//
// Every job (ingest, distill, link, lint, Letta-mirror, replay) writes through
// here so no caller reinvents atomicity, locking, or the wikilink guard. The
// pre-existing `daily.ts` keeps its own (equivalent, already-shipped) in-house
// helpers; new code should use this module.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import writeFileAtomic from 'write-file-atomic';
import { lock } from 'proper-lockfile';

import { serializeNote, type NoteFrontmatterInput } from './frontmatter.js';

// ──────────────────────────────────────────────────────────────────────────────
// Wikilink guard (PRD §5 / §8.2 — wikilinks always, no relative md links)
// ──────────────────────────────────────────────────────────────────────────────

// Matches a markdown link whose target is a relative `.md` path, e.g.
// `](./foo.md)`, `](../bar.md#h)`, `](notes/baz.md)`. Permits absolute http(s)
// links (sources) and `[[wikilinks]]` (which aren't `](...)` syntax at all).
const RELATIVE_MD_LINK_RE = /\]\(\s*(?!https?:\/\/)[^)]*\.md(?:[)#?]|\s)/i;

export class WikilinkViolationError extends Error {
  constructor(target: string) {
    super(
      `Vault write to "${target}" contains a relative markdown link; use [[wikilinks]] only (PRD §8.2).`,
    );
    this.name = 'WikilinkViolationError';
  }
}

/** Throw if `body` contains a relative `.md` markdown link. */
export function assertNoRelativeMdLinks(body: string, target = '<note>'): void {
  if (RELATIVE_MD_LINK_RE.test(body)) throw new WikilinkViolationError(target);
}

// ──────────────────────────────────────────────────────────────────────────────
// Low-level primitives
// ──────────────────────────────────────────────────────────────────────────────

/** True if a path exists. */
async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run `fn` while holding an exclusive lock on `target`. The target need not
 * exist yet (realpath:false → the lock is keyed on the literal path). Retries a
 * few times with backoff; a 30s stale TTL reclaims locks left by a crashed
 * process. Throws `ELOCKED` if the lock cannot be acquired within the retries —
 * callers that prefer to skip-and-retry-next-cron should catch via `isLocked`.
 */
export async function withFileLock<T>(
  target: string,
  fn: () => Promise<T>,
): Promise<T> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const release = await lock(target, {
    realpath: false,
    stale: 30_000,
    retries: { retries: 5, factor: 2, minTimeout: 50, maxTimeout: 1000 },
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}

/** True if an error is a proper-lockfile "already locked" rejection. */
export function isLocked(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === 'ELOCKED'
  );
}

/**
 * Atomic write (tmp + rename). `write-file-atomic` handles fsync + the Windows
 * EPERM/EBUSY retry internally. Parent dir is created if missing. This is the
 * raw primitive — `writeNote` wraps it with locking + validation.
 */
export async function atomicWrite(target: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await writeFileAtomic(target, contents);
}

// ──────────────────────────────────────────────────────────────────────────────
// Note writers
// ──────────────────────────────────────────────────────────────────────────────

export type WriteResult =
  | { written: true; path: string }
  | { written: false; path: string; reason: 'locked' | 'exists' };

/**
 * Write a note (frontmatter + body) atomically under a per-file lock. Validates
 * §8.3 frontmatter and enforces the wikilink-only rule before any disk I/O.
 * Returns `{ written: false, reason: 'locked' }` on contention rather than
 * throwing, so a job can skip and retry on the next pass.
 */
export async function writeNote(
  target: string,
  frontmatter: NoteFrontmatterInput,
  body: string,
): Promise<WriteResult> {
  assertNoRelativeMdLinks(body, target);
  const contents = serializeNote(frontmatter, body); // throws on invalid fm
  try {
    await withFileLock(target, () => atomicWrite(target, contents));
    return { written: true, path: target };
  } catch (err) {
    if (isLocked(err)) return { written: false, path: target, reason: 'locked' };
    throw err;
  }
}

/**
 * Write a note only if it does not already exist (idempotent create). Used for
 * notes that must never be clobbered (append-only types created once). Re-checks
 * existence inside the lock to close the create-race.
 */
export async function writeNoteIfAbsent(
  target: string,
  frontmatter: NoteFrontmatterInput,
  body: string,
): Promise<WriteResult> {
  if (await exists(target)) return { written: false, path: target, reason: 'exists' };
  assertNoRelativeMdLinks(body, target);
  const contents = serializeNote(frontmatter, body);
  try {
    return await withFileLock(target, async () => {
      if (await exists(target)) {
        return { written: false, path: target, reason: 'exists' } as const;
      }
      await atomicWrite(target, contents);
      return { written: true, path: target } as const;
    });
  } catch (err) {
    if (isLocked(err)) return { written: false, path: target, reason: 'locked' };
    throw err;
  }
}

/**
 * Append a section to an append-only note (agent_log / daily). Never edits
 * existing content (PRD §8.5). Creates the file if absent. The appended text is
 * wikilink-guarded and a single trailing newline is normalized.
 */
export async function appendSection(target: string, text: string): Promise<WriteResult> {
  assertNoRelativeMdLinks(text, target);
  const chunk = `\n${text.replace(/\s+$/, '')}\n`;
  try {
    await withFileLock(target, async () => {
      await fs.appendFile(target, chunk, { encoding: 'utf8' });
    });
    return { written: true, path: target };
  } catch (err) {
    if (isLocked(err)) return { written: false, path: target, reason: 'locked' };
    throw err;
  }
}
