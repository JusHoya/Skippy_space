// ingest/originals.ts — content-addressed original preservation (FR-WIKI-03).
//
// "Preserve imported originals by content hash. ... Crashes cannot remove the
//  only source copy. Ingest is resumable/deduplicated."
//
// PRD §8.2 already names `60_Sources/` "immutable raw sources" but does not
// spell out a sub-layout for the *pre-extraction* binary/text originals
// (distinct from the derived, ULID-named source notes that already live
// directly under `60_Sources/`). Default (record as OQ-XX, nonblocking):
// store originals content-addressed under `60_Sources/originals/<sha256><ext>`
// — same immutable-raw-sources folder, a subdirectory so ULID note files and
// hash-named originals never collide. A `<sha256>.note.json` marker sits
// alongside each original and is written ONLY after its derived note has been
// durably written; its presence is the crash-safe "ingestion of this content
// is fully committed" signal that both dedup and resume key off.

import { promises as fs } from 'node:fs';
import * as crypto from 'node:crypto';
import * as path from 'node:path';

import writeFileAtomic from 'write-file-atomic';

import { ensureContainedParentDir, recheckContained, resolveContained } from '../vault-path.js';

// NOTE: this module writes its own binary/JSON payloads directly via
// `write-file-atomic` (same tmp+rename primitive `atomic.ts` wraps for note
// text) rather than importing `atomic.ts`'s `atomicWrite`, which is typed for
// UTF-8 note bodies only and owned by the concurrent WS-D workstream.
//
// E3-2 (containment): every write below resolves its target through
// `resolveContained` (the same real, junction/symlink-resolved proof the note
// broker uses) and rechecks it immediately before the write, so a junction
// planted at `60_Sources/`, `60_Sources/originals/`, or the store file itself
// cannot redirect a "vault write" outside the vault.

/** `<vaultRoot>/60_Sources/originals` — the content-addressed original store. */
export function originalsDir(vaultRoot: string): string {
  return path.join(vaultRoot, '60_Sources', 'originals');
}

/** SHA-256 of a buffer, lowercase hex. */
export function sha256Hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export interface NoteMarker {
  sourceId: string;
  sourceNotePath: string;
  hash: string;
  ext: string;
}

/** Absolute path to the original's content-addressed copy (informational; not a trust boundary). */
export function originalStorePath(vaultRoot: string, hash: string, ext: string): string {
  return path.join(originalsDir(vaultRoot), `${hash}${ext}`);
}

/** Absolute path to the hash's completion marker (informational; not a trust boundary). */
export function markerPath(vaultRoot: string, hash: string): string {
  return path.join(originalsDir(vaultRoot), `${hash}.note.json`);
}

/** Vault-relative path (POSIX form) of the original's content-addressed copy. */
function originalStoreRelPath(hash: string, ext: string): string {
  return `60_Sources/originals/${hash}${ext}`;
}

/** Vault-relative path (POSIX form) of the hash's completion marker. */
function markerRelPath(hash: string): string {
  return `60_Sources/originals/${hash}.note.json`;
}

/**
 * Create `60_Sources/originals/` safely (validated real containment, never a
 * blind `mkdir -p` through an unchecked ancestor) and return its absolute
 * path. Used to seat the per-hash ingest lock file (E4-3) alongside the store.
 */
export async function ensureOriginalsDir(vaultRoot: string): Promise<string> {
  // Resolve a target ONE LEVEL under `originals/` (never actually written) so
  // `ensureContainedParentDir` — which creates the TARGET's missing parents,
  // re-proving containment after each level — creates `60_Sources/` and
  // `60_Sources/originals/` themselves, level by level, with no blind
  // `mkdir -p` through an unchecked ancestor.
  const cp = await resolveContained(vaultRoot, '60_Sources/originals/.lock-anchor', {
    allowHidden: true,
    allowNonFileTarget: true,
  });
  return ensureContainedParentDir(cp);
}

export class OriginalIntegrityError extends Error {
  constructor(target: string, expected: string, actual: string) {
    super(
      `original preservation integrity check failed for ${target}: expected sha256 ${expected}, got ${actual}`,
    );
    this.name = 'OriginalIntegrityError';
  }
}

