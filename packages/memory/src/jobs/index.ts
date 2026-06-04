// jobs/index.ts — the four-job memory pipeline barrel (PRD §8.5).
//
// Re-exports the four jobs (ingest → distill → link → lint) plus a `runPipeline`
// convenience that runs them sequentially over one dropped file. The distiller is
// SWAPPABLE (`DistillFn`); `runPipeline` defaults to the deterministic
// `mockDistill` so the exit-criterion test runs with NO LLM / Docker / Obsidian.

export * from './types.js';
export * from './ingest.js';
export * from './distill.js';
export * from './link.js';
export * from './lint.js';
// Phase 3.5 (WS-D) — archival->vault mirror (pure filesystem durable fallback).
export * from './archival-mirror.js';

import { runIngest, type IngestResult } from './ingest.js';
import { runDistill, mockDistill, type DistillFn, type DistillResult } from './distill.js';
import { runLink, type LinkResult } from './link.js';
import { runLint, type LintResult } from './lint.js';
import type { JobEvent } from './types.js';

export interface RunPipelineOptions {
  /** Absolute path to the vault root. */
  vaultRoot: string;
  /** Absolute path to the dropped file under `00_Inbox/`. */
  sourcePath: string;
  /** Swappable distiller. Defaults to the deterministic `mockDistill`. */
  distill?: DistillFn;
  /** Optional progress callback, forwarded to every job. */
  onJob?: (e: JobEvent) => void;
}

export interface PipelineResult {
  ingest: IngestResult;
  distill: DistillResult;
  link: LinkResult;
  lint: LintResult;
}

/**
 * Run the full four-job pipeline over one dropped file, sequentially:
 *   ingest → distill (default `mockDistill`) → link → lint.
 * Returns the combined per-job results. Any job throwing aborts the pipeline
 * (its `onJob` 'error' event fires first).
 */
export async function runPipeline(opts: RunPipelineOptions): Promise<PipelineResult> {
  const { vaultRoot, sourcePath, onJob } = opts;
  const distill = opts.distill ?? mockDistill;

  const ingest = await runIngest({ vaultRoot, sourcePath, ...(onJob ? { onJob } : {}) });

  const distillResult = await runDistill({
    vaultRoot,
    source: { sourceId: ingest.sourceId, title: ingest.title, body: ingest.body },
    distill,
    ...(onJob ? { onJob } : {}),
  });

  const link = await runLink({ vaultRoot, ...(onJob ? { onJob } : {}) });
  const lint = await runLint({ vaultRoot, ...(onJob ? { onJob } : {}) });

  return { ingest, distill: distillResult, link, lint };
}
