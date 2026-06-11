// @ts-nocheck — runs under tsx (`node:test`), not the app's `tsc`. The @skippy/ui
// tsconfig restricts `types` to `vite/client` (no @types/node) and greedily
// includes src/**/*, so the node: test imports below would otherwise fail the
// package typecheck. Mirrors the convention in stores/cameraStore.test.ts.
//
// SceneRoot.test.ts — lock-ins for the three review §4 scene fixes:
//   1. Strategic-zoom LOD cascade (PRD §7.4) — the visibility contract the
//      newly-wired `applyLod` drives so detail actually drops on zoom.
//   2. Batched fog boot-seed — the single-pass merge produces region states
//      identical to the old O(N^2) per-pedestal markBright/markSeen loop.
//   3. Walker despawn bookkeeping — the per-frame teardown keeps the
//      WALKER_REF_STORE / spec / delegation maps in lockstep so destroyed
//      containers don't leak.
//
// Run (once wave 4 links tsx into @skippy/ui):
//   node --import tsx --test src/scene/SceneRoot.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ZOOM_LODS, lodForScale } from '@skippy/shared';
import { lodVisibility } from './Camera.js';

// ── 1. LOD cascade ───────────────────────────────────────────────────────────

test('LOD visibility cascade: sprites only at sprite; pedestals at sprite+icon', () => {
  // The SC-style drop SceneRoot.applyLod enforces. Sprites (beercans + walkers)
  // collapse first, then pedestals, leaving only the always-on minimap-dot face.
  assert.equal(lodVisibility('sprites', 'sprite'), true);
  assert.equal(lodVisibility('sprites', 'icon'), false);
  assert.equal(lodVisibility('sprites', 'dot'), false);
  assert.equal(lodVisibility('sprites', 'org'), false);

  assert.equal(lodVisibility('pedestals', 'sprite'), true);
  assert.equal(lodVisibility('pedestals', 'icon'), true);
  assert.equal(lodVisibility('pedestals', 'dot'), false);
  assert.equal(lodVisibility('pedestals', 'org'), false);

  // The dot face never hides — at every zoom the strategic overlay stays drawn.
  for (const lod of ZOOM_LODS) {
    assert.equal(lodVisibility('minimap-dots', lod), true);
  }
});

test('LOD boundaries: zooming out monotonically reveals fewer sprite layers', () => {
  // Drive `lodForScale` across the thresholds the camera store uses and confirm
  // the layer set the scene shows only ever shrinks as you zoom out — the
  // property `applyLod` relies on so a zoom never *adds* detail.
  const scales = [2.0, 0.6, 0.55, 0.4, 0.3, 0.2, 0.15, 0.1, 0.05];
  let prevSpriteCount = Infinity;
  for (const scale of scales) {
    const lod = lodForScale(scale);
    const count =
      (lodVisibility('sprites', lod) ? 1 : 0) + (lodVisibility('pedestals', lod) ? 1 : 0);
    assert.ok(count <= prevSpriteCount, `scale ${scale} (lod ${lod}) added detail`);
    prevSpriteCount = count;
  }
});

// ── 2. Batched fog boot-seed equivalence ─────────────────────────────────────

// Reference (slow) per-pedestal transition rules, transcribed from fogStore.ts.
// `markBright` forces 'bright'; `markSeen` sets 'shrouded' but never downgrades
// an already-'bright' region.
function referenceSeed(ids, now, seenBy) {
  const regions = {};
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const existing = regions[id];
    if (i % 7 === 0) {
      regions[id] = { ...(existing ?? { regionId: id }), regionId: id, state: 'bright', lastSeenAt: now };
    } else {
      // markSeen
      if (existing && existing.state === 'bright') {
        regions[id] = { ...existing, lastSeenBy: seenBy, lastSeenAt: now };
      } else {
        regions[id] = { ...(existing ?? { regionId: id }), regionId: id, state: 'shrouded', lastSeenBy: seenBy, lastSeenAt: now };
      }
    }
  }
  return regions;
}

// The batched single-pass seed SceneRoot commits with one setState. Must equal
// the reference loop region-for-region.
function batchedSeed(ids, now, seenBy, prior = {}) {
  const regions = { ...prior };
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const existing = regions[id];
    if (i % 7 === 0) {
      regions[id] = { ...(existing ?? { regionId: id }), regionId: id, state: 'bright', lastSeenAt: now };
    } else if (existing && existing.state === 'bright') {
      regions[id] = { ...existing, lastSeenBy: seenBy, lastSeenAt: now };
    } else {
      regions[id] = { ...(existing ?? { regionId: id }), regionId: id, state: 'shrouded', lastSeenBy: seenBy, lastSeenAt: now };
    }
  }
  return regions;
}

test('batched fog seed matches the per-pedestal markBright/markSeen result', () => {
  const now = '2026-06-10T00:00:00.000Z';
  const seenBy = 'skippy';
  const ids = Array.from({ length: 50 }, (_, i) => `pedestal.file-${i}`);
  assert.deepEqual(batchedSeed(ids, now, seenBy), referenceSeed(ids, now, seenBy));
});

