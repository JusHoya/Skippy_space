// jobs/letta-bootstrap.ts — provision the per-board Letta agents from the charters.
//
// Phase 4 (OQ-D4-04). Every charter under `agent_space/` (skippy.md, boards/*.md,
// staff/*.md) declares `memory.letta_agent_id` (the agent's Letta *name* handle, e.g.
// `bd_research_v1`) and `memory.core_memory_facts` (seed persona statements). Until now
// nothing created those agents on the Letta server — the Phase 3.5 manual checklist
// said "pre-create each board agent … there is no bootstrap job yet". This job IS that
// bootstrap: it parses the charters and, for each declared `letta_agent_id`, ensures
// the agent exists on the server (creating it with its core-memory facts seeded), and
// is IDEMPOTENT — a re-run skips agents that already exist.
//
// GRACEFUL DEGRADATION (mirrors the rest of @skippy/memory): when Letta is down or the
// kill switch (`LETTA_DISABLED=1`) is set, the job does NO network work and returns a
// "skipped" result with `ok: true` — the CLI maps that to exit 0. `ok` is `false` ONLY
// when the server is genuinely reachable (`connected`/`degraded`) but one or more
// create/list operations failed — the one condition an operator should act on. Nothing
// here throws.
//
// CHARTER PARSING: we reuse `gray-matter` (already an @skippy/memory dep, used by
// frontmatter.ts) rather than the agent-runtime hand-rolled parser — charters are
// author-controlled YAML that js-yaml parses cleanly, and this keeps the job inside
// @skippy/memory with no cross-package reach.

