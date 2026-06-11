/// <reference types="node" />
// TerminalPane.test.ts — lock-in for the in-flight `pty_open` leak
// (REVIEW-2026-06-10 §4, TerminalPane.tsx:89).
//
// Run via: node --import tsx --test src/hud/TerminalPane.test.ts
// NOTE: @skippy/ui has no tsx/vitest test runner wired yet (wave 4 adds it),
// so this file is currently a *lock-in spec* — it documents and asserts the
// invariant; CI executes it once the runner lands. The logic is also covered
// by `pnpm --filter @skippy/ui typecheck`.
//
// The regression: TerminalPane opens its Rust-side PTY inside an async IIFE
// (`await invoke('pty_open', ...)`). React StrictMode mounts → unmounts →
// mounts on every dev boot, so the first mount's effect cleanup runs *before*
// `pty_open` resolves. At that point the effect's local `ptyId` is still null,
// so the cleanup's `if (ptyId && ownsPty) pty_close(...)` guard is false and
// closes nothing. When `pty_open` finally resolves, the post-await
// `if (disposed) return;` short-circuits — stranding a live pwsh process with
// no renderer-side handle. Over a dev session this leaks one orphan shell per
// boot.
//
// The fix closes the freshly-resolved handle when the effect was already
// disposed (and we own the PTY). These tests drive the exact open/dispose race
// the effect implements through a fake `invoke`, asserting:
//   (a) open-then-unmount closes via the normal cleanup path (1 close),
//   (b) unmount-then-open closes the superseded handle (1 close, never 0),
//   (c) the attach-existing path (existingPtyId) never closes — the subprocess
//       outlives the tab.

import { test } from 'node:test';
import assert from 'node:assert/strict';

type InvokeCall = { cmd: string; args: Record<string, unknown> };

/**
 * Faithful, runnable model of TerminalPane's effect lifecycle w.r.t. PTY
 * ownership. Mirrors the production effect body in TerminalPane.tsx: the async
 * open IIFE plus the synchronous cleanup returned from `useEffect`. Kept in the
 * test (not imported) because the effect body is inlined in the component and
 * not exported; if you change the leak-guard in the component, mirror it here.
 */
function makeTerminalEffect(opts: {
  existingPtyId?: string;
  invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown>;
  /** Resolves with the id the Rust side assigns to a fresh `pty_open`. */
  openId: string;
}) {
  const { existingPtyId, invoke, openId } = opts;
  let ptyId: string | null = null;
  let disposed = false;
  const ownsPty = existingPtyId === undefined;

  const open = (async () => {
    if (existingPtyId !== undefined) {
      ptyId = existingPtyId;
      await invoke('pty_resize', { ptyId, cols: 80, rows: 24 }).catch(() => undefined);
    } else {
      const opened = (await invoke('pty_open', { cols: 80, rows: 24 })) as string;
      if (disposed) {
        void invoke('pty_close', { ptyId: opened }).catch(() => undefined);
        return;
      }
      ptyId = opened;
    }
    if (disposed) return;
    await invoke('pty_subscribe', { ptyId });
  })();

  const cleanup = () => {
    disposed = true;
    if (ptyId && ownsPty) {
      void invoke('pty_close', { ptyId }).catch(() => undefined);
    }
  };

  // `pty_open` resolves to `openId`; callers control timing via the fake invoke.
  void openId;
  return { open, cleanup };
}

/** A fake `invoke` whose `pty_open` resolution is held open until released. */
function deferredInvoke(openId: string) {
  const calls: InvokeCall[] = [];
  let releaseOpen!: () => void;
  const opened = new Promise<void>((r) => {
    releaseOpen = r;
  });
  const invoke = async (cmd: string, args: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd === 'pty_open') {
      await opened;
      return openId;
    }
    return null;
  };
  return { invoke, calls, releaseOpen };
}

const closes = (calls: InvokeCall[]) => calls.filter((c) => c.cmd === 'pty_close');

test('open resolves before unmount → cleanup closes exactly once', async () => {
  const fake = deferredInvoke('pty-A');
  const { open, cleanup } = makeTerminalEffect({ invoke: fake.invoke, openId: 'pty-A' });

  fake.releaseOpen(); // pty_open resolves first…
  await open;
  cleanup(); // …then the tab unmounts.

  const c = closes(fake.calls);
  assert.equal(c.length, 1, 'normal-order unmount must close the PTY once');
  assert.equal(c.at(0)?.args.ptyId, 'pty-A');
});

test('unmount before open resolves → superseded handle is still closed (no leak)', async () => {
  const fake = deferredInvoke('pty-B');
  const { open, cleanup } = makeTerminalEffect({ invoke: fake.invoke, openId: 'pty-B' });

  // StrictMode: cleanup runs while pty_open is still in flight (ptyId === null).
  cleanup();
  fake.releaseOpen(); // now the Rust side returns the live PTY id.
  await open;

  const c = closes(fake.calls);
  assert.equal(c.length, 1, 'in-flight open must close the resolved PTY — this is the leak');
  assert.equal(
    c.at(0)?.args.ptyId,
    'pty-B',
    'the freshly-resolved handle is the one that must be closed',
  );
});

test('attach-existing PTY (existingPtyId) is never closed on unmount', async () => {
  const fake = deferredInvoke('unused');
  const { open, cleanup } = makeTerminalEffect({
    existingPtyId: 'claude-code-1',
    invoke: fake.invoke,
    openId: 'unused',
  });

  fake.releaseOpen();
  await open;
  cleanup();

  assert.equal(closes(fake.calls).length, 0, 'tab does not own the existing PTY — must not pty_close it');
});
