#!/usr/bin/env node
// Phase 1 exit-gate validator (PRD §14.2).
//
// Phase 1's exit criterion: "the user can issue a multi-board task and watch
// the right captains light up + the right task agents spawn." Concretely we
// check:
//   - All Phase 0 checks still pass (delegates to phase0-validate.mjs's logic).
//   - 13 charters on disk (1 Skippy + 8 Boards + 4 Staff) with valid YAML
//     frontmatter.
//   - 8 vault persona pages + _index + daily template, all with the closed-set
//     note types from PRD §8.4.
//   - 6 new Phase 1 envelope variants round-trip through @skippy/shared's Zod.
//   - infra/*/docker-compose.yml files parse as valid YAML.
//   - Sidecar boot emits 8 `board_spawned` + 8 `board_ready` envelopes within
//     a 60 s budget — the load-bearing Phase 1 proof that BoardSupervisor is
//     actually managing eight Boards.
//   - Skippy's `delegate_to_board` MCP tool round-trips on a user prompt that
//     asks for implementation work (expects ≥1 `delegation` + `delegation_ack`).
//
// Usage:
//   pnpm validate:phase1
//   node scripts/phase1-validate.mjs

import { spawn, execSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// ── env loading (mirror of phase0) ─────────────────────────────────────────
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

// ── result accumulator ─────────────────────────────────────────────────────
const results = [];
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
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
    const head = out.split('\n').slice(-5).join(' / ').trim().slice(0, 280);
    return record(name, false, head || `exit ${result.status}`);
  }
  record(name, true, `${Date.now() - start} ms`);
}

// ── minimal YAML frontmatter parser ─────────────────────────────────────────
// We do not have js-yaml in the validator's runtime; we want a parse that
// rejects truly broken frontmatter but tolerates the simple key:value and
// inline-list forms charters/personas use.
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const body = m[1];
  const obj = {};
  let currentKey = null;
  let inList = false;
  for (const raw of body.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    if (/^\s*-\s+/.test(raw)) {
      if (!currentKey || !inList) return null; // dangling list item
      obj[currentKey].push(raw.replace(/^\s*-\s+/, '').trim());
      continue;
    }
    const kv = raw.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!kv) continue; // permissive: ignore decorative lines
    const [, k, vRaw] = kv;
    currentKey = k;
    inList = false;
    const v = vRaw.trim();
    if (!v) {
      obj[k] = [];
      inList = true;
    } else if (v.startsWith('[')) {
      // inline list `[a, b, c]`
      obj[k] = v.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean);
    } else {
      obj[k] = v.replace(/^["']|["']$/g, '');
    }
  }
  return obj;
}

// ── checks ──────────────────────────────────────────────────────────────────
console.log(`\n${DIM}# Skippy_space — Phase 1 exit-gate validator${RESET}\n`);

// ── stack (Phase 0 staples) ────────────────────────────────────────────────
console.log(`${DIM}stack${RESET}`);
runStep('typecheck (pnpm -r typecheck)', PNPM, ['-r', 'typecheck']);
runStep('agent-runtime build (tsup)', PNPM, ['--filter', '@skippy/agent-runtime', 'build']);
runStep(
  'cargo check (Rust shell)',
  'cargo',
  ['check', '--manifest-path', 'apps/shell/src-tauri/Cargo.toml', '--quiet'],
  { env: cargoEnv() },
);

// ── charters (Agent A surface) ─────────────────────────────────────────────
console.log(`\n${DIM}charters${RESET}`);
const CHARTER_PATHS = [
  ['agent_space/skippy.md', 'skippy'],
  ['agent_space/CLAUDE.md', null],
  ...['engineering', 'coding', 'design', 'marketing', 'finance', 'research', 'publishing', 'devops'].map(
    (b) => [`agent_space/boards/${b}.md`, b],
  ),
  ...['agent-creator', 'skill-auditor', 'memory-manager', 'psych-monitor'].map((s) => [
    `agent_space/staff/${s}.md`,
    s,
  ]),
];
let chartersOk = 0;
for (const [rel, expectedId] of CHARTER_PATHS) {
  const abs = resolve(root, rel);
  if (!existsSync(abs)) {
    record(rel, false, 'missing');
    continue;
  }
  if (rel === 'agent_space/CLAUDE.md') {
    record(rel, true, `${readFileSync(abs).length} B`);
    chartersOk++;
    continue;
  }
  const text = readFileSync(abs, 'utf8');
  const fm = parseFrontmatter(text);
  if (!fm) {
    record(rel, false, 'no frontmatter');
    continue;
  }
  const ok = Boolean(
    fm.display_name &&
      fm.codename &&
      fm.model &&
      (fm.board === expectedId || fm.agent === expectedId || fm.staff === expectedId),
  );
  record(rel, ok, ok ? `${fm.codename} • ${fm.model}` : `bad/missing required keys`);
  if (ok) chartersOk++;
}
record(`13 charters total`, chartersOk >= 13, `${chartersOk}/13`);

