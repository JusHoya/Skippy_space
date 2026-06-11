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
// The invariant is NOT "zod is pinned to majors {3,4}" — that pin would fail the
// day someone legitimately bumps a major. The invariant is: agent-runtime runs
// its OWN zod major, distinct from the shared/memory major, and the resolved
// tree never silently drifts to a major NONE of the packages declared. We
// therefore derive the expected majors from the package.json ranges themselves
// and assert the resolved tree is a SUBSET of those — robust to a future bump.
console.log(`\n${DIM}zod scoping${RESET}`);
{
  // Read the declared zod major from a package.json's dependency range (the
  // first integer of the range, e.g. "^4.4.3" -> 4). Returns null if absent.
  function declaredZodMajor(rel) {
    const src = readIf(rel);
    if (!src) return null;
    try {
      const json = JSON.parse(src);
      const range =
        json.dependencies?.zod ?? json.devDependencies?.zod ?? json.peerDependencies?.zod;
      if (typeof range !== 'string') return null;
      const m = /(\d+)/.exec(range);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  }
  const arMajor = declaredZodMajor('apps/agent-runtime/package.json');
  const shMajor = declaredZodMajor('packages/shared/package.json');
  const memMajor = declaredZodMajor('packages/memory/package.json');
  record('agent-runtime declares a zod major', arMajor !== null, `zod@^${arMajor ?? '?'}`);
  record('shared declares a zod major', shMajor !== null, `zod@^${shMajor ?? '?'}`);
  record('memory declares a zod major', memMajor !== null, `zod@^${memMajor ?? '?'}`);
  // The real coexistence split: shared + memory agree, and agent-runtime diverges.
  record('shared + memory share one zod major', shMajor !== null && shMajor === memMajor, `shared=${shMajor} memory=${memMajor}`);
  record(
    'agent-runtime zod major diverges from shared/memory',
    arMajor !== null && arMajor !== shMajor,
    `agent-runtime=${arMajor} vs shared/memory=${shMajor}`,
  );

  // Resolved-tree containment: parse `pnpm ls --json` (structured, not freeform
  // text) and assert every resolved zod major is one a package actually declared
  // — i.e. no surprise third major crept in transitively. Subset, not exact set.
  const expected = new Set([arMajor, shMajor, memMajor].filter((x) => x !== null));
  const ls = spawnSync(PNPM, ['ls', 'zod', '-r', '--json'], { cwd: root, stdio: 'pipe', shell: false });
  const resolved = new Set();
  try {
    const tree = JSON.parse(ls.stdout?.toString() ?? '[]');
    for (const pkg of Array.isArray(tree) ? tree : []) {
      for (const group of ['dependencies', 'devDependencies']) {
        const v = pkg?.[group]?.zod?.version;
        if (typeof v === 'string') {
          const m = /^(\d+)\./.exec(v);
          if (m) resolved.add(m[1]);
        }
      }
    }
  } catch {
    // leave `resolved` empty → the check below records the parse failure
  }
  const unexpected = [...resolved].filter((maj) => !expected.has(maj));
  record(
    'resolved zod majors are all declared (no surprise drift)',
    resolved.size > 0 && unexpected.length === 0,
    resolved.size === 0
      ? 'could not read pnpm ls --json'
      : `resolved {${[...resolved].sort().join(',')}} ⊆ declared {${[...expected].sort().join(',')}}`,
  );

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
