// clients.degraded.test.ts — WS2 graceful-degradation tests (node:test).
//
// Run via: node --import tsx --test src/clients.degraded.test.ts
//
// These assert the *degraded* paths only — no network, no model weights required:
//   - ObsidianRestClient against an unbound port returns {ok:false} from every
//     method and available()===false, without throwing.
//   - readSmartConnectionsEmbeddings on a vault with no .smart-env → empty Map.
//   - cosineSimilarity: identical ≈ 1, orthogonal ≈ 0.
//   - makeVectorStore on an empty vault → a store whose search() returns [].
//
// We deliberately do NOT exercise getLocalEmbedder against the HF Hub: in offline
// CI there are no weights and it returns null by design. makeVectorStore's outcome
// therefore depends on whether weights happen to be cached locally — so the
// vector-store test asserts the contract that holds EITHER way (search() returns []
// when there's nothing to rank), not a specific `available` value.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ObsidianRestClient } from './obsidian-rest.js';
import {
  readSmartConnectionsEmbeddings,
  cosineSimilarity,
} from './embeddings.js';
import { makeVectorStore } from './vector-store.js';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'skippy-clients-'));
}

// Port 9 (discard) is effectively never listening; fetch → ECONNREFUSED fast.
// A short timeout keeps the test snappy even if the OS slow-fails the connect.
function unboundClient(): ObsidianRestClient {
  return new ObsidianRestClient({
    apiUrl: 'http://127.0.0.1:9',
    apiKey: 'dummy-key-so-hasKey-is-true',
    timeoutMs: 1000,
  });
}

test('ObsidianRestClient: unbound endpoint → available() is false, no throw', async () => {
  const client = unboundClient();
  const avail = await client.available();
  assert.equal(avail, false);
});

test('ObsidianRestClient: every method returns {ok:false} against an unbound port', async () => {
  const client = unboundClient();

  const read = await client.readFile('10_Atomic/x.md');
  assert.equal(read.ok, false);
  if (!read.ok) assert.equal(typeof read.error, 'string');

  const patch = await client.patchFrontmatter('10_Atomic/x.md', 'status', 'active');
  assert.equal(patch.ok, false);

  const append = await client.appendBlock('40_Daily/today.md', '- a line');
  assert.equal(append.ok, false);

  const search = await client.search('plasma confinement');
  assert.equal(search.ok, false);
});

test('ObsidianRestClient: no API key → unavailable, methods degrade without network', async () => {
  // Empty key string → hasKey() false → short-circuits before any fetch.
  const client = new ObsidianRestClient({ apiUrl: 'http://127.0.0.1:9', apiKey: '' });
  assert.equal(await client.available(), false);
  const read = await client.readFile('whatever.md');
  assert.equal(read.ok, false);
  if (!read.ok) assert.match(read.error, /OBSIDIAN_API_KEY/);
});

// ──────────────────────────────────────────────────────────────────────────────
// status() — the health signal (REVIEW §3/§7): "no-key" vs "down" must be
// distinguishable, not collapsed into a bare available()===false.
// ──────────────────────────────────────────────────────────────────────────────

test('ObsidianRestClient.status(): no key → "no-key" (zero network), unbound port → "down"', async () => {
  const noKey = new ObsidianRestClient({ apiUrl: 'http://127.0.0.1:9', apiKey: '' });
  const started = Date.now();
  assert.equal(await noKey.status(), 'no-key');
  assert.ok(Date.now() - started < 200, 'no-key must not dial the network');

  const down = unboundClient();
  const status = await down.status();
  assert.equal(status, 'down'); // transport failure → server is off
  assert.notEqual(status, 'no-key'); // observably distinct from the missing-key case
  assert.equal(await down.available(), false);
});

// ──────────────────────────────────────────────────────────────────────────────
// Write-rail parity (REVIEW §3): REST writes must honor the same wikilink + §8.3
// rails as the fs path, BEFORE any network call (so they degrade without a server).
// ──────────────────────────────────────────────────────────────────────────────

test('ObsidianRestClient.appendBlock: relative .md link is rejected before the network', async () => {
  // Use an *unbound* port: if the guard didn't fire we'd get a network error, not
  // the wikilink error — so matching the wikilink message proves we short-circuited.
  const client = unboundClient();
  const bad = await client.appendBlock('40_Daily/today.md', 'see [readme](./README.md)');
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.error, /wikilink|relative markdown link/i);

  // A [[wikilink]] (and an absolute http link) is allowed through to the network,
  // where the unbound port then degrades it — so NOT a wikilink-guard rejection.
  const okShape = await client.appendBlock('40_Daily/today.md', 'see [[other-note]]');
  assert.equal(okShape.ok, false);
  if (!okShape.ok) assert.doesNotMatch(okShape.error, /relative markdown link/i);
});

