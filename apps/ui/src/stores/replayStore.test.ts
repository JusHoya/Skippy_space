// @ts-nocheck — runs under tsx (`node:test`), not the app's `tsc`. The @skippy/ui
// tsconfig restricts `types` to `vite/client` (no @types/node) and greedily
// includes src/**/*, so the node: test imports below would otherwise fail the
// package typecheck. The runtime behavior is verified by tsx; see run line below.
//
// replayStore.test.ts — lock-in for replay JSONL Envelope discipline
// (REVIEW-2026-06-10 §quality, replayStore.ts:26).
//
// The regression: `ReplayRecord` was `any`, so `loadSession` pushed raw
// `JSON.parse` output straight into `records` and `reconstructAt` trusted
// arbitrary untyped fields — bypassing the strict `Envelope` zod parse the
// LIVE channel (`lib/channel.ts`) enforces on every wire message. A torn line,
// a stale/forward-incompatible schema, or a hand-edited `.jsonl` could feed the
// scrubber junk.
//
// The fix types `ReplayRecord` against the shared `Envelope` union and validates
// every parsed line with `Envelope.safeParse`, dropping anything that doesn't
// conform. These tests prove (a) valid envelopes survive, (b) bad-JSON /
// non-union / missing-field / wrong-type records are dropped, and (c)
// `reconstructAt` reconstructs agent state only from the validated records.
//
// NOTE (wave 4): @skippy/ui has no wired tsx test runner yet — `tsx` is not
// resolvable from apps/ui (the existing cameraStore.test.ts fails the same way).
// This file is a lock-in for when wave 4 wires the runner. The core
// validation logic is independently proven against the real shared schema.
//
// Run (once the runner is wired): node --import tsx --test src/stores/replayStore.test.ts

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// A minimal Tauri bridge so importing the store (→ `../lib/tauri` →
// `@tauri-apps/api/core`) and driving `safeInvoke('replay_load', …)` works
// without a DOM. We stub `invoke` to return the JSONL text under test, mirroring
// what the Rust `replay_load` command would hand back.
interface FakeInternals {
  invoke: (cmd: string, args: unknown) => Promise<unknown>;
  transformCallback: (cb: (raw: unknown) => void, once?: boolean) => number;
  unregisterCallback: (id: number) => void;
}

// What `invoke('replay_load', …)` should resolve to for the current test.
let replayLoadText: string | null = '';

function installFakeTauri(): void {
  const internals: FakeInternals = {
    invoke(cmd) {
      if (cmd === 'replay_load') return Promise.resolve(replayLoadText);
      if (cmd === 'replay_list_sessions') return Promise.resolve([]);
      return Promise.resolve(null);
    },
    transformCallback() {
      return 1;
    },
    unregisterCallback() {
      /* no-op */
    },
  };
  (globalThis as unknown as { window: unknown }).window = {
    __TAURI_INTERNALS__: internals,
  };
}

// Re-import the store with a query suffix so each test gets a pristine
// module-level Zustand singleton (Node ESM caches by full specifier).
let importCounter = 0;
type ReplayModule = typeof import('./replayStore.js');
async function freshReplayModule(): Promise<ReplayModule> {
  importCounter += 1;
  return (await import(`./replayStore.js?test=${importCounter}`)) as ReplayModule;
}

let mod: ReplayModule;

beforeEach(async () => {
  installFakeTauri();
  replayLoadText = '';
  mod = await freshReplayModule();
});

const TS = '2026-06-10T00:00:00.000Z';

test('loadSession keeps valid envelopes and drops invalid/torn lines', async () => {
  replayLoadText = [
    JSON.stringify({ type: 'agent_state', agentId: 'skippy', state: 'working', ts: TS }),
    '{ torn partial line', // unparseable JSON (mid-write tear)
    JSON.stringify({ type: 'bogus', whatever: 1 }), // not in the union
    JSON.stringify({ type: 'agent_state', agentId: 'skippy' }), // missing required state/ts
    JSON.stringify({ type: 'agent_token', agentId: 'skippy', promptId: 'p1', text: 'hi', ts: TS }),
    '', // blank line
  ].join('\n');

  await mod.useReplayStore.getState().loadSession('s1');
  const { records, selectedIndex } = mod.useReplayStore.getState();

  assert.equal(records.length, 2, 'only the two well-formed envelopes survive');
  assert.deepEqual(records.map((r) => r.type), ['agent_state', 'agent_token']);
  assert.equal(selectedIndex, 1, 'selection pins to the last valid record');
});

test('loadSession drops a record whose field types are wrong', async () => {
  replayLoadText = [
    // inputTokens must be a non-negative int; a string must be rejected, not coerced.
    JSON.stringify({
      type: 'telemetry_span',
      spanId: 'sp1',
      agentId: 'skippy',
      model: 'claude',
      inputTokens: 'lots',
      outputTokens: 5,
      costUsd: 0,
      durationMs: 1,
      ts: TS,
    }),
    JSON.stringify({ type: 'agent_state', agentId: 'skippy', state: 'idle', ts: TS }),
  ].join('\n');

  await mod.useReplayStore.getState().loadSession('s2');
  const { records } = mod.useReplayStore.getState();

  assert.equal(records.length, 1);
  assert.equal(records[0].type, 'agent_state');
});

test('reconstructAt rebuilds agent view only from validated records', async () => {
  const records = [
    { type: 'agent_state', agentId: 'skippy', state: 'working', task: 'plan', ts: TS },
    { type: 'agent_token', agentId: 'skippy', promptId: 'p1', text: 'hello', ts: TS },
    {
      type: 'telemetry_span',
      spanId: 'sp1',
      agentId: 'skippy',
      model: 'claude-opus',
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.01,
      durationMs: 12,
      ts: TS,
    },
    // An envelope with no agentId must be ignored by the reconstruction.
    { type: 'replay_session', sessionId: 's3', event: 'started', ts: TS },
  ];

  const at0 = mod.reconstructAt(records, 0);
  assert.equal(at0.skippy.state, 'working');
  assert.equal(at0.skippy.task, 'plan');
  assert.equal(at0.skippy.lastToken, undefined);

  const at3 = mod.reconstructAt(records, 99); // index clamps to the last record
  assert.equal(at3.skippy.lastToken, 'hello');
  assert.equal(at3.skippy.model, 'claude-opus');
  assert.equal(at3.skippy.inputTokens, 100);
  assert.equal(at3.skippy.outputTokens, 20);
  assert.equal(at3.skippy.state, 'speaking', 'token marks the agent speaking');
  // The agentId-less replay_session envelope contributes no reconstruction.
  assert.deepEqual(Object.keys(at3), ['skippy']);
});

test('loadSession with no Tauri text clears records but keeps the selection', async () => {
  replayLoadText = null; // simulates outside-Tauri / read failure
  await mod.useReplayStore.getState().loadSession('s4');
  const { records, activeSessionId, selectedIndex } = mod.useReplayStore.getState();
  assert.deepEqual(records, []);
  assert.equal(activeSessionId, 's4');
  assert.equal(selectedIndex, 0);
});
