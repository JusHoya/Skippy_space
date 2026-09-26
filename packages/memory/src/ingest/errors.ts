// ingest/errors.ts — explicit, visible ingest-failure reporting (FR-WIKI-03).
//
// "Unsupported formats stay intact with errors." An unsupported or
// mis-encoded drop is never read as UTF-8 and never deleted; instead we write
// a sidecar `<original>.ingest-error.json` next to it in `00_Inbox/` so the
// failure is visible on disk (the watcher/UI can surface it, a human browsing
// the inbox sees it immediately) without touching the original bytes.
// `vault-watcher.ts` ignores `*.ingest-error.json` so the sidecar itself is
// never re-enqueued.
//
// E3-2 (containment): the sidecar's path is derived from the untrusted
// `sourcePath`, so writing it goes through the same real (junction/symlink
// resolved) containment proof every other vault write does, rechecked
// immediately before the write — never a raw `writeFileAtomic` on an
// unvalidated path.
//
// E4-2/E4-7: every record carries the dropped content's sha256, so a retrying
// watcher can tell "this exact content already failed, don't loop" apart from
// "the file changed since the last failure, retry it".

import { promises as fs } from 'node:fs';

import writeFileAtomic from 'write-file-atomic';

import { ensureContainedParentDir, recheckContained } from '../vault-path.js';
import { resolveInsideVault } from './containment.js';
import { sha256Hex } from './originals.js';

export const INGEST_ERROR_SUFFIX = '.ingest-error.json';

export interface IngestErrorRecord {
  sourcePath: string;
  reason:
    | 'unsupported-format'
    | 'invalid-encoding'
    | 'integrity-check-failed'
    | 'wikilink-violation'
    | 'unexpected-failure';
  detail: string;
  extension: string;
  at: string; // ISO timestamp
  /** sha256 (hex) of the dropped content this failure applies to (E4-2/E4-7). */
  contentSha256?: string;
}

/** Sidecar path for a given inbox drop. */
export function ingestErrorPath(sourcePath: string): string {
  return `${sourcePath}${INGEST_ERROR_SUFFIX}`;
}

/**
 * Write (or overwrite) the sidecar error record for `sourcePath`. Never
 * touches the original. `vaultRoot` is required so the sidecar's target is
 * proven to lie inside the real vault (E3-2) before it is written.
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
  const cp = await resolveInsideVault(vaultRoot, ingestErrorPath(sourcePath), {
    allowNonFileTarget: false,
  });
  await ensureContainedParentDir(cp);
  await recheckContained(cp);
  await writeFileAtomic(cp.abs, JSON.stringify(record, null, 2));
  return cp.abs;
}

/**
 * Convenience for a watcher-level unsupported-format report (E4-5): hashes
 * the drop's current bytes and writes the sidecar. Used by the agent-runtime
 * wiring so an unsupported drop in production gets the same explicit,
 * on-disk error record `runIngest` itself would have written, not just a
 * console warning.
 */
export async function recordUnsupported(
  vaultRoot: string,
  sourcePath: string,
  ext: string,
): Promise<string> {
  let hash: string | undefined;
  try {
    const bytes = await fs.readFile(sourcePath);
    hash = sha256Hex(bytes);
  } catch {
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

/** Read back a sidecar error record, or `null` if none exists / it's unparseable. */
export async function readIngestError(
  vaultRoot: string,
  sourcePath: string,
): Promise<IngestErrorRecord | null> {
  try {
    const cp = await resolveInsideVault(vaultRoot, ingestErrorPath(sourcePath));
    if (!cp.exists) return null;
    const raw = await fs.readFile(cp.abs, 'utf8');
    return JSON.parse(raw) as IngestErrorRecord;
  } catch {
    return null;
  }
}
