// jobs/letta-bootstrap.cli.ts — tsx entrypoint for the letta-bootstrap job.
//
// Run indirectly via `node scripts/letta-bootstrap.mjs` (which spawns this under tsx
// from the @skippy/memory package so its deps resolve). Kept as a 3-line shim so the
// real logic stays in letta-bootstrap.ts (unit-tested, headless). Exits with the code
// runBootstrapCli() returns: 0 on success or a clean down/disabled skip, 1 only when a
// reachable server rejected ≥1 provisioning op. Never throws past here.

import { runBootstrapCli } from './letta-bootstrap.js';

runBootstrapCli(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    // Defensive: the job is non-throwing, but a catastrophic import/IO error must
    // still surface as a clean non-zero exit rather than an unhandled rejection.
    console.error(`letta-bootstrap: unexpected error — ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
