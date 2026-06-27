#!/usr/bin/env node
// Phase 4 exit-gate validator — "Polish + Ship" (the buildable subset).
//
// This session's Phase 4 scope (PRD §14.5) deliberately EXCLUDES the ship
// infrastructure that needs real secrets we can't provision headlessly — EV
// code-signing (Azure Key Vault cert), the Tauri auto-updater endpoint, and the
// v1.0 release. Those stay TODO in §14.5. What this gate proves landed:
//
//   1. Sprite v1 — the procedural beercans got the "generative" polish (OQ-02:
//      generative throughout, NO binary assets). Asserted at the source level
//      (the gate runs no Pixi/WebGPU runtime) + a hard "no asset loaders" rule.
//   2. Onboarding flow + in-app docs (F1) — first-run Skippy intro, CLAUDE.md
//      scan, sample mission; a searchable docs panel on F1 (the minimap `size`
//      layer that used to own F1 moved to Shift+F1). Skippy's voice is NOT
//      stripped from the onboarding copy (root CLAUDE.md "Don't strip" rule).
//   3. Letta carryover — OQ-D4-01..04 resolved: the REST client is hardened to
//      the VERIFIED current Letta v1 contract (with graceful legacy fallbacks),
//      a live-verify script exists, and a letta-bootstrap provisioning job
//      replaces the old manual "pre-create each board agent" step.
//
// Fully headless + deterministic: NO Docker, NO live Letta/Obsidian, NO
// ANTHROPIC_API_KEY. The decisive proofs are the @skippy/memory + @skippy/ui
// test suites and the two Letta CLI scripts SKIPPING cleanly (exit 0) with no
// server. The gate also re-runs validate:phase3.5 to prove zero regression.
//
// Usage:
//   pnpm validate:phase4
//   node scripts/phase4-validate.mjs

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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

console.log(`\n${DIM}# Skippy_space — Phase 4 exit-gate validator (Polish: sprites + onboarding/docs + Letta carryover)${RESET}\n`);

// ── stack ───────────────────────────────────────────────────────────────────
console.log(`${DIM}stack${RESET}`);
runStep('typecheck (pnpm -r typecheck)', PNPM, ['-r', 'typecheck']);
runStep('agent-runtime build (tsup)', PNPM, ['--filter', '@skippy/agent-runtime', 'build']);

// ── Sprite v1 (OQ-02: generative polish, NO binary assets) ──────────────────
console.log(`\n${DIM}sprite v1 (generative, no binary assets)${RESET}`);
{
  const beercan = readIf('packages/sprite-kit/src/beercan.ts') ?? '';
  const index = readIf('packages/sprite-kit/src/index.ts') ?? '';
  const gallery = readIf('apps/ui/src/gallery/SpriteGallery.tsx') ?? '';

  // The v1 metal/3D treatment: the new layered BeercanRefs the polish introduced.
  const layers = ['bodyShade', 'rimTop', 'rimBottom', 'ledGlow', 'antennaGlow'];
  const present = layers.filter((l) => beercan.includes(l));
  record('beercan.ts gained the v1 metal/3D layers', present.length === layers.length, present.join(','));
  record('paintBrushedMetal exported from sprite-kit', /export\s+function\s+paintBrushedMetal/.test(beercan) && /paintBrushedMetal/.test(index), null);
  record('listAllCostumes exported (Skippy + 8 boards roster)', /export\s+function\s+listAllCostumes/.test(index), null);
  record('gallery showcases the animation-state matrix', /SHOWCASE_STATES/.test(gallery) && /Animation states/.test(gallery), null);

  // The load-bearing OQ-02 invariant: every pixel is procedural Graphics. No
  // texture/atlas/PNG loader may appear anywhere in sprite-kit/src — if one does,
  // the "generative throughout" rule silently broke.
  const FORBIDDEN = /\.png|\.webp|\.atlas|Assets\.load|Texture\.from|Spritesheet|loadTexture/;
  const srcDir = resolve(root, 'packages/sprite-kit/src');
  const offenders = [];
  for (const f of existsSync(srcDir) ? readdirSync(srcDir) : []) {
    if (!f.endsWith('.ts')) continue;
    if (FORBIDDEN.test(readFileSync(resolve(srcDir, f), 'utf8'))) offenders.push(f);
  }
  record('sprite-kit stays 100% procedural (no asset loaders)', offenders.length === 0, offenders.length ? `offenders: ${offenders.join(',')}` : 'no .png/atlas/Texture.from');
}

