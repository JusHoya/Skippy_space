// jobs/letta-bootstrap.test.ts — OQ-D4-04 bootstrap job tests (node:test).
//
// Run via: node --import tsx --test src/jobs/letta-bootstrap.test.ts
//
// HEADLESS — NO real Letta. We build a tmp agent_space/ of charters and drive the job
// with a MOCK client that records its calls, asserting:
//   - charter parsing extracts memory.letta_agent_id + core_memory_facts from
//     skippy.md / boards/*.md / staff/*.md (gray-matter, the real parser);
//   - idempotency: an agent the mock reports as already-present is NOT re-created;
//   - a missing agent IS created, with its facts seeded into a persona block;
//   - a 'down'/'disabled' server SKIPS with zero network and ok:true;
//   - a create failure against a reachable server yields ok:false + status 'failed'.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  bootstrapLettaAgents,
  collectCharterLettaSpecs,
  buildCreateSpec,
  type LettaBootstrapClient,
} from './letta-bootstrap.js';
import type {
  CreateAgentSpec,
  LettaAgentSummary,
  LettaResult,
  LettaStatus,
} from '../letta-client.js';

// ── fixtures ────────────────────────────────────────────────────────────────

const SKIPPY = `---
agent: skippy
display_name: "Skippy the Magnificent"
memory:
  letta_agent_id: skippy_orchestrator_v1
  vault_subdir: 50_Agents/skippy/
  core_memory_facts:
    - "I am Skippy the Magnificent. The Iron Law: I NEVER implement."
    - "I command eight Board Captains."
---

# Skippy
Body.
`;

const RESEARCH = `---
board: research
display_name: "The Research Captain"
memory:
  letta_agent_id: bd_research_v1
  vault_subdir: 50_Agents/research/
  core_memory_facts:
    - "I am the Research Captain. I report to Skippy."
    - "Every claim needs a source."
---

# Research
Body.
`;

const STAFF = `---
agent: memory-manager
role: staff_officer
memory:
  letta_agent_id: staff_memory_manager_v1
  core_memory_facts:
    - "I am The Historian, a Staff Officer."
---

# Historian
Body.
`;

// A charter with NO letta binding — must be ignored by discovery.
const NO_LETTA = `---
board: design
display_name: "The Design Captain"
memory:
  vault_subdir: 50_Agents/design/
---

# Design
Body.
`;

async function tmpAgentSpace(): Promise<string> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skippy-letta-bootstrap-'));
  await fs.mkdir(path.join(rootDir, 'boards'), { recursive: true });
  await fs.mkdir(path.join(rootDir, 'staff'), { recursive: true });
  await fs.writeFile(path.join(rootDir, 'skippy.md'), SKIPPY, 'utf8');
  await fs.writeFile(path.join(rootDir, 'boards', 'research.md'), RESEARCH, 'utf8');
  await fs.writeFile(path.join(rootDir, 'boards', 'design.md'), NO_LETTA, 'utf8');
  await fs.writeFile(path.join(rootDir, 'staff', 'memory-manager.md'), STAFF, 'utf8');
  return rootDir;
}

// ── mock client ───────────────────────────────────────────────────────────────

interface MockOpts {
  status?: LettaStatus;
  /** Names the server already has (idempotency). */
  existing?: string[];
  /** Force createAgent to fail for these names. */
  failCreate?: string[];
  /** Force listAgents to fail (server error) for these names. */
  failList?: string[];
}

class MockClient implements LettaBootstrapClient {
  readonly created: CreateAgentSpec[] = [];
  readonly listed: (string | undefined)[] = [];
  private readonly existing: Set<string>;
  constructor(private readonly o: MockOpts = {}) {
    this.existing = new Set(o.existing ?? []);
  }
  async status(): Promise<LettaStatus> {
    return this.o.status ?? 'connected';
  }
  async listAgents(name?: string): Promise<LettaResult<LettaAgentSummary[]>> {
    this.listed.push(name);
    if (name !== undefined && (this.o.failList ?? []).includes(name)) {
      return { ok: false, error: 'HTTP 500 list failed' };
    }
    const hits =
      name !== undefined && this.existing.has(name)
        ? [{ id: `agent-${name}`, name }]
        : [];
    return { ok: true, data: hits };
  }
  async createAgent(spec: CreateAgentSpec): Promise<LettaResult<LettaAgentSummary>> {
    this.created.push(spec);
    if ((this.o.failCreate ?? []).includes(spec.name)) {
      return { ok: false, error: 'HTTP 422 create failed' };
    }
    return { ok: true, data: { id: `agent-${spec.name}`, name: spec.name } };
  }
}

// ── tests ─────────────────────────────────────────────────────────────────────

test('collectCharterLettaSpecs: parses skippy + board + staff, ignores no-letta charters', async () => {
  const rootDir = await tmpAgentSpace();
  const specs = await collectCharterLettaSpecs(rootDir);
  const names = specs.map((s) => s.agentName).sort();
  assert.deepEqual(names, ['bd_research_v1', 'skippy_orchestrator_v1', 'staff_memory_manager_v1']);

  const research = specs.find((s) => s.agentName === 'bd_research_v1');
  assert.ok(research);
  assert.equal(research.coreMemoryFacts.length, 2);
  assert.match(research.coreMemoryFacts[0] ?? '', /Research Captain/);
  // design.md has no letta_agent_id and must not appear.
  assert.equal(specs.find((s) => s.source.includes('design')), undefined);
});

