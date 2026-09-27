// replay-writer.test.ts — M0 red-team round 2, N2 (FR-SEC-02): the replay
// stream `vault/.skippy/replays/<id>.jsonl` must be contained. A `.skippy`
// junction to outside the vault (or to `.git`) disables the writer; nothing is
// written through it.
//
// The junction tests fail on 956c208. Run via:
//   node --import tsx --test src/replay-writer.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { appendToReplay, closeReplayWriter, initReplayWriter } from './replay-writer.js';

async function setup(): Promise<{ vault: string; outside: string }> {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skippy-rt2-replay-')));
  const vault = path.join(base, 'vault');
  const outside = path.join(base, 'outside');
  await fs.mkdir(path.join(vault, '.git'), { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  return { vault, outside };
}

async function junction(target: string, link: string): Promise<boolean> {
  try {
    await fs.symlink(target, link, 'junction');
    return true;
  } catch {
    return false;
  }
}

async function tree(dir: string): Promise<string[]> {
  return ((await fs.readdir(dir, { recursive: true })) as string[]).map((p) => p.replace(/\\/g, '/'));
}

test('RT2-N2: a normal vault gets a contained replay file with every envelope', async () => {
  const { vault } = await setup();
  const r = initReplayWriter(vault);
  appendToReplay({ type: 'log', message: 'first (buffered while opening)' });
  await new Promise((res) => setTimeout(res, 50));
  appendToReplay({ type: 'log', message: 'second' });
  await closeReplayWriter();
  const lines = (await fs.readFile(r.path, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]!).message, 'first (buffered while opening)');
  const st = await fs.stat(r.path);
  assert.equal(st.nlink, 1);
});

test('RT2-N2: a .skippy junction to outside the vault disables replay; nothing is written outside', async (t) => {
  const { vault, outside } = await setup();
  if (!(await junction(outside, path.join(vault, '.skippy')))) return t.skip('junction creation not permitted');
  initReplayWriter(vault);
  appendToReplay({ type: 'log', message: 'secret envelope' });
  await closeReplayWriter();
  appendToReplay({ type: 'log', message: 'after close' });
  assert.deepEqual(await tree(outside), [], 'no replay file outside the vault');
});

test('RT2-N2: a .skippy junction to .git is rejected (only the .skippy hidden segment is allowed)', async (t) => {
  const { vault } = await setup();
  if (!(await junction(path.join(vault, '.git'), path.join(vault, '.skippy')))) {
    return t.skip('junction creation not permitted');
  }
  initReplayWriter(vault);
  appendToReplay({ type: 'log', message: 'into git?' });
  await closeReplayWriter();
  assert.deepEqual(await tree(path.join(vault, '.git')), [], 'nothing written into .git');
});

test('RT2-N2: a replays/ junction below a real .skippy is rejected too', async (t) => {
  const { vault, outside } = await setup();
  await fs.mkdir(path.join(vault, '.skippy'));
  if (!(await junction(outside, path.join(vault, '.skippy', 'replays')))) {
    return t.skip('junction creation not permitted');
  }
  initReplayWriter(vault);
  appendToReplay({ type: 'log', message: 'nested escape' });
  await closeReplayWriter();
  assert.deepEqual(await tree(outside), []);
});
