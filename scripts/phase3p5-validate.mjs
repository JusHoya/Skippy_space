#!/usr/bin/env node
// Phase 3.5 exit-gate validator — completes Obsidian D1 (MCP tools) + adds
// Letta/D4 (per-board archival memory + archival->vault mirror).
//
// Fully headless + deterministic: NO Docker, NO live Obsidian, NO ANTHROPIC_API_KEY.
// The decisive proof is apps/agent-runtime's mcp-registry.test.ts — it builds the
// obsidian+letta MCP servers, asserts every tool degrades to isError when its
// service is offline, and asserts letta_append_archival STILL mirrors to the
// board's vault agent_log.md (the durable D4 fallback). The gate also re-runs
// `pnpm validate:phase3` to prove zero regression (the SDK MCP path is gated
// behind PHASE3_AGENTS_ENABLED, so the OFF path — all four prior gates — is
// unchanged).
//
// Usage:
//   pnpm validate:phase3.5
//   node scripts/phase3p5-validate.mjs

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function loadDotEnv() {
  const path = resolve(root, '.env');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
loadDotEnv();

function resolvePnpm() {
  const wingetPath = `${process.env.LOCALAPPDATA}\\Microsoft\\WinGet\\Packages\\pnpm.pnpm_Microsoft.Winget.Source_8wekyb3d8bbwe\\pnpm.exe`;
  if (existsSync(wingetPath)) return wingetPath;
  try {
    const lookup = process.platform === 'win32' ? 'where pnpm.exe' : 'command -v pnpm';
    const out = execSync(lookup, { stdio: 'pipe' }).toString().trim();
    const first = out.split(/\r?\n/).find((line) => existsSync(line));
    if (first) return first;
  } catch {}
  throw new Error('pnpm.exe not found.');
}
const PNPM = resolvePnpm();

const results = [];
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const tag = ok ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
  console.log(`  ${tag}  ${name}${detail ? `  ${DIM}${detail}${RESET}` : ''}`);
}

function runStep(name, file, args = [], opts = {}) {
  const start = Date.now();
  const result = spawnSync(file, args, { cwd: root, stdio: 'pipe', shell: false, ...opts });
  if (result.error) return record(name, false, result.error.message.slice(0, 200));
  if (result.status !== 0) {
    const out = (result.stdout?.toString() ?? '') + (result.stderr?.toString() ?? '');
    return record(name, false, out.split('\n').slice(-6).join(' / ').trim().slice(0, 320) || `exit ${result.status}`);
  }
  record(name, true, `${Date.now() - start} ms`);
}

function readIf(rel) {
  const abs = resolve(root, rel);
  return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
}

console.log(`\n${DIM}# Skippy_space — Phase 3.5 exit-gate validator (D1 Obsidian MCP + D4 Letta)${RESET}\n`);

// ── stack ───────────────────────────────────────────────────────────────────
console.log(`${DIM}stack${RESET}`);
runStep('typecheck (pnpm -r typecheck)', PNPM, ['-r', 'typecheck']);
runStep('agent-runtime build (tsup)', PNPM, ['--filter', '@skippy/agent-runtime', 'build']);

