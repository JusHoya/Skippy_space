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

import { createInterface } from 'node:readline';

import { logger } from './logger.js';
import { initOtel, shutdownOtel } from './otel.js';
import { parseEnvelope, writeEnvelope } from './protocol.js';
import { setupGracefulShutdown } from './shutdown.js';
import { handleUserPrompt } from './skippy.js';
import { getSupervisor } from './supervisor.js';

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
      } else {
        // Phase 1 still only consumes user_prompt envelopes from stdin —
        // delegation envelopes are produced by the sidecar, not consumed. The
        // Rust shell and renderer can co-evolve without bricking us.
        logger.debug({ msg: 'unhandled envelope type', type: env.type });
      }
    } catch (e) {
      logger.warn({ msg: 'bad envelope', line, err: String(e) });
    }
  }

  // stdin EOF -> graceful drain.
  await supervisor.shutdown();
  await shutdownOtel();
}

main().catch((err: unknown) => {
  logger.fatal({ msg: 'fatal', err: String(err) });
  process.exit(1);
});