test('ObsidianRestClient.patchFrontmatter: invalid §8.3 field value rejected before the network', async () => {
  const client = unboundClient();

  // `status` is a closed §8.4/§8.3 enum — a bogus value must be caught by the
  // reused validator, not silently PATCHed onto the live note.
  const badStatus = await client.patchFrontmatter('10_Atomic/x.md', 'status', 'not-a-status');
  assert.equal(badStatus.ok, false);
  if (!badStatus.ok) assert.match(badStatus.error, /patchFrontmatter/i);

  // `confidence` is constrained to 0..1; out-of-range is rejected too.
  const badConf = await client.patchFrontmatter('10_Atomic/x.md', 'confidence', 5);
  assert.equal(badConf.ok, false);
  if (!badConf.ok) assert.match(badConf.error, /patchFrontmatter/i);

  // A valid value for a constrained field passes the guard and reaches the network
  // (where the unbound port degrades it) — so NOT a patchFrontmatter validation error.
  const okStatus = await client.patchFrontmatter('10_Atomic/x.md', 'status', 'active');
  assert.equal(okStatus.ok, false);
  if (!okStatus.ok) assert.doesNotMatch(okStatus.error, /patchFrontmatter:/);

  // A passthrough key the §8.3 schema doesn't constrain is not blocked by the guard.
  const okExtra = await client.patchFrontmatter('10_Atomic/x.md', 'schema_version', 3);
  assert.equal(okExtra.ok, false);
  if (!okExtra.ok) assert.doesNotMatch(okExtra.error, /patchFrontmatter:/);
});

test('readSmartConnectionsEmbeddings: no .smart-env → empty Map (no throw)', async () => {
  const dir = await tmpDir();
  const map = await readSmartConnectionsEmbeddings(dir);
  assert.ok(map instanceof Map);
  assert.equal(map.size, 0);
});

test('readSmartConnectionsEmbeddings: parses a present .smart-env cache', async () => {
  // Sanity-check the happy path so the degraded test isn't the only coverage.
  const dir = await tmpDir();
  const smartEnv = path.join(dir, '.smart-env', 'multi');
  await fs.mkdir(smartEnv, { recursive: true });
  // A representative shape: object keyed by note path, each carrying a vector.
  await fs.writeFile(
    path.join(smartEnv, 'sources.json'),
    JSON.stringify({
      '10_Atomic/a.md': { key: '10_Atomic/a.md', vec: [0.1, 0.2, 0.3] },
      '10_Atomic/b.md': [0.4, 0.5, 0.6],
    }),
  );
  const map = await readSmartConnectionsEmbeddings(dir);
  assert.equal(map.size, 2);
  assert.deepEqual(map.get('10_Atomic/a.md'), [0.1, 0.2, 0.3]);
  assert.deepEqual(map.get('10_Atomic/b.md'), [0.4, 0.5, 0.6]);
});

test('cosineSimilarity: identical ≈ 1, orthogonal ≈ 0, mismatch → 0', () => {
  const a = [1, 2, 3, 4];
  assert.ok(Math.abs(cosineSimilarity(a, a) - 1) < 1e-9);

  const x = [1, 0, 0];
  const y = [0, 1, 0];
  assert.ok(Math.abs(cosineSimilarity(x, y) - 0) < 1e-9);

  // Length mismatch and zero vector are well-defined (0), not NaN.
  assert.equal(cosineSimilarity([1, 2], [1, 2, 3]), 0);
  assert.equal(cosineSimilarity([0, 0, 0], [1, 1, 1]), 0);
});

test('makeVectorStore: empty vault → search() returns [] regardless of model availability', async () => {
  const dir = await tmpDir(); // no .smart-env
  const store = await makeVectorStore({ vaultRoot: dir });

  // Whether or not local weights are cached, an empty corpus has nothing to rank.
  const emptyCorpus = await store.search('any query', [], 5);
  assert.deepEqual(emptyCorpus, []);

  // topK <= 0 also yields []. And if no embedder loaded (offline CI), even a
  // non-empty corpus returns [] — the contract the link job relies on.
  const zeroK = await store.search('q', [{ id: 'a', text: 'hello world' }], 0);
  assert.deepEqual(zeroK, []);

  // If there's no embedder available, search over a real corpus must still be [].
  if (!store.available) {
    const hits = await store.search('q', [{ id: 'a', text: 'hello world' }], 3);
    assert.deepEqual(hits, []);
  }
});