import { existsSync, promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';

import { LettaClient } from '../letta-client.js';
import type {
  CreateAgentSpec,
  LettaAgentSummary,
  LettaResult,
  LettaStatus,
} from '../letta-client.js';

// ──────────────────────────────────────────────────────────────────────────────
// Injected client surface — the subset of LettaClient this job needs. `LettaClient`
// satisfies it structurally; tests pass a lightweight fake so the suite is headless.
// ──────────────────────────────────────────────────────────────────────────────

export interface LettaBootstrapClient {
  status(force?: boolean): Promise<LettaStatus>;
  listAgents(name?: string): Promise<LettaResult<LettaAgentSummary[]>>;
  createAgent(spec: CreateAgentSpec): Promise<LettaResult<LettaAgentSummary>>;
}

/** One charter's Letta binding, extracted from `memory:` frontmatter. */
export interface CharterLettaSpec {
  /** `memory.letta_agent_id` — the Letta agent *name* handle (e.g. `bd_research_v1`). */
  agentName: string;
  /** `memory.core_memory_facts` — persona seed statements (may be empty). */
  coreMemoryFacts: string[];
  /** Charter file the binding came from (relative to agent_space), for logging. */
  source: string;
}

export type BootstrapAgentStatus = 'created' | 'exists' | 'failed';

/** Per-agent outcome of a bootstrap pass. */
export interface BootstrapAgentResult {
  agentName: string;
  status: BootstrapAgentStatus;
  /** Letta DB id when known (after a create, or a found existing agent). */
  id?: string;
  /** Present only when `status === 'failed'`. */
  error?: string;
  source: string;
}

/** Aggregate result of a bootstrap pass. */
export interface BootstrapResult {
  /** false ONLY when the server was reachable but ≥1 op failed; true otherwise
   * (including the down/disabled skip — nothing actionable happened). */
  ok: boolean;
  /** The server health at the time of the run. `down`/`disabled` ⇒ skipped. */
  serverStatus: LettaStatus;
  /** True when no network was attempted because Letta was down/disabled. */
  skipped: boolean;
  /** Per-agent outcomes (empty when skipped). */
  agents: BootstrapAgentResult[];
}

export interface BootstrapOptions {
  /** Absolute path to the `agent_space/` directory holding the charters. */
  agentSpaceRoot: string;
  /** The Letta client (or a structural fake in tests). */
  client: LettaBootstrapClient;
  /** Optional progress log sink (defaults to no-op). */
  onLog?: (msg: string) => void;
}

// ──────────────────────────────────────────────────────────────────────────────
// Charter discovery + parsing
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Collect every charter's Letta binding under `agentSpaceRoot`: `skippy.md`, every
 * `boards/*.md`, and every `staff/*.md`. Charters with no `memory.letta_agent_id` are
 * skipped silently. Never throws — a missing dir or unreadable file is just omitted.
 */
export async function collectCharterLettaSpecs(
  agentSpaceRoot: string,
): Promise<CharterLettaSpec[]> {
  const files: string[] = [];
  const skippy = path.join(agentSpaceRoot, 'skippy.md');
  if (await fileExists(skippy)) files.push(skippy);
  for (const sub of ['boards', 'staff']) {
    const dir = path.join(agentSpaceRoot, sub);
    for (const name of await safeReaddir(dir)) {
      if (name.endsWith('.md')) files.push(path.join(dir, name));
    }
  }

  // De-duplicate by agentName (first charter wins) so a duplicated handle can't
  // trigger two creates of the same agent.
  const seen = new Set<string>();
  const specs: CharterLettaSpec[] = [];
  for (const file of files) {
    const spec = await parseCharterLettaSpec(file, agentSpaceRoot);
    if (spec === undefined || seen.has(spec.agentName)) continue;
    seen.add(spec.agentName);
    specs.push(spec);
  }
  return specs;
}

/** Parse one charter file into a `CharterLettaSpec`, or undefined if it has no
 * `memory.letta_agent_id`. Never throws — a read/parse failure yields undefined. */
export async function parseCharterLettaSpec(
  file: string,
  agentSpaceRoot: string,
): Promise<CharterLettaSpec | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
  let data: Record<string, unknown>;
  try {
    data = matter(raw).data as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const mem = data['memory'];
  if (typeof mem !== 'object' || mem === null) return undefined;
  const m = mem as Record<string, unknown>;
  const agentName = typeof m['letta_agent_id'] === 'string' ? m['letta_agent_id'].trim() : '';
  if (agentName.length === 0) return undefined;
  const facts = Array.isArray(m['core_memory_facts'])
    ? m['core_memory_facts'].filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    : [];
  return {
    agentName,
    coreMemoryFacts: facts,
    source: path.relative(agentSpaceRoot, file).split(path.sep).join('/'),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// The job
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Provision the per-board Letta agents from the charters, idempotently.
 *
 * Flow: probe `client.status()`. If `down`/`disabled`, return a SKIP (`ok:true`,
 * `skipped:true`) without touching the network — safe in the headless gate / CI. If
 * the server is reachable, parse the charters and for each declared `letta_agent_id`:
 *   - `listAgents(name)` — if a match exists, record `exists` (no write);
 *   - otherwise `createAgent({ name, memoryBlocks: [persona from facts] })`, recording
 *     `created` or `failed`.
 * Returns `ok:false` iff any op failed against a reachable server. Never throws.
 */
export async function bootstrapLettaAgents(
  opts: BootstrapOptions,
): Promise<BootstrapResult> {
  const log = opts.onLog ?? (() => {});
  const serverStatus = await opts.client.status();

  if (serverStatus === 'down' || serverStatus === 'disabled') {
    log(
      serverStatus === 'disabled'
        ? 'Letta disabled (LETTA_DISABLED=1) — skipping bootstrap (no network).'
        : 'Letta server unreachable — skipping bootstrap (no agents provisioned).',
    );
    return { ok: true, serverStatus, skipped: true, agents: [] };
  }

  const specs = await collectCharterLettaSpecs(opts.agentSpaceRoot);
  log(`Discovered ${specs.length} charter Letta binding(s) under ${opts.agentSpaceRoot}.`);

  const agents: BootstrapAgentResult[] = [];
  for (const spec of specs) {
    agents.push(await ensureAgent(opts.client, spec, log));
  }

  const failures = agents.filter((a) => a.status === 'failed');
  return {
    ok: failures.length === 0,
    serverStatus,
    skipped: false,
    agents,
  };
}

/**
 * Ensure ONE charter's agent exists on the server (idempotent). Lists by name; if a
 * match is found, returns `exists` without writing. Otherwise creates it with the
 * core-memory facts seeded into a `persona` block. A failed list OR create yields
 * `failed` (with the error) — never throws.
 */
async function ensureAgent(
  client: LettaBootstrapClient,
  spec: CharterLettaSpec,
  log: (msg: string) => void,
): Promise<BootstrapAgentResult> {
  const list = await client.listAgents(spec.agentName);
  if (!list.ok) {
    log(`  ${spec.agentName}: list failed — ${list.error}`);
    return { agentName: spec.agentName, status: 'failed', error: list.error, source: spec.source };
  }
  const existing = list.data.find((a) => a.name === spec.agentName);
  if (existing !== undefined) {
    log(`  ${spec.agentName}: already exists (${existing.id || 'id n/a'}) — skipping.`);
    const r: BootstrapAgentResult = { agentName: spec.agentName, status: 'exists', source: spec.source };
    if (existing.id) r.id = existing.id;
    return r;
  }

  const created = await client.createAgent(buildCreateSpec(spec));
  if (!created.ok) {
    log(`  ${spec.agentName}: create failed — ${created.error}`);
    return { agentName: spec.agentName, status: 'failed', error: created.error, source: spec.source };
  }
  log(`  ${spec.agentName}: created (${created.data.id || 'id n/a'}).`);
  const r: BootstrapAgentResult = { agentName: spec.agentName, status: 'created', source: spec.source };
  if (created.data.id) r.id = created.data.id;
  return r;
}

/** Build the create spec for a charter: name = handle, persona block seeded from the
 * charter's core_memory_facts (joined newline-wise). We only seed a `persona` block —
 * the facts are first-person identity statements — and let the server apply its own
 * default `human` block + LLM/embedding config. */
export function buildCreateSpec(spec: CharterLettaSpec): CreateAgentSpec {
  const out: CreateAgentSpec = { name: spec.agentName };
  if (spec.coreMemoryFacts.length > 0) {
    out.memoryBlocks = [{ label: 'persona', value: spec.coreMemoryFacts.join('\n') }];
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

/**
 * CLI driver: resolve the project root (→ agent_space/), construct a real
 * `LettaClient`, run the bootstrap, print a human summary, and return an exit code.
 * Exit 0 on success OR a clean down/disabled SKIP; exit 1 only when the server was
 * reachable but ≥1 provisioning op failed. Never throws — used by
 * `scripts/letta-bootstrap.mjs`.
 */
export async function runBootstrapCli(argv: string[] = []): Promise<number> {
  const rootArg = argv.find((a) => a.startsWith('--agent-space='));
  const agentSpaceRoot = rootArg
    ? path.resolve(rootArg.slice('--agent-space='.length))
    : path.join(findProjectRoot(), 'agent_space');

  const client = new LettaClient();
  const result = await bootstrapLettaAgents({
    agentSpaceRoot,
    client,
    onLog: (msg) => console.log(msg),
  });

  if (result.skipped) {
    console.log(`letta-bootstrap: skipped (server ${result.serverStatus}). Nothing provisioned.`);
    return 0;
  }
  const created = result.agents.filter((a) => a.status === 'created').length;
  const exists = result.agents.filter((a) => a.status === 'exists').length;
  const failed = result.agents.filter((a) => a.status === 'failed').length;
  console.log(
    `letta-bootstrap: ${created} created, ${exists} already present, ${failed} failed ` +
      `(server ${result.serverStatus}).`,
  );
  return result.ok ? 0 : 1;
}

/** Walk up from this module to the first dir containing `agent_space/` (or a
 * `pnpm-workspace.yaml`). Falls back to three levels up (packages/memory/src/jobs →
 * repo root) so it still resolves when run from a built copy. */
function findProjectRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, 'agent_space')) || existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** readdir that returns [] instead of throwing on a missing/unreadable directory. */
async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}
