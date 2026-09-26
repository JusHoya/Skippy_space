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
// Crash-safe ordering (each step is safe to re-run; a crash at any point
// leaves at least one intact copy of the content):
//
//   1. Read the raw bytes of the drop. Look up a DECLARED extractor by
//      extension (`ingest/extractors.ts`). No extractor -> write a sidecar
//      `.ingest-error.json`, throw, leave the original untouched.
//   2. Decode with that extractor (strict UTF-8 for M0's qualified formats).
//      Decode failure -> sidecar error, throw, original untouched.
//   3. Hash the raw bytes (sha256). If a completion MARKER already exists for
//      that hash and its note still exists, this content is already fully
//      ingested (dedup / resume-after-full-completion): remove the (now
//      redundant) inbox copy and return the existing result.
//   4. Copy the raw bytes into the content-addressed original store
//      (`60_Sources/originals/<sha256><ext>`), verifying the on-disk copy's
//      hash. Idempotent — a prior run may have completed this already.
//   5. Look for an existing `60_Sources/*.md` note whose frontmatter
//      `source_sha256` already matches this hash (a prior run may have
//      written the note but crashed before the marker). Reuse it if found;
//      otherwise mint a fresh ULID and write a new derived note with
//      provenance (`source_sha256`, original path, extractor name/version).
//   6. Write the completion marker — ONLY now is "ingest of this content" a
//      durably committed fact.
//   7. Remove the original from `00_Inbox/`.
//
// We never paraphrase the body (that's the distiller's job); we copy it
// verbatim into the source note. Provenance is preserved via
// `source: file://<basename>` plus the new `source_sha256`/`original_path`/
// `extractor_*` passthrough fields (PRD §8.3 schema is `.passthrough()`).

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { ulid } from 'ulid';

import { writeNote } from '../atomic.js';
import { makeFrontmatter, parseNote, validateFrontmatter } from '../frontmatter.js';
import { getExtractor, InvalidEncodingError } from '../ingest/extractors.js';
import { writeIngestError } from '../ingest/errors.js';
import {
  originalStorePath,
  preserveOriginal,
  readMarker,
  sha256Hex,
  writeMarker,
} from '../ingest/originals.js';
import type { JobEvent } from './types.js';

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

/** Scan `60_Sources/*.md` for a note whose frontmatter `source_sha256` matches `hash`. */
async function findNoteBySourceHash(
  vaultRoot: string,
  hash: string,
): Promise<{ sourceId: string; sourceNotePath: string; title: string; body: string } | null> {
  const sourcesDir = path.join(vaultRoot, '60_Sources');
  let entries: string[];
  try {
    entries = await fs.readdir(sourcesDir);
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith('.md')) continue;
    const p = path.join(sourcesDir, entry);
    let raw: string;
    try {
      raw = await fs.readFile(p, 'utf8');
    } catch {
      continue;
    }
    const parsed = parseNote(raw);
    if (parsed.frontmatter['source_sha256'] !== hash) continue;
    const v = validateFrontmatter(parsed.frontmatter);
    if (!v.ok) continue;
    return {
      sourceId: v.value.id,
      sourceNotePath: p,
      title: v.value.title,
      body: parsed.body,
    };
  }
  return null;
}

/**
 * Run Job 1 (Ingest). See the module header for the full crash-safe step
 * ordering. Resumable and deduplicated by content hash: re-running on the
 * same bytes (whether a genuine resume after a crash, or a fresh re-drop of
 * identical content) never produces a duplicate note and never loses the
 * only copy of the source.
 */
export async function runIngest(opts: RunIngestOptions): Promise<IngestResult> {
  const { vaultRoot, sourcePath, onJob, crashAfter } = opts;
  onJob?.({ job: 'ingest', phase: 'start', sourcePath });

  try {
    const ext = (/\.[^./\\]+$/.exec(sourcePath)?.[0] ?? '').toLowerCase();
    const extractor = getExtractor(sourcePath);
    if (!extractor) {
      await writeIngestError(
        sourcePath,
        'unsupported-format',
        `no declared extractor for extension "${ext}"`,
        ext,
      );
      throw new UnsupportedFormatError(sourcePath, ext);
    }

    // Read once as bytes: the hash is over the exact original bytes, and the
    // extractor decodes from those same bytes (never a pre-decoded string).
    const raw = await fs.readFile(sourcePath);

    let text: string;
    try {
      text = extractor.extract(raw).text;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      await writeIngestError(sourcePath, 'invalid-encoding', detail, ext);
      throw err instanceof InvalidEncodingError ? err : new InvalidEncodingError(detail);
    }

    const title = deriveTitle(text, sourcePath);

    // Step 3: dedup / resume-after-full-completion short circuit.
    const hash = sha256Hex(raw);
    const existingMarker = await readMarker(vaultRoot, hash);
    if (existingMarker) {
      const stillThere = await fs
        .access(existingMarker.sourceNotePath)
        .then(() => true)
        .catch(() => false);
      if (stillThere) {
        const raw2 = await fs.readFile(existingMarker.sourceNotePath, 'utf8');
        const parsed2 = parseNote(raw2);
        await fs.rm(sourcePath, { force: true });
        onJob?.({
          job: 'ingest',
          phase: 'complete',
          sourcePath,
          counts: { sources: 0 },
          detail: 'deduplicated: identical content already ingested',
        });
        return {
          sourceNotePath: existingMarker.sourceNotePath,
          sourceId: existingMarker.sourceId,
          title,
          body: parsed2.body,
          sourceSha256: hash,
          originalPath: originalStorePath(vaultRoot, hash, ext),
          deduplicated: true,
        };
      }
    }

    // Step 4: preserve the original (idempotent, verified).
    const { storePath } = await preserveOriginal(vaultRoot, raw, ext);
    if (crashAfter === 'copy') {
      throw new Error('ingest: test-injected crash after original preservation');
    }

    // Step 5: reuse an already-written orphan note for this hash, else create one.
    let sourceId: string;
    let sourceNotePath: string;
    let body: string;
    const orphan = await findNoteBySourceHash(vaultRoot, hash);
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
        },
      });

      const res = await writeNote(sourceNotePath, fm, body);
      if (!res.written) {
        throw new Error(
          `ingest: could not write source note ${sourceNotePath} (reason: ${res.reason})`,
        );
      }
    }

    if (crashAfter === 'note') {
      throw new Error('ingest: test-injected crash after note write, before marker/cleanup');
    }

    // Step 6: commit — only now is this hash's ingest durably "done".
    await writeMarker(vaultRoot, { sourceId, sourceNotePath, hash, ext });

    // Step 7: the original is fully preserved (content-addressed store) and
    // normalized (source note + marker) — now it's safe to clear the inbox.
    await fs.rm(sourcePath, { force: true });

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
  } catch (err) {
    onJob?.({
      job: 'ingest',
      phase: 'error',
      sourcePath,
      detail: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
