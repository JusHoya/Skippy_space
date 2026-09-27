// vault-broker.reserved.test.ts — M0 red-team round 2, N4 (FR-WIKI-02): the
// append-only daily and agent_log paths cannot be squatted by a general write,
// and a squatted daily path is an explicit error, not `created: false`.
//
// Every test here fails on 956c208. Run via:
//   node --import tsx --test src/vault-broker.reserved.test.ts

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { AppendOnlyViolationError, VaultBroker } from './vault-broker.js';
import { makeFrontmatter } from './frontmatter.js';
import { dailyNoteRelPath, generateDailyNote } from './daily.js';
import { mirrorArchivalToVault } from './jobs/archival-mirror.js';

// Temp dirs this file creates; removed after all of its tests (best effort:
// a Windows handle still open on one must not fail the run).
const tmpDirs: string[] = [];
async function trackTmp(p: Promise<string>): Promise<string> {
  const dir = await p;
  tmpDirs.push(dir);
  return dir;
}
after(async () => {
  await Promise.all(tmpDirs.map((d) => fs.rm(d, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})));
});

async function makeVault(): Promise<string> {
  const base = await fs.realpath(await trackTmp(fs.mkdtemp(path.join(os.tmpdir(), 'skippy-rt2-reserved-'))));
  const vault = path.join(base, 'vault');
  for (const d of ['40_Daily', '50_Agents/research', '20_Topics']) {
    await fs.mkdir(path.join(vault, d), { recursive: true });
  }
  return vault;
}

const concept = () => makeFrontmatter({ title: 'squat', type: 'concept', authored_by: 'x', source: null });
const exists = (p: string) => fs.access(p).then(() => true, () => false);

const SQUAT = `---
id: 01HZX900AADAXXYSQUATXATE01
title: squat
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-01-01T00:00:00Z
type: concept
status: active
tags: []
source: null
authored_by: human
---
overwritable
`;

test('RT2-N4: createNote refuses a non-daily note at a daily path (incl. case and junction aliases)', async (t) => {
  const vault = await makeVault();
  const broker = new VaultBroker(vault);
  const tomorrow = new Date(Date.now() + 86_400_000);
  const rel = dailyNoteRelPath(tomorrow);
  await assert.rejects(() => broker.createNote(rel, concept(), 'squat'), AppendOnlyViolationError);
  await assert.rejects(() => broker.createNote(rel.replace('40_Daily', '40_daily'), concept(), 'x'), AppendOnlyViolationError);
  await assert.rejects(() => broker.createNote('40_Daily/anything.md', concept(), 'x'), AppendOnlyViolationError);
  assert.equal(await exists(path.join(vault, ...rel.split('/'))), false);

  let aliased = false;
  try {
    await fs.symlink(path.join(vault, '40_Daily'), path.join(vault, 'alias'), 'junction');
    aliased = true;
  } catch {
    t.diagnostic('junction creation not permitted; skipping the junction alias case');
  }
  if (aliased) {
    await assert.rejects(() => broker.createNote('alias/2031-01-01.md', concept(), 'x'), AppendOnlyViolationError);
    assert.equal(await exists(path.join(vault, '40_Daily', '2031-01-01.md')), false);
  }

  // The real generator still creates it afterwards.
  const g = await generateDailyNote({ vaultRoot: vault, date: tomorrow });
  assert.equal(g.created, true);
});

test('RT2-N4: createNote refuses a non-agent_log note at 50_Agents/<board>/agent_log.md', async () => {
  const vault = await makeVault();
  const broker = new VaultBroker(vault);
  await assert.rejects(
    () => broker.createNote('50_Agents/research/agent_log.md', concept(), 'squat'),
    AppendOnlyViolationError,
  );
  await assert.rejects(
    () => broker.createNote('50_agents/Research/AGENT_LOG.md', concept(), 'squat'),
    AppendOnlyViolationError,
  );
  const m = await mirrorArchivalToVault({ board: 'research', text: 'memory', vaultRoot: vault });
  assert.equal(m.ok, true, 'the archival mirror still owns the path');
});

test('RT2-N4: a squatted daily note is an explicit error and cannot be overwritten or patched', async () => {
  const vault = await makeVault();
  const date = new Date(2031, 0, 2);
  const rel = dailyNoteRelPath(date);
  const abs = path.join(vault, ...rel.split('/'));
  await fs.writeFile(abs, SQUAT); // e.g. hand-written outside the broker

  await assert.rejects(() => generateDailyNote({ vaultRoot: vault, date }), /reserved|squat/i);

  const broker = new VaultBroker(vault);
  const snap = await broker.readNote(rel);
  assert.ok(snap);
  await assert.rejects(
    () => broker.updateNote(rel, snap.hash, () => ({ body: 'REPLACED' })),
    AppendOnlyViolationError,
  );
  await assert.rejects(() => broker.patchFrontmatter(rel, snap.hash, 'status', 'draft'), AppendOnlyViolationError);
  assert.equal(await fs.readFile(abs, 'utf8'), SQUAT, 'unchanged');
});

test('RT2-N4: a squatted agent_log cannot be overwritten; the mirror reports an explicit error', async () => {
  const vault = await makeVault();
  const rel = '50_Agents/research/agent_log.md';
  const abs = path.join(vault, ...rel.split('/'));
  await fs.writeFile(abs, SQUAT);
  const broker = new VaultBroker(vault);
  const snap = await broker.readNote(rel);
  assert.ok(snap);
  await assert.rejects(
    () => broker.updateNote(rel, snap.hash, () => ({ body: 'REPLACED' })),
    AppendOnlyViolationError,
  );
  const m = await mirrorArchivalToVault({ board: 'research', text: 'memory', vaultRoot: vault });
  assert.equal(m.ok, false);
  assert.match(m.error ?? '', /append-only/i);
  assert.equal(await fs.readFile(abs, 'utf8'), SQUAT, 'unchanged');
});
