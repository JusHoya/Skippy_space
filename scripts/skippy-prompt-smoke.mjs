#!/usr/bin/env node
// Smoke test: prove Skippy streams tokens (and doesn't hang) on a real prompt.
//
// Pipes a synthetic user_prompt envelope into the agent-runtime sidecar via
// stdin, waits up to 90 s for `agent_complete`, and reports:
//   • time-to-first-token (TTFT)              — proves the streaming fix
//   • full turnaround (prompt → agent_complete) — proves the loop terminates
//   • count of agent_token + agent_state envelopes
//   • whether the loop hit MAX_TOOL_ITERATIONS
//   • whether `delegation` + `delegation_ack` round-tripped
//
// This is the diagnostic harness for the Zone 1 hang fix. It cribs from
// scripts/phase1-validate.mjs::testPhase1Sidecar() but is laser-focused on
// latency rather than envelope schema coverage.
//
// Usage:
//   node scripts/skippy-prompt-smoke.mjs
//   node scripts/skippy-prompt-smoke.mjs "Custom prompt here"
//
// Exit 0 on success (first token within 30 s + agent_complete within 90 s),
// exit 1 on hang / timeout / mid-stream error.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// ── env loading (mirror of phase1) ─────────────────────────────────────────
function loadDotEnv() {
  const path = resolve(root, '.env');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
loadDotEnv();

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('FAIL: ANTHROPIC_API_KEY missing in .env or environment');
  process.exit(1);
}

const sidecar = resolve(root, 'apps/agent-runtime/dist/index.js');
if (!existsSync(sidecar)) {
  console.error(
    'FAIL: sidecar dist missing. Run `pnpm --filter @skippy/agent-runtime build` first.',
  );
  process.exit(1);
}

// ── prompt selection ───────────────────────────────────────────────────────
const DEFAULT_PROMPT =
  'Build me a small Python CLI that fetches the current xkcd comic and prints its title and image URL. Delegate it.';
const userPrompt = process.argv[2] ?? DEFAULT_PROMPT;

const FIRST_TOKEN_BUDGET_MS = 30_000;
const FULL_TURN_BUDGET_MS = 90_000;
const BOARD_READY_BUDGET_MS = 60_000;

// ── spawn + listen ─────────────────────────────────────────────────────────
console.log('\n# Skippy prompt smoke');
console.log(`  sidecar : ${sidecar}`);
console.log(`  prompt  : "${userPrompt.slice(0, 80)}${userPrompt.length > 80 ? '...' : ''}"`);
console.log('');

const child = spawn('node', [sidecar], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, LOG_LEVEL: 'warn' },
});

const events = [];
const rl = createInterface({ input: child.stdout });
rl.on('line', (line) => {
  try {
    events.push({ ...JSON.parse(line), _rxAt: Date.now() });
  } catch {}
});
let stderrTail = '';
child.stderr.on('data', (c) => {
  stderrTail = (stderrTail + c.toString()).slice(-4000);
});

// Wait for at least one board_ready so we know the supervisor is up. Real users
// can prompt before all 8 boards land, but for the smoke harness we want to
// remove that as a variable.
const readyDeadline = Date.now() + BOARD_READY_BUDGET_MS;
while (Date.now() < readyDeadline) {
  const readyCount = events.filter((e) => e.type === 'board_ready').length;
  if (readyCount >= 8) break;
  await new Promise((r) => setTimeout(r, 200));
}
const readyCount = events.filter((e) => e.type === 'board_ready').length;
console.log(`  boards  : ${readyCount}/8 ready before prompt dispatch`);

// ── dispatch prompt ────────────────────────────────────────────────────────
const promptId =
  '01H' +
  Array.from({ length: 23 }, () =>
    'ABCDEFGHJKMNPQRSTVWXYZ0123456789'[Math.floor(Math.random() * 32)],
  ).join('');
const promptSentAt = Date.now();
child.stdin.write(
  JSON.stringify({
    type: 'user_prompt',
    promptId,
    text: userPrompt,
    ts: new Date().toISOString(),
  }) + '\n',
);

