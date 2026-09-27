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

import { atomicWriteContained } from '../safe-write.js';
import {
  VaultPathError,
  ensureContainedParentDir,
  resolveContained,
  type ContainedPath,
} from '../vault-path.js';
import { EXTRACTORS } from './extractors.js';

// E3-2 (containment): every write below resolves its target through
// `resolveContained` (the same real, junction/symlink-resolved proof the note
// broker uses, with NO hidden segments allowed) and writes it with
// `atomicWriteContained` (safe-write.ts: random O_EXCL temp file, fsync,
// containment recheck, rename, single-link check), so a junction planted at
// `60_Sources/`, `60_Sources/originals/`, or the store file itself cannot
// redirect a "vault write" outside the vault, and a hardlink planted at a
// predictable temp name cannot either (N3; write-file-atomic's temp names were
// predictable and opened with 'w'). Reads go through a single-link
// regular-file handle, so a hardlinked store entry or marker is never trusted.

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

const HASH_RE = /^[0-9a-f]{64}$/;

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
 * Read a contained file through a handle that must be a single-link regular
 * file (never a hardlink alias of something outside the vault).
 */
async function readContainedFile(cp: ContainedPath, maxBytes?: number): Promise<Buffer> {
  const handle = await fs.open(cp.abs, 'r');
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new VaultPathError('target_not_file', cp.rel);
    if (st.nlink > 1) throw new VaultPathError('hardlinked_target', cp.rel, `${st.nlink} hard links`);
    if (maxBytes !== undefined && st.size > maxBytes) {
      throw new VaultPathError('too_long', cp.rel, `${st.size} bytes exceeds ${maxBytes}`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/**
 * Create `60_Sources/originals/` safely (validated real containment, never a
 * blind `mkdir -p` through an unchecked ancestor) and return its REAL absolute
 * path. Used to seat the per-hash ingest lock file (E4-3) alongside the store.
 */
export async function ensureOriginalsDir(vaultRoot: string): Promise<string> {
  // Resolve a target ONE LEVEL under `originals/` (never actually written) so
  // `ensureContainedParentDir` — which creates the TARGET's missing parents,
  // re-proving containment after each level — creates `60_Sources/` and
  // `60_Sources/originals/` themselves, level by level. The anchor name is not
  // hidden, so no hidden segment is ever allowed on this path.
  const cp = await resolveContained(vaultRoot, '60_Sources/originals/lock-anchor', {
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

async function writeVerified(cp: ContainedPath, buf: Buffer, hash: string): Promise<string> {
  await atomicWriteContained(cp, buf);
  const written = await readContainedFile(cp);
  const writtenHash = sha256Hex(written);
  if (writtenHash !== hash) throw new OriginalIntegrityError(cp.abs, hash, writtenHash);
  return cp.abs;
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
    const existing = await readContainedFile(cp);
    const existingHash = sha256Hex(existing);
    if (existingHash !== hash) {
      throw new OriginalIntegrityError(cp.abs, hash, existingHash);
    }
    return { hash, storePath: cp.abs };
  }

  // No lock here: originals are content-addressed and idempotent; the per-hash
  // lock in jobs/ingest.ts serializes concurrent ingests of the same content.
  // The temp+rename writer means a crash mid-copy never leaves a half-written
  // file at the content-addressed path.
  return { hash, storePath: await writeVerified(cp, buf, hash) };
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
  return { hash, storePath: await writeVerified(cp, buf, hash) };
}

/**
 * Whether the stored original for `hash`/`ext` exists and hashes to `hash`.
 * Throws `VaultPathError` if the store path is not safely contained (a
 * junction, a hardlink): the caller must then fail closed, never "repair"
 * through it or delete the inbox copy.
 */
export async function storedOriginalIsIntact(vaultRoot: string, hash: string, ext: string): Promise<boolean> {
  const cp = await resolveContained(vaultRoot, originalStoreRelPath(hash, ext));
  if (!cp.exists) return false;
  try {
    return sha256Hex(await readContainedFile(cp)) === hash;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Read a hash's completion marker, or `null` if absent, unparseable or
 * structurally invalid (N7): the recorded `hash` must equal the hash in the
 * marker's own file name and `ext` must be a declared extractor extension.
 * (The caller also verifies `sourceNotePath` against the vault; see
 * jobs/ingest.ts.)
 */
export async function readMarker(vaultRoot: string, hash: string): Promise<NoteMarker | null> {
  if (!HASH_RE.test(hash)) return null;
  try {
    const cp = await resolveContained(vaultRoot, markerRelPath(hash));
    if (!cp.exists) return null;
    const raw = (await readContainedFile(cp, 64 * 1024)).toString('utf8');
    const parsed = JSON.parse(raw) as Partial<NoteMarker> | null;
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      typeof parsed.sourceId === 'string' &&
      typeof parsed.sourceNotePath === 'string' &&
      parsed.hash === hash &&
      typeof parsed.ext === 'string' &&
      Object.prototype.hasOwnProperty.call(EXTRACTORS, parsed.ext)
    ) {
      return {
        sourceId: parsed.sourceId,
        sourceNotePath: parsed.sourceNotePath,
        hash: parsed.hash,
        ext: parsed.ext,
      };
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
 * Overwrites an invalid (e.g. forged) marker at the same path.
 */
export async function writeMarker(vaultRoot: string, marker: NoteMarker): Promise<void> {
  if (!HASH_RE.test(marker.hash)) throw new Error(`writeMarker: invalid hash ${JSON.stringify(marker.hash)}`);
  const cp = await resolveContained(vaultRoot, markerRelPath(marker.hash));
  await atomicWriteContained(cp, JSON.stringify(marker, null, 2));
}
