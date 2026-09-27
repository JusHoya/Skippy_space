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
//   8. Look for an existing `60_Sources/*.md` note for this hash (a prior run
//      may have written the note but crashed before the marker) and reuse it
//      ONLY if it is provably ours (M0 final #1, `verifySourceNote`):
//      `authored_by: research.ingest`, `type: external_source`,
//      `source_sha256`, an `original_path` naming this hash's store entry
//      with this drop's extension, the recorded extractor's name and version,
//      and a body byte-equal to what that extractor derives from THESE bytes.
//      Anything else with a matching hash (e.g. a note an agent planted and
//      stamped) is reported and ignored; a fresh ULID note is written with
//      provenance through a broker holding the ingest capability
//      (ingest/provenance.ts) -- the only broker that may write 60_Sources/.
//      The same verification applies to the note a completion marker names.
//   9. Write the completion marker — ONLY now is "ingest of this content" a
//      durably committed fact.
//  10. Safely remove the original from `00_Inbox/` (E3-2/E4-4: contained,
//      renamed to a random hidden freeze name and re-hashed immediately before
//      the delete, so a concurrent writer to the same inbox path cannot race
//      the deletion of content that was never actually preserved). A frozen
//      file whose bytes changed is restored WITHOUT ever replacing a newer
//      drop at its name (M0 final #2, ingest/recovery.ts): the displaced
//      version goes to `<stem>.conflict-<ts><ext>` and an event says so.
//
// The vault root is canonicalized once (native realpath, M0 final #5), and a
// `sourcePath` given under the configured (possibly 8.3 or junction) form of
// the root is re-based onto it, so reported paths are canonical.
//
// We never paraphrase the body (that's the distiller's job); we copy it
// verbatim into the source note. Provenance is preserved via
// `source: file://<basename>` plus `source_sha256`/`original_path`/
// `extractor_*`/`source_encoding`/`source_bom_stripped` passthrough fields
// (PRD §8.3 schema is `.passthrough()`).

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { ulid } from 'ulid';

import { makeFrontmatter, parseNote, serializeNote } from '../frontmatter.js';
import { VaultBroker, type NoteSnapshot } from '../vault-broker.js';
import { assertNoRelativeMdLinks } from '../atomic.js';
import { cmpKey, realVaultRoot, rebaseOntoRoot } from '../vault-path.js';
import { acquireVaultLock } from '../vault-lock.js';
import { EXTRACTORS, getExtractor, InvalidEncodingError } from '../ingest/extractors.js';
import { INGEST_AUTHOR, INGEST_WRITER, SOURCES_DIR } from '../ingest/provenance.js';
import { ingestTmpName, restoreNoClobber } from '../ingest/recovery.js';
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


/** A source note found by content hash, read through the broker and verified. */
interface SourceNoteRef {
  sourceId: string;
  /** Absolute path beneath the (canonical) vault root (for reporting). */
  sourceNotePath: string;
  /** The extracted text the note was verified against (the distiller's input). */
  text: string;
  /** The extension whose extractor derived the note (from its `original_path`). */
  ext: string;
}

const SOURCE_NOTE_REL_RE = new RegExp(`^${SOURCES_DIR}/[^/]+\\.md$`, 'i');

/** Any valid §8.3 frontmatter; only used to compute the stored form of a body. */
const PROBE_FRONTMATTER = makeFrontmatter({
  id: '00000000000000000000000000',
  title: 'probe',
  type: 'external_source',
  authored_by: INGEST_AUTHOR,
  source: 'file://probe',
  now: new Date(0),
});

/**
 * The body a source note carries after `createNote(fm, text)` and a re-read:
 * serialization adds a separating newline and a trailing one, and the parse
 * drops one. Independent of the frontmatter.
 */
export function storedSourceBody(text: string): string {
  return parseNote(serializeNote(PROBE_FRONTMATTER, text)).body;
}

/**
 * Prove a 60_Sources note was derived by this pipeline from exactly `raw`
 * (M0 final #1). Returns the verified text and extension, or the first reason
 * it cannot be trusted. Frontmatter alone is never enough: the body must be
 * byte-identical to what the recorded extractor produces from these bytes.
 */
