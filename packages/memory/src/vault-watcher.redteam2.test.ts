// vault-watcher.redteam2.test.ts — M0 red-team round 2 regressions for the
// inbox watcher (FR-SEC-02, FR-WIKI-03).
//
//   N1: junctions inside `00_Inbox/` (to `.obsidian`, the originals store, or
//       outside) are never followed; nothing behind them reaches `onFile`.
//   N5: the startup scan is recursive (a nested crash leftover is re-queued).
//   N6: oversized, 8.3-named and hardlinked drops are REPORTED (onRejected, or
//       onUnsupported when no onRejected is given), never dropped silently and
//       never handed to onFile.
//
// Every test here fails on 956c208. Run via:
//   node --import tsx --test src/vault-watcher.redteam2.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { watchInbox } from './vault-watcher.js';
import { runIngest } from './jobs/ingest.js';

async function makeVault(): Promise<{ vault: string; outside: string }> {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skippy-rt2-watch-')));
  const vault = path.join(base, 'vault');
  const outside = path.join(base, 'outside');
  for (const d of ['00_Inbox', '.obsidian']) await fs.mkdir(path.join(vault, d), { recursive: true });
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

function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('timed out waiting'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Seen {
  files: string[];
  reported: string[];
}

function start(vault: string) {
  const seen: Seen = { files: [], reported: [] };
  const w = watchInbox({
    vaultRoot: vault,
    onFile: (p) => seen.files.push(path.relative(vault, p).replace(/\\/g, '/')),
    onUnsupported: (p) => seen.reported.push(path.relative(vault, p).replace(/\\/g, '/')),
    // Not in the 956c208 API (extra keys are ignored there).
    onRejected: (p: string) => seen.reported.push(path.relative(vault, p).replace(/\\/g, '/')),
  } as Parameters<typeof watchInbox>[0]);
  return { seen, w };
}

test('RT2-N1: files behind inbox junctions (.obsidian, originals, outside) never reach onFile', async (t) => {
  const { vault, outside } = await makeVault();
  // One real ingest first, so the originals store has content.
  const a = path.join(vault, '00_Inbox', 'a.md');
  await fs.writeFile(a, '# only copy\n');
  await runIngest({ vaultRoot: vault, sourcePath: a });
  const originals = path.join(vault, '60_Sources', 'originals');
  const ok =
    (await junction(path.join(vault, '.obsidian'), path.join(vault, '00_Inbox', 'j'))) &&
    (await junction(originals, path.join(vault, '00_Inbox', 'o'))) &&
    (await junction(outside, path.join(vault, '00_Inbox', 'out')));
  if (!ok) return t.skip('junction creation not permitted');
  await fs.writeFile(path.join(outside, 'pre.md'), '# pre-existing outside\n');

  const { seen, w } = start(vault);
  try {
    await sleep(900);
    // Live writes into the junction targets.
    await fs.writeFile(path.join(vault, '.obsidian', 'workspace.json'), '{"layout":1}');
    await fs.writeFile(path.join(outside, 'outside.md'), '# outside\n');
    await fs.writeFile(path.join(originals, 'planted.md'), '# planted\n');
    // A genuine drop, so we know the watcher is live.
    await fs.writeFile(path.join(vault, '00_Inbox', 'b.md'), '# second drop\n');
    await waitFor(() => seen.files.includes('00_Inbox/b.md'));
    await sleep(1200);
    const through = seen.files.filter((f) => /^00_Inbox\/(j|o|out)\//.test(f));
    assert.deepEqual(through, [], `nothing through a junction is enqueued (got ${JSON.stringify(seen.files)})`);
  } finally {
    await w.close();
  }
});

test('RT2-N5: a nested crash leftover (00_Inbox/sub/...) is re-queued by the startup scan', async () => {
  const { vault } = await makeVault();
  await fs.mkdir(path.join(vault, '00_Inbox', 'sub', 'deeper'), { recursive: true });
  await fs.writeFile(path.join(vault, '00_Inbox', 'top-leftover.md'), '# top\n');
  await fs.writeFile(path.join(vault, '00_Inbox', 'sub', 'nested-leftover.md'), '# nested\n');
  await fs.writeFile(path.join(vault, '00_Inbox', 'sub', 'deeper', 'deep.md'), '# deeper\n');
  await fs.writeFile(path.join(vault, '00_Inbox', 'sub', 'x.md.ingest-error.json'), '{}');
  const { seen, w } = start(vault);
  try {
    await waitFor(() => seen.files.length >= 3);
    await sleep(200);
    assert.deepEqual(
      [...seen.files].sort(),
      ['00_Inbox/sub/deeper/deep.md', '00_Inbox/sub/nested-leftover.md', '00_Inbox/top-leftover.md'],
    );
  } finally {
    await w.close();
  }
});

test('RT2-N6: oversized, 8.3-named and hardlinked drops are reported, never silently dropped or enqueued', async () => {
  const { vault, outside } = await makeVault();
  const inbox = path.join(vault, '00_Inbox');
  for (const n of ['huge.md', 'huge.pdf']) {
    const fh = await fs.open(path.join(inbox, n), 'w');
    await fh.truncate(64 * 1024 * 1024 + 1);
    await fh.close();
  }
  await fs.writeFile(path.join(inbox, 'Report~1.md'), '# legit\n');
  await fs.writeFile(path.join(outside, 'victim.md'), '# outside\n');
  await fs.link(path.join(outside, 'victim.md'), path.join(inbox, 'h.md'));

  const { seen, w } = start(vault);
  try {
    await waitFor(() => seen.reported.length >= 4, 6000).catch(() => {});
    await sleep(200);
    for (const n of ['huge.md', 'huge.pdf', 'Report~1.md', 'h.md']) {
      assert.ok(seen.reported.includes(`00_Inbox/${n}`), `${n} is reported (got ${JSON.stringify(seen)})`);
      assert.ok(!seen.files.includes(`00_Inbox/${n}`), `${n} is not enqueued for ingest`);
    }
  } finally {
    await w.close();
    for (const n of ['huge.md', 'huge.pdf']) await fs.rm(path.join(inbox, n), { force: true });
  }
});