// ── Onboarding flow + in-app docs (F1) ──────────────────────────────────────
console.log(`\n${DIM}onboarding + in-app docs (F1)${RESET}`);
{
  for (const [rel, desc] of [
    ['apps/ui/src/hud/Onboarding.tsx', 'first-run Skippy intro + CLAUDE.md scan + sample mission'],
    ['apps/ui/src/hud/DocsPanel.tsx', 'searchable in-app docs panel'],
  ]) {
    const abs = resolve(root, rel);
    record(rel, existsSync(abs) && readFileSync(abs).length > 0, desc);
  }

  const uiStore = readIf('apps/ui/src/stores/uiStore.ts') ?? '';
  record('uiStore exposes docs + first-run state', /ONBOARDING_SEEN_KEY/.test(uiStore) && /docsOpen/.test(uiStore) && /onboardingOpen/.test(uiStore) && /toggleDocs/.test(uiStore), null);

  const hotkeys = readIf('apps/ui/src/hud/Hotkeys.tsx') ?? '';
  // F1 now opens docs; the displaced minimap `size` layer lives on Shift+F1.
  record('F1 → toggleDocs (in-app docs)', /toggleDocs\(\)/.test(hotkeys), null);
  // The plain F_KEY_LAYERS block must no longer carry F1 (it moved to Shift+F1).
  // Isolate that object literal and assert F1 is absent from it, while the
  // SHIFT_F_KEY_LAYERS block maps F1 → size.
  const fBlock = (/const F_KEY_LAYERS[^}]*\}/.exec(hotkeys) ?? [''])[0];
  const shiftBlock = (/const SHIFT_F_KEY_LAYERS[^}]*\}/.exec(hotkeys) ?? [''])[0];
  record("minimap `size` layer re-homed off F1 (Shift+F1)", !/F1\s*:/.test(fBlock) && /F1\s*:\s*'size'/.test(shiftBlock), null);

  const app = readIf('apps/ui/src/App.tsx') ?? '';
  record('App mounts <Onboarding /> + <DocsPanel />', /<Onboarding\s*\/>/.test(app) && /<DocsPanel\s*\/>/.test(app), null);

  // Root CLAUDE.md "Don't strip Skippy's voice" — onboarding copy is spoken BY
  // Skippy, so it must carry the persona tokens. Docs panel must teach the Iron Law.
  const onboarding = readIf('apps/ui/src/hud/Onboarding.tsx') ?? '';
  record('onboarding keeps Skippy voice (monkey + Magnificent)', /monkey/i.test(onboarding) && /magnificent/i.test(onboarding), null);
  const docs = readIf('apps/ui/src/hud/DocsPanel.tsx') ?? '';
  record('docs panel teaches the Iron Law of Delegation', /Iron Law/.test(docs), null);
}

// ── Letta carryover (OQ-D4-01..04) ──────────────────────────────────────────
console.log(`\n${DIM}letta carryover (OQ-D4-01..04)${RESET}`);
{
  const client = readIf('packages/memory/src/letta-client.ts') ?? '';
  // OQ-D4-01/02/03: the VERIFIED current Letta v1 contract replaced the guesses.
  record('letta-client hardened to VERIFIED Letta v1 contract', /VERIFIED/.test(client) && /archival-memory\/search/.test(client) && /core-memory\/blocks/.test(client) && !/PROVISIONAL/.test(client), null);
  record('letta-client gained listAgents + createAgent (for bootstrap)', /async\s+listAgents/.test(client) && /async\s+createAgent/.test(client), null);

  // OQ-D4-04: the provisioning job + its barrel export.
  const bootstrap = readIf('packages/memory/src/jobs/letta-bootstrap.ts');
  record('packages/memory/src/jobs/letta-bootstrap.ts', bootstrap !== null && bootstrap.length > 0, 'provision per-board Letta agents from charters');
  const jobsIndex = readIf('packages/memory/src/jobs/index.ts') ?? '';
  record('jobs barrel re-exports letta-bootstrap', /letta-bootstrap/.test(jobsIndex), null);

  // The two CLI scripts must exist AND skip cleanly (exit 0) with no Letta — the
  // gate runs headless, so a script that hard-failed when the server is absent
  // would be unusable in CI. LETTA_DISABLED forces the zero-network path.
  for (const rel of ['scripts/letta-verify.mjs', 'scripts/letta-bootstrap.mjs']) {
    record(rel, existsSync(resolve(root, rel)), null);
  }
  const verify = spawnSync(process.execPath, ['scripts/letta-verify.mjs'], { cwd: root, stdio: 'pipe', shell: false, env: { ...process.env, LETTA_DISABLED: '1' } });
  record('letta-verify skips cleanly with Letta down (exit 0)', verify.status === 0, `exit ${verify.status}`);
  const boot = spawnSync(process.execPath, ['scripts/letta-bootstrap.mjs'], { cwd: root, stdio: 'pipe', shell: false, env: { ...process.env, LETTA_DISABLED: '1' } });
  record('letta-bootstrap skips cleanly with Letta down (exit 0)', boot.status === 0, `exit ${boot.status}`);
}

// ── DECISIVE: the behavioral test suites ────────────────────────────────────
console.log(`\n${DIM}behavioral suites (exit criterion)${RESET}`);
// @skippy/memory: includes letta-client endpoint-contract + bootstrap idempotency tests.
runStep('memory suite (pnpm --filter @skippy/memory test)', PNPM, ['--filter', '@skippy/memory', 'test']);
// @skippy/ui: includes the HUD specs the onboarding/docs wiring must not break.
runStep('ui suite (pnpm --filter @skippy/ui test)', PNPM, ['--filter', '@skippy/ui', 'test']);

// ── no regression: Phase 3.5 gate still green (re-runs Phase 3 inside) ───────
console.log(`\n${DIM}no regression${RESET}`);
runStep('validate:phase3.5 still passes (D1 + D4, gated path off)', PNPM, ['validate:phase3.5']);

// ── summary ─────────────────────────────────────────────────────────────────
const passed = results.filter((r) => r.ok).length;
const total = results.length;
const allGreen = passed === total;
console.log(
  `\n${allGreen ? GREEN : RED}${passed}/${total} checks passed${RESET}` +
    (allGreen ? ' — Phase 4 exit gate cleared (sprite v1 + onboarding/docs + Letta carryover). Ship infra (signing/updater/release) remains TODO in PRD §14.5.' : ''),
);
process.exit(allGreen ? 0 : 1);
