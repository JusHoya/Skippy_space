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
  const { _subscribeEffect, flushTokenBatch } = currentMod;
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

  // Token writes are now coalesced onto the next frame, so drain the batch
  // synchronously before asserting (no rAF in the Node test env).
  flushTokenBatch();

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

// ── Token coalescing (REVIEW-2026-06-10 §4 / perf) ──────────────────────────
//
// A burst of N `agent_token` envelopes used to write to promptStore AND
// agentStore N times — re-rendering three HUD components + re-running the scene
// glow subscription per token. The fix buffers them and flushes once per frame.
// These lock-ins prove (a) a burst collapses to a single store write yet (b)
// the concatenated narration is still whole and in order.

test('a burst of tokens collapses to ONE appendToken / setAgent write', async () => {
  const { _subscribeEffect, flushTokenBatch, _pendingTokenPromptCount } = currentMod;
  const { usePromptStore } = (await import(
    '../stores/promptStore.js'
  )) as typeof import('../stores/promptStore.js');
  const { useAgentStore } = (await import(
    '../stores/agentStore.js'
  )) as typeof import('../stores/agentStore.js');

  // Count store writes by wrapping the actions.
  let appendCalls = 0;
  const realAppend = usePromptStore.getState().appendToken;
  usePromptStore.setState({
    appendToken: (id: string, chunk: string) => {
      appendCalls += 1;
      realAppend(id, chunk);
    },
  });
  let setAgentCalls = 0;
  const realSetAgent = useAgentStore.getState().setAgent;
  useAgentStore.setState({
    setAgent: ((id: Parameters<typeof realSetAgent>[0], patch) => {
      setAgentCalls += 1;
      realSetAgent(id, patch);
    }) as typeof realSetAgent,
  });

  const cleanup = _subscribeEffect();
  const promptId = 'prompt-burst';
  usePromptStore.getState().setPrompt(promptId, 'hi');

  // Five tokens, all delivered before any frame flush.
  for (const t of ['H', 'e', 'l', 'l', 'o']) {
    deliver({
      type: 'agent_token',
      agentId: 'skippy',
      promptId,
      text: t,
      ts: new Date().toISOString(),
    });
  }

  // Nothing written yet — all five sit in the per-prompt buffer.
  assert.equal(appendCalls, 0, 'tokens must not write to the store until the frame flush');
  assert.equal(_pendingTokenPromptCount(), 1, 'one prompt should have buffered tokens');

  // One frame later (driven manually): a single batched write per store.
  flushTokenBatch();
  assert.equal(appendCalls, 1, 'a 5-token burst must coalesce to ONE appendToken');
  assert.equal(setAgentCalls, 1, 'a 5-token burst must coalesce to ONE setAgent');
  assert.equal(_pendingTokenPromptCount(), 0, 'the buffer must drain on flush');

  // Narration is whole and in order.
  assert.equal(usePromptStore.getState().current?.streamed, 'Hello');

  cleanup();
  // Restore the real actions so the shared store singleton doesn't leak the
  // call-counting wrappers into later tests.
  usePromptStore.setState({ appendToken: realAppend });
  useAgentStore.setState({ setAgent: realSetAgent });
});

test('agent_complete flushes buffered tokens before finalizing', async () => {
  const { _subscribeEffect } = currentMod;
  const { usePromptStore } = (await import(
    '../stores/promptStore.js'
  )) as typeof import('../stores/promptStore.js');

  const cleanup = _subscribeEffect();
  const promptId = 'prompt-complete';
  usePromptStore.getState().setPrompt(promptId, 'hi');

  const ts = new Date().toISOString();
  deliver({ type: 'agent_token', agentId: 'skippy', promptId, text: 'done', ts });
  // Completion arrives with the last token still buffered — it must flush first.
  deliver({ type: 'agent_complete', agentId: 'skippy', promptId, ts });

  const cur = usePromptStore.getState().current;
  assert.equal(cur?.complete, true, 'prompt should be marked complete');
  assert.equal(cur?.streamed, 'done', 'the final buffered token must survive completion');

  cleanup();
});

// ── sidecar-crash recovery (REVIEW §5 critic, sidecar.rs) ───────────────────
//
// A sidecar (agent-runtime child) crash used to be invisible to the renderer:
// only a console-bound Log signalled it, so an in-flight Skippy turn stayed in
// 'thinking'/'speaking' forever — the dead child can never emit the
// agent_complete that would idle it. The fix adds a `sidecar_status` envelope
// that, on 'crashed'/'restarted', resets the agent roster so nothing hangs.

test('sidecar_status:crashed resets a stuck thinking/speaking agent to idle', async () => {
  const { dispatchEnvelope } = currentMod;
  const { useAgentStore } = (await import(
    '../stores/agentStore.js'
  )) as typeof import('../stores/agentStore.js');

  // Skippy is mid-turn (speaking) and a board is mid-task (thinking) when the
  // runtime dies — exactly the state that used to hang forever.
  useAgentStore.getState().setAgent('skippy', { state: 'speaking' });
  useAgentStore.getState().setAgent('board.coding' as never, { state: 'thinking' });
  assert.equal(useAgentStore.getState().agents.skippy?.state, 'speaking');

  dispatchEnvelope({
    type: 'sidecar_status',
    event: 'crashed',
    detail: 'sidecar exited with status ExitStatus(...)',
    ts: new Date().toISOString(),
  });

  // The whole runtime is gone, so the roster collapses back to a lone idle
  // Skippy — no agent is left stranded mid-turn.
  const agents = useAgentStore.getState().agents;
  assert.equal(agents.skippy?.state, 'idle', 'Skippy must un-stick to idle after a crash');
  assert.equal(
    agents['board.coding'],
    undefined,
    'the dead board sprite is cleared; it re-announces on restart',
  );
});

test('sidecar_status:ready (clean cold boot) does NOT wipe the roster', async () => {
  const { dispatchEnvelope } = currentMod;
  const { useAgentStore } = (await import(
    '../stores/agentStore.js'
  )) as typeof import('../stores/agentStore.js');

  useAgentStore.getState().setAgent('board.research' as never, { state: 'working' });

  dispatchEnvelope({
    type: 'sidecar_status',
    event: 'ready',
    ts: new Date().toISOString(),
  });

  // A first clean boot is informational only — it must not reset live agents
  // (there's been no crash to recover from).
  assert.equal(
    useAgentStore.getState().agents['board.research']?.state,
    'working',
    'a ready pulse must not disturb the existing roster',
  );
});

// ── memory_job is no longer dropped (REVIEW-2026-06-10 §4) ──────────────────

test('memory_job envelopes are published, not dropped', () => {
  const { dispatchEnvelope, latestMemoryJob } = currentMod;

  assert.equal(latestMemoryJob(), null, 'no memory-job pulse seen yet');

  const env = {
    type: 'memory_job' as const,
    job: 'ingest' as const,
    phase: 'complete' as const,
    sourcePath: 'vault/00_Inbox/x.md',
    counts: { sources: 1, atomic: 7 },
    ts: new Date().toISOString(),
  };
  dispatchEnvelope(env);

  const latest = latestMemoryJob();
  assert.ok(latest, 'memory_job must be surfaced, not silently discarded');
  assert.equal(latest?.job, 'ingest');
  assert.equal(latest?.phase, 'complete');
  assert.equal(latest?.counts?.atomic, 7);
});
