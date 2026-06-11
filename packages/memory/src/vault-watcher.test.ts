// vault-watcher.test.ts — inbox retry + startup-recovery tests (node:test).
//
// Run via: node --import tsx --test src/vault-watcher.test.ts
//
// These lock in the REVIEW §3 fix: an inbox drop must never strand on a transient
// ingest failure or across a restart. We assert, against a real temp directory:
//   - a pre-existing drop (present before the watcher starts) is enqueued at
//     startup, despite chokidar's ignoreInitial;
//   - a drop whose first onFile *fails* is retried on the next re-scan (not marked
//     done) and eventually succeeds — i.e. failure does not strand it;
//   - a drop whose onFile *succeeds* and is then removed (as Job 1 does) is not
//     re-enqueued.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { watchInbox, type InboxWatcher } from './vault-watcher.js';

async function tmpInbox(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skippy-inbox-'));
  const inbox = path.join(root, '00_Inbox');
  await fs.mkdir(inbox, { recursive: true });
  return inbox;
}

/** Poll `cond` until true or `ms` elapses; keeps the tests fast and non-flaky. */
async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.fail(`condition not met within ${ms}ms`);
}

test('startup scan: a pre-existing drop is enqueued despite ignoreInitial', async () => {
  const inbox = await tmpInbox();
  // Drop a file BEFORE the watcher starts — chokidar's ignoreInitial would skip it,
  // so only the startup scan can surface it.
  await fs.writeFile(path.join(inbox, 'pre-existing.md'), '# already here');

  const seen: string[] = [];
  let watcher: InboxWatcher | undefined;
  try {
    watcher = watchInbox({
      vaultRoot: path.dirname(inbox),
      dir: inbox,
      rescanMs: 0, // startup scan only — no periodic re-scan needed for this case
      onFile: (abs) => {
        seen.push(path.basename(abs));
      },
    });
    await waitFor(() => seen.includes('pre-existing.md'));
  } finally {
    await watcher?.close();
  }
  assert.deepEqual(seen, ['pre-existing.md']);
});

test('retry: a failed ingest is retried on the next re-scan (not stranded)', async () => {
  const inbox = await tmpInbox();
  const drop = path.join(inbox, 'flaky.md');
  await fs.writeFile(drop, '# flaky drop');

  let attempts = 0;
  let watcher: InboxWatcher | undefined;
  try {
    watcher = watchInbox({
      vaultRoot: path.dirname(inbox),
      dir: inbox,
      rescanMs: 50, // fast recovery cadence for the test
      onFile: async (_abs) => {
        attempts += 1;
        // Fail the first attempt (transient), succeed thereafter. A successful
        // "ingest" removes the drop, mirroring Job 1 — which also proves we stop.
        if (attempts === 1) throw new Error('transient ingest failure');
        await fs.rm(drop);
      },
    });
    // First attempt fails → drop is NOT marked done → a later re-scan retries it.
    await waitFor(() => attempts >= 2, 4000);
    assert.ok(attempts >= 2, 'the failed drop was retried at least once');
    // The 2nd attempt succeeded and removed the file (Job 1 semantics); let a few
    // more re-scan cycles pass and confirm it isn't retried forever.
    const settled = attempts;
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(attempts, settled, 'a succeeded+removed drop must not be re-enqueued');
  } finally {
    await watcher?.close();
  }
});

test('debounce: a single successful drop fires onFile exactly once', async () => {
  const inbox = await tmpInbox();
  const drop = path.join(inbox, 'once.md');
  await fs.writeFile(drop, '# ingest me');

  let calls = 0;
  let watcher: InboxWatcher | undefined;
  try {
    watcher = watchInbox({
      vaultRoot: path.dirname(inbox),
      dir: inbox,
      rescanMs: 40,
      onFile: async (_abs) => {
        calls += 1;
        await fs.rm(drop); // success → removed (Job 1 semantics)
      },
    });
    await waitFor(() => calls >= 1);
    // Let several re-scan cycles pass; the removed drop must not re-fire.
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(calls, 1, 'a single drop must ingest exactly once');
  } finally {
    await watcher?.close();
  }
});

test('missing inbox: watcher is a graceful no-op (never throws)', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skippy-noinbox-'));
  let watcher: InboxWatcher | undefined;
  try {
    watcher = watchInbox({
      vaultRoot: root, // no 00_Inbox here
      onFile: () => assert.fail('onFile must not fire when the inbox is absent'),
    });
    // Give the async stat() a beat to resolve into the no-op branch.
    await new Promise((r) => setTimeout(r, 100));
  } finally {
    await watcher?.close();
  }
});