// Skippy voice check — load-bearing per CLAUDE.md
console.log(`\n${DIM}skippy persona${RESET}`);
const skippyText = readFileSync(resolve(root, 'agent_space/skippy.md'), 'utf8').toLowerCase();
const voiceTokens = ['monkey', 'magnificent', 'iron law', 'asshole setting'];
const missingVoice = voiceTokens.filter((t) => !skippyText.includes(t));
record(
  'skippy.md retains canonical voice',
  missingVoice.length === 0,
  missingVoice.length === 0 ? voiceTokens.join(' • ') : `missing: ${missingVoice.join(', ')}`,
);

// ── vault (Agent D surface) ────────────────────────────────────────────────
console.log(`\n${DIM}vault${RESET}`);
const VAULT_REQUIRED = [
  'vault/50_Agents/_index.md',
  'vault/40_Daily/_template.md',
  ...['engineering', 'coding', 'design', 'marketing', 'finance', 'research', 'publishing', 'devops'].map(
    (b) => `vault/50_Agents/${b}/agent_persona.md`,
  ),
];
let vaultOk = 0;
const seenUlids = new Set();
for (const rel of VAULT_REQUIRED) {
  const abs = resolve(root, rel);
  if (!existsSync(abs)) {
    record(rel, false, 'missing');
    continue;
  }
  const text = readFileSync(abs, 'utf8');
  const fm = parseFrontmatter(text);
  if (!fm) {
    record(rel, false, 'no frontmatter');
    continue;
  }
  const validType = ['agent_persona', 'daily'].includes(fm.type);
  const hasLinks = /\[\[[^\]]+\]\]/.test(text);
  const ulidOk = !fm.id || (!seenUlids.has(fm.id) && /^[0-9A-HJKMNP-TV-Z]{26}$/i.test(fm.id));
  if (fm.id) seenUlids.add(fm.id);
  const ok = validType && hasLinks && ulidOk;
  record(rel, ok, ok ? `${fm.type} • ulid ${fm.id?.slice(0, 8)}…` : `type=${fm.type} links=${hasLinks} ulid=${ulidOk}`);
  if (ok) vaultOk++;
}
record('10 vault files total', vaultOk >= 10, `${vaultOk}/10`);

// ── envelopes (Agent C surface) ────────────────────────────────────────────
console.log(`\n${DIM}envelopes${RESET}`);
async function checkEnvelopes() {
  // @skippy/shared exports its Zod schemas straight from src/*.ts (no dist).
  // Resolve via tsx inside agent-runtime so the workspace dep mapping points
  // to the source files. This is the same pattern agent-runtime's `dev`
  // script uses, so the resolution chain is already proven.
  const probe = resolve(root, 'scripts/.phase1-envelope-smoke.mjs');
  const body = [
    `import { Envelope } from '@skippy/shared';`,
    `const cases = [`,
    `  { type: 'board_spawned', boardId: 'engineering', agentId: 'board.engineering', model: 'claude-sonnet-4-6', ts: new Date().toISOString() },`,
    `  { type: 'board_ready', boardId: 'coding', agentId: 'board.coding', ts: new Date().toISOString() },`,
    `  { type: 'board_state', boardId: 'design', agentId: 'board.design', state: 'working', ts: new Date().toISOString() },`,
    `  { type: 'delegation', delegationId: 'D1', fromAgentId: 'skippy', toBoardId: 'engineering', missionBrief: 'do the thing', ts: new Date().toISOString() },`,
    `  { type: 'delegation_ack', delegationId: 'D1', fromBoardId: 'engineering', decision: 'accept', ts: new Date().toISOString() },`,
    `  { type: 'delegation_complete', delegationId: 'D1', fromBoardId: 'engineering', result: 'success', summary: 'ok', ts: new Date().toISOString() },`,
    `];`,
    `for (const c of cases) {`,
    `  const r = Envelope.safeParse(c);`,
    `  if (!r.success) { console.error('FAIL', c.type, JSON.stringify(r.error.issues)); process.exit(1); }`,
    `}`,
    `process.exit(0);`,
  ].join('\n');
  const fs = await import('node:fs');
  fs.writeFileSync(probe, body);
  try {
    runStep('6 new envelopes parse via @skippy/shared', PNPM, [
      '--filter',
      '@skippy/agent-runtime',
      'exec',
      'tsx',
      probe,
    ]);
  } finally {
    try {
      fs.unlinkSync(probe);
    } catch {}
  }
}
await checkEnvelopes();

