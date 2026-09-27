// ingest/errors.ts — explicit, visible ingest-failure reporting (FR-WIKI-03).
//
// "Unsupported formats stay intact with errors." An unsupported, mis-encoded,
// oversized or path-rejected drop is never modified; instead we write a sidecar
// `<original>.ingest-error.json` next to it in `00_Inbox/` so the failure is
// visible on disk (the watcher/UI can surface it, a human browsing the inbox
// sees it immediately) without touching the original bytes.
// `vault-watcher.ts` ignores `*.ingest-error.json` so the sidecar itself is
// never re-enqueued.
//
// Containment (E3-2, round-2 N1): the sidecar's path is derived from the
// untrusted `sourcePath`, so it must satisfy the same strict inbox rules as an
// ingest source (ingest/containment.ts): inside the REAL `00_Inbox/`, no hidden
// or 8.3 segments, no reparse point between the inbox and the sidecar, and an
// existing sidecar must be a single-link regular file. When the natural
// sidecar path fails those rules (e.g. the drop's directory is a junction into
// `.git`, or its name is `Report~1.md`), the record goes to
// `00_Inbox/_ingest-errors/<sha256 of the drop's inbox-relative path>.ingest-error.json`
// instead (N6). Paths outside the inbox never get a sidecar. Writes use
// `atomicWriteContained` (safe-write.ts), never write-file-atomic (N3).
//
// E4-2/E4-7: every record carries the dropped content's sha256 when it was
// read, so a retrying watcher can tell "this exact content already failed,
// don't loop" apart from "the file changed since the last failure, retry it".

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { atomicWriteContained } from '../safe-write.js';
import { ensureContainedParentDir, cmpKey } from '../vault-path.js';
import {
  INBOX_DIR,
  INGEST_ERRORS_DIR,
  IngestSourceRejectedError,
  inboxRelPath,
  readInboxFile,
  resolveInboxPath,
  type IngestRejectReason,
} from './containment.js';
import { sha256Hex } from './originals.js';

export const INGEST_ERROR_SUFFIX = '.ingest-error.json';

export interface IngestErrorRecord {
  sourcePath: string;
  reason:
    | 'unsupported-format'
    | 'invalid-encoding'
    | 'integrity-check-failed'
    | 'wikilink-violation'
    | 'unexpected-failure'
    | Exclude<IngestRejectReason, 'outside-inbox'>;
  detail: string;
  extension: string;
  at: string; // ISO timestamp
  /** sha256 (hex) of the dropped content this failure applies to (E4-2/E4-7). */
  contentSha256?: string;
}

/** Natural sidecar path for a given inbox drop. */
export function ingestErrorPath(sourcePath: string): string {
  return `${sourcePath}${INGEST_ERROR_SUFFIX}`;
}

/**
 * Fallback sidecar path for a drop whose natural sidecar path is unsafe:
 * `<vault>/00_Inbox/_ingest-errors/<sha256(inbox-relative path)>.ingest-error.json`.
 * Returns null for a path outside the inbox.
 */
export function fallbackIngestErrorPath(vaultRoot: string, sourcePath: string): string | null {
  const rel = inboxRelPath(vaultRoot, sourcePath);
  if (rel === null) return null;
  // Keyed on the inbox-relative path (case-folded on NTFS), not its content:
  // a rejected drop is never read.
  const norm = process.platform === 'win32' ? rel.toLowerCase() : rel;
  const key = createHash('sha256').update(norm).digest('hex');
  return path.join(vaultRoot, INBOX_DIR, INGEST_ERRORS_DIR, `${key}${INGEST_ERROR_SUFFIX}`);
}

async function writeSidecarAt(vaultRoot: string, sidecarAbs: string, json: string): Promise<string> {
  const t = await resolveInboxPath(vaultRoot, sidecarAbs);
  const realParent = await ensureContainedParentDir(t.cp);
  // The (possibly just created) parent chain must still be reparse-free.
  const expectedParent = path.dirname(t.cp.abs);
  if (cmpKey(realParent) !== cmpKey(expectedParent)) {
    throw new IngestSourceRejectedError('reparse-point', sidecarAbs, `${expectedParent} resolves to ${realParent}`);
  }
  await resolveInboxPath(vaultRoot, sidecarAbs);
  await atomicWriteContained(t.cp, json, { target: path.join(realParent, path.basename(t.cp.abs)) });
  return t.cp.abs;
}

