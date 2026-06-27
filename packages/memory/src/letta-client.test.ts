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
import { createServer, type IncomingMessage, type Server } from 'node:http';

import { LettaClient } from './letta-client.js';

// ──────────────────────────────────────────────────────────────────────────────
// Stub-server harness — a node:http server whose handler decides each response, with
// every request (method + path + parsed body) recorded so endpoint-fallback tests can
// assert exactly which route/verb/body the client used. Mirrors the inline servers in
// the status() tests but reusable across the endpoint-contract tests below.
// ──────────────────────────────────────────────────────────────────────────────

interface RecordedReq {
  method: string;
  path: string;
  body: unknown;
}

type Handler = (req: RecordedReq) => { status: number; json?: unknown };

async function stubServer(handler: Handler): Promise<{
  client: LettaClient;
  requests: RecordedReq[];
  close: () => Promise<void>;
}> {
  const requests: RecordedReq[] = [];
  const server: Server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = null;
      try {
        body = raw.length > 0 ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      const rec: RecordedReq = { method: req.method ?? '', path: req.url ?? '', body };
      requests.push(rec);
      const out = handler(rec);
      res.statusCode = out.status;
      if (out.json !== undefined) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(out.json));
      } else {
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  const client = new LettaClient({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 1000 });
  return {
    client,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function withoutKillSwitch(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    const prev = process.env.LETTA_DISABLED;
    delete process.env.LETTA_DISABLED;
    try {
      await fn();
    } finally {
      if (prev !== undefined) process.env.LETTA_DISABLED = prev;
    }
  };
}

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

// ──────────────────────────────────────────────────────────────────────────────
// Endpoint contract (OQ-D4-01/02/03) — the VERIFIED-current shapes are tried first;
// known legacy variants are tried only on a shape/path rejection (404/405/422); a
// transport failure or hard status does NOT fan out across candidates.
// ──────────────────────────────────────────────────────────────────────────────

test('appendArchival: uses POST /archival-memory {text} on a modern server', withoutKillSwitch(async () => {
  const srv = await stubServer((req) => {
    if (req.method === 'POST' && req.path === '/v1/agents/bd_research_v1/archival-memory') {
      return { status: 200, json: [{ id: 'passage-1' }] };
    }
    return { status: 404, json: { error: 'not found' } };
  });
  try {
    const res = await srv.client.appendArchival('bd_research_v1', 'a fact');
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.data.id, 'passage-1');
    // Exactly one request — the verified path won on the first try.
    assert.equal(srv.requests.length, 1);
    assert.deepEqual(srv.requests[0]?.body, { text: 'a fact' });
  } finally {
    await srv.close();
  }
}));

test('appendArchival: falls back to legacy /archival/insert when modern path 404s', withoutKillSwitch(async () => {
  const srv = await stubServer((req) => {
    if (req.path === '/v1/agents/a1/archival-memory') return { status: 404, json: { error: 'gone' } };
    if (req.path === '/v1/agents/a1/archival/insert') return { status: 200, json: { id: 'legacy-1' } };
    return { status: 500 };
  });
  try {
    const res = await srv.client.appendArchival('a1', 'x');
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.data.id, 'legacy-1');
    // First candidate 404'd → fell through to the legacy insert route.
    assert.equal(srv.requests.length, 2);
    assert.equal(srv.requests[1]?.path, '/v1/agents/a1/archival/insert');
  } finally {
    await srv.close();
  }
}));

test('searchArchival: GET /archival-memory/search wins; results normalized from {results:[{content}]}', withoutKillSwitch(async () => {
  const srv = await stubServer((req) => {
    if (req.method === 'GET' && req.path.startsWith('/v1/agents/a1/archival-memory/search')) {
      return { status: 200, json: { count: 1, results: [{ id: 'p1', content: 'plasma fact' }] } };
    }
    return { status: 404 };
  });
  try {
    const res = await srv.client.searchArchival('a1', 'plasma', 5);
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.data.results.length, 1);
      assert.equal(res.data.results[0]?.text, 'plasma fact');
    }
    // The query went on the URL (GET), not a body.
    assert.match(srv.requests[0]?.path ?? '', /query=plasma/);
    assert.match(srv.requests[0]?.path ?? '', /top_k=5/);
    assert.equal(srv.requests.length, 1);
  } finally {
    await srv.close();
  }
}));

