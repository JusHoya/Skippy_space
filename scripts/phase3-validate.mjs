#!/usr/bin/env node
// Phase 3 exit-gate validator (PRD §14.4 — "Memory deepens").
//
// Phase 3 ships the Karpathy memory pipeline + the live telemetry surface:
//   - WS1 memory-core: §8.3 frontmatter schema + atomic/locked vault writes.
//   - WS2 client layer: Obsidian REST + bge-micro embeddings + vector store,
//     all degrading to no-op when their service is down.
//   - WS4 task charters: ingest / distiller / link / lint.
//   - WS5 four-job pipeline: ingest -> distill(mock|llm) -> link -> lint, plus a
//     chokidar inbox watcher. The DECISIVE check: a paper dropped into a tmp
//     vault 00_Inbox/ produces >=8 linked atomic notes (the memory e2e test).
//   - WS6 telemetry data path: token/cost extraction + the telemetry/replay
//     envelopes + the renderer's cost / latency / context / error widgets.
//
// The gate is deterministic and headless: no live LLM, Obsidian, or Docker.
// The distiller runs in `mock` mode; the real-LLM path is the same plumbing
// with SKIPPY_DISTILL_MODE=llm and is validated by a separate MANUAL checklist
// (see scripts/README.md).
//
// Usage:
//   pnpm validate:phase3
//   node scripts/phase3-validate.mjs

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// ── env + pnpm path resolution (mirrors phase0/1/2) ────────────────────────
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

function cargoEnv() {
  return {
    ...process.env,
    CARGO_TARGET_DIR:
      process.env.CARGO_TARGET_DIR ?? `${process.env.USERPROFILE}\\.cargo-skippy-target`,
    PATH: `${process.env.USERPROFILE}\\.cargo\\bin;${process.env.PATH}`,
  };
}

// ── result accumulator ──────────────────────────────────────────────────────
const results = [];
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const tag = ok ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
  const tail = detail ? `  ${DIM}${detail}${RESET}` : '';
  console.log(`  ${tag}  ${name}${tail}`);
}

function runStep(name, file, args = [], opts = {}) {
  const start = Date.now();
  const result = spawnSync(file, args, { cwd: root, stdio: 'pipe', shell: false, ...opts });
  if (result.error) return record(name, false, result.error.message.slice(0, 200));
  if (result.status !== 0) {
    const out = (result.stdout?.toString() ?? '') + (result.stderr?.toString() ?? '');
    const head = out.split('\n').slice(-6).join(' / ').trim().slice(0, 320);
    return record(name, false, head || `exit ${result.status}`);
  }
  record(name, true, `${Date.now() - start} ms`);
}

function readIf(rel) {
  const abs = resolve(root, rel);
  return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
}

// ── checks ──────────────────────────────────────────────────────────────────
console.log(`\n${DIM}# Skippy_space — Phase 3 exit-gate validator${RESET}\n`);

// ── stack (Phase 0/1/2 staples carried forward) ────────────────────────────
console.log(`${DIM}stack${RESET}`);
runStep('typecheck (pnpm -r typecheck)', PNPM, ['-r', 'typecheck']);
runStep('agent-runtime build (tsup)', PNPM, ['--filter', '@skippy/agent-runtime', 'build']);
runStep(
  'cargo check (Rust shell)',
  'cargo',
  ['check', '--manifest-path', 'apps/shell/src-tauri/Cargo.toml', '--quiet'],
  { env: cargoEnv() },
);

// ── DECISIVE: the memory unit + exit-criterion e2e suite ───────────────────
// `@skippy/memory`'s test suite includes pipeline.e2e.test.ts, which drops a
// fixture paper into a tmp vault 00_Inbox/ and asserts >=8 valid §8.3 atomic
// notes with distilled_from backlinks + >=1 [[wikilink]] in 20_Topics — the
// Phase 3 exit criterion, run deterministically with the mock distiller.
console.log(`\n${DIM}memory pipeline (exit criterion)${RESET}`);
runStep('memory unit + e2e (pnpm --filter @skippy/memory test)', PNPM, [
  '--filter',
  '@skippy/memory',
  'test',
]);

// ── Phase 3 file presence ──────────────────────────────────────────────────
console.log(`\n${DIM}phase 3 files${RESET}`);
const PHASE3_FILES = [
  // WS1 memory core
  ['packages/memory/src/frontmatter.ts', 'Frontmatter §8.3 schema'],
  ['packages/memory/src/atomic.ts', 'Atomic + locked vault writer'],
  // WS2 client layer
  ['packages/memory/src/obsidian-rest.ts', 'Obsidian Local REST client'],
  ['packages/memory/src/embeddings.ts', 'Smart Connections + bge-micro embeddings'],
  ['packages/memory/src/vector-store.ts', 'Vector store abstraction'],
  // WS5 pipeline
  ['packages/memory/src/jobs/ingest.ts', 'Ingest job'],
  ['packages/memory/src/jobs/distill.ts', 'Distill job (mock|llm)'],
  ['packages/memory/src/jobs/link.ts', 'Link job'],
  ['packages/memory/src/jobs/lint.ts', 'Lint job (read-only)'],
  ['packages/memory/src/vault-watcher.ts', 'Chokidar inbox watcher'],
  // WS6 telemetry
  ['packages/shared/src/pricing.ts', 'Model pricing + getCost'],
  ['packages/shared/src/model-limits.ts', 'Context limits + contextPct'],
  ['packages/shared/src/phase3.ts', 'Phase 3 telemetry/memory/replay envelopes'],
  ['apps/ui/src/stores/telemetryStore.ts', 'Telemetry aggregation store'],
  ['apps/ui/src/hud/TelemetryPanel.tsx', 'Cost/latency/context/error widgets'],
  // WS4 task charters
  ['agent_space/tasks/ingest.md', 'Ingest charter'],
  ['agent_space/tasks/distiller.md', 'Distiller charter'],
  ['agent_space/tasks/link.md', 'Link charter'],
  ['agent_space/tasks/lint.md', 'Lint charter'],
  // vault dirs
  ['vault/_index/schema-violations/.gitkeep', 'Lint schema-violations dir'],
];
for (const [rel, desc] of PHASE3_FILES) {
  const abs = resolve(root, rel);
  if (!existsSync(abs)) {
    record(rel, false, 'missing');
    continue;
  }
  const bytes = readFileSync(abs).length;
  // `.gitkeep` markers are intentionally empty — existence is the check.
  const ok = rel.endsWith('.gitkeep') ? true : bytes > 0;
  record(rel, ok, `${desc} • ${bytes} B`);
}

