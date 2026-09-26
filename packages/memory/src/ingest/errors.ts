// ingest/errors.ts — explicit, visible ingest-failure reporting (FR-WIKI-03).
//
// "Unsupported formats stay intact with errors." An unsupported or
// mis-encoded drop is never read as UTF-8 and never deleted; instead we write
// a sidecar `<original>.ingest-error.json` next to it in `00_Inbox/` so the
// failure is visible on disk (the watcher/UI can surface it, a human browsing
// the inbox sees it immediately) without touching the original bytes.
// `vault-watcher.ts` ignores `*.ingest-error.json` so the sidecar itself is
// never re-enqueued.

import { promises as fs } from 'node:fs';

import writeFileAtomic from 'write-file-atomic';

export const INGEST_ERROR_SUFFIX = '.ingest-error.json';

export interface IngestErrorRecord {
  sourcePath: string;
  reason: 'unsupported-format' | 'invalid-encoding' | 'integrity-check-failed';
  detail: string;
  extension: string;
  at: string; // ISO timestamp
}

/** Sidecar path for a given inbox drop. */
export function ingestErrorPath(sourcePath: string): string {
  return `${sourcePath}${INGEST_ERROR_SUFFIX}`;
}

/** Write (or overwrite) the sidecar error record for `sourcePath`. Never touches the original. */
export async function writeIngestError(
  sourcePath: string,
  reason: IngestErrorRecord['reason'],
  detail: string,
  extension: string,
): Promise<string> {
  const record: IngestErrorRecord = {
    sourcePath,
    reason,
    detail,
    extension,
    at: new Date().toISOString(),
  };
  const p = ingestErrorPath(sourcePath);
  await writeFileAtomic(p, JSON.stringify(record, null, 2));
  return p;
}

/** Read back a sidecar error record, or `null` if none exists / it's unparseable. */
export async function readIngestError(sourcePath: string): Promise<IngestErrorRecord | null> {
  try {
    const raw = await fs.readFile(ingestErrorPath(sourcePath), 'utf8');
    return JSON.parse(raw) as IngestErrorRecord;
  } catch {
    return null;
  }
}
