// logger.ts — pino logger writing to stderr only.
//
// IMPORTANT: stdout is the envelope channel between the runtime and the Rust
// shell. NEVER write logs to stdout — they will be parsed (and rejected) as
// envelopes. pino.destination(2) targets file descriptor 2 (stderr).

import pino from 'pino';

export const logger = pino(
  { level: process.env.LOG_LEVEL ?? 'info' },
  pino.destination(2),
);
