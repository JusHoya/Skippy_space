/// <reference types="node" />
// channel.test.ts — lock-in for the StrictMode double-subscribe bug
// (REVIEW-2026-06-10 §1, channel.ts).
//
// Run via: node --import tsx --test src/lib/channel.test.ts
//
// The regression: `useEventChannel`'s effect cleanup used to be a no-op, so
// React StrictMode's intentional mount → cleanup → mount registered TWO live
// `events_subscribe` channels in the Rust EventBus. Every envelope was then
// processed twice — `promptStore.appendToken` (string concat) duplicated each
// streamed token and `telemetryStore.recordSpan` double-billed cost.
//
// These tests prove the fix without a DOM/React renderer by driving the exact
// effect body React runs (`_subscribeEffect`) through the StrictMode sequence,
// then asserting (a) only ONE channel is ever opened and (b) an envelope routed
// through that channel is handled exactly once.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// A minimal stand-in for Tauri's injected bridge. `isTauri()` checks for
// `window.__TAURI_INTERNALS__`; the real `Channel` constructor calls
// `transformCallback` and `invoke` calls `invoke` on this object. We record
// every `events_subscribe` call and keep the channel callback so the test can
// push messages the way the Rust side would.
interface FakeInternals {
  invokeCalls: { cmd: string; args: unknown }[];
  // The function the real Channel registered; feeding it `{ index, message }`
  // drives the channel's `onmessage`, exactly like the Rust EventBus does.
  channelCallback: ((raw: unknown) => void) | null;
  callbackId: number;
  invoke: (cmd: string, args: unknown) => Promise<unknown>;
  transformCallback: (cb: (raw: unknown) => void, once: boolean) => number;
  unregisterCallback: (id: number) => void;
}

function installFakeTauri(): FakeInternals {
  const internals: FakeInternals = {
    invokeCalls: [],
    channelCallback: null,
    callbackId: 0,
    transformCallback(cb) {
      // The renderer only ever opens one Channel here; capture its callback.
      internals.channelCallback = cb;
      internals.callbackId += 1;
      return internals.callbackId;
    },
    invoke(cmd, args) {
      internals.invokeCalls.push({ cmd, args });
      return Promise.resolve(null);
    },
    unregisterCallback() {
      /* no-op for the test */
    },
  };
  // jsdom-free: define just enough of `window` for `isTauri()` + Channel.
  (globalThis as unknown as { window: unknown }).window = {
    __TAURI_INTERNALS__: internals,
  };
  return internals;
}

let internals: FakeInternals;

beforeEach(async () => {
  internals = installFakeTauri();
  // Fresh module state per test: the singleton lives at module scope, so we
  // import a cache-busted copy each time to start from zero subscriptions.
  const mod = await freshChannelModule();
  currentMod = mod;
});

// We re-import the module under test with a query suffix so each test gets a
// pristine module-level singleton (Node ESM caches by full specifier).
let importCounter = 0;
type ChannelModule = typeof import('./channel.js');
let currentMod: ChannelModule;
async function freshChannelModule(): Promise<ChannelModule> {
  importCounter += 1;
  return (await import(`./channel.js?test=${importCounter}`)) as ChannelModule;
}

// Emulate a Rust-side envelope delivery through the single open channel.
function deliver(raw: unknown): void {
  const cb = internals.channelCallback;
  assert.ok(cb, 'no channel was opened');
  cb({ index: deliveredCount, message: raw });
  deliveredCount += 1;
}
let deliveredCount = 0;

beforeEach(() => {
  deliveredCount = 0;
});

test('StrictMode mount → cleanup → mount yields a single live subscription', () => {
  const { _subscribeEffect, _activeSubscriptionCount, _mountCount } = currentMod;

  // React StrictMode runs the effect, immediately runs its cleanup, then runs
  // the effect again — all on the first commit. Replay that exactly.
  const cleanup1 = _subscribeEffect();
  cleanup1();
  const cleanup2 = _subscribeEffect();

  assert.equal(
    _activeSubscriptionCount(),
    1,
    'exactly one channel must be live after a StrictMode double-mount',
  );
  assert.equal(_mountCount(), 1, 'ref-count should net to one live mount');

  // Only one `events_subscribe` should have hit the Rust shell.
  const subscribes = internals.invokeCalls.filter((c) => c.cmd === 'events_subscribe');
  assert.equal(subscribes.length, 1, 'events_subscribe must be invoked once, not twice');

  cleanup2();
});

test('an envelope routed through the singleton is processed exactly once', async () => {
  const { _subscribeEffect } = currentMod;
  // The channel module imports the store via a BARE specifier, so every
  // cache-busted channel copy shares the one canonical store module. Import it
  // the same (unsuffixed) way to observe the exact state the dispatcher writes.
  const { usePromptStore } = (await import(
    '../stores/promptStore.js'
  )) as typeof import('../stores/promptStore.js');

  // StrictMode double-mount.
  const cleanup1 = _subscribeEffect();
  cleanup1();
  const cleanup2 = _subscribeEffect();

  const promptId = 'prompt-1';
  usePromptStore.getState().setPrompt(promptId, 'hi');

  // One token envelope, delivered once by the Rust side.
  deliver({
    type: 'agent_token',
    agentId: 'skippy',
    promptId,
    text: 'X',
    ts: new Date().toISOString(),
  });

  // The pre-fix bug opened two channels, so a single delivery fanned out to two
  // `appendToken` calls → 'XX'. With one channel it must be exactly 'X'.
  assert.equal(usePromptStore.getState().current?.streamed, 'X');

  cleanup2();
});

test('a failed events_subscribe rolls back so a later mount can retry', async () => {
  // Re-stub invoke to reject, simulating the shell command failing.
  internals.invoke = (cmd, args) => {
    internals.invokeCalls.push({ cmd, args });
    return Promise.reject(new Error('shell unavailable'));
  };

  const { _subscribeEffect, _activeSubscriptionCount } = currentMod;

  const cleanup = _subscribeEffect();
  // Let the rejected invoke settle (a macrotask drains all pending microtasks,
  // including the `.catch` rollback inside ensureSubscribed).
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(
    _activeSubscriptionCount(),
    0,
    'a failed subscription must roll back to zero so a retry can re-subscribe',
  );

  cleanup();
});
