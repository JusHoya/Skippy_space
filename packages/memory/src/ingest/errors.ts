// ingest/errors.ts — explicit, visible ingest-failure reporting (FR-WIKI-03).
//
// "Unsupported formats stay intact with errors." An unsupported, mis-encoded,
// oversized or path-rejected drop is never modified; instead we write a sidecar
// `<original>.ingest-error.json` next to it in `00_Inbox/` so the failure is
// visible on disk (the watcher/UI can surface it, a human browsing the inbox
// sees it immediately) without touching the original bytes.
// `vault-watcher.ts` never enqueues a `*.ingest-error.json`; it stays silent
// only about records that are PROVABLY ours (`isOwnIngestErrorSidecar`: `kind`
// marker, known reason, a location that matches the drop the record names,
// and a valid `mac`, an HMAC-SHA256 over the record's fields and its own
// location under the per-vault secret in `.skippy/ingest-sidecar.key`,
// ingest/sidecar-key.ts; M0 NFC/NFD round D3) and reports any other file with
// that suffix as `reserved-name` (M0 final #6). Content alone is forgeable, so
// a hand-written record neither counts as ours nor, through `readIngestError`,
// suppresses the retry of a drop. Records without a valid MAC (including ones
// written before this change) are reported once, never trusted.
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
// Exact names (PRD OQ-21; M0 case-fold round): the MAC's location, the
// "sits where the writer puts it" check and the fallback key all use the
// EXACT inbox-relative path (POSIX separators only), never a case fold, so
// two drops NTFS keeps distinct never share a record and a record copied to
// a look-alike name does not authenticate there.
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
import { macEqual, macHex, sidecarKey } from './sidecar-key.js';

export const INGEST_ERROR_SUFFIX = '.ingest-error.json';

/**
 * Ownership marker inside every record this module writes (M0 final #6). The
 * watcher treats a `*.ingest-error.json` as the pipeline's own artifact only if
 * its CONTENT proves it (`isOwnIngestErrorSidecar`), never by suffix alone.
 */
export const INGEST_ERROR_KIND = 'skippy.ingest-error';

export interface IngestErrorRecord {
  /** Ownership marker (absent in records written before M0 final #6). */
  kind?: typeof INGEST_ERROR_KIND;
  /** The drop's path relative to `00_Inbox/` (POSIX), when it is inside it. */
  inboxRel?: string;
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
  /** HMAC-SHA256 (hex) proving the pipeline wrote this record at this location (D3). */
  mac?: string;
}

/**
 * Location key of a sidecar inside the inbox: POSIX separators, otherwise the
 * EXACT code units (PRD OQ-21; M0 case-fold round, gap 2). Never case-folded:
 * JavaScript's `toLowerCase` folds pairs NTFS keeps distinct (U+212A KELVIN
 * SIGN and `K`, ...), so a folded key let a genuine record copied to
 * `Kelvin.xyz.ingest-error.json` authenticate for a different drop. The
 * watcher and `readIngestError` pass on-disk (or drop-derived) names, so the
 * exact key is what a genuine record is found under; a record copied or
 * renamed to any other exact path fails its MAC.
 */
function locationKey(inboxRel: string): string {
  return inboxRel.replace(/\\/g, '/');
}

/** The canonical MAC input: every field but `mac`, plus the sidecar's own location. */
function macInput(rec: IngestErrorRecord, sidecarInboxRel: string): string {
  return JSON.stringify([
    'skippy.ingest-error/v1',
    locationKey(sidecarInboxRel),
    rec.kind ?? null,
    rec.inboxRel ?? null,
    rec.sourcePath,
    rec.reason,
    rec.detail,
    rec.extension,
    rec.at,
    rec.contentSha256 ?? null,
  ]);
}

/** True iff `rec`, read from `sidecarAbs`, carries a valid MAC under this vault's key. */
async function hasValidMac(vaultRoot: string, sidecarAbs: string, rec: IngestErrorRecord): Promise<boolean> {
  if (typeof rec.mac !== 'string') return false;
  const sidecarRel = inboxRelPath(vaultRoot, sidecarAbs);
  if (sidecarRel === null) return false;
  if (typeof rec.detail !== 'string' || typeof rec.extension !== 'string' || typeof rec.at !== 'string') return false;
  let key: Buffer | null;
  try {
    key = await sidecarKey(vaultRoot, false);
  } catch {
    return false;
  }
  if (key === null) return false;
  return macEqual(rec.mac, macHex(key, macInput(rec, sidecarRel)));
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
  // Keyed on the EXACT inbox-relative path (POSIX separators), not its content
  // (a rejected drop is never read) and never case-folded: two drops NTFS
  // keeps distinct (`Kelvin.xyz` with U+212A vs `Kelvin.xyz`) must not share
  // one record (gap 3).
  const key = createHash('sha256').update(locationKey(rel)).digest('hex');
  return path.join(vaultRoot, INBOX_DIR, INGEST_ERRORS_DIR, `${key}${INGEST_ERROR_SUFFIX}`);
}

