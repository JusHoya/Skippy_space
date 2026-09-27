// safe-write.test.ts — M0 red-team round 2, N3: vault writers must not follow a
// hardlink pre-planted at a predictable temp-file name (FR-SEC-02, G0).
//
// write-file-atomic 8 names its temp `<target>.<uint32 of sha1(__filename, pid,
// threadId, ++counter)>` and opens it with 'w'. We plant hardlinks to an
// outside victim at every name it would use for the first 200 invocations in
// this process, then write through the broker and through ingest's originals
// store. The victim must be untouched and the written files single-link.
//
// The broker/ingest tests fail on 956c208. Run via:
//   node --import tsx --test src/safe-write.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';

import { VaultBroker } from './vault-broker.js';
import { makeFrontmatter } from './frontmatter.js';
import { runIngest } from './jobs/ingest.js';
import { sha256Hex } from './ingest/originals.js';
import { resolveContained } from './vault-path.js';

const VICTIM_TEXT = 'ORIGINAL OUTSIDE CONTENT';

function wfaModulePath(): string | null {
  try {
    return createRequire(import.meta.url).resolve('write-file-atomic');
  } catch {
    return null;
  }
}

/** Every temp name write-file-atomic would use for `target` in this process (first `n` calls). */
function predictedTempNames(target: string, n = 200): string[] {
  const mod = wfaModulePath();
  if (!mod) return [];
  const out: string[] = [];
  for (let i = 1; i <= n; i++) {
    const num = crypto
      .createHash('sha1')
      .update(mod)
      .update(String(process.pid))
      .update('0')
      .update(String(i))
      .digest()
      .readUInt32BE(0);
    out.push(`${target}.${num}`);
  }
  return out;
}

async function setup(): Promise<{ vault: string; victim: string }> {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skippy-rt2-safewrite-')));
  const vault = path.join(base, 'vault');
  await fs.mkdir(path.join(vault, '10_Atomic'), { recursive: true });
  await fs.mkdir(path.join(vault, '00_Inbox'), { recursive: true });
  await fs.mkdir(path.join(base, 'outside'), { recursive: true });
  const victim = path.join(base, 'outside', 'victim.txt');
  await fs.writeFile(victim, VICTIM_TEXT);
  return { vault, victim };
}

async function plant(victim: string, target: string): Promise<void> {
  for (const name of predictedTempNames(target)) {
    await fs.link(victim, name).catch(() => {});
  }
}

const fm = () => makeFrontmatter({ title: 't', type: 'concept', authored_by: 'x', source: null });

test('RT2-N3: broker create/update never write through a hardlink planted at a temp name', async () => {
  const { vault, victim } = await setup();
  const target = path.join(await fs.realpath(path.join(vault, '10_Atomic')), 'n.md');
  await plant(victim, target);

  const created = await new VaultBroker(vault).createNote('10_Atomic/n.md', fm(), 'ATTACKER BODY via broker');
  assert.equal(created.ok, true);
  assert.equal(await fs.readFile(victim, 'utf8'), VICTIM_TEXT, 'victim untouched by create');
  assert.equal((await fs.stat(target)).nlink, 1, 'note is a single-link file');

  const broker = new VaultBroker(vault);
  const snap = await broker.readNote('10_Atomic/n.md');
  assert.ok(snap);
  const updated = await broker.updateNote('10_Atomic/n.md', snap.hash, () => ({ body: 'second body' }));
  assert.equal(updated.ok, true);
  assert.equal(await fs.readFile(victim, 'utf8'), VICTIM_TEXT, 'victim untouched by update');
  assert.equal((await fs.stat(target)).nlink, 1);
});

test('RT2-N3: the originals store and marker never write through planted hardlinks', async () => {
  const { vault, victim } = await setup();
  const content = Buffer.from('# drop\n');
  const h = sha256Hex(content);
  const originals = path.join(vault, '60_Sources', 'originals');
  await fs.mkdir(originals, { recursive: true });
  const realOriginals = await fs.realpath(originals);
  await plant(victim, path.join(realOriginals, `${h}.md`));
  await plant(victim, path.join(realOriginals, `${h}.note.json`));

  const drop = path.join(vault, '00_Inbox', 'd.md');
  await fs.writeFile(drop, content);
  const r = await runIngest({ vaultRoot: vault, sourcePath: drop });
  assert.equal(await fs.readFile(victim, 'utf8'), VICTIM_TEXT, 'victim untouched');
  assert.equal((await fs.stat(r.originalPath)).nlink, 1);
  assert.equal(sha256Hex(await fs.readFile(r.originalPath)), h);
  assert.equal((await fs.stat(path.join(realOriginals, `${h}.note.json`))).nlink, 1);
});

test('RT2-N3: atomicWriteContained removes its temp file when the commit fails', async () => {
  const { atomicWriteContained } = await import('./safe-write.js');
  const { vault } = await setup();
  // The target is a directory: the rename must fail, and no temp file may remain.
  await fs.mkdir(path.join(vault, '10_Atomic', 'd.md'));
  const cp = await resolveContained(vault, '10_Atomic/d.md', { allowNonFileTarget: true });
  await assert.rejects(() => atomicWriteContained(cp, 'x'));
  const left = (await fs.readdir(path.join(vault, '10_Atomic'))).filter((n) => n !== 'd.md');
  assert.deepEqual(left, [], 'no temp file left behind');
});