// ── non-stub assertions: WS1 modules carry real exports ────────────────────
console.log(`\n${DIM}non-stub assertions${RESET}`);
for (const rel of ['packages/memory/src/frontmatter.ts', 'packages/memory/src/atomic.ts']) {
  const src = readIf(rel) ?? '';
  const real = /export\s+(?:function|const|class)\s/.test(src) && !/^\s*export\s*\{\s*\}\s*;?\s*$/m.test(src.trim());
  record(`${rel} is non-stub`, real, real ? null : 'still a Phase-0 stub');
}
{
  const panel = readIf('apps/ui/src/hud/TelemetryPanel.tsx') ?? '';
  record(
    'TelemetryPanel consumes telemetryStore (not placeholder)',
    /useTelemetryStore/.test(panel),
    null,
  );
}

// ── envelope union carries the Phase 3 wire types ──────────────────────────
console.log(`\n${DIM}wire contracts${RESET}`);
{
  const env = readIf('packages/shared/src/envelope.ts') ?? '';
  for (const t of [
    'TelemetrySpanEnvelope',
    'ContextWindowEnvelope',
    'ErrorSpanEnvelope',
    'MemoryJobEnvelope',
    'ReplaySessionEnvelope',
  ]) {
    record(`Envelope union includes ${t}`, env.includes(t), null);
  }
}

// ── task charters parse as §6.1 frontmatter ────────────────────────────────
console.log(`\n${DIM}task charters${RESET}`);
for (const name of ['ingest', 'distiller', 'link', 'lint']) {
  const src = readIf(`agent_space/tasks/${name}.md`) ?? '';
  const fm = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(src);
  const body = fm?.[1] ?? '';
  const ok =
    !!fm &&
    /(^|\n)task:\s*\S/.test(body) &&
    /(^|\n)model:\s*\S/.test(body) &&
    /(^|\n)tools:\s*\[/.test(body);
  record(`${name}.md valid §6.1 frontmatter`, ok, null);
}

// ── cost/limits arithmetic smoke (tsx probe through agent-runtime) ─────────
console.log(`\n${DIM}cost arithmetic${RESET}`);
function writeProbe(name, body) {
  const probe = resolve(root, `scripts/.phase3-${name}.mjs`);
  writeFileSync(probe, body);
  return probe;
}
const costProbe = `
import { getCost, contextPct, MODEL_PRICING } from '@skippy/shared';
let failures = [];
function check(name, ok, info) { if (!ok) failures.push(\`\${name}: \${info ?? 'false'}\`); }
// Haiku @ 1M in + 1M out = $1 + $5 = $6.
const haiku = getCost('claude-haiku-4-5-20251001', 1_000_000, 1_000_000);
check('haiku 1M+1M = $6', Math.abs(haiku - 6) < 1e-9, \`got \${haiku}\`);
// Sonnet @ 1M in = $3.
check('sonnet 1M in = $3', Math.abs(getCost('claude-sonnet-4-6', 1_000_000, 0) - 3) < 1e-9, null);
// Unknown model falls back, never NaN.
check('unknown model not NaN', Number.isFinite(getCost('mystery', 1000, 1000)), null);
// contextPct clamps 0..1.
check('contextPct clamps to 1', contextPct('claude-haiku-4-5-20251001', 999_999_999) === 1, null);
check('pricing table has 3 models', Object.keys(MODEL_PRICING).length === 3, null);
if (failures.length > 0) { console.error('FAIL\\n' + failures.map((f) => '  - ' + f).join('\\n')); process.exit(1); }
console.log('OK');
`;
{
  const probe = writeProbe('cost', costProbe);
  try {
    runStep('probe.cost (getCost/contextPct)', PNPM, [
      '--filter',
      '@skippy/agent-runtime',
      'exec',
      'tsx',
      probe,
    ]);
  } finally {
    try { unlinkSync(probe); } catch {}
  }
}

// ── visual smoke (refreshes the HUD baseline incl. TelemetryPanel) ─────────
console.log(`\n${DIM}visual${RESET}`);
runStep('playwright (gallery + hud)', PNPM, [
  'exec',
  'playwright',
  'test',
  'tests/visual/gallery.spec.ts',
  '--reporter=line',
]);

// ── summary ────────────────────────────────────────────────────────────────
const passed = results.filter((r) => r.ok).length;
const total = results.length;
const allGreen = passed === total;
console.log(
  `\n${allGreen ? GREEN : RED}${passed}/${total} checks passed${RESET}` +
    (allGreen ? ' — Phase 3 exit gate cleared.' : ''),
);
process.exit(allGreen ? 0 : 1);
