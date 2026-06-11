// shutdown.test.ts — lock-in for the unified, idempotent graceful-shutdown path.
//
// Proves the fix for the two-competing-shutdown-paths race:
//   (a) the drain runs exactly once and exit(0) follows it (not before);
//   (b) a second trigger (e.g. a second Ctrl+C, or SIGTERM racing stdin-EOF)
//       coalesces onto the in-flight drain — it neither re-runs the teardown
//       nor short-circuits the process exit;
//   (c) SIGTERM and SIGINT both drive that same single drain;
//   (d) a drain that rejects still lets the process exit (a hung sidecar on
//       app-close is worse than a partial teardown).
//
// We inject the `exit` hook so the test runner is never actually killed, and we
// remove the signal listeners setupGracefulShutdown registers between tests so
// the cases don't bleed into each other.
//
// Run: node --import tsx --test src/shutdown.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setupGracefulShutdown } from './shutdown.js';

/** Detach every SIGTERM/SIGINT listener so each test starts from a clean slate. */
function clearSignalListeners(): void {
  process.removeAllListeners('SIGTERM');
  process.removeAllListeners('SIGINT');
}

/** A barrier promise plus its resolver, for holding a drain open mid-flight. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test('drain runs exactly once and exit(0) follows it', async () => {
  clearSignalListeners();
  let drainCalls = 0;
  let drainDoneBeforeExit = false;
  let exitCode: number | null = null;

  const { triggerShutdown } = setupGracefulShutdown(
    async () => {
      drainCalls++;
      // Yield a microtask so "exit before drain settles" would be observable.
      await Promise.resolve();
      drainDoneBeforeExit = true;
    },
    (code) => {
      exitCode = code;
    },
  );

  await triggerShutdown('stdin-eof');

  assert.equal(drainCalls, 1, 'drain ran once');
  assert.equal(exitCode, 0, 'exited 0');
  assert.ok(drainDoneBeforeExit, 'exit happened AFTER the drain settled');
  clearSignalListeners();
});

test('a second trigger coalesces — no double-run, no early exit', async () => {
  clearSignalListeners();
  let drainCalls = 0;
  let exitCalls = 0;
  const gate = deferred();

  const { triggerShutdown } = setupGracefulShutdown(
    async () => {
      drainCalls++;
      // Hold the drain open so the second trigger lands mid-flight.
      await gate.promise;
    },
    () => {
      exitCalls++;
    },
  );

  const first = triggerShutdown('SIGTERM');
  // Second trigger arrives while the first drain is still running.
  const second = triggerShutdown('stdin-eof');

  assert.equal(drainCalls, 1, 'second trigger did NOT start a second drain');
  assert.equal(exitCalls, 0, 'no exit while the drain is still in flight');

  gate.resolve();
  await Promise.all([first, second]);

  assert.equal(drainCalls, 1, 'still exactly one drain after both settle');
  assert.equal(exitCalls, 1, 'process exits exactly once');
  clearSignalListeners();
});

test('SIGTERM and SIGINT both drive the single drain', async () => {
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    clearSignalListeners();
    let drainCalls = 0;
    let exitCode: number | null = null;
    const done = deferred();

    setupGracefulShutdown(
      async () => {
        drainCalls++;
      },
      (code) => {
        exitCode = code;
        done.resolve();
      },
    );

    process.emit(sig);
    await done.promise;

    assert.equal(drainCalls, 1, `${sig} ran the drain once`);
    assert.equal(exitCode, 0, `${sig} exited 0`);
    clearSignalListeners();
  }
});

test('a rejecting drain still exits the process', async () => {
  clearSignalListeners();
  let exitCode: number | null = null;

  const { triggerShutdown } = setupGracefulShutdown(
    async () => {
      throw new Error('teardown blew up');
    },
    (code) => {
      exitCode = code;
    },
  );

  await triggerShutdown('SIGINT');

  assert.equal(exitCode, 0, 'a failed drain must not wedge the process — it still exits');
  clearSignalListeners();
});
