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

// ──────────────────────────────────────────────────────────────────────────────
// status() — the health signal (REVIEW §3/§7): callers must be able to tell
// `disabled` from `down` from `degraded` from `connected`, not just see {ok:false}.
// ──────────────────────────────────────────────────────────────────────────────

test('LettaClient.status(): LETTA_DISABLED=1 → "disabled" (and available() false)', async () => {
  const prev = process.env.LETTA_DISABLED;
  process.env.LETTA_DISABLED = '1';
  try {
    const client = new LettaClient({ baseUrl: 'http://127.0.0.1:9', timeoutMs: 5000 });
    const started = Date.now();
    assert.equal(await client.status(), 'disabled');
    assert.equal(await client.available(), false);
    // disabled is the zero-network fast path — must resolve well under the timeout.
    assert.ok(Date.now() - started < 500, 'status() must not dial when disabled');
  } finally {
    if (prev === undefined) delete process.env.LETTA_DISABLED;
    else process.env.LETTA_DISABLED = prev;
  }
});

test('LettaClient.status(): unreachable host → "down" (distinct from "disabled")', async () => {
  const prev = process.env.LETTA_DISABLED;
  delete process.env.LETTA_DISABLED;
  try {
    const client = unreachableClient();
    const status = await client.status();
    // A transport failure (ECONNREFUSED/timeout) is "down" — the server is off, which
    // is observably different from the intentional "disabled" kill switch above.
    assert.equal(status, 'down');
    assert.notEqual(status, 'disabled');
    assert.equal(await client.available(), false);
  } finally {
    if (prev !== undefined) process.env.LETTA_DISABLED = prev;
  }
});

test('LettaClient.status(): a reachable-but-unhealthy server → "degraded"', async () => {
  const prev = process.env.LETTA_DISABLED;
  delete process.env.LETTA_DISABLED;
  // Stand up a server that answers HTTP but never 2xx on the probe routes: the box
  // is *up* (so not "down") yet not serving a healthy API (so not "connected").
  const { createServer } = await import('node:http');
  const server = createServer((_req, res) => {
    res.statusCode = 401; // auth rejected — a classic degraded signal
    res.end('unauthorized');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  try {
    const client = new LettaClient({
      baseUrl: `http://127.0.0.1:${port}`,
      timeoutMs: 1000,
    });
    const status = await client.status();
    assert.equal(status, 'degraded');
    // degraded is "no working Letta" for callers, but it's observably not "down".
    assert.equal(await client.available(), false);
    assert.notEqual(status, 'down');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (prev !== undefined) process.env.LETTA_DISABLED = prev;
  }
});

test('LettaClient.status(): a healthy server → "connected" (and available() true)', async () => {
  const prev = process.env.LETTA_DISABLED;
  delete process.env.LETTA_DISABLED;
  const { createServer } = await import('node:http');
  const server = createServer((_req, res) => {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'ok' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  try {
    const client = new LettaClient({
      baseUrl: `http://127.0.0.1:${port}`,
      timeoutMs: 1000,
    });
    assert.equal(await client.status(), 'connected');
    assert.equal(await client.available(), true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (prev !== undefined) process.env.LETTA_DISABLED = prev;
  }
});
