// vault-watcher.test.ts — WS-E regression test: only declared-supported
// extensions are enqueued for extraction (FR-WIKI-03 / A04).
//
// Run via: node --import tsx --test src/vault-watcher.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { watchInbox } from './vault-watcher.js';

async function makeVault(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skippy-watcher-'));
  await fs.mkdir(path.join(root, '00_Inbox'), { recursive: true });
  return root;
}

function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
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

test('supported extensions go to onFile; unsupported go to onUnsupported, not onFile', async () => {
  const vaultRoot = await makeVault();
  const supported: string[] = [];
  const unsupported: Array<{ p: string; ext: string }> = [];

  const watcher = watchInbox({
    vaultRoot,
    onFile: (p) => supported.push(p),
    onUnsupported: (p, ext) => unsupported.push({ p, ext }),
  });

  try {
    // The watcher's directory check + chokidar setup is async; give it a
    // moment to start before writing, so the 'add' events aren't missed.
    await new Promise((r) => setTimeout(r, 300));
    await fs.writeFile(path.join(vaultRoot, '00_Inbox', 'good.md'), '# hi\n');
    await fs.writeFile(path.join(vaultRoot, '00_Inbox', 'bad.pdf'), Buffer.from([0x25, 0x50, 0x44, 0x46]));

    await waitFor(() => supported.length >= 1 && unsupported.length >= 1, 6000);

    assert.equal(supported.length, 1);
    assert.ok(supported[0]!.endsWith('good.md'));

    assert.equal(unsupported.length, 1);
    assert.ok(unsupported[0]!.p.endsWith('bad.pdf'));
    assert.equal(unsupported[0]!.ext, '.pdf');
  } finally {
    await watcher.close();
  }
});

test('an .ingest-error.json sidecar is ignored, never re-enqueued', async () => {
  const vaultRoot = await makeVault();
  const seen: string[] = [];

  const watcher = watchInbox({ vaultRoot, onFile: (p) => seen.push(p) });
  try {
    await fs.writeFile(
      path.join(vaultRoot, '00_Inbox', 'bad.pdf.ingest-error.json'),
      JSON.stringify({ reason: 'unsupported-format' }),
    );
    // Give chokidar a moment; nothing should ever fire for the sidecar.
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual(seen, []);
  } finally {
    await watcher.close();
  }
});
