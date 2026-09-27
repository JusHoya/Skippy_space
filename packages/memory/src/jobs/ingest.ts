// jobs/ingest.ts — Job 1 of the four-job memory pipeline (PRD §8.5, FR-WIKI-03).
//
// Owner charter: agent_space/tasks/ingest.md (research.ingest). The LLM charter
// describes a smart normalizer that strips rendering cruft; THIS module is the
// deterministic, dependency-light runtime glue that the agent-runtime (or the
// e2e exit-criterion test) drives.
//
// FR-WIKI-03 (P0): "Preserve imported originals by content hash. Declare text
// encodings; PDF/binary extraction needs qualified extractors. Unsupported
// formats stay intact with errors. Derived text includes original reference,
// extractor version and offsets/pages where available. Crashes cannot remove
// the only source copy. Ingest is resumable/deduplicated."
//
// Crash-safe, containment-safe ordering (each step is safe to re-run; a crash
// at any point leaves at least one intact, contained copy of the content):
//
//   0. Prove `sourcePath` is an ingestable inbox file before reading it at all
//      (E3-2, N1, N6; ingest/containment.ts): lexically under `00_Inbox/`, real
//      path inside the REAL `00_Inbox/` with no junction/symlink in any segment,
//      no hidden/8.3/reserved segment, a single-link regular file of at most
//      MAX_INGEST_BYTES. Anything else is rejected with a sidecar (inside the
//      inbox) and never read, modified or deleted.
//   1. Read the raw bytes of the drop and hash them (sha256). The hash is
//      computed once, over the exact original bytes, and used for every
//      sidecar/store/marker path below (E4-8: no more re-deriving a possibly
//      different extension per call site).
//   2. Look up a DECLARED extractor by extension (`ingest/extractors.ts`). No
//      extractor -> write a sidecar `.ingest-error.json` (with the content
//      hash), throw, leave the original untouched.
//   3. Decode with that extractor (strict UTF-8 for M0's qualified formats,
//      NUL-byte and BOM aware). Decode failure -> sidecar error, throw,
//      original untouched.
//   4. Content-level policy check (wikilink-only rule) on the decoded text,
//      BEFORE anything is copied (E4-7) -> sidecar error, throw, original
//      untouched.
//   5. Acquire an exclusive per-content-hash lock (E4-3) so two concurrent
//      drops of identical bytes serialize rather than race into duplicate
//      notes. Everything from here to the `finally` release is inside it.
//   6. Dedup / resume-after-full-completion short circuit: if a VALID
//      completion MARKER exists for this hash (N7: its hash matches its file
//      name, its ext is a declared extractor, and its `sourceNotePath` is a
//      contained `60_Sources/` note, read via the broker, recording this
//      `source_sha256` and the marker's id; an invalid marker is ignored and
//      rewritten by the normal path) and its note still exists, verify
//      the STORED original itself still exists and hashes correctly (E4-1) —
//      repairing it from the (already-verified) inbox bytes if not — then
//      safely remove the inbox copy (E4-4/E3-2) and return.
//   7. Copy the raw bytes into the content-addressed original store
//      (`60_Sources/originals/<sha256><ext>`), verifying the on-disk copy's
//      hash. Idempotent and containment-checked (`ingest/originals.ts`).
//   8. Look for an existing `60_Sources/*.md` note whose frontmatter
//      `source_sha256` already matches this hash (a prior run may have
//      written the note but crashed before the marker). Reuse it if found;
//      otherwise mint a fresh ULID and write a new derived note with
//      provenance (`source_sha256`, original path, extractor name/version,
//      declared encoding) through the vault broker.
//   9. Write the completion marker — ONLY now is "ingest of this content" a
//      durably committed fact.
//  10. Safely remove the original from `00_Inbox/` (E3-2/E4-4: contained,
//      renamed to a stable temp name and re-hashed immediately before the
//      delete, so a concurrent writer to the same inbox path cannot race the
//      deletion of content that was never actually preserved).
//
// We never paraphrase the body (that's the distiller's job); we copy it
// verbatim into the source note. Provenance is preserved via
// `source: file://<basename>` plus `source_sha256`/`original_path`/
// `extractor_*`/`source_encoding`/`source_bom_stripped` passthrough fields
// (PRD §8.3 schema is `.passthrough()`).

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { ulid } from 'ulid';
import { lock } from 'proper-lockfile';

