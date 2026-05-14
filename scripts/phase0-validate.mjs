#!/usr/bin/env node
// Phase 0 exit-gate validator.
//
// Runs every Phase 0 functional check end-to-end and prints a dashboard.
// Exits non-zero if any check fails. Designed to be safe to re-run any time
// without mutating repo state (no commits, no schema changes).
//
// Usage:
//   pnpm validate:phase0
//   node scripts/phase0-validate.mjs

import { spawn, execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// ── env loading ─────────────────────────────────────────────────────────────
function loadDotEnv() {
  const path = resolve(root, '.env');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
loadDotEnv();

// pnpm path resolution — handle winget-installed pnpm that isn't on PATH
function resolvePnpm() {
  try {
    execSync('pnpm --version', { stdio: 'pipe' });
    return 'pnpm';
  } catch {
    const wingetPath = `${process.env.LOCALAPPDATA}\\Microsoft\\WinGet\\Packages\\pnpm.pnpm_Microsoft.Winget.Source_8wekyb3d8bbwe\\pnpm.exe`;
    if (existsSync(wingetPath)) return wingetPath;
    throw new Error('pnpm not found on PATH or in winget user-scope. Install pnpm and retry.');
  }
}
const PNPM = resolvePnpm();

// Cargo target dir redirect — avoids SAC issues when a fresh shell has the env-var unset
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

function runShell(name, cmd, opts = {}) {
  const start = Date.now();
  try {
    execSync(cmd, { cwd: root, stdio: 'pipe', shell: true, ...opts });
    record(name, true, `${Date.now() - start} ms`);
  } catch (err) {
    const out = (err.stdout?.toString() ?? '') + (err.stderr?.toString() ?? '');
    const head = out.split('\n').slice(-5).join(' / ').trim().slice(0, 280);
    record(name, false, head || err.message.slice(0, 200));
  }
}

// ── checks ──────────────────────────────────────────────────────────────────
console.log(`\n${DIM}# Skippy_space — Phase 0 exit-gate validator${RESET}\n`);

console.log(`${DIM}stack${RESET}`);
runShell('typecheck (pnpm -r typecheck)', `"${PNPM}" -r typecheck`);
runShell('agent-runtime build (tsup)', `"${PNPM}" --filter @skippy/agent-runtime build`);
runShell('cargo check (Rust shell)', `cargo check --manifest-path apps/shell/src-tauri/Cargo.toml --quiet`, {
  env: cargoEnv(),
});

console.log(`\n${DIM}renderer${RESET}`);
runShell('visual smoke (Playwright, 3 specs)', `"${PNPM}" exec playwright test tests/visual/gallery.spec.ts --reporter=line`);

console.log(`\n${DIM}artifacts${RESET}`);
function checkExists(name, relPath) {
  const exists = existsSync(resolve(root, relPath));
  record(name, exists, exists ? relPath : `missing: ${relPath}`);
}
checkExists('sidecar built', 'apps/agent-runtime/dist/index.js');
checkExists('icons present (icon.ico)', 'apps/shell/src-tauri/icons/icon.ico');
checkExists('Tauri config', 'apps/shell/src-tauri/tauri.conf.json');
checkExists('PRD source-of-truth', 'docs/PRD.md');
checkExists('vault schema', 'vault/CLAUDE.md');
checkExists('.env.example committed', '.env.example');

// ── sidecar round-trip (real Anthropic call) ───────────────────────────────
console.log(`\n${DIM}end-to-end${RESET}`);

async function testSidecarRoundtrip() {
  if (!process.env.ANTHROPIC_API_KEY) {
    record('sidecar round-trip (real Claude call)', false, 'ANTHROPIC_API_KEY missing — set it in .env');
    return null;
  }
  const sidecar = resolve(root, 'apps/agent-runtime/dist/index.js');
  if (!existsSync(sidecar)) {
    record('sidecar round-trip (real Claude call)', false, 'sidecar dist missing; run pnpm build:runtime first');
    return null;
  }

  const child = spawn('node', [sidecar], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, LOG_LEVEL: 'warn' },
  });
  const events = [];
  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    try {
      events.push(JSON.parse(line));
    } catch {
      // ignore non-JSON noise (shouldn't happen — stdout is sacred)
    }
  });
  let stderrTail = '';
  child.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-4000);
  });

  // Build a synthetic ULID-like id (the Rust side accepts any string for promptId)
  const promptId =
    '01H' +
    Array.from({ length: 23 }, () =>
      'ABCDEFGHJKMNPQRSTVWXYZ0123456789'[Math.floor(Math.random() * 32)],
    ).join('');
  child.stdin.write(
    JSON.stringify({
      type: 'user_prompt',
      promptId,
      text: 'In one sentence: are you alive, monkey?',
      ts: new Date().toISOString(),
    }) + '\n',
  );

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (events.some((e) => e.type === 'agent_complete' && e.promptId === promptId)) break;
    if (events.some((e) => e.type === 'agent_state' && e.state === 'error' && e.promptId === promptId)) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  child.stdin.end();
  await Promise.race([
    once(child, 'close').catch(() => {}),
    new Promise((r) => setTimeout(r, 5000)),
  ]);
  try {
    child.kill();
  } catch {}

  const has = (type, state) =>
    events.some(
      (e) => e.type === type && (state == null || e.state === state) && (e.promptId === promptId || type === 'log'),
    );
  const tokens = events.filter((e) => e.type === 'agent_token' && e.promptId === promptId);
  const thinking = has('agent_state', 'thinking');
  const speaking = has('agent_state', 'speaking');
  const completed = has('agent_complete', null);
  const idle = events.some(
    (e) => e.type === 'agent_state' && e.state === 'idle' && e.promptId === promptId,
  );
  const erroredEvents = events.filter((e) => e.type === 'agent_state' && e.state === 'error');

  const ok = thinking && speaking && tokens.length > 0 && completed && idle && erroredEvents.length === 0;
  const detail = ok
    ? `${events.length} envelopes; ${tokens.length} tokens streamed`
    : `thinking=${thinking} speaking=${speaking} tokens=${tokens.length} completed=${completed} idle=${idle} errors=${erroredEvents.length}${stderrTail ? ` stderr:${stderrTail.slice(0, 200)}` : ''}`;
  record('sidecar round-trip (real Claude call)', ok, detail);

  if (ok) {
    const text = tokens.map((t) => t.text).join('');
    console.log(`\n  ${GREEN}Skippy says:${RESET} ${text.trim()}\n`);
  }
  return ok;
}
await testSidecarRoundtrip();

// ── summary ────────────────────────────────────────────────────────────────
const passed = results.filter((r) => r.ok).length;
const total = results.length;
const allGreen = passed === total;
console.log(
  `\n${allGreen ? GREEN : RED}${passed}/${total} checks passed${RESET}` +
    (allGreen ? ' — Phase 0 exit gate cleared.' : ''),
);
process.exit(allGreen ? 0 : 1);
