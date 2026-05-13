// index.ts — entrypoint for the @skippy/agent-runtime sidecar.
//
// The sidecar runs as a long-lived Node 22 LTS child process spawned by the
// Tauri shell (apps/shell/src-tauri/src/sidecar.rs). It reads JSONL envelopes
// from stdin, dispatches them, and writes JSONL envelopes to stdout. stderr
// is reserved for pino logs (see logger.ts). See PRD §5.1, §5.2, §14.1.

import { createInterface } from 'node:readline';

import { logger } from './logger.js';
import { initOtel, shutdownOtel } from './otel.js';
import { parseEnvelope, writeEnvelope } from './protocol.js';
import { setupGracefulShutdown } from './shutdown.js';
import { handleUserPrompt } from './skippy.js';

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
        // Phase 0 only handles user_prompt envelopes — log and ignore the rest
        // so the Rust shell and renderer can co-evolve without bricking us.
        logger.debug({ msg: 'unhandled envelope type', type: env.type });
      }
    } catch (e) {
      logger.warn({ msg: 'bad envelope', line, err: String(e) });
    }
  }

  await shutdownOtel();
}

main().catch((err: unknown) => {
  logger.fatal({ msg: 'fatal', err: String(err) });
  process.exit(1);
});