import { makeFrontmatter } from '../frontmatter.js';
import { VaultBroker } from '../vault-broker.js';
import { assertNoRelativeMdLinks } from '../atomic.js';
import { cmpKey } from '../vault-path.js';
import { getExtractor, InvalidEncodingError } from '../ingest/extractors.js';
import { INGEST_ERROR_SUFFIX, writeIngestError } from '../ingest/errors.js';
import {
  INGEST_ERRORS_DIR,
  IngestSourceRejectedError,
  MAX_INGEST_BYTES,
  inboxRelPath,
  readInboxFile,
  resolveInboxPath,
} from '../ingest/containment.js';
import {
  OriginalIntegrityError,
  ensureOriginalsDir,
  originalStorePath,
  preserveOriginal,
  readMarker,
  repairOriginal,
  sha256Hex,
  storedOriginalIsIntact,
  writeMarker,
  type NoteMarker,
} from '../ingest/originals.js';
import type { JobEvent } from './types.js';

export { IngestSourceRejectedError, MAX_INGEST_BYTES } from '../ingest/containment.js';

export interface RunIngestOptions {
  /** Absolute path to the vault root (folder containing `00_Inbox/`, `60_Sources/`). */
  vaultRoot: string;
  /** Absolute path to the raw drop under `00_Inbox/`. */
  sourcePath: string;
  /** Optional progress callback. */
  onJob?: (e: JobEvent) => void;
  /**
   * Test-only crash injection: throw immediately after the named step
   * completes, before the next durable step runs. Used by the regression
   * suite to prove ingest is crash-safe; never set in production.
   */
  crashAfter?: 'copy' | 'note';
  /**
   * Test-only race injection: awaited immediately before the inbox copy is
   * removed (after the original is fully preserved/normalized, but before
   * the final re-hash-then-delete). Used by the regression suite to prove a
   * concurrent writer that mutates the inbox file in this window is detected
   * and the deletion skipped (E4-4); never set in production.
   */
  onBeforeInboxRemoval?: () => Promise<void> | void;
}

export interface IngestResult {
  /** Absolute path to the normalized source note in `60_Sources/`. */
  sourceNotePath: string;
  /** ULID id of the source note (the distiller's `source:` reference). */
  sourceId: string;
  /** Title derived from the first `# heading` or the filename. */
  title: string;
  /** Normalized markdown body (verbatim copy of the drop). */
  body: string;
  /** sha256 (hex) of the original drop's exact bytes. */
  sourceSha256: string;
  /** Absolute path to the preserved original in the content-addressed store. */
  originalPath: string;
  /** True if this call short-circuited on an already-completed ingest of the same content. */
  deduplicated: boolean;
}

/** Thrown when a drop's extension has no declared extractor (FR-WIKI-03). */
export class UnsupportedFormatError extends Error {
  constructor(sourcePath: string, ext: string) {
    super(
      `ingest: no declared extractor for "${ext || '(no extension)'}" (${sourcePath}); ` +
        `original left intact, see the .ingest-error.json sidecar`,
    );
    this.name = 'UnsupportedFormatError';
  }
}

/** Derive a title: first markdown `# heading`, else the filename stem. */
export function deriveTitle(body: string, sourcePath: string): string {
  for (const line of body.split(/\r?\n/)) {
    const m = /^#\s+(.+?)\s*#*\s*$/.exec(line);
    if (m && m[1] && m[1].trim().length > 0) return m[1].trim();
  }
  // Fall back to the filename without extension.
  const base = path.basename(sourcePath);
  const stem = base.replace(/\.[^.]+$/, '');
  return stem.length > 0 ? stem : base;
}