async function writeSidecarAt(
  vaultRoot: string,
  sidecarAbs: string,
  record: IngestErrorRecord,
  key: Buffer,
): Promise<string> {
  const t = await resolveInboxPath(vaultRoot, sidecarAbs);
  const sidecarRel = inboxRelPath(vaultRoot, sidecarAbs);
  if (sidecarRel === null) {
    throw new IngestSourceRejectedError('outside-inbox', sidecarAbs, 'no sidecar is written outside the inbox');
  }
  const json = JSON.stringify({ ...record, mac: macHex(key, macInput(record, sidecarRel)) }, null, 2);
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
  const inboxRel = inboxRelPath(vaultRoot, sourcePath);
  const record: IngestErrorRecord = {
    kind: INGEST_ERROR_KIND,
    ...(inboxRel !== null ? { inboxRel } : {}),
    sourcePath,
    reason,
    detail,
    extension,
    at: new Date().toISOString(),
    ...(contentSha256 ? { contentSha256 } : {}),
  };
  const fallback = fallbackIngestErrorPath(vaultRoot, sourcePath);
  if (fallback === null) {
    throw new IngestSourceRejectedError('outside-inbox', sourcePath, 'no sidecar is written outside the inbox');
  }
  // Fail closed (D3): without the vault's MAC key no record is written, since
  // an unauthenticated record would itself be reported as a foreign file.
  const key = await sidecarKey(vaultRoot, true);
  if (key === null) throw new Error('ingest sidecar key unavailable');
  try {
    return await writeSidecarAt(vaultRoot, ingestErrorPath(sourcePath), record, key);
  } catch (err) {
    try {
      return await writeSidecarAt(vaultRoot, fallback, record, key);
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

const RECORD_REASONS: ReadonlySet<string> = new Set([
  'unsupported-format',
  'invalid-encoding',
  'integrity-check-failed',
  'wikilink-violation',
  'unexpected-failure',
  'path-rejected',
  'reparse-point',
  'hardlinked',
  'not-a-file',
  'too-large',
  'read-error',
  'hidden',
  'reserved-name',
  'too-deep',
  'internal-folder',
]);

/** Exact (separator-normalized) inbox-relative path equality; see `locationKey`. */
function sameRel(a: string, b: string): boolean {
  return locationKey(a) === locationKey(b);
}

/**
 * True iff `sidecarAbs` is provably a record this pipeline wrote (M0 final #6):
 * it lies inside the real inbox, parses as an ingest-error record with a known
 * reason, carries the ownership marker, sits exactly where `writeIngestError`
 * puts the record for the drop it names (the natural `<drop>.ingest-error.json`,
 * or the `_ingest-errors/` fallback keyed on that drop), and carries a valid
 * `mac` for that location under this vault's key (D3). A user file that merely
 * has the suffix, or copies a record's shape, is not.
 */
export async function isOwnIngestErrorSidecar(vaultRoot: string, sidecarAbs: string): Promise<boolean> {
  let rec: IngestErrorRecord | null;
  try {
    rec = await readSidecarAt(vaultRoot, sidecarAbs);
  } catch {
    return false;
  }
  if (!rec || typeof rec.reason !== 'string' || !RECORD_REASONS.has(rec.reason) || typeof rec.at !== 'string') {
    return false;
  }
  if (rec.kind !== INGEST_ERROR_KIND) return false;
  const sidecarRel = inboxRelPath(vaultRoot, sidecarAbs);
  if (sidecarRel === null) return false;
  const dropRel = typeof rec.inboxRel === 'string' ? rec.inboxRel : inboxRelPath(vaultRoot, rec.sourcePath);
  if (dropRel === null) return false;
  let located = sameRel(sidecarRel, `${dropRel}${INGEST_ERROR_SUFFIX}`);
  if (!located) {
    const fallback = fallbackIngestErrorPath(vaultRoot, path.join(vaultRoot, INBOX_DIR, ...dropRel.split('/')));
    const fallbackRel = fallback === null ? null : inboxRelPath(vaultRoot, fallback);
    located = fallbackRel !== null && sameRel(sidecarRel, fallbackRel);
  }
  // D3: the shape and location are forgeable; the MAC is not.
  return located && (await hasValidMac(vaultRoot, sidecarAbs, rec));
}

/**
 * Read back the sidecar error record for `sourcePath` (natural path first,
 * then the `_ingest-errors/` fallback), or `null` if none exists, it is
 * unparseable, its path is not safely inside the inbox, or it is not provably
 * the pipeline's own record (valid `mac`, D3): a hand-written record never
 * stands in for a real failure (the watcher uses its `contentSha256` to skip
 * retries).
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
      if (rec && (await isOwnIngestErrorSidecar(vaultRoot, c))) return rec;
    } catch {
      // unsafe or unreadable candidate: try the next one
    }
  }
  return null;
}
