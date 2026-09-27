// memory-jobs.ts — wires the @skippy/memory four-job pipeline into the sidecar.
//
// Phase 3 (WS5 runtime side). PRD §8.5: a chokidar watcher on vault/00_Inbox/
// runs the pipeline (ingest → distill → link → lint) on every dropped file, and
// a nightly cron runs the Link + Lint passes. Every job's progress is mirrored
// to the renderer as `memory_job` envelopes and wrapped in an OTel span
// (CLAUDE.md: all agent comms are traced).
//
// The distiller is swappable (PRD architecture decision): `SKIPPY_DISTILL_MODE`
//   = 'mock' (default) → the deterministic `mockDistill` (no LLM).
//   = 'llm'            → `llmDistill` below (one Haiku call), iff ANTHROPIC_API_KEY
//                        is set; any failure falls back to mockDistill.
// Disable the whole subsystem with `SKIPPY_MEMORY_JOBS=0`.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SpanStatusCode, trace } from '@opentelemetry/api';
import cron, { type ScheduledTask } from 'node-cron';
import Anthropic from '@anthropic-ai/sdk';

import {
  runPipeline,
  runLink,
  runLint,
  mockDistill,
  watchInbox,
  canonicalVaultRootSync,
  recordUnsupported,
  recordIngestRejection,
  type DistillFn,
  type JobEvent,
  type InboxWatcher,
} from '@skippy/memory';

import { logger } from './logger.js';
import { getModelFor } from './modelRegistry.js';
import { writeEnvelope } from './protocol.js';

const tracer = trace.getTracer('skippy-memory-jobs');

/** Resolve the vault root: explicit env wins, else walk up to the repo's vault/. */
function resolveVaultRoot(): string {
  const fromEnv = process.env.SKIPPY_VAULT_ROOT;
  if (fromEnv) return fromEnv;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, 'vault'))) return path.join(dir, 'vault');
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return path.join(dir, 'vault');
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(dir, 'vault');
}

/** Forward a pipeline JobEvent to the renderer as a `memory_job` envelope. */
function emitJob(e: JobEvent): void {
  writeEnvelope({
    type: 'memory_job',
    job: e.job,
    phase: e.phase,
    ...(e.sourcePath ? { sourcePath: path.basename(e.sourcePath) } : {}),
    ...(e.detail ? { detail: e.detail } : {}),
    ...(e.counts ? { counts: e.counts } : {}),
    ts: new Date().toISOString(),
  });
}

// ── llm distiller (gated; falls back to mock on any failure) ─────────────────

/** Extract the first JSON array from a model response, tolerant of prose/fences. */
function extractJsonArray(text: string): unknown {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

const llmDistill: DistillFn = async (input) => {
  try {
    const c = new Anthropic();
    const resp = await c.messages.create({
      model: getModelFor('board.research'),
      max_tokens: 2048,
      system:
        'You are research.distiller. Distill the source into 8–15 atomic facts — each one self-contained, specific, and supported by the source. Return ONLY a JSON array of objects {"title": string, "body": string, "confidence": number between 0 and 1}. No prose, no code fences.',
      messages: [
        { role: 'user', content: `Title: ${input.title}\n\n${input.body.slice(0, 12000)}` },
      ],
    });
    const text = resp.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    const parsed = extractJsonArray(text);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed
        .map((d) => {
          const o = (d ?? {}) as Record<string, unknown>;
          const title = typeof o.title === 'string' ? o.title.slice(0, 120) : '';
          const body = typeof o.body === 'string' ? o.body : '';
          const confidence = typeof o.confidence === 'number' ? o.confidence : 0.6;
          return { title: title || 'Untitled fact', body, confidence };
        })
        .filter((d) => d.body.length > 0);
    }
    logger.warn({ msg: 'llmDistill returned no parseable facts; using mock' });
  } catch (err) {
    logger.warn({ msg: 'llmDistill failed; falling back to mock', err: String(err) });
  }
  return mockDistill(input);
};

function selectDistiller(): DistillFn {
  if (process.env.SKIPPY_DISTILL_MODE === 'llm' && process.env.ANTHROPIC_API_KEY) {
    return llmDistill;
  }
  return mockDistill;
}

// ── lifecycle ────────────────────────────────────────────────────────────────

export interface MemoryJobsHandle {
  stop: () => Promise<void>;
}

/** Run one scheduled job under an OTel span, swallowing errors (cron must not crash). */
async function runScheduled(name: string, fn: () => Promise<unknown>): Promise<void> {
  await tracer.startActiveSpan(`skippy.memory.${name}`, async (span) => {
    try {
      await fn();
      span.setStatus({ code: SpanStatusCode.OK });
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      logger.warn({ msg: `scheduled ${name} failed`, err: String(err) });
    } finally {
      span.end();
    }
  });
}

/** Run the full pipeline for one dropped file under a span. */
async function processDrop(
  vaultRoot: string,
  sourcePath: string,
  distill: DistillFn,
): Promise<void> {
  await tracer.startActiveSpan('skippy.memory.pipeline', async (span) => {
    span.setAttribute('skippy.memory.source', path.basename(sourcePath));
    try {
      const res = await runPipeline({ vaultRoot, sourcePath, distill, onJob: emitJob });
      span.setAttribute('skippy.memory.atomic_notes', res.distill.atomicIds.length);
      span.setAttribute('skippy.memory.links_added', res.link.linksAdded);
      span.setStatus({ code: SpanStatusCode.OK });
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      emitJob({ job: 'ingest', phase: 'error', sourcePath, detail: String(err) });
    } finally {
      span.end();
    }
  });
}

