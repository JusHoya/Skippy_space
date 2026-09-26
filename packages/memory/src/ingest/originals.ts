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

// NOTE: this module writes its own binary/JSON payloads directly via
// `write-file-atomic` (same tmp+rename primitive `atomic.ts` wraps for note
// text) rather than importing `atomic.ts`'s `atomicWrite`, which is typed for
// UTF-8 note bodies only and owned by the concurrent WS-D workstream.

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

/** Absolute path to the original's content-addressed copy. */
export function originalStorePath(vaultRoot: string, hash: string, ext: string): string {
  return path.join(originalsDir(vaultRoot), `${hash}${ext}`);
}

/** Absolute path to the hash's completion marker. */
export function markerPath(vaultRoot: string, hash: string): string {
  return path.join(originalsDir(vaultRoot), `${hash}.note.json`);
}

export class OriginalIntegrityError extends Error {
  constructor(target: string, expected: string, actual: string) {
    super(
      `original preservation integrity check failed for ${target}: expected sha256 ${expected}, got ${actual}`,
    );
    this.name = 'OriginalIntegrityError';
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
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
  const dest = originalStorePath(vaultRoot, hash, ext);

  if (await exists(dest)) {
    const existing = await fs.readFile(dest);
    const existingHash = sha256Hex(existing);
    if (existingHash !== hash) {
      throw new OriginalIntegrityError(dest, hash, existingHash);
    }
    return { hash, storePath: dest };
  }

  await fs.mkdir(path.dirname(dest), { recursive: true });
  // tmp + rename (same primitive `atomic.ts` uses elsewhere) so a crash
  // mid-copy never leaves a half-written file at the content-addressed path.
  await writeFileAtomic(dest, buf);

  const written = await fs.readFile(dest);
  const writtenHash = sha256Hex(written);
  if (writtenHash !== hash) {
    throw new OriginalIntegrityError(dest, hash, writtenHash);
  }
  return { hash, storePath: dest };
}

/** Read a hash's completion marker, or `null` if absent/unparseable. */
export async function readMarker(vaultRoot: string, hash: string): Promise<NoteMarker | null> {
  const p = markerPath(vaultRoot, hash);
  try {
    const raw = await fs.readFile(p, 'utf8');
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
  const p = markerPath(vaultRoot, marker.hash);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await writeFileAtomic(p, JSON.stringify(marker, null, 2));
}
