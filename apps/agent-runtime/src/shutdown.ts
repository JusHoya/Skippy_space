// shutdown.ts — graceful exit handlers.
//
// The Rust shell sends SIGTERM (and Ctrl+C surfaces as SIGINT) when the user
// closes the app. We also treat stdin EOF as a shutdown signal — once the
// shell closes our stdin we have no more work to do.

import { logger } from './logger.js';
import { shutdownOtel } from './otel.js';

export function setupGracefulShutdown(): void {
  let shutting = false;
  const handler = async (sig: string): Promise<void> => {
    if (shutting) return;
    shutting = true;
    logger.info({ msg: 'shutdown signal', sig });
    await shutdownOtel();
    process.exit(0);
  };

  process.on('SIGTERM', () => {
    void handler('SIGTERM');
  });
  process.on('SIGINT', () => {
    void handler('SIGINT');
  });
  process.stdin.on('end', () => {
    void handler('stdin-eof');
  });
}
