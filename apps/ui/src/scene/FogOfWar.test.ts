// @ts-nocheck — runs under tsx (`node:test`), not the app's `tsc`. The @skippy/ui
// tsconfig restricts `types` to `vite/client` (no @types/node) and greedily
// includes src/**/*, so the node: test imports below would otherwise fail the
// package typecheck. The runtime behavior is verified by tsx; see run line below.
//
// FogOfWar.test.ts — lock-in for fog vs delegation-highlight tint coordination
// (review §4). A pedestal Container's `.tint` is written by two independent
// Zustand subscriptions: this module (fog state) and FilePedestals'
// `setActiveTint` (the delegation highlight that paints a board accent color
// while a walker is en route). Before the fix a fog regions-delta clobbered any
// live highlight. The fix makes fog defer the `tint` channel to an active
// highlight while still owning the `alpha` (dim) channel.
//
// Run: node --import tsx --test src/scene/FogOfWar.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyFogToPedestals } from './FogOfWar';

const SHROUDED_TINT = 0x6a6a6a;
const WHITE = 0xffffff;
const ACCENT = 0x66fcf1; // a board accent color — never one of fog's own tints

// Minimal duck-typed stand-in: applyFogToPedestals only reads `.children` and
// mutates each child's `.label` / `.alpha` / `.tint`.
function makeField(children) {
  return { children };
}

function ped(label, tint, alpha = 1) {
  return { label, tint, alpha };
}

function region(state) {
  return { regionId: 'pedestal.src/a.ts', state };
}

test('shrouded region dims a default pedestal (alpha + tint)', () => {
  const p = ped('pedestal.src/a.ts', WHITE);
  applyFogToPedestals(makeField([p]), { 'pedestal.src/a.ts': region('shrouded') });
  assert.equal(p.alpha, 0.45);
  assert.equal(p.tint, SHROUDED_TINT);
});

test('fog preserves an active highlight tint but still applies dim alpha', () => {
  // The delegation highlight already painted this pedestal a board accent color.
  const p = ped('pedestal.src/a.ts', ACCENT);
  applyFogToPedestals(makeField([p]), { 'pedestal.src/a.ts': region('shrouded') });
  // Highlight wins the tint channel...
  assert.equal(p.tint, ACCENT);
  // ...but fog still owns alpha (its exclusive channel), so the dim still reads.
  assert.equal(p.alpha, 0.45);
});

test('fog reclaims a pedestal the instant its highlight clears to white', () => {
  // setActiveTint(id, null) resets tint to 0xffffff, which IS a fog-owned value.
  const p = ped('pedestal.src/a.ts', WHITE);
  applyFogToPedestals(makeField([p]), { 'pedestal.src/a.ts': region('shrouded') });
  assert.equal(p.tint, SHROUDED_TINT);
  assert.equal(p.alpha, 0.45);
});

test('bright fog resets a previously-shrouded pedestal to white + full alpha', () => {
  const p = ped('pedestal.src/a.ts', SHROUDED_TINT, 0.45);
  applyFogToPedestals(makeField([p]), { 'pedestal.src/a.ts': region('bright') });
  assert.equal(p.alpha, 1);
  assert.equal(p.tint, WHITE);
});

test('non-pedestal children are skipped entirely', () => {
  const decoy = ped('walkersStage', ACCENT);
  applyFogToPedestals(makeField([decoy]), {});
  assert.equal(decoy.alpha, 1);
  assert.equal(decoy.tint, ACCENT);
});

test('missing region entry → unexplored (alpha 0) on a fog-owned pedestal', () => {
  const p = ped('pedestal.src/a.ts', WHITE);
  applyFogToPedestals(makeField([p]), {});
  assert.equal(p.alpha, 0);
  assert.equal(p.tint, WHITE);
});
