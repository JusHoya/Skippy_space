// index.ts — entrypoint for the @skippy/agent-runtime sidecar.
//
// The sidecar runs as a long-lived Node 22 LTS child process spawned by the
// Tauri shell (apps/shell/src-tauri/src/sidecar.rs). It reads JSONL envelopes
// from stdin, dispatches them, and writes JSONL envelopes to stdout. stderr
// is reserved for pino logs (see logger.ts). See PRD §5.1, §5.2, §14.1, §14.2.
//
// Phase 1: at startup we also instantiate the BoardSupervisor and kick off
// its background `start()` (loads all 8 charters, spawns 8 Boards in parallel).
// The supervisor emits `board_spawned` + `board_ready` envelopes as each
// board comes online; Skippy's `delegate_to_board` tool routes through the
// same supervisor singleton.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { logger } from './logger.js';
import { startMemoryJobs, type MemoryJobsHandle } from './memory-jobs.js';
import { setModelFor, type ScopeId } from './modelRegistry.js';
import { initOtel, shutdownOtel } from './otel.js';
import { parseEnvelope, registerReplaySink, writeEnvelope } from './protocol.js';
import { appendToReplay, closeReplayWriter, initReplayWriter } from './replay-writer.js';
import { setupGracefulShutdown } from './shutdown.js';
import { handleUserPrompt } from './skippy.js';
import { getSupervisor } from './supervisor.js';
import type { ModelId } from '@skippy/shared';

/**
 * Resolve the vault root: explicit env wins, else walk up to the repo's vault/.
 * Mirrors `resolveVaultRoot` in memory-jobs.ts (kept local to avoid coupling the
 * replay writer's boot to the memory subsystem).
 */
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

async function main(): Promise<void> {
  await initOtel();
  setupGracefulShutdown();

  logger.info({ msg: 'agent-runtime starting', node: process.version });
  writeEnvelope({
    type: 'log',
    level: 'info',
    source: 'agent-runtime',
    message: 'sidecar ready',
    ts: new Date().toISOString(),
  });

  // Spin up the 8-Board supervisor in the background. We deliberately do NOT
  // await — boards emit their own `board_ready` envelopes when each one
  // finishes warming up, and we want the sidecar's stdin loop responsive
  // immediately. If any one board fails to start, the supervisor logs it; the
  // others continue. See PRD R-01 (warmpool / cold-start mitigation).
  const supervisor = getSupervisor();
  void supervisor.start().catch((err: unknown) => {
    logger.error({ msg: 'supervisor.start failed', err: String(err) });
    writeEnvelope({
      type: 'log',
      level: 'error',
      source: 'agent-runtime',
      message: `supervisor.start failed: ${String(err)}`,
      ts: new Date().toISOString(),
    });
  });

  // Phase 3 (WS5): start the four-job memory pipeline — an inbox watcher that
  // runs ingest→distill→link→lint on dropped files, plus a nightly Link/Lint
  // cron. Degrades gracefully (no-op watcher) when vault/ is absent; disable
  // entirely with SKIPPY_MEMORY_JOBS=0.
  const memoryJobs: MemoryJobsHandle = startMemoryJobs();

  // Phase 3 (WS8): TEE every outbound envelope to a per-session .replay file
  // (PRD §9.5). We register the writer as a sink on `writeEnvelope` and emit a
  // `replay_session: started` boundary so the renderer's ReplayScrubber can
  // pick up the active session. Disable entirely with SKIPPY_REPLAY=0; the
  // writer also degrades to a no-op if vault/.skippy is unwritable.
  let replaySessionId: string | null = null;
  if (process.env.SKIPPY_REPLAY !== '0') {
    const replay = initReplayWriter(resolveVaultRoot());
    replaySessionId = replay.sessionId;
    registerReplaySink(appendToReplay);
    writeEnvelope({
      type: 'replay_session',
      sessionId: replay.sessionId,
      event: 'started',
      path: replay.path,
      ts: new Date().toISOString(),
    });
  } else {
    logger.info({ msg: 'replay writer disabled via SKIPPY_REPLAY=0' });
  }

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const env = parseEnvelope(line);
      if (env.type === 'user_prompt') {
        handleUserPrompt(env).catch((err: unknown) => {
          logger.error({ msg: 'user_prompt failed', err: String(err) });
          writeEnvelope({
            type: 'log',
            level: 'error',
            source: 'skippy',
            message: String(err),
            ts: new Date().toISOString(),
          });
        });
      } else if (env.type === 'set_model') {
        // Phase 3-prep: renderer rebinds an agent's model. We update the
        // in-process registry; subsequent LLM calls from that scope pick up
        // the new model. In-flight calls keep their original model per the
        // `SetModelEnvelope` contract in @skippy/shared.
        setModelFor(env.scope as ScopeId, env.modelId as ModelId);
      } else {
        // Phase 1 still only consumes user_prompt + set_model envelopes from
        // stdin — delegation envelopes are produced by the sidecar, not
        // consumed. The Rust shell and renderer can co-evolve without
        // bricking us.
        logger.debug({ msg: 'unhandled envelope type', type: env.type });
      }
    } catch (e) {
      logger.warn({ msg: 'bad envelope', line, err: String(e) });
    }
  }

  // stdin EOF -> graceful drain.
  // Emit the `replay_session: ended` boundary *before* closing the writer so the
  // boundary lands inside the replay file itself, then flush + close it.
  if (replaySessionId !== null) {
    writeEnvelope({
      type: 'replay_session',
      sessionId: replaySessionId,
      event: 'ended',
      ts: new Date().toISOString(),
    });
    await closeReplayWriter();
  }
  await memoryJobs.stop();
  await supervisor.shutdown();
  await shutdownOtel();
}

main().catch((err: unknown) => {
  logger.fatal({ msg: 'fatal', err: String(err) });
  process.exit(1);
});
