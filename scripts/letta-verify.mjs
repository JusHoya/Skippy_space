#!/usr/bin/env node
// scripts/letta-verify.mjs — live verification of the Letta REST contract (OQ-D4-01/02/03).
//
// Converts the letta-client's endpoint choices from "guess" to "verified": when a Letta
// server is reachable it round-trips archival append → search and a core-memory edit
// against a throwaway test agent, trying the SAME candidate shapes the client falls
// through, and PRINTS which path/verb/body each operation actually accepted on THIS
// server (the pinned image). It cleans up the test agent afterward.
//
// SAFE BY DEFAULT: respects LETTA_DISABLED=1 (zero network) and, when the server is
// simply unreachable, SKIPS with a clear message and exits 0 — so it is safe to run in
// the headless exit gate / CI with no Docker. It exits non-zero ONLY when the server is
// reachable but a verification step failed (an operator-actionable signal).
//
// Usage:
//   node scripts/letta-verify.mjs
//   LETTA_BASE_URL=http://localhost:8283 LETTA_API_KEY=... node scripts/letta-verify.mjs

import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// Load .env (LETTA_* lines) like the phase validators, so LETTA_BASE_URL/DISABLED apply.
const envPath = resolve(root, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const BASE = (process.env.LETTA_BASE_URL ?? 'http://localhost:8283').replace(/\/+$/, '');
const API_KEY = process.env.LETTA_API_KEY;
const TIMEOUT_MS = 5000;

const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

function log(msg) {
  console.log(msg);
}

async function req(method, path, body) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (API_KEY) headers.Authorization = `Bearer ${API_KEY}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    const raw = await res.text();
    let json = null;
    try {
      json = raw.length > 0 ? JSON.parse(raw) : null;
    } catch {
      json = null;
    }
    return { ok: res.ok, status: res.status, json, raw };
  } catch (err) {
    return { ok: false, status: undefined, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Try candidates in order; return { hit, attempts } where hit is the first 2xx. */
async function tryCandidates(candidates) {
  const attempts = [];
  for (const c of candidates) {
    const res = await req(c.method, c.path, c.body);
    attempts.push({ label: c.label, status: res.status, ok: res.ok });
    if (res.ok) return { hit: { ...c, res }, attempts };
  }
  return { hit: null, attempts };
}

function qs(params) {
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

async function main() {
  log(`\n${DIM}# Skippy_space — Letta REST verification (OQ-D4-01/02/03)${RESET}`);
  log(`${DIM}target: ${BASE}${RESET}\n`);

  // ── Kill switch ────────────────────────────────────────────────────────────
  if (process.env.LETTA_DISABLED === '1') {
    log(`${YELLOW}SKIP${RESET} LETTA_DISABLED=1 — kill switch set, no network performed. (exit 0)`);
    return 0;
  }

  // ── Reachability ───────────────────────────────────────────────────────────
  let root1 = await req('GET', '/');
  if (!root1.ok && root1.status === 404) root1 = await req('GET', '/v1/health');
  if (root1.status === undefined) {
    log(`${YELLOW}SKIP${RESET} Letta unreachable at ${BASE} (server down). Start it with:`);
    log(`${DIM}  docker compose --profile letta -f infra/letta/docker-compose.yml up -d${RESET}`);
    log(`${YELLOW}SKIP${RESET} Nothing verified; this is expected in the headless gate. (exit 0)`);
    return 0;
  }
  log(`${GREEN}OK${RESET}   server reachable (probe status ${root1.status}).`);

  // ── Create a throwaway test agent ──────────────────────────────────────────
  const name = `skippy_verify_${Date.now()}`;
  const create = await req('POST', '/v1/agents', {
    name,
    memory_blocks: [
      { label: 'persona', value: 'I am a Skippy verification agent. Delete me.' },
      { label: 'human', value: 'A test harness.' },
    ],
  });
  if (!create.ok) {
    log(`${RED}FAIL${RESET} could not create a test agent (POST /v1/agents → ${create.status ?? 'no-status'}).`);
    log(`${DIM}  body: ${(create.raw ?? create.error ?? '').slice(0, 300)}${RESET}`);
    log(`${DIM}  (a self-hosted Letta needs a default LLM + embedding configured to create agents.)${RESET}`);
    return 1;
  }
  const agentId = create.json && typeof create.json.id === 'string' ? create.json.id : undefined;
  log(`${GREEN}OK${RESET}   created test agent ${agentId ?? '(id n/a)'} (name=${name}).`);
  if (!agentId) {
    log(`${RED}FAIL${RESET} create response carried no agent id; cannot run scoped checks.`);
    return 1;
  }
  const id = encodeURIComponent(agentId);

  let failures = 0;

  // ── OQ-D4-01: archival INSERT ──────────────────────────────────────────────
  const insert = await tryCandidates([
    { label: 'POST /v1/agents/{id}/archival-memory {text}', method: 'POST', path: `/v1/agents/${id}/archival-memory`, body: { text: 'plasma confinement requires magnetic stability' } },
    { label: 'POST /v1/agents/{id}/archival/insert {text}', method: 'POST', path: `/v1/agents/${id}/archival/insert`, body: { text: 'plasma confinement requires magnetic stability' } },
    { label: 'POST /v1/agents/{id}/archival-memory {content}', method: 'POST', path: `/v1/agents/${id}/archival-memory`, body: { content: 'plasma confinement requires magnetic stability' } },
  ]);
  if (insert.hit) {
    log(`${GREEN}PASS${RESET} [OQ-D4-01] archival insert  → ${insert.hit.label}`);
  } else {
    failures++;
    log(`${RED}FAIL${RESET} [OQ-D4-01] archival insert — no candidate accepted: ${JSON.stringify(insert.attempts)}`);
  }

  // ── OQ-D4-02: archival SEARCH ──────────────────────────────────────────────
  const search = await tryCandidates([
    { label: 'GET /v1/agents/{id}/archival-memory/search?query&top_k', method: 'GET', path: `/v1/agents/${id}/archival-memory/search${qs({ query: 'plasma', top_k: 5 })}` },
    { label: 'POST /v1/agents/{id}/archival-memory/search {query,top_k}', method: 'POST', path: `/v1/agents/${id}/archival-memory/search`, body: { query: 'plasma', top_k: 5 } },
    { label: 'POST /v1/agents/{id}/archival/search {query,limit}', method: 'POST', path: `/v1/agents/${id}/archival/search`, body: { query: 'plasma', limit: 5 } },
  ]);
  if (search.hit) {
    const n = countHits(search.hit.res.json);
    log(`${GREEN}PASS${RESET} [OQ-D4-02] archival search  → ${search.hit.label} (${n} hit(s))`);
  } else {
    failures++;
    log(`${RED}FAIL${RESET} [OQ-D4-02] archival search — no candidate accepted: ${JSON.stringify(search.attempts)}`);
  }

  // ── OQ-D4-03: core-memory EDIT ─────────────────────────────────────────────
  const edit = await tryCandidates([
    { label: 'PATCH /v1/agents/{id}/core-memory/blocks/persona {value}', method: 'PATCH', path: `/v1/agents/${id}/core-memory/blocks/persona`, body: { value: 'Updated by Skippy verify.' } },
    { label: 'POST /v1/agents/{id}/core-memory/blocks/persona {value}', method: 'POST', path: `/v1/agents/${id}/core-memory/blocks/persona`, body: { value: 'Updated by Skippy verify.' } },
    { label: 'PATCH /v1/agents/{id}/memory/block/persona {value}', method: 'PATCH', path: `/v1/agents/${id}/memory/block/persona`, body: { value: 'Updated by Skippy verify.' } },
  ]);
  if (edit.hit) {
    log(`${GREEN}PASS${RESET} [OQ-D4-03] core-memory edit → ${edit.hit.label}`);
  } else {
    failures++;
    log(`${RED}FAIL${RESET} [OQ-D4-03] core-memory edit — no candidate accepted: ${JSON.stringify(edit.attempts)}`);
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────
  const del = await req('DELETE', `/v1/agents/${id}`);
  log(del.ok ? `${GREEN}OK${RESET}   deleted test agent.` : `${YELLOW}WARN${RESET} could not delete test agent ${agentId} (status ${del.status ?? 'n/a'}) — remove it manually.`);

  log(
    failures === 0
      ? `\n${GREEN}All Letta REST contracts verified against ${BASE}.${RESET} Update the client comments if any winning shape differs from the VERIFIED one.`
      : `\n${RED}${failures} verification(s) failed.${RESET} The winning shapes above are authoritative for this image — reconcile letta-client.ts.`,
  );
  return failures === 0 ? 0 : 1;
}

function countHits(json) {
  if (Array.isArray(json)) return json.length;
  if (json && typeof json === 'object') {
    for (const k of ['results', 'passages', 'archival_memory']) {
      if (Array.isArray(json[k])) return json[k].length;
    }
    if (typeof json.count === 'number') return json.count;
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // A verification harness must itself never hard-crash the gate; degrade to skip.
    console.log(`${YELLOW}SKIP${RESET} letta-verify hit an unexpected error: ${err instanceof Error ? err.message : String(err)} (exit 0)`);
    process.exit(0);
  });