// ── zod scoping (the load-bearing invariant) ───────────────────────────────
console.log(`\n${DIM}zod scoping${RESET}`);
{
  const ar = readIf('apps/agent-runtime/package.json') ?? '';
  const sh = readIf('packages/shared/package.json') ?? '';
  const mem = readIf('packages/memory/package.json') ?? '';
  record('agent-runtime declares zod@^4', /"zod":\s*"\^?4/.test(ar), null);
  record('shared stays on zod@^3', /"zod":\s*"\^?3/.test(sh), null);
  record('memory stays on zod@^3', /"zod":\s*"\^?3/.test(mem), null);
  // Exactly the two expected majors present in the tree (a third would mean drift).
  const ls = spawnSync(PNPM, ['ls', 'zod', '-r'], { cwd: root, stdio: 'pipe', shell: false });
  const majors = new Set(
    [...(ls.stdout?.toString() ?? '').matchAll(/zod\s+(\d+)\.\d+\.\d+/g)].map((m) => m[1]),
  );
  record('zod tree has exactly majors {3,4}', majors.size === 2 && majors.has('3') && majors.has('4'), `found {${[...majors].sort().join(',')}}`);
  // Coexistence guard: the registry must construct zod schemas from agent-runtime's
  // own zod, never import a schema object from @skippy/*.
  const reg = readIf('apps/agent-runtime/src/mcp-registry.ts') ?? '';
  record("mcp-registry imports zod from 'zod' only", /from\s+'zod'/.test(reg) && !/z\w*\s*from\s+'@skippy/.test(reg), null);
}

// ── file presence (D1 + D4) ────────────────────────────────────────────────
console.log(`\n${DIM}phase 3.5 files${RESET}`);
const FILES = [
  ['apps/agent-runtime/src/mcp-registry.ts', 'MCP server factory (buildMcpServers)'],
  ['apps/agent-runtime/src/mcp-handlers.ts', 'Obsidian + Letta tool handlers'],
  ['apps/agent-runtime/src/mcp-registry.test.ts', 'MCP degradation test suite'],
  ['apps/agent-runtime/src/vault-root.ts', 'Shared vault-root resolver'],
  ['packages/memory/src/letta-client.ts', 'Graceful Letta REST client'],
  ['packages/memory/src/jobs/archival-mirror.ts', 'Archival->vault mirror'],
];
for (const [rel, desc] of FILES) {
  const abs = resolve(root, rel);
  record(rel, existsSync(abs) && readFileSync(abs).length > 0, desc);
}

// ── source wiring assertions ────────────────────────────────────────────────
console.log(`\n${DIM}wiring${RESET}`);
{
  const reg = readIf('apps/agent-runtime/src/mcp-registry.ts') ?? '';
  record('buildMcpServers wires obsidian + letta servers', /buildObsidianServer/.test(reg) && /buildLettaServer/.test(reg), null);
  const sdkBoard = readIf('apps/agent-runtime/src/sdk-board.ts') ?? '';
  record('sdk-board passes mcpServers into query()', /mcpServers:\s*params\.mcpServers/.test(sdkBoard), null);
  const board = readIf('apps/agent-runtime/src/board.ts') ?? '';
  record('board.ts builds mcpServers inside the gated block', /sdkBoardsEnabled\(\)/.test(board) && /buildMcpServers\(/.test(board), null);
  const idx = readIf('packages/memory/src/index.ts') ?? '';
  record('@skippy/memory exports LettaClient + archival mirror', /letta-client/.test(idx) && /jobs\/index|archival-mirror/.test(idx + (readIf('packages/memory/src/jobs/index.ts') ?? '')), null);
}

// ── DECISIVE: headless degradation suites ──────────────────────────────────
console.log(`\n${DIM}headless degradation (exit criterion)${RESET}`);
// mcp-registry.test.ts: builds obsidian+letta servers with everything offline,
// asserts tools return isError AND letta_append_archival mirrors to agent_log.md.
runStep('agent-runtime MCP tests (pnpm --filter @skippy/agent-runtime test)', PNPM, ['--filter', '@skippy/agent-runtime', 'test']);
// memory suite covers letta-client.test.ts + archival-mirror.test.ts.
runStep('memory suite incl. letta-client + mirror (pnpm --filter @skippy/memory test)', PNPM, ['--filter', '@skippy/memory', 'test']);

// ── no regression: Phase 3 gate still green (feature gated OFF) ─────────────
console.log(`\n${DIM}no regression${RESET}`);
runStep('validate:phase3 still passes (PHASE3_AGENTS_ENABLED off)', PNPM, ['validate:phase3']);

// ── summary ────────────────────────────────────────────────────────────────
const passed = results.filter((r) => r.ok).length;
const total = results.length;
const allGreen = passed === total;
console.log(
  `\n${allGreen ? GREEN : RED}${passed}/${total} checks passed${RESET}` +
    (allGreen ? ' — Phase 3.5 exit gate cleared (D1 + D4 complete).' : ''),
);
process.exit(allGreen ? 0 : 1);