export function verifySourceNote(
  snap: Pick<NoteSnapshot, 'frontmatter' | 'body'>,
  raw: Buffer,
  hash: string,
): { text: string; ext: string } | { mismatch: string } {
  const fm = snap.frontmatter;
  if (fm['source_sha256'] !== hash) return { mismatch: `source_sha256 is not ${hash}` };
  if (fm['authored_by'] !== INGEST_AUTHOR) {
    return { mismatch: `authored_by is ${JSON.stringify(fm['authored_by'])}, not the ingest pipeline` };
  }
  if (fm['type'] !== 'external_source') return { mismatch: `type is ${JSON.stringify(fm['type'])}` };
  const original = fm['original_path'];
  if (typeof original !== 'string') return { mismatch: 'original_path is missing' };
  const m = /\/60_sources\/originals\/([0-9a-f]{64})(\.[^./]+)$/.exec(original.replace(/\\/g, '/').toLowerCase());
  if (!m || m[1] !== hash) {
    return { mismatch: `original_path ${JSON.stringify(original)} is not this content's store entry` };
  }
  const ext = m[2]!;
  const extractor = Object.prototype.hasOwnProperty.call(EXTRACTORS, ext) ? EXTRACTORS[ext] : undefined;
  if (!extractor) return { mismatch: `original_path extension ${ext} has no declared extractor` };
  if (fm['extractor_name'] !== extractor.name || fm['extractor_version'] !== extractor.version) {
    return {
      mismatch:
        `extractor ${JSON.stringify(fm['extractor_name'])}@${JSON.stringify(fm['extractor_version'])} ` +
        `is not ${extractor.name}@${extractor.version}`,
    };
  }
  let extracted;
  try {
    extracted = extractor.extract(raw);
  } catch (err) {
    return { mismatch: `the bytes do not extract: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (fm['source_encoding'] !== undefined && fm['source_encoding'] !== extracted.encoding) {
    return { mismatch: `source_encoding ${JSON.stringify(fm['source_encoding'])} is not ${extracted.encoding}` };
  }
  if (fm['source_bom_stripped'] !== undefined && fm['source_bom_stripped'] !== extracted.bomStripped) {
    return { mismatch: 'source_bom_stripped does not match the bytes' };
  }
  if (sha256Hex(Buffer.from(snap.body, 'utf8')) !== sha256Hex(Buffer.from(storedSourceBody(extracted.text), 'utf8'))) {
    return { mismatch: `the body differs from what ${extractor.name}@${extractor.version} derives from these bytes` };
  }
  return { text: extracted.text, ext };
}

/**
 * Read `60_Sources/<name>.md` through the broker (containment, no hidden or
 * 8.3 segments, single-link regular file, strict UTF-8) and verify it against
 * `raw` (`verifySourceNote`; plus `id === expectedId` when given).
 */
async function readVerifiedSourceNote(
  vaultRoot: string,
  broker: VaultBroker,
  rel: string,
  raw: Buffer,
  hash: string,
  expectedId?: string,
): Promise<SourceNoteRef | { invalid: string }> {
  if (!SOURCE_NOTE_REL_RE.test(rel)) return { invalid: `${rel} is not a ${SOURCES_DIR}/ note` };
  const snap = await broker.readNote(rel);
  if (!snap) return { invalid: `${rel} does not exist` };
  const id = snap.frontmatter['id'];
  if (typeof id !== 'string' || id.length === 0) return { invalid: `${rel} has no id` };
  if (expectedId !== undefined && id !== expectedId) return { invalid: `${rel} has id ${id}, not ${expectedId}` };
  const v = verifySourceNote(snap, raw, hash);
  if ('mismatch' in v) return { invalid: `${rel}: ${v.mismatch}` };
  return {
    sourceId: id,
    sourceNotePath: path.join(vaultRoot, ...snap.path.split('/')),
    text: v.text,
    ext: v.ext,
  };
}

/**
 * Scan `60_Sources/*.md` for a note derived by this pipeline from exactly
 * these bytes with extension `ext` (orphan reuse after a crash between the
 * note and the marker). Every candidate is read through the broker (N7). A
 * candidate that claims this `source_sha256` but fails verification (a planted
 * or edited note) is reported through `report` and never adopted.
 */
async function findVerifiedOrphan(
  vaultRoot: string,
  broker: VaultBroker,
  raw: Buffer,
  hash: string,
  ext: string,
  report: (detail: string) => void,
): Promise<SourceNoteRef | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(path.join(vaultRoot, SOURCES_DIR));
  } catch {
    return null;
  }
  for (const entry of entries.sort()) {
    if (!entry.toLowerCase().endsWith('.md')) continue;
    const rel = `${SOURCES_DIR}/${entry}`;
    let snap: NoteSnapshot | null;
    try {
      snap = await broker.readNote(rel);
    } catch {
      continue; // uncontained / hardlinked / non-UTF-8 candidate: never trusted
    }
    if (!snap || snap.frontmatter['source_sha256'] !== hash) continue;
    const id = snap.frontmatter['id'];
    const v = verifySourceNote(snap, raw, hash);
    if ('mismatch' in v || typeof id !== 'string' || id.length === 0) {
      const why = 'mismatch' in v ? v.mismatch : 'it has no id';
      report(`ignoring ${rel}: it claims source_sha256 ${hash} but is not provably derived from it (${why})`);
      continue;
    }
    if (v.ext !== ext) continue;
    return { sourceId: id, sourceNotePath: path.join(vaultRoot, ...snap.path.split('/')), text: v.text, ext: v.ext };
  }
  return null;
}

/**
 * Validate a completion marker against the vault (N7, M0 final #1).
 * `readMarker` already checked that its `hash` equals the file-name hash and
 * its `ext` is a declared extractor extension. Here `sourceNotePath` must
 * lexically be `<vaultRoot>/60_Sources/<name>.md`, and that note, read through
 * the broker, must carry `id === marker.sourceId` and pass `verifySourceNote`
 * for these bytes with the marker's extension. Returns the note, or a reason.
 */
async function validateMarker(
  vaultRoot: string,
  broker: VaultBroker,
  hash: string,
  marker: NoteMarker,
  raw: Buffer,
): Promise<SourceNoteRef | { invalid: string }> {
  const rel = path
    .relative(path.resolve(vaultRoot), path.resolve(vaultRoot, marker.sourceNotePath))
    .split(path.sep)
    .join('/');
  if (!SOURCE_NOTE_REL_RE.test(rel)) {
    return { invalid: `sourceNotePath ${JSON.stringify(marker.sourceNotePath)} is not a 60_Sources/ note` };
  }
  try {
    const note = await readVerifiedSourceNote(vaultRoot, broker, rel, raw, hash, marker.sourceId);
    if ('invalid' in note) return note;
    if (note.ext !== marker.ext) return { invalid: `${rel} was derived as ${note.ext}, marker says ${marker.ext}` };
    return note;
  } catch (err) {
    return { invalid: `${rel} cannot be read safely: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Rename the inbox drop to a hidden freeze name inside the SAME (real,
 * verified) directory, re-hash it, and delete it ONLY if the bytes still match
 * `expectedHash` (E4-4). The rename freezes the file against a concurrent
 * writer between the hash check and the delete; a mismatch means someone
 * changed the file since it was preserved, so it is restored instead of
 * discarded -- never over a newer file that has since appeared under the
 * original name (M0 final #2: `restoreNoClobber` links, never renames over;
 * the displaced version gets a `.conflict-<ts>` name), and `report` says where
 * it went. The drop must pass the strict inbox rules (ingest/containment.ts)
 * immediately before the rename, and the frozen file must still be a
 * single-link regular file in that same real directory after it; otherwise
 * nothing is deleted (N1). If even the restore fails, the frozen file stays on
 * disk under its `.ingest-tmp` name and the watcher's startup recovery
 * (ingest/recovery.ts) brings it back.
 */
async function safeRemoveInboxFile(
  vaultRoot: string,
  sourcePath: string,
  expectedHash: string,
  report: (detail: string) => void,
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
  const name = path.basename(src);
  const tmpAbs = path.join(dir, ingestTmpName(name));
  try {
    await fs.rename(src, tmpAbs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; // raced away already
    throw err;
  }

  const restore = async (why: string): Promise<void> => {
    try {
      const r = await restoreNoClobber(tmpAbs, dir, name);
      report(
        r.conflict
          ? `${name} changed during ingest (${why}) and a newer file now holds that name; ` +
              `the displaced version was kept as ${path.basename(r.restoredAs)} and will be ingested separately`
          : `${name} changed during ingest (${why}); it was restored under its name for re-ingest`,
      );
    } catch (err) {
      report(
        `${name} changed during ingest (${why}) and could not be restored (${String(err)}); ` +
          `its bytes remain in ${path.basename(tmpAbs)} and are recovered at the next watcher start`,
      );
    }
  };

  try {
    const st = await fs.lstat(tmpAbs);
    const realDir = await fs.realpath(dir);
    if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1 || cmpKey(realDir) !== cmpKey(dir)) {
      await restore('the frozen file is not a single-link regular file in the real inbox');
      return;
    }
    const handle = await fs.open(tmpAbs, 'r');
    let bytes: Buffer;
    try {
      const hst = await handle.stat();
      if (!hst.isFile() || hst.nlink !== 1 || hst.size > MAX_INGEST_BYTES) {
        await handle.close();
        await restore('the frozen file changed shape');
        return;
      }
      bytes = await handle.readFile();
    } finally {
      await handle.close().catch(() => {});
    }
    if (sha256Hex(bytes) !== expectedHash) {
      // Content changed concurrently since it was preserved: this is no
      // longer safe to delete. Restore it so it is picked up again (watcher
      // `add`/`change`/startup-scan retry, E4-2).
      await restore('its bytes no longer match the preserved original');
      return;
    }
    await fs.rm(tmpAbs, { force: true });
  } catch (err) {
    await restore(`error: ${err instanceof Error ? err.message : String(err)}`);
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
  const { onJob, crashAfter, onBeforeInboxRemoval } = opts;
  let vaultRoot = opts.vaultRoot;
  let sourcePath = opts.sourcePath;
  onJob?.({ job: 'ingest', phase: 'start', sourcePath });

  let hash: string | undefined;
  let ext = '';
  let sidecarWritten = false;

  try {
    // M0 final #5: one canonical root (native realpath: long names, on-disk
    // case) for every path comparison below; a drop path given under the
    // configured alias form of the root is re-based onto it.
    const canonicalRoot = await realVaultRoot(opts.vaultRoot);
    sourcePath = rebaseOntoRoot(opts.vaultRoot, canonicalRoot, opts.sourcePath);
    vaultRoot = canonicalRoot;
    const report = (detail: string) => onJob?.({ job: 'ingest', phase: 'progress', sourcePath, detail });

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
    // The ONLY broker holding the ingest capability (ingest/provenance.ts):
    // it alone may write 60_Sources/ notes and provenance keys.
    const broker = new VaultBroker(vaultRoot, { ingestWriter: INGEST_WRITER });

    // Step 5: serialize per content hash (E4-3) so two concurrent identical
    // drops cannot both observe "no marker yet" and both mint a note. A
    // squatted lock path is an explicit VaultLockPathError (M0 final #3).
    const originalsDirAbs = await ensureOriginalsDir(vaultRoot);
    const lockTarget = path.join(originalsDirAbs, hash);
    const release = await acquireVaultLock(lockTarget, {
      stale: 30_000,
      retries: { retries: 40, factor: 1.2, minTimeout: 25, maxTimeout: 250 },
    });
    if (release === null) {
      throw new Error(`ingest: content ${hash} is locked by another ingest; retry later`);
    }

    try {
      // Step 6: dedup / resume-after-full-completion short circuit. The
      // marker is only trusted after validation (N7): its hash matches its
      // file name, its ext is declared, and its note is a contained
      // `60_Sources/` note provably derived from these bytes (M0 final #1).
      // An invalid marker is ignored (and reported); normal ingest then
      // proceeds and rewrites it.
      const existingMarker = await readMarker(vaultRoot, hash);
      if (existingMarker) {
        const v = await validateMarker(vaultRoot, broker, hash, existingMarker, raw);
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
          await safeRemoveInboxFile(vaultRoot, sourcePath, hash, report);
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
            body: v.text,
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

      // Step 8: reuse a VERIFIED orphan note for these bytes (M0 final #1),
      // else create one. The distiller always gets `text`, the extraction of
      // the drop itself, never a body read back from a note.
      let sourceId: string;
      let sourceNotePath: string;
      const body = text; // ingest normalizes form, never substance — copied verbatim.
      const orphan = await findVerifiedOrphan(vaultRoot, broker, raw, hash, ext, report);
      if (orphan) {
        sourceId = orphan.sourceId;
        sourceNotePath = orphan.sourceNotePath;
      } else {
        sourceId = ulid();
        sourceNotePath = path.join(vaultRoot, SOURCES_DIR, `${sourceId}.md`);

        const fm = makeFrontmatter({
          id: sourceId,
          title,
          type: 'external_source',
          status: 'active',
          authored_by: INGEST_AUTHOR,
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
        const res = await broker.createNote(`${SOURCES_DIR}/${sourceId}.md`, fm, body);
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
      await safeRemoveInboxFile(vaultRoot, sourcePath, hash, report);

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
