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

// E4-2: a file already sitting in the inbox BEFORE the watcher starts (e.g.
// a crash left it there, or the sidecar restarted mid-backlog) must still be
// enqueued — not silently stranded forever because `ignoreInitial` skipped it.
test('E4-2: a pre-existing inbox file is enqueued by the startup scan', async () => {
  const vaultRoot = await makeVault();
  await fs.writeFile(path.join(vaultRoot, '00_Inbox', 'leftover.md'), '# Leftover\n');

  const supported: string[] = [];
  const watcher = watchInbox({ vaultRoot, onFile: (p) => supported.push(p) });
  try {
    await waitFor(() => supported.length >= 1, 4000);
    assert.ok(supported[0]!.endsWith('leftover.md'));
  } finally {
    await watcher.close();
  }
});

// E4-2: a file that previously failed (recorded via its `.ingest-error.json`
// sidecar) and is later overwritten with DIFFERENT content must be retried —
// the old failure recorded a different content hash, so this isn't a loop.
test('E4-2: a file overwritten with different content after a failure is retried', async () => {
  const vaultRoot = await makeVault();
  const inboxDir = path.join(vaultRoot, '00_Inbox');
  const target = path.join(inboxDir, 'retry.md');
  await fs.writeFile(target, '# First\n');

  // Simulate a prior failed ingest of the FIRST content (mirrors what
  // `ingest/errors.ts#writeIngestError` would have written for it).
  const { sha256Hex } = await import('./ingest/originals.js');
  const firstHash = sha256Hex(await fs.readFile(target));
  await fs.writeFile(
    `${target}.ingest-error.json`,
    JSON.stringify({
      sourcePath: target,
      reason: 'invalid-encoding',
      detail: 'simulated prior failure',
      extension: '.md',
      at: new Date().toISOString(),
      contentSha256: firstHash,
    }),
  );

  const supported: string[] = [];
  const watcher = watchInbox({ vaultRoot, onFile: (p) => supported.push(p) });
  try {
    // Startup scan sees the SAME content the sidecar already covers — must
    // NOT be re-enqueued (no infinite fail-retry loop).
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(supported.length, 0, 'unchanged failing content is not re-enqueued');

    // Now the file is overwritten with genuinely different content — this
    // must be retried.
    await new Promise((r) => setTimeout(r, 300));
    await fs.writeFile(target, '# Second, actually different\n');
    await waitFor(() => supported.length >= 1, 4000);
    assert.ok(supported[0]!.endsWith('retry.md'));
  } finally {
    await watcher.close();
  }
});