/**
 * Start the memory subsystem: the inbox watcher + the nightly Link/Lint cron.
 * Returns a handle whose `stop()` tears both down (called on sidecar shutdown).
 * No-op (returns an inert handle) when `SKIPPY_MEMORY_JOBS=0`.
 */
export function startMemoryJobs(): MemoryJobsHandle {
  if (process.env.SKIPPY_MEMORY_JOBS === '0') {
    logger.info({ msg: 'memory jobs disabled via SKIPPY_MEMORY_JOBS=0' });
    return { stop: async () => {} };
  }

  // M0 final #5: canonicalize the configured root ONCE (native realpath: an
  // 8.3 alias or junction root becomes its long form) and use that one form
  // for the watcher, runIngest and the scheduled jobs. A root that cannot be
  // canonicalized is a loud error event, not a silently idle watcher.
  const configuredRoot = resolveVaultRoot();
  let vaultRoot: string;
  try {
    vaultRoot = canonicalVaultRootSync(configuredRoot);
  } catch (err) {
    logger.error({ msg: 'memory jobs disabled: vault root cannot be canonicalized', vaultRoot: configuredRoot, err: String(err) });
    emitJob({ job: 'ingest', phase: 'error', detail: `vault root unusable, memory jobs not started: ${String(err)}` });
    return { stop: async () => {} };
  }
  const distill = selectDistiller();
  logger.info({
    msg: 'memory jobs starting',
    vaultRoot,
    distillMode: process.env.SKIPPY_DISTILL_MODE === 'llm' ? 'llm' : 'mock',
  });

  // E4-3: serialize drops through a single FIFO queue rather than firing an
  // unawaited `processDrop` per watcher event — two concurrent identical
  // drops must not both observe "not yet ingested" and both mint a note. (A
  // per-content-hash lock inside `runIngest` itself is the deeper fix for
  // multi-process/resumed-run correctness; this queue additionally keeps the
  // sidecar's own event ordering sane for humans watching the log.)
  let dropQueue: Promise<void> = Promise.resolve();
  const enqueueDrop = (absPath: string): void => {
    dropQueue = dropQueue
      .then(() => processDrop(vaultRoot, absPath, distill))
      .catch((err) => {
        logger.warn({ msg: 'queued processDrop failed', err: String(err) });
      });
  };

  const watcher: InboxWatcher = watchInbox({
    vaultRoot,
    onFile: (absPath) => {
      enqueueDrop(absPath);
    },
    onUnsupported: (absPath, ext) => {
      // E4-5: an unsupported drop must get the same explicit, on-disk error
      // record + `memory_job` event as a `runIngest`-detected failure, not
      // just a console warning.
      void (async () => {
        try {
          await recordUnsupported(vaultRoot, absPath, ext);
        } catch (err) {
          logger.warn({ msg: 'failed to record unsupported-format sidecar', err: String(err) });
        }
        emitJob({
          job: 'ingest',
          phase: 'error',
          sourcePath: absPath,
          detail: `unsupported format "${ext}"; original left intact, see .ingest-error.json`,
        });
      })();
    },
    onRejected: (absPath, reason, detail) => {
      // N6: an inbox entry ingest must not read (junction/symlink, hardlink,
      // 8.3/reserved name, over the size cap, unreadable) gets an explicit
      // sidecar (next to it, or under 00_Inbox/_ingest-errors/ when that is not
      // safely writable) and a `memory_job` error event. The file is never
      // read, modified or followed.
      void (async () => {
        try {
          await recordIngestRejection(vaultRoot, absPath, reason, detail);
        } catch (err) {
          logger.warn({ msg: 'failed to record rejected-drop sidecar', err: String(err) });
        }
        emitJob({
          job: 'ingest',
          phase: 'error',
          sourcePath: absPath,
          detail: `rejected (${reason}); original left intact, see .ingest-error.json`,
        });
      })();
    },
    onError: (err) => {
      // M0 final #5: a watcher that cannot run is an explicit error event.
      logger.error({ msg: 'inbox watcher error', err: String(err) });
      emitJob({ job: 'ingest', phase: 'error', detail: `inbox watcher: ${err.message}` });
    },
    onRecovered: (r) => {
      // M0 final #7: leftover .ingest-tmp freeze files are surfaced, never hidden.
      const entry = { msg: 'ingest-tmp recovery', tmpPath: r.tmpPath, action: r.action, detail: r.detail };
      if (r.action === 'left') logger.error(entry);
      else logger.warn(entry);
      emitJob({
        job: 'ingest',
        phase: r.action === 'left' ? 'error' : 'progress',
        sourcePath: r.restoredAs ?? r.tmpPath,
        detail: `recovered interrupted ingest (${r.action}): ${r.detail}`,
      });
    },
  });

  // Nightly Link 02:00 UTC, nightly Lint 03:00 UTC, weekly Lint Mon 03:30 UTC.
  const tasks: ScheduledTask[] = [];
  const schedule = (expr: string, fn: () => Promise<void>): void => {
    if (!cron.validate(expr)) return;
    tasks.push(cron.schedule(expr, () => void fn(), { timezone: 'UTC' }));
  };
  schedule('0 2 * * *', () => runScheduled('link', () => runLink({ vaultRoot, onJob: emitJob })));
  schedule('0 3 * * *', () => runScheduled('lint', () => runLint({ vaultRoot, onJob: emitJob })));
  schedule('30 3 * * 1', () => runScheduled('lint', () => runLint({ vaultRoot, onJob: emitJob })));

  return {
    stop: async () => {
      for (const t of tasks) t.stop();
      await watcher.close();
      logger.debug({ msg: 'memory jobs stopped' });
    },
  };
}
