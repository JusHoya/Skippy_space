#!/usr/bin/env node
// scripts/letta-bootstrap.mjs — provision the per-board Letta agents from the charters.
//
// OQ-D4-04. Thin launcher: spawns the real job (packages/memory/src/jobs/
// letta-bootstrap.ts) under tsx, from the @skippy/memory package dir so its deps
// (gray-matter, tsx) resolve. The job itself parses every charter under agent_space/
// (skippy.md, boards/*.md, staff/*.md), reads each `memory.letta_agent_id` +
// `memory.core_memory_facts`, and idempotently ensures that agent exists on the Letta
// server (creating it with its persona facts seeded; skipping ones already present).
//
// GRACEFUL: when Letta is down or LETTA_DISABLED=1, the job does ZERO network work and
// the run exits 0 with a clear "skipped" message — safe in CI / the headless gate. It
// exits non-zero ONLY when the server is reachable but a provisioning op failed.
//
// Usage:
//   node scripts/letta-bootstrap.mjs
//   LETTA_BASE_URL=http://localhost:8283 node scripts/letta-bootstrap.mjs
//   node scripts/letta-bootstrap.mjs --agent-space=/path/to/agent_space
//
// Env: LETTA_BASE_URL (default http://localhost:8283), LETTA_API_KEY, LETTA_DISABLED=1.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const memoryPkg = resolve(root, 'packages', 'memory');
const cliEntry = resolve(memoryPkg, 'src', 'jobs', 'letta-bootstrap.cli.ts');

// Load .env (LETTA_* lines) the same way the phase validators do, so a developer's
// LETTA_BASE_URL / LETTA_DISABLED is honored without re-exporting it by hand.
const envPath = resolve(root, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

if (!existsSync(cliEntry)) {
  console.error(`letta-bootstrap: CLI entry not found at ${cliEntry}`);
  process.exit(1);
}

// Run the job under tsx, cwd=packages/memory so `tsx` + the job's deps resolve there.
const child = spawnSync(
  process.execPath,
  ['--import', 'tsx', cliEntry, ...process.argv.slice(2)],
  { cwd: memoryPkg, stdio: 'inherit', env: process.env },
);

if (child.error) {
  console.error(`letta-bootstrap: failed to launch tsx runner — ${child.error.message}`);
  process.exit(1);
}
process.exit(child.status ?? 1);