test('buildCreateSpec: seeds core_memory_facts into a single persona block', () => {
  const spec = buildCreateSpec({
    agentName: 'bd_research_v1',
    coreMemoryFacts: ['fact a', 'fact b'],
    source: 'boards/research.md',
  });
  assert.equal(spec.name, 'bd_research_v1');
  assert.ok(spec.memoryBlocks && spec.memoryBlocks.length === 1);
  assert.equal(spec.memoryBlocks?.[0]?.label, 'persona');
  assert.equal(spec.memoryBlocks?.[0]?.value, 'fact a\nfact b');
});

test('buildCreateSpec: no facts → no memory blocks (server applies defaults)', () => {
  const spec = buildCreateSpec({ agentName: 'x', coreMemoryFacts: [], source: 'x.md' });
  assert.equal(spec.memoryBlocks, undefined);
});

test('bootstrap: creates every agent on a fresh server (all missing)', async () => {
  const rootDir = await tmpAgentSpace();
  const client = new MockClient({ status: 'connected', existing: [] });
  const res = await bootstrapLettaAgents({ agentSpaceRoot: rootDir, client });

  assert.equal(res.ok, true);
  assert.equal(res.skipped, false);
  assert.equal(res.agents.length, 3);
  assert.ok(res.agents.every((a) => a.status === 'created'));
  // Three creates, one per charter binding.
  assert.equal(client.created.length, 3);
  assert.deepEqual(
    client.created.map((c) => c.name).sort(),
    ['bd_research_v1', 'skippy_orchestrator_v1', 'staff_memory_manager_v1'],
  );
});

test('bootstrap: idempotent — existing agents are NOT re-created', async () => {
  const rootDir = await tmpAgentSpace();
  const client = new MockClient({
    status: 'connected',
    existing: ['skippy_orchestrator_v1', 'staff_memory_manager_v1'],
  });
  const res = await bootstrapLettaAgents({ agentSpaceRoot: rootDir, client });

  assert.equal(res.ok, true);
  // Only the one missing agent (research) is created.
  assert.deepEqual(client.created.map((c) => c.name), ['bd_research_v1']);
  const exists = res.agents.filter((a) => a.status === 'exists').map((a) => a.agentName).sort();
  assert.deepEqual(exists, ['skippy_orchestrator_v1', 'staff_memory_manager_v1']);
  assert.equal(res.agents.find((a) => a.agentName === 'bd_research_v1')?.status, 'created');
});

test('bootstrap: a down server SKIPS with zero network (ok:true, skipped, no calls)', async () => {
  const rootDir = await tmpAgentSpace();
  const client = new MockClient({ status: 'down' });
  const res = await bootstrapLettaAgents({ agentSpaceRoot: rootDir, client });

  assert.equal(res.ok, true);
  assert.equal(res.skipped, true);
  assert.equal(res.serverStatus, 'down');
  assert.equal(res.agents.length, 0);
  // No list/create attempted — the skip must be before any network work.
  assert.equal(client.listed.length, 0);
  assert.equal(client.created.length, 0);
});

test('bootstrap: a disabled server SKIPS the same way', async () => {
  const rootDir = await tmpAgentSpace();
  const client = new MockClient({ status: 'disabled' });
  const res = await bootstrapLettaAgents({ agentSpaceRoot: rootDir, client });
  assert.equal(res.ok, true);
  assert.equal(res.skipped, true);
  assert.equal(res.serverStatus, 'disabled');
  assert.equal(client.created.length, 0);
});

test('bootstrap: a create failure against a reachable server → ok:false + failed status', async () => {
  const rootDir = await tmpAgentSpace();
  const client = new MockClient({ status: 'connected', failCreate: ['bd_research_v1'] });
  const res = await bootstrapLettaAgents({ agentSpaceRoot: rootDir, client });

  assert.equal(res.ok, false, 'a failed op against a reachable server is actionable');
  assert.equal(res.skipped, false);
  const failed = res.agents.find((a) => a.agentName === 'bd_research_v1');
  assert.equal(failed?.status, 'failed');
  assert.match(failed?.error ?? '', /create failed/);
  // The other two still created successfully.
  assert.equal(res.agents.filter((a) => a.status === 'created').length, 2);
});

test('bootstrap: a list failure is reported as failed (not a silent skip)', async () => {
  const rootDir = await tmpAgentSpace();
  const client = new MockClient({ status: 'connected', failList: ['skippy_orchestrator_v1'] });
  const res = await bootstrapLettaAgents({ agentSpaceRoot: rootDir, client });

  assert.equal(res.ok, false);
  const failed = res.agents.find((a) => a.agentName === 'skippy_orchestrator_v1');
  assert.equal(failed?.status, 'failed');
  // A list failure means we never attempted a create for that agent.
  assert.equal(client.created.find((c) => c.name === 'skippy_orchestrator_v1'), undefined);
});