/** A source note found by content hash, read through the broker. */
interface SourceNoteRef {
  sourceId: string;
  /** Absolute path beneath the caller's vault root (for reporting). */
  sourceNotePath: string;
  body: string;
}

const SOURCE_NOTE_REL_RE = /^60_Sources\/[^/]+\.md$/i;

/**
 * Read `60_Sources/<name>.md` through the broker (containment, no hidden or
 * 8.3 segments, single-link regular file) and return it iff its frontmatter
 * `source_sha256` is `hash` (and, when given, its `id` is `expectedId`).
 */
async function readSourceNote(
  vaultRoot: string,
  broker: VaultBroker,
  rel: string,
  hash: string,
  expectedId?: string,
): Promise<SourceNoteRef | null> {
  if (!SOURCE_NOTE_REL_RE.test(rel)) return null;
  const snap = await broker.readNote(rel);
  if (!snap) return null;
  if (snap.frontmatter['source_sha256'] !== hash) return null;
  const id = snap.frontmatter['id'];
  if (typeof id !== 'string' || id.length === 0) return null;
  if (expectedId !== undefined && id !== expectedId) return null;
  return { sourceId: id, sourceNotePath: path.join(vaultRoot, ...snap.path.split('/')), body: snap.body };
}

/**
 * Scan `60_Sources/*.md` for a note whose frontmatter `source_sha256` matches
 * `hash`. Every candidate is read through the broker (N7), so a hardlinked or
 * junction-reached "note" is never read.
 */
async function findNoteBySourceHash(
  vaultRoot: string,
  broker: VaultBroker,
  hash: string,
): Promise<SourceNoteRef | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(path.join(vaultRoot, '60_Sources'));
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith('.md')) continue;
    try {
      const found = await readSourceNote(vaultRoot, broker, `60_Sources/${entry}`, hash);
      if (found) return found;
    } catch {
      // Uncontained / hardlinked / unreadable candidate: never trusted.
    }
  }
  return null;
}

/**
 * Validate a completion marker against the vault (N7). `readMarker` already
 * checked that its `hash` equals the file-name hash and its `ext` is a
 * declared extractor extension. Here `sourceNotePath` must lexically be
 * `<vaultRoot>/60_Sources/<name>.md` and that note, read through the broker,
 * must carry `source_sha256 === hash` and `id === marker.sourceId`. Returns the
 * note, or a reason string for an invalid marker.
 */
