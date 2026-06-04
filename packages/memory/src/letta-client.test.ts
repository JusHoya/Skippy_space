// letta-client.test.ts — WS-C graceful-degradation tests (node:test).
//
// Run via: node --import tsx --test src/letta-client.test.ts
//
// Mirrors clients.degraded.test.ts. Asserts the two degraded paths only — no live
// Letta server required:
//   - LETTA_DISABLED=1 → available() is false and every method returns {ok:false}
//     with ZERO network I/O (asserted by the call returning effectively instantly,
//     well under the request timeout).
//   - an unreachable host (port 9 / discard) → available() false and every method
//     returns {ok:false} within the timeout, never throwing.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LettaClient } from './letta-client.js';

// Port 9 (discard) is effectively never listening; fetch → ECONNREFUSED fast.
// A short timeout keeps the test snappy even if the OS slow-fails the connect.
function unreachableClient(): LettaClient {
  return new LettaClient({ baseUrl: 'http://127.0.0.1:9', timeoutMs: 1000 });
}

// ──────────────────────────────────────────────────────────────────────────────
// LETTA_DISABLED=1 — the zero-network kill switch.
// ──────────────────────────────────────────────────────────────────────────────

test('LettaClient: LETTA_DISABLED=1 → available() false + every method {ok:false}, zero network', async () => {
  const prev = process.env.LETTA_DISABLED;
  process.env.LETTA_DISABLED = '1';
  try {
    // Point at a real-looking but unreachable host to prove we never dial it: the
    // kill switch must short-circuit *before* any fetch, so these resolve instantly.
    const client = new LettaClient({ baseUrl: 'http://127.0.0.1:9', timeoutMs: 5000 });

    const started = Date.now();

    assert.equal(await client.available(), false);

    const search = await client.searchArchival('agent-1', 'plasma confinement');
    assert.equal(search.ok, false);
    if (!search.ok) assert.match(search.error, /disabled/i);

    const append = await client.appendArchival('agent-1', 'a new memory');
    assert.equal(append.ok, false);
    if (!append.ok) assert.match(append.error, /disabled/i);

    const edit = await client.editCore('agent-1', 'persona', 'updated');
    assert.equal(edit.ok, false);
    if (!edit.ok) assert.match(edit.error, /disabled/i);

    // ZERO network: even with a 5s timeout, all four calls returned synchronously.
    // If any had dialed the unreachable host we'd be at/over the connect latency.
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 500, `expected zero-network fast path, took ${elapsed}ms`);
  } finally {
    if (prev === undefined) delete process.env.LETTA_DISABLED;
    else process.env.LETTA_DISABLED = prev;
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Unreachable host — the real-network degradation path.
// ──────────────────────────────────────────────────────────────────────────────

test('LettaClient: unreachable host → available() is false, no throw', async () => {
  // Guard against an ambient LETTA_DISABLED leaking in and trivializing the test.
  const prev = process.env.LETTA_DISABLED;
  delete process.env.LETTA_DISABLED;
  try {
    const client = unreachableClient();
    const avail = await client.available();
    assert.equal(avail, false);
  } finally {
    if (prev !== undefined) process.env.LETTA_DISABLED = prev;
  }
});

test('LettaClient: every method returns {ok:false} against an unreachable host', async () => {
  const prev = process.env.LETTA_DISABLED;
  delete process.env.LETTA_DISABLED;
  try {
    const client = unreachableClient();

    const search = await client.searchArchival('agent-1', 'plasma confinement', 5);
    assert.equal(search.ok, false);
    if (!search.ok) assert.equal(typeof search.error, 'string');

    const append = await client.appendArchival('agent-1', 'a new memory');
    assert.equal(append.ok, false);
    if (!append.ok) assert.equal(typeof append.error, 'string');

    const edit = await client.editCore('agent-1', 'persona', 'updated value');
    assert.equal(edit.ok, false);
    if (!edit.ok) assert.equal(typeof edit.error, 'string');
  } finally {
    if (prev !== undefined) process.env.LETTA_DISABLED = prev;
  }
});