test('editCore: PATCH core-memory/blocks/{label} {value} on a modern server', withoutKillSwitch(async () => {
  const srv = await stubServer((req) => {
    if (req.method === 'PATCH' && req.path === '/v1/agents/a1/core-memory/blocks/persona') {
      return { status: 200, json: { label: 'persona', value: 'new' } };
    }
    return { status: 404 };
  });
  try {
    const res = await srv.client.editCore('a1', 'persona', 'new');
    assert.equal(res.ok, true);
    assert.equal(srv.requests.length, 1);
    assert.deepEqual(srv.requests[0]?.body, { value: 'new' });
  } finally {
    await srv.close();
  }
}));

test('a transport failure does NOT fan out across all candidates (fast degrade)', withoutKillSwitch(async () => {
  // Unreachable host: the first candidate fails at the transport level (status
  // undefined), so the client must stop immediately rather than dialing all three.
  const client = new LettaClient({ baseUrl: 'http://127.0.0.1:9', timeoutMs: 400 });
  const started = Date.now();
  const res = await client.appendArchival('a1', 'x');
  assert.equal(res.ok, false);
  // Three sequential 400ms timeouts would be ≥1200ms; one is well under.
  assert.ok(Date.now() - started < 900, `expected a single transport attempt, took ${Date.now() - started}ms`);
}));

// ──────────────────────────────────────────────────────────────────────────────
// Agent provisioning helpers (OQ-D4-04) — listAgents / createAgent.
// ──────────────────────────────────────────────────────────────────────────────

test('listAgents: GET /v1/agents?name= and normalizes {id,name}', withoutKillSwitch(async () => {
  const srv = await stubServer((req) => {
    if (req.method === 'GET' && req.path.startsWith('/v1/agents')) {
      return { status: 200, json: [{ id: 'agent-1', name: 'bd_research_v1', extra: 'ignored' }] };
    }
    return { status: 404 };
  });
  try {
    const res = await srv.client.listAgents('bd_research_v1');
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.data.length, 1);
      assert.deepEqual(res.data[0], { id: 'agent-1', name: 'bd_research_v1' });
    }
    assert.match(srv.requests[0]?.path ?? '', /name=bd_research_v1/);
  } finally {
    await srv.close();
  }
}));

test('createAgent: POST /v1/agents with name + memory_blocks; returns {id,name}', withoutKillSwitch(async () => {
  const srv = await stubServer((req) => {
    if (req.method === 'POST' && req.path === '/v1/agents') {
      return { status: 200, json: { id: 'agent-9', name: 'bd_research_v1' } };
    }
    return { status: 404 };
  });
  try {
    const res = await srv.client.createAgent({
      name: 'bd_research_v1',
      memoryBlocks: [{ label: 'persona', value: 'I am Research.' }],
    });
    assert.equal(res.ok, true);
    if (res.ok) assert.deepEqual(res.data, { id: 'agent-9', name: 'bd_research_v1' });
    const body = srv.requests[0]?.body as Record<string, unknown>;
    assert.equal(body.name, 'bd_research_v1');
    assert.deepEqual(body.memory_blocks, [{ label: 'persona', value: 'I am Research.' }]);
  } finally {
    await srv.close();
  }
}));

test('listAgents/createAgent degrade to {ok:false} against an unreachable host', withoutKillSwitch(async () => {
  const client = new LettaClient({ baseUrl: 'http://127.0.0.1:9', timeoutMs: 500 });
  const list = await client.listAgents('x');
  assert.equal(list.ok, false);
  const create = await client.createAgent({ name: 'x' });
  assert.equal(create.ok, false);
}));