/**
 * Write (or overwrite) the sidecar error record for `sourcePath`. Never
 * touches the original. Tries the natural sidecar path, then the
 * `_ingest-errors/` fallback; throws if neither is safely writable or the drop
 * is not inside the inbox. Returns the sidecar's absolute path.
 */
export async function writeIngestError(
  vaultRoot: string,
  sourcePath: string,
  reason: IngestErrorRecord['reason'],
  detail: string,
  extension: string,
  contentSha256?: string,
): Promise<string> {
  const record: IngestErrorRecord = {
    sourcePath,
    reason,
    detail,
    extension,
    at: new Date().toISOString(),
    ...(contentSha256 ? { contentSha256 } : {}),
  };
  const json = JSON.stringify(record, null, 2);
  const fallback = fallbackIngestErrorPath(vaultRoot, sourcePath);
  if (fallback === null) {
    throw new IngestSourceRejectedError('outside-inbox', sourcePath, 'no sidecar is written outside the inbox');
  }
  try {
    return await writeSidecarAt(vaultRoot, ingestErrorPath(sourcePath), json);
  } catch (err) {
    try {
      return await writeSidecarAt(vaultRoot, fallback, json);
    } catch (err2) {
      throw new AggregateError([err, err2], `could not write an ingest-error sidecar for ${sourcePath}`);
    }
  }
}

/**
 * Record a rejected inbox drop (path rules, reparse point, hardlink, size,
 * read error) with a sidecar. Never reads or modifies the drop. Used by the
 * agent-runtime for the watcher's `onRejected` report (N6).
 */
export async function recordIngestRejection(
  vaultRoot: string,
  sourcePath: string,
  reason: IngestRejectReason,
  detail: string,
): Promise<string> {
  const rec: IngestErrorRecord['reason'] = reason === 'outside-inbox' ? 'path-rejected' : reason;
  const ext = (/\.[^./\\]+$/.exec(sourcePath)?.[0] ?? '').toLowerCase();
  return writeIngestError(vaultRoot, sourcePath, rec, detail, ext);
}

/**
 * Convenience for a watcher-level unsupported-format report (E4-5): hashes
 * the drop's current bytes (strict inbox read, size-capped) and writes the
 * sidecar. A drop the strict read rejects is recorded as that rejection.
 */
export async function recordUnsupported(
  vaultRoot: string,
  sourcePath: string,
  ext: string,
): Promise<string> {
  let hash: string | undefined;
  try {
    const { bytes } = await readInboxFile(vaultRoot, sourcePath);
    hash = sha256Hex(bytes);
  } catch (err) {
    if (err instanceof IngestSourceRejectedError) {
      return recordIngestRejection(vaultRoot, sourcePath, err.reason, err.message);
    }
    hash = undefined;
  }
  return writeIngestError(
    vaultRoot,
    sourcePath,
    'unsupported-format',
    `no declared extractor for extension "${ext}"`,
    ext,
    hash,
  );
}

async function readSidecarAt(vaultRoot: string, sidecarAbs: string): Promise<IngestErrorRecord | null> {
  const t = await resolveInboxPath(vaultRoot, sidecarAbs);
  if (!t.exists) return null;
  const handle = await fs.open(t.cp.abs, 'r');
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.nlink !== 1 || st.size > 1024 * 1024) return null;
    const raw = await handle.readFile('utf8');
    const rec = JSON.parse(raw) as IngestErrorRecord | null;
    return rec && typeof rec === 'object' && typeof rec.sourcePath === 'string' ? rec : null;
  } finally {
    await handle.close();
  }
}

/**
 * Read back the sidecar error record for `sourcePath` (natural path first,
 * then the `_ingest-errors/` fallback), or `null` if none exists, it is
 * unparseable, or its path is not safely inside the inbox.
 */
export async function readIngestError(
  vaultRoot: string,
  sourcePath: string,
): Promise<IngestErrorRecord | null> {
  const candidates = [ingestErrorPath(sourcePath), fallbackIngestErrorPath(vaultRoot, sourcePath)];
  for (const c of candidates) {
    if (c === null) continue;
    try {
      const rec = await readSidecarAt(vaultRoot, c);
      if (rec) return rec;
    } catch {
      // unsafe or unreadable candidate: try the next one
    }
  }
  return null;
}
