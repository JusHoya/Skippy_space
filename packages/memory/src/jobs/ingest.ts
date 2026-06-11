// jobs/ingest.ts — Job 1 of the four-job memory pipeline (PRD §8.5).
//
// Owner charter: agent_space/tasks/ingest.md (research.ingest). The LLM charter
// describes a smart normalizer that strips rendering cruft; THIS module is the
// deterministic, dependency-light runtime glue that the agent-runtime (or the
// e2e exit-criterion test) drives. It performs the mechanical half of ingest:
//
//   1. Read the raw drop under `00_Inbox/`.
//   2. Derive a title (first markdown `# heading`, else the filename).
//   3. Stamp the full §8.3 frontmatter (`type: external_source`).
//   4. Write the normalized source note to `60_Sources/<ulid>.md` (WS1 writeNote).
//   5. Remove the original from `00_Inbox/` — it has been moved+normalized.
//
// We never paraphrase the body (that's the distiller's job); we copy it verbatim
// into the source note. Provenance is preserved via `source: file://<basename>`.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { ulid } from 'ulid';

import { writeNote } from '../atomic.js';
import { makeFrontmatter } from '../frontmatter.js';
import { neutralizeRelativeMdLinks } from './archival-mirror.js';
import type { JobEvent } from './types.js';

export interface RunIngestOptions {
  /** Absolute path to the vault root (folder containing `00_Inbox/`, `60_Sources/`). */
  vaultRoot: string;
  /** Absolute path to the raw drop under `00_Inbox/`. */
  sourcePath: string;
  /** Optional progress callback. */
  onJob?: (e: JobEvent) => void;
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

/**
 * Run Job 1 (Ingest). Reads `sourcePath` from `00_Inbox/`, normalizes it into a
 * `60_Sources/<ulid>.md` source note with §8.3 frontmatter, then removes the
 * original. Returns the new note's id/path/title/body so the distiller can run
 * without re-reading disk.
 */
export async function runIngest(opts: RunIngestOptions): Promise<IngestResult> {
  const { vaultRoot, sourcePath, onJob } = opts;
  onJob?.({ job: 'ingest', phase: 'start', sourcePath });

  try {
    const raw = await fs.readFile(sourcePath, 'utf8');
    const title = deriveTitle(raw, sourcePath);

    const sourceId = ulid();
    const sourceNotePath = path.join(vaultRoot, '60_Sources', `${sourceId}.md`);

    const fm = makeFrontmatter({
      id: sourceId,
      title,
      type: 'external_source',
      status: 'active',
      authored_by: 'research.ingest',
      source: `file://${path.basename(sourcePath)}`,
    });

    // The body is copied verbatim — ingest normalizes form, never substance — EXCEPT
    // that external drops (scraped/exported content) routinely carry relative `.md`
    // links like `[x](./README.md)`, which atomic.ts's wikilink guard hard-rejects
    // (PRD §8.2). Throwing here would abort the whole pipeline at job 1 and strand the
    // drop in `00_Inbox/` forever. External content isn't agent-authored, so we
    // neutralize those links (keep the label, drop the relative target) so the source
    // archives losslessly. The hard-throwing guard is reserved for agent-authored notes.
    const body = neutralizeRelativeMdLinks(raw);
    const res = await writeNote(sourceNotePath, fm, body);
    if (!res.written) {
      throw new Error(
        `ingest: could not write source note ${sourceNotePath} (reason: ${res.reason})`,
      );
    }

    // The original has been moved+normalized into 60_Sources — remove it from the
    // inbox so the watcher doesn't re-fire and the distiller reads the clean copy.
    await fs.rm(sourcePath, { force: true });

    onJob?.({
      job: 'ingest',
      phase: 'complete',
      sourcePath,
      counts: { sources: 1 },
    });

    return { sourceNotePath, sourceId, title, body };
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