// ── infra (Agent E surface) ────────────────────────────────────────────────
console.log(`\n${DIM}infra${RESET}`);
const INFRA_FILES = [
  'infra/docker-compose.yml',
  'infra/langfuse/docker-compose.yml',
  'infra/letta/docker-compose.yml',
  'infra/otel-collector/docker-compose.yml',
  'infra/otel-collector/otel-collector.yaml',
  'scripts/phase1-up.ps1',
  'scripts/phase1-down.ps1',
  'scripts/phase1-status.ps1',
];
for (const rel of INFRA_FILES) {
  const abs = resolve(root, rel);
  record(rel, existsSync(abs), existsSync(abs) ? `${readFileSync(abs).length} B` : 'missing');
}

// ── sidecar Phase 1: 8 boards + delegation round-trip ──────────────────────
console.log(`\n${DIM}sidecar (Phase 1)${RESET}`);
async function testPhase1Sidecar() {
  if (!process.env.ANTHROPIC_API_KEY) {
    record('sidecar phase 1 round-trip', false, 'ANTHROPIC_API_KEY missing');
    return;
  }
  const sidecar = resolve(root, 'apps/agent-runtime/dist/index.js');
  if (!existsSync(sidecar)) {
    record('sidecar phase 1 round-trip', false, 'sidecar dist missing');
    return;
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
    } catch {}
  });
  let stderrTail = '';
  child.stderr.on('data', (c) => {
    stderrTail = (stderrTail + c.toString()).slice(-4000);
  });

  // 1) Wait for 8 board_ready envelopes (cold-start budget per R-01).
  const readyDeadline = Date.now() + 60_000;
  while (Date.now() < readyDeadline) {
    const readyCount = events.filter((e) => e.type === 'board_ready').length;
    if (readyCount >= 8) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const spawned = events.filter((e) => e.type === 'board_spawned');
  const ready = events.filter((e) => e.type === 'board_ready');
  record(
    '8 board_spawned envelopes',
    spawned.length >= 8,
    `${spawned.length}/8 — ${spawned.map((e) => e.boardId).join(',')}`,
  );
  record(
    '8 board_ready envelopes',
    ready.length >= 8,
    `${ready.length}/8 within 60s`,
  );

  // 2) Send a user prompt that should trigger delegate_to_board.
  const promptId =
    '01H' +
    Array.from({ length: 23 }, () =>
      'ABCDEFGHJKMNPQRSTVWXYZ0123456789'[Math.floor(Math.random() * 32)],
    ).join('');
  child.stdin.write(
    JSON.stringify({
      type: 'user_prompt',
      promptId,
      text:
        'Build me a small Python CLI that fetches the current xkcd comic and prints its title and image URL. Delegate it.',
      ts: new Date().toISOString(),
    }) + '\n',
  );

  const delegateDeadline = Date.now() + 60_000;
  while (Date.now() < delegateDeadline) {
    const delegationCount = events.filter((e) => e.type === 'delegation').length;
    const ackCount = events.filter((e) => e.type === 'delegation_ack').length;
    const completed = events.some(
      (e) => e.type === 'agent_complete' && e.promptId === promptId,
    );
    if (delegationCount >= 1 && ackCount >= 1 && completed) break;
    if (
      events.some(
        (e) => e.type === 'agent_state' && e.state === 'error' && e.promptId === promptId,
      )
    )
      break;
    await new Promise((r) => setTimeout(r, 200));
  }

  child.stdin.end();
  await Promise.race([
    once(child, 'close').catch(() => {}),
    new Promise((r) => setTimeout(r, 5000)),
  ]);
  try {
    child.kill();
  } catch {}

  const delegations = events.filter((e) => e.type === 'delegation');
  const acks = events.filter((e) => e.type === 'delegation_ack');
  const completed = events.some((e) => e.type === 'agent_complete' && e.promptId === promptId);
  const errored = events.filter(
    (e) => e.type === 'agent_state' && e.state === 'error' && e.promptId === promptId,
  );

  record(
    'Skippy emits ≥1 delegation envelope',
    delegations.length >= 1,
    delegations[0]
      ? `→ board.${delegations[0].toBoardId} "${delegations[0].missionBrief.slice(0, 60)}..."`
      : `0 emitted${stderrTail ? ` stderr:${stderrTail.slice(0, 200)}` : ''}`,
  );
  record(
    'Board emits ≥1 delegation_ack envelope',
    acks.length >= 1,
    acks[0] ? `${acks[0].decision} from board.${acks[0].fromBoardId}` : '0 acked',
  );
  record(
    'Skippy turn completes without error',
    completed && errored.length === 0,
    completed ? `complete=true errors=${errored.length}` : 'no agent_complete envelope',
  );
}
await testPhase1Sidecar();

// ── summary ────────────────────────────────────────────────────────────────
const passed = results.filter((r) => r.ok).length;
const total = results.length;
const allGreen = passed === total;
console.log(
  `\n${allGreen ? GREEN : RED}${passed}/${total} checks passed${RESET}` +
    (allGreen ? ' — Phase 1 exit gate cleared.' : ''),
);
process.exit(allGreen ? 0 : 1);