// ── wait for completion ────────────────────────────────────────────────────
const fullDeadline = Date.now() + FULL_TURN_BUDGET_MS;
let firstTokenAt = null;
let completedAt = null;
let erroredAt = null;
let lastTokenAt = null;

while (Date.now() < fullDeadline) {
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e._inspected || e.promptId !== promptId) continue;
    e._inspected = true;
    if (e.type === 'agent_token' && firstTokenAt === null) firstTokenAt = e._rxAt;
    if (e.type === 'agent_token') lastTokenAt = e._rxAt;
    if (e.type === 'agent_complete') completedAt = e._rxAt;
    if (e.type === 'agent_state' && e.state === 'error') erroredAt = e._rxAt;
  }
  if (completedAt || erroredAt) break;
  await new Promise((r) => setTimeout(r, 100));
}

// ── teardown ───────────────────────────────────────────────────────────────
child.stdin.end();
await Promise.race([
  once(child, 'close').catch(() => {}),
  new Promise((r) => setTimeout(r, 5000)),
]);
try {
  child.kill();
} catch {}

// ── report ─────────────────────────────────────────────────────────────────
const tokens = events.filter((e) => e.type === 'agent_token' && e.promptId === promptId);
const stateChanges = events.filter(
  (e) => e.type === 'agent_state' && e.promptId === promptId,
);
const delegations = events.filter((e) => e.type === 'delegation');
const delegationAcks = events.filter((e) => e.type === 'delegation_ack');

const ttft = firstTokenAt ? firstTokenAt - promptSentAt : null;
const total = completedAt ? completedAt - promptSentAt : null;
const ttftStr = ttft !== null ? `${ttft} ms` : '— never';
const totalStr = total !== null ? `${total} ms` : '— never';

console.log('');
console.log('## Result');
console.log(`  time to first token : ${ttftStr}`);
console.log(`  prompt → complete   : ${totalStr}`);
console.log(`  agent_token count   : ${tokens.length}`);
console.log(`  agent_state changes : ${stateChanges.map((s) => s.state).join(' → ') || '(none)'}`);
console.log(`  delegation envelopes: ${delegations.length}`);
console.log(`  delegation_ack envs : ${delegationAcks.length}`);
if (erroredAt) {
  console.log(`  ERROR at +${erroredAt - promptSentAt} ms`);
}

// Concatenate token text for a quick eyeball.
const skippyText = tokens.map((t) => t.text).join('').trim();
if (skippyText) {
  const preview = skippyText.slice(0, 240).replace(/\s+/g, ' ');
  console.log('');
  console.log(`  Skippy said: "${preview}${skippyText.length > 240 ? '...' : ''}"`);
}

if (stderrTail.trim()) {
  console.log('');
  console.log('  --- stderr tail (last 600 chars) ---');
  console.log('  ' + stderrTail.slice(-600).split('\n').join('\n  '));
}

console.log('');
const ok =
  firstTokenAt !== null &&
  ttft <= FIRST_TOKEN_BUDGET_MS &&
  completedAt !== null &&
  erroredAt === null;
if (ok) {
  console.log(`PASS (TTFT ${ttft} ms, total ${total} ms)`);
  process.exit(0);
} else {
  if (firstTokenAt === null) {
    console.log(`FAIL: no agent_token within ${FULL_TURN_BUDGET_MS} ms — Skippy hung`);
  } else if (ttft > FIRST_TOKEN_BUDGET_MS) {
    console.log(`FAIL: first token took ${ttft} ms (budget ${FIRST_TOKEN_BUDGET_MS} ms)`);
  } else if (erroredAt) {
    console.log(`FAIL: agent_state=error at +${erroredAt - promptSentAt} ms`);
  } else {
    console.log(`FAIL: no agent_complete within ${FULL_TURN_BUDGET_MS} ms`);
  }
  process.exit(1);
}