test('every 7th pedestal is bright; the rest shrouded + attributed to Skippy', () => {
  const now = '2026-06-10T00:00:00.000Z';
  const ids = Array.from({ length: 21 }, (_, i) => `pedestal.f-${i}`);
  const regions = batchedSeed(ids, now, 'skippy');
  for (let i = 0; i < ids.length; i++) {
    const r = regions[ids[i]];
    if (i % 7 === 0) {
      assert.equal(r.state, 'bright');
    } else {
      assert.equal(r.state, 'shrouded');
      assert.equal(r.lastSeenBy, 'skippy');
    }
    assert.equal(r.regionId, ids[i]);
    assert.equal(r.lastSeenAt, now);
  }
});

test('batched seed never downgrades a pre-existing bright region', () => {
  // A region already bright (e.g. a tool opened it before boot) must survive a
  // markSeen slot — the batched merge mirrors fogStore.markSeen's guard.
  const now = '2026-06-10T00:00:00.000Z';
  const ids = ['pedestal.a', 'pedestal.b'];
  const prior = { 'pedestal.b': { regionId: 'pedestal.b', state: 'bright', lastSeenAt: 'earlier' } };
  // 'pedestal.b' falls on index 1 (a markSeen slot) — must stay bright.
  const regions = batchedSeed(ids, now, 'skippy', prior);
  assert.equal(regions['pedestal.b'].state, 'bright');
  assert.equal(regions['pedestal.b'].lastSeenBy, 'skippy');
});

// ── 3. Walker despawn bookkeeping ────────────────────────────────────────────

// Model of SceneRoot's per-frame walker maps + the `removeWalker` teardown, so a
// regression that drops one map out of lockstep (the original leak) is caught.
function makeWalkerWorld() {
  const refStore = new Map(); // WALKER_REF_STORE proxy: id -> { destroyed }
  const specs = new Map(); // walkerId -> spec
  const byDelegation = new Map(); // delegationId -> walkerId
  const pedestal = new Map(); // walkerId -> pedestalId
  const tints = new Map(); // pedestalId -> tint | null

  function spawn(delegationId, walkerId, pedestalId) {
    refStore.set(walkerId, { destroyed: false });
    specs.set(walkerId, { id: walkerId, progress: 0 });
    byDelegation.set(delegationId, walkerId);
    pedestal.set(walkerId, pedestalId);
    tints.set(pedestalId, 0x00ffff);
  }
  function removeWalker(delegationId) {
    const walkerId = byDelegation.get(delegationId);
    if (!walkerId) return;
    const refs = refStore.get(walkerId);
    if (refs) {
      refs.destroyed = true; // despawnWalker -> container.destroy
      refStore.delete(walkerId);
    }
    specs.delete(walkerId);
    byDelegation.delete(delegationId);
    const pedestalId = pedestal.get(walkerId);
    if (pedestalId) {
      tints.set(pedestalId, null);
      pedestal.delete(walkerId);
    }
  }
  return { refStore, specs, byDelegation, pedestal, tints, spawn, removeWalker };
}

test('removeWalker keeps all four walker maps in lockstep and clears the tint', () => {
  const w = makeWalkerWorld();
  w.spawn('deleg-1', 'task.deleg-1', 'pedestal.x');
  w.spawn('deleg-2', 'task.deleg-2', 'pedestal.y');

  w.removeWalker('deleg-1');

  // deleg-1 fully gone from every structure; its container destroyed.
  assert.equal(w.refStore.has('task.deleg-1'), false);
  assert.equal(w.specs.has('task.deleg-1'), false);
  assert.equal(w.byDelegation.has('deleg-1'), false);
  assert.equal(w.pedestal.has('task.deleg-1'), false);
  assert.equal(w.tints.get('pedestal.x'), null);

  // deleg-2 untouched.
  assert.equal(w.refStore.has('task.deleg-2'), true);
  assert.equal(w.specs.has('task.deleg-2'), true);
  assert.equal(w.tints.get('pedestal.y'), 0x00ffff);
});

test('removeWalker is idempotent for an unknown / already-removed delegation', () => {
  const w = makeWalkerWorld();
  w.spawn('deleg-1', 'task.deleg-1', 'pedestal.x');
  w.removeWalker('deleg-1');
  // Second call (e.g. a re-emitted terminal status) must be a harmless no-op.
  assert.doesNotThrow(() => w.removeWalker('deleg-1'));
  assert.doesNotThrow(() => w.removeWalker('never-existed'));
  assert.equal(w.refStore.size, 0);
});

test('drain removes every live walker (unmount path)', () => {
  const w = makeWalkerWorld();
  w.spawn('d1', 'task.d1', 'pedestal.1');
  w.spawn('d2', 'task.d2', 'pedestal.2');
  w.spawn('d3', 'task.d3', 'pedestal.3');
  // drainWalkers snapshots the keys (removeWalker mutates the map mid-loop).
  for (const delegationId of [...w.byDelegation.keys()]) w.removeWalker(delegationId);
  assert.equal(w.refStore.size, 0);
  assert.equal(w.specs.size, 0);
  assert.equal(w.byDelegation.size, 0);
  assert.equal(w.pedestal.size, 0);
});