/**
 * Copy `buf` (the original's exact bytes) into the content-addressed store,
 * verifying the on-disk copy hashes to `hash` before returning. Idempotent: if
 * a copy already exists at the destination it is re-hashed and reused rather
 * than overwritten (a previous run may have completed this step before a
 * crash) — a mismatch is a genuine integrity fault and throws rather than
 * silently clobbering a possibly-referenced original.
 */
export async function preserveOriginal(
  vaultRoot: string,
  buf: Buffer,
  ext: string,
): Promise<{ hash: string; storePath: string }> {
  const hash = sha256Hex(buf);
  const cp = await resolveContained(vaultRoot, originalStoreRelPath(hash, ext));

  if (cp.exists) {
    const existing = await fs.readFile(cp.abs);
    const existingHash = sha256Hex(existing);
    if (existingHash !== hash) {
      throw new OriginalIntegrityError(cp.abs, hash, existingHash);
    }
    return { hash, storePath: cp.abs };
  }

  // Safe directory creation: `ensureContainedParentDir` creates any missing
  // parent levels one at a time, re-proving containment after each (never a
  // blind `mkdir -p` through an unchecked ancestor), then we recheck the
  // target itself once more (no lock here: originals are content-addressed
  // and idempotent; the per-hash lock in jobs/ingest.ts serializes concurrent
  // ingests of the same content) right before the write.
  await ensureContainedParentDir(cp);
  await recheckContained(cp);
  // tmp + rename (same primitive `atomic.ts` uses elsewhere) so a crash
  // mid-copy never leaves a half-written file at the content-addressed path.
  await writeFileAtomic(cp.abs, buf);

  const written = await fs.readFile(cp.abs);
  const writtenHash = sha256Hex(written);
  if (writtenHash !== hash) {
    throw new OriginalIntegrityError(cp.abs, hash, writtenHash);
  }
  return { hash, storePath: cp.abs };
}

/**
 * Unconditionally (re)write the content-addressed store entry for `buf`,
 * even if a DIFFERENT (corrupted) copy already sits at that path (E4-1).
 * Unlike `preserveOriginal` — which trusts an existing copy that hashes
 * correctly and THROWS rather than silently clobber one that doesn't — this
 * is for the one caller (the dedup repair path in jobs/ingest.ts) that has
 * already independently verified `buf` against a durable, hash-committed
 * marker and is explicitly repairing a proven-corrupt or missing store
 * entry, not trusting an unverified write.
 */
export async function repairOriginal(
  vaultRoot: string,
  buf: Buffer,
  ext: string,
): Promise<{ hash: string; storePath: string }> {
  const hash = sha256Hex(buf);
  const cp = await resolveContained(vaultRoot, originalStoreRelPath(hash, ext));
  await ensureContainedParentDir(cp);
  await recheckContained(cp);
  await writeFileAtomic(cp.abs, buf);
  const written = await fs.readFile(cp.abs);
  const writtenHash = sha256Hex(written);
  if (writtenHash !== hash) {
    throw new OriginalIntegrityError(cp.abs, hash, writtenHash);
  }
  return { hash, storePath: cp.abs };
}

/** Read a hash's completion marker, or `null` if absent/unparseable. */
export async function readMarker(vaultRoot: string, hash: string): Promise<NoteMarker | null> {
  try {
    const cp = await resolveContained(vaultRoot, markerRelPath(hash));
    if (!cp.exists) return null;
    const raw = await fs.readFile(cp.abs, 'utf8');
    const parsed = JSON.parse(raw) as Partial<NoteMarker>;
    if (
      typeof parsed.sourceId === 'string' &&
      typeof parsed.sourceNotePath === 'string' &&
      typeof parsed.hash === 'string' &&
      typeof parsed.ext === 'string'
    ) {
      return parsed as NoteMarker;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Write the completion marker. MUST be called only after the derived note is
 * durably written — its existence is the signal that ingestion for `hash` is
 * finished (source copy preserved + note written), which is what lets a
 * re-drop of the same content, or a resumed run, skip straight to cleanup.
 */
export async function writeMarker(vaultRoot: string, marker: NoteMarker): Promise<void> {
  const cp = await resolveContained(vaultRoot, markerRelPath(marker.hash));
  await ensureContainedParentDir(cp);
  await recheckContained(cp);
  await writeFileAtomic(cp.abs, JSON.stringify(marker, null, 2));
}
