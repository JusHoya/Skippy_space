// jobs/types.ts — the shared progress-event contract for the four-job pipeline.
//
// Every job (ingest, distill, link, lint) and the `runPipeline` orchestrator emit
// `JobEvent`s through an optional `onJob` callback. The agent-runtime maps these to
// OTel spans (PRD §9) and the RTS UI walker animations; the e2e test ignores them.
// Keeping the shape in one place avoids drift between the four job modules.

/** Which of the four pipeline jobs a progress event belongs to. */
export type JobName = 'ingest' | 'distill' | 'link' | 'lint';

/** Lifecycle phase of a job event. */
export type JobPhase = 'start' | 'progress' | 'complete' | 'error';

/** Running tallies surfaced as a job makes progress (all optional). */
export interface JobCounts {
  sources?: number;
  atomic?: number;
  links?: number;
  proposals?: number;
}

/** One progress event emitted by a pipeline job. */
export interface JobEvent {
  job: JobName;
  phase: JobPhase;
  /** The drop being processed (set by ingest / the orchestrator). */
  sourcePath?: string;
  /** Free-form human-readable detail (e.g. an error message). */
  detail?: string;
  /** Running counts for the job. */
  counts?: JobCounts;
}

/** The optional progress callback shape shared by every job + the orchestrator. */
export type OnJob = (e: JobEvent) => void;