async function validateMarker(
  vaultRoot: string,
  broker: VaultBroker,
  hash: string,
  marker: NoteMarker,
): Promise<SourceNoteRef | { invalid: string }> {
  const rel = path
    .relative(path.resolve(vaultRoot), path.resolve(vaultRoot, marker.sourceNotePath))
    .split(path.sep)
    .join('/');
  if (!SOURCE_NOTE_REL_RE.test(rel)) {
    return { invalid: `sourceNotePath ${JSON.stringify(marker.sourceNotePath)} is not a 60_Sources/ note` };
  }
  try {
    const note = await readSourceNote(vaultRoot, broker, rel, hash, marker.sourceId);
    return note ?? { invalid: `${rel} is missing or does not record source_sha256 ${hash} for ${marker.sourceId}` };
  } catch (err) {
    return { invalid: `${rel} cannot be read safely: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Rename the inbox drop to a hidden temp name inside the SAME (real, verified)
 * directory, re-hash it, and delete it ONLY if the bytes still match
 * `expectedHash` (E4-4). The rename freezes the file against a concurrent
 * writer between the hash check and the delete; a mismatch means someone
 * changed the file since it was preserved, so it is restored under its
 * original name instead of discarded, ready for the next watcher pass to
 * re-ingest. The drop must pass the strict inbox rules (ingest/containment.ts:
 * real path inside the real `00_Inbox/`, no reparse point in between,
 * single-link regular file) immediately before the rename, and the temp file
 * must still be a single-link regular file in that same real directory after
 * it; otherwise nothing is deleted (N1).
 */
async function safeRemoveInboxFile(
  vaultRoot: string,
  sourcePath: string,
  expectedHash: string,
): Promise<void> {
  let t;
  try {
    t = await resolveInboxPath(vaultRoot, sourcePath);
  } catch {
    // Cannot prove it is an inbox file — never delete something we can't prove is ours.
    return;
  }
  if (!t.exists) return; // already gone (a prior run, or a racing removal)

  const src = t.cp.abs;
  const dir = path.dirname(src);
  const tmpAbs = path.join(dir, `.${randomBytes(16).toString('hex')}.ingest-tmp`);
  try {
    await fs.rename(src, tmpAbs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; // raced away already
    throw err;
  }

  const restore = () =>
    fs.rename(tmpAbs, src).catch(() => {
      // The original name got reclaimed by a new writer in the meantime; leave
      // the temp copy on disk rather than silently discard content.
    });

  try {
    const st = await fs.lstat(tmpAbs);
    const realDir = await fs.realpath(dir);
    if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1 || cmpKey(realDir) !== cmpKey(dir)) {
      await restore();
      return;
    }
    const handle = await fs.open(tmpAbs, 'r');
    let bytes: Buffer;
    try {
      const hst = await handle.stat();
      if (!hst.isFile() || hst.nlink !== 1 || hst.size > MAX_INGEST_BYTES) {
        await handle.close();
        await restore();
        return;
      }
      bytes = await handle.readFile();
    } finally {
      await handle.close().catch(() => {});
    }
    if (sha256Hex(bytes) !== expectedHash) {
      // Content changed concurrently since it was preserved: this is no
      // longer safe to delete. Restore it under its original name so it is
      // picked up again (watcher `change`/startup-scan retry, E4-2).
      await restore();
      return;
    }
    await fs.rm(tmpAbs, { force: true });
  } catch (err) {
    await restore();
    throw err;
  }
}

/** Map a rejection reason onto the sidecar record's reason. */
function rejectionRecordReason(err: IngestSourceRejectedError) {
  return err.reason === 'outside-inbox' ? ('path-rejected' as const) : err.reason;
}

/**
 * Run Job 1 (Ingest). See the module header for the full crash-safe,
 * containment-safe step ordering. Resumable, deduplicated by content hash,
 * and serialized per content hash: re-running on the same bytes (whether a
 * genuine resume after a crash, a fresh re-drop of identical content, or a
 * concurrent drop racing an in-flight ingest of the same content) never
 * produces a duplicate note and never loses the only copy of the source.
 */
export async function runIngest(opts: RunIngestOptions): Promise<IngestResult> {
  const { vaultRoot, sourcePath, onJob, crashAfter, onBeforeInboxRemoval } = opts;
  onJob?.({ job: 'ingest', phase: 'start', sourcePath });

  let hash: string | undefined;
  let ext = '';
  let sidecarWritten = false;

  try {
    ext = (/\.[^./\\]+$/.exec(sourcePath)?.[0] ?? '').toLowerCase();

    // Steps 0+1: the drop must be a single-link regular file whose real path
    // is inside the real `00_Inbox/` with no reparse point in between and no
    // hidden/8.3/reserved segment, at most MAX_INGEST_BYTES long (N1/N6). Read
    // once, bounded, through a handle whose identity is re-verified, and hash
    // immediately; the hash is reused for every sidecar/store/marker path
    // below — never re-derived per call site (E4-8). A rejected drop is never
    // read or modified; it gets a sidecar if it is (lexically) in the inbox.
    // Our own error records are never ingest sources (a `.json` sidecar has a
    // declared extractor and would otherwise be ingested and deleted).
    const inboxRel = inboxRelPath(vaultRoot, sourcePath);
    if (
      inboxRel !== null &&
      (inboxRel.toLowerCase().endsWith(INGEST_ERROR_SUFFIX) ||
        inboxRel.split('/').some((s) => s.toLowerCase() === INGEST_ERRORS_DIR))
    ) {
      throw new IngestSourceRejectedError('path-rejected', sourcePath, 'ingest-error records are not ingest sources');
    }

    let raw: Buffer;
    try {
      raw = (await readInboxFile(vaultRoot, sourcePath)).bytes;
    } catch (err) {
      if (err instanceof IngestSourceRejectedError && inboxRel !== null) {
        await writeIngestError(vaultRoot, sourcePath, rejectionRecordReason(err), err.message, ext)
          .then(() => {
            sidecarWritten = true;
          })
          .catch(() => {
            // Best-effort: the thrown rejection is still reported via onJob.
          });
      }
      throw err;
    }
    hash = sha256Hex(raw);

    const extractor = getExtractor(sourcePath);
    if (!extractor) {
      await writeIngestError(
        vaultRoot,
        sourcePath,
        'unsupported-format',
        `no declared extractor for extension "${ext}"`,
        ext,
        hash,
      );
      sidecarWritten = true;
      throw new UnsupportedFormatError(sourcePath, ext);
    }

    let extracted: ReturnType<typeof extractor.extract>;
    try {
      extracted = extractor.extract(raw);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      await writeIngestError(vaultRoot, sourcePath, 'invalid-encoding', detail, ext, hash);
      sidecarWritten = true;
      throw err instanceof InvalidEncodingError ? err : new InvalidEncodingError(detail);
    }
    const text = extracted.text;

    // Step 4: content-level policy check BEFORE anything is copied (E4-7).
    try {
      assertNoRelativeMdLinks(text, sourcePath);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      await writeIngestError(vaultRoot, sourcePath, 'wikilink-violation', detail, ext, hash);
      sidecarWritten = true;
      throw err;
    }

    const title = deriveTitle(text, sourcePath);
    const broker = new VaultBroker(vaultRoot);

    // Step 5: serialize per content hash (E4-3) so two concurrent identical
    // drops cannot both observe "no marker yet" and both mint a note.
    const originalsDirAbs = await ensureOriginalsDir(vaultRoot);
    const lockTarget = path.join(originalsDirAbs, `${hash}.lock`);
    const release = await lock(lockTarget, {
      realpath: false,
      stale: 30_000,
      retries: { retries: 40, factor: 1.2, minTimeout: 25, maxTimeout: 250 },
    });

    try {
      // Step 6: dedup / resume-after-full-completion short circuit. The
      // marker is only trusted after validation (N7): its hash matches its
      // file name, its ext is declared, and its note is a contained
      // `60_Sources/` note recording this hash. An invalid marker is ignored
      // (and reported); normal ingest then proceeds and rewrites it.
      const existingMarker = await readMarker(vaultRoot, hash);
      if (existingMarker) {
        const v = await validateMarker(vaultRoot, broker, hash, existingMarker);
        if ('invalid' in v) {
          onJob?.({
            job: 'ingest',
            phase: 'progress',
            sourcePath,
            detail: `ignoring invalid completion marker for ${hash}: ${v.invalid}`,
          });
        } else {
          // E4-1: never trust the marker's presence alone — verify the
          // STORED original still exists and hashes correctly before
          // removing the (only remaining, if this is a repair) inbox copy.
          // An uncontained store path throws here (fail closed).
          const storedPath = originalStorePath(vaultRoot, hash, existingMarker.ext);
          if (!(await storedOriginalIsIntact(vaultRoot, hash, existingMarker.ext))) {
            // `raw` hashes to `hash` and `hash` is durably committed via the
            // validated marker — repair the store from the inbox bytes.
            await repairOriginal(vaultRoot, raw, existingMarker.ext);
          }

          await onBeforeInboxRemoval?.();
          await safeRemoveInboxFile(vaultRoot, sourcePath, hash);
          onJob?.({
            job: 'ingest',
            phase: 'complete',
            sourcePath,
            counts: { sources: 0 },
            detail: 'deduplicated: identical content already ingested',
          });
          return {
            sourceNotePath: v.sourceNotePath,
            sourceId: v.sourceId,
            title,
            body: v.body,
            sourceSha256: hash,
            // E4-8: report the ACTUAL stored path (the existing marker's
            // extension), not this drop's possibly-different extension.
            originalPath: storedPath,
            deduplicated: true,
          };
        }
      }

      // Step 7: preserve the original (idempotent, verified, contained).
      const { storePath } = await preserveOriginal(vaultRoot, raw, ext);
      if (crashAfter === 'copy') {
        throw new Error('ingest: test-injected crash after original preservation');
      }

      // Step 8: reuse an already-written orphan note for this hash, else create one.
      let sourceId: string;
      let sourceNotePath: string;
      let body: string;
      const orphan = await findNoteBySourceHash(vaultRoot, broker, hash);
      if (orphan) {
        sourceId = orphan.sourceId;
        sourceNotePath = orphan.sourceNotePath;
        body = orphan.body;
      } else {
        sourceId = ulid();
        sourceNotePath = path.join(vaultRoot, '60_Sources', `${sourceId}.md`);
        body = text; // ingest normalizes form, never substance — copied verbatim.

        const fm = makeFrontmatter({
          id: sourceId,
          title,
          type: 'external_source',
          status: 'active',
          authored_by: 'research.ingest',
          source: `file://${path.basename(sourcePath)}`,
          extra: {
            source_sha256: hash,
            original_path: storePath,
            extractor_name: extractor.name,
            extractor_version: extractor.version,
            source_encoding: extracted.encoding,
            source_bom_stripped: extracted.bomStripped,
          },
        });

        // WS-D: create-only through the vault broker (containment + lock + atomic
        // write; a fresh ULID path never collides, and nothing is ever clobbered).
        const res = await broker.createNote(`60_Sources/${sourceId}.md`, fm, body);
        if (!res.ok) {
          throw new Error(
            `ingest: could not write source note ${sourceNotePath} (reason: ${res.reason})`,
          );
        }
      }

      if (crashAfter === 'note') {
        throw new Error('ingest: test-injected crash after note write, before marker/cleanup');
      }

      // Step 9: commit — only now is this hash's ingest durably "done".
      await writeMarker(vaultRoot, { sourceId, sourceNotePath, hash, ext });

      // Step 10: the original is fully preserved (content-addressed store) and
      // normalized (source note + marker) — now it's safe to clear the inbox.
      await onBeforeInboxRemoval?.();
      await safeRemoveInboxFile(vaultRoot, sourcePath, hash);

      onJob?.({
        job: 'ingest',
        phase: 'complete',
        sourcePath,
        counts: { sources: 1 },
      });

      return {
        sourceNotePath,
        sourceId,
        title,
        body,
        sourceSha256: hash,
        originalPath: storePath,
        deduplicated: false,
      };
    } finally {
      await release();
    }
  } catch (err) {
    // Only write a sidecar here for failure modes we can name with
    // confidence (E4-7: `OriginalIntegrityError`'s dedicated
    // `integrity-check-failed` reason). Path/size/read rejections, unsupported
    // formats, bad encodings and wikilink violations already wrote their own
    // sidecar inline, above, closer to the actual cause. Deliberately NOT a
    // catch-all "unexpected-failure" sidecar for every other thrown error:
    // those include the regression suite's `crashAfter` injection (simulating
    // a hard process crash, which would never run this catch block at all)
    // and internal step failures (e.g. a broker write rejection) whose correct
    // handling is "let the caller see the error and retry", not "leave a stale
    // error record behind that masks a later, different failure".
    if (!sidecarWritten && typeof hash === 'string' && err instanceof OriginalIntegrityError) {
      await writeIngestError(
        vaultRoot,
        sourcePath,
        'integrity-check-failed',
        err.message,
        ext,
        hash,
      ).catch(() => {
        // Best-effort: never let sidecar-write failure mask the original error.
      });
    }
    onJob?.({
      job: 'ingest',
      phase: 'error',
      sourcePath,
      detail: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
