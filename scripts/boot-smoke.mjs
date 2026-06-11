#!/usr/bin/env node
// Boot smoke test — proves the BUILT sidecar (`dist/index.js`, the exact artifact
// the Tauri shell spawns via `node`) actually boots and brings up all 8 Boards.
//
// This is the gate that would have caught the dead-on-arrival regression in
// docs/REVIEW-2026-06-10.md §0: tsup left @skippy/memory external, so the bundled
// dist threw ERR_MODULE_NOT_FOUND at module load and the supervisor restart-looped
// forever — while every string-grep phase gate still reported green. String greps
// can't see a crash at runtime; this spawns the real artifact and watches stdout.
//
// Fully headless + deterministic: NO Docker, NO live Obsidian/Letta, NO
// ANTHROPIC_API_KEY (Board charter loading needs no network — only LLM *queries*
// do, which this test never triggers).
//
// Usage:
//   pnpm validate:boot          (builds the runtime first, then smokes it)
//   node scripts/boot-smoke.mjs --no-build   (smoke the existing dist as-is)

import { spawn, execSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const distEntry = resolve(root, 'apps/agent-runtime/dist/index.js');

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const EXPECTED_BOARDS = 8;
const BOOT_TIMEOUT_MS = 25_000;

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

function buildRuntime() {
  const PNPM = resolvePnpm();
  console.log(`${DIM}  building @skippy/agent-runtime…${RESET}`);
  const r = spawnSync(PNPM, ['--filter', '@skippy/agent-runtime', 'build'], {
    cwd: root,
    stdio: 'pipe',
    shell: false,
  });
  if (r.status !== 0) {
    const out = (r.stdout?.toString() ?? '') + (r.stderr?.toString() ?? '');
    console.error(`${RED}  build FAILED${RESET}\n${out.split('\n').slice(-12).join('\n')}`);
    process.exit(1);
  }
}

function smoke() {
  return new Promise((resolvePromise) => {
    const spawned = new Set();
    let settled = false;
    const tail = [];

    const child = spawn(process.execPath, [distEntry], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
      // No ANTHROPIC_API_KEY on purpose — boot must not depend on it.
      env: { ...process.env, PHASE3_AGENTS_ENABLED: '0' },
    });

    const done = (ok, detail) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.stdin.end();
        child.kill();
      } catch {}
      resolvePromise({ ok, detail, spawned: [...spawned] });
    };

    const timer = setTimeout(
      () =>
        done(
          false,
          `timed out after ${BOOT_TIMEOUT_MS} ms with ${spawned.size}/${EXPECTED_BOARDS} boards (${[...spawned].join(', ') || 'none'})`,
        ),
      BOOT_TIMEOUT_MS,
    );

    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        let env;
        try {
          env = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (env?.type === 'board_spawned' && typeof env.boardId === 'string') {
          spawned.add(env.boardId);
          if (spawned.size >= EXPECTED_BOARDS) done(true, `${spawned.size} boards spawned`);
        }
      }
    });

    const errTail = [];
    child.stderr.on('data', (c) => errTail.push(c.toString()));
    child.on('error', (e) => done(false, `spawn error: ${e.message}`));
    child.on('exit', (code) => {
      if (code !== 0) {
        tail.push(...errTail.join('').split('\n').slice(-10));
        done(false, `sidecar exited ${code} before booting: ${tail.join(' / ').slice(0, 400)}`);
      } else {
        done(false, `sidecar exited 0 with only ${spawned.size}/${EXPECTED_BOARDS} boards`);
      }
    });
  });
}

console.log('\nBoot smoke — spawning the built sidecar and watching for all 8 Boards\n');
if (!process.argv.includes('--no-build')) buildRuntime();
if (!existsSync(distEntry)) {
  console.error(`${RED}  FAIL${RESET}  dist not found at ${distEntry} (run the build first)`);
  process.exit(1);
}

const { ok, detail } = await smoke();
const tag = ok ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
console.log(`  ${tag}  built sidecar boots and spawns ${EXPECTED_BOARDS} boards  ${DIM}${detail}${RESET}\n`);
process.exit(ok ? 0 : 1);
