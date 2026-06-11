// @ts-nocheck — runs under tsx (`node:test`), not the app's `tsc`. The @skippy/ui
// tsconfig restricts `types` to `vite/client` (no @types/node) and greedily
// includes src/**/*, so the node: test imports below would otherwise fail the
// package typecheck. The runtime behavior is verified by tsx; see run line below.
//
// cameraStore.test.ts — lock-in for zoom-to-cursor focus pinning (PRD §7.2).
//
// Proves the `zoomBy` focus math is the true inverse of the camera transform
// `host = hostW/2 + (world + pan) * scale` (see `scene/Camera.ts`): the world
// point under the cursor must stay under the cursor across a zoom. The prior
// screen-space pin formula drifted the focus toward screen center — see the
// worked counterexample in docs/REVIEW-2026-06-10.md.
//
// Run: node --import tsx --test src/stores/cameraStore.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { CameraView } from '@skippy/shared';
import { useCameraStore } from './cameraStore.js';
import { worldSpaceFromHostPoint } from '../scene/Camera.js';

/** Project a world-space point to a host pixel using the camera transform. */
function hostFromWorld(world: number, pan: number, scale: number, hostDim: number): number {
  return hostDim / 2 + (world + pan) * scale;
}

/** Reset the store to a known, generous-clamp view between cases. */
function setView(patch: Partial<CameraView>): void {
  useCameraStore.getState().setView({
    scale: 1,
    panX: 0,
    panY: 0,
    minScale: 0.01,
    maxScale: 100,
    ...patch,
  });
}

test('zoomBy matches the REVIEW worked example (panX=-150, not -300)', () => {
  // DPR=1, hostW=1000, scale 1->2, cursor host=800, pan=0.
  const hostW = 1000;
  setView({ scale: 1, panX: 0, panY: 0 });
  const view = useCameraStore.getState().view;
  const world = worldSpaceFromHostPoint(800, 0, view, hostW, hostW);
  useCameraStore.getState().zoomBy(2, world.x, world.y);
  const after = useCameraStore.getState().view;
  assert.equal(after.scale, 2);
  assert.equal(after.panX, -150);
});

test('zoomBy keeps the cursor world point pinned across a zoom (host coord unchanged)', () => {
  const hostW = 1280;
  const hostH = 720;
  // A non-trivial starting view so a screen-space pin would visibly diverge.
  const cases: { hostX: number; hostY: number; factor: number; pan: [number, number]; scale: number }[] = [
    { hostX: 800, hostY: 0, factor: 2, pan: [0, 0], scale: 1 },
    { hostX: 200, hostY: 540, factor: 0.5, pan: [120, -75], scale: 1.4 },
    { hostX: 1100, hostY: 110, factor: 1.37, pan: [-310, 240], scale: 0.6 },
  ];
  for (const c of cases) {
    setView({ scale: c.scale, panX: c.pan[0], panY: c.pan[1] });
    const before = useCameraStore.getState().view;
    // host -> world under the cursor.
    const world = worldSpaceFromHostPoint(c.hostX, c.hostY, before, hostW, hostH);
    useCameraStore.getState().zoomBy(c.factor, world.x, world.y);
    const after = useCameraStore.getState().view;
    // world -> host with the NEW view; the focus world point must re-project
    // to the same host pixel it was grabbed from.
    const hostXAfter = hostFromWorld(world.x, after.panX, after.scale, hostW);
    const hostYAfter = hostFromWorld(world.y, after.panY, after.scale, hostH);
    assert.ok(Math.abs(hostXAfter - c.hostX) < 1e-6, `x pinned: ${hostXAfter} vs ${c.hostX}`);
    assert.ok(Math.abs(hostYAfter - c.hostY) < 1e-6, `y pinned: ${hostYAfter} vs ${c.hostY}`);
  }
});

test('zoomBy without a focus point pans nothing (pure scale)', () => {
  setView({ scale: 1, panX: 42, panY: -17 });
  useCameraStore.getState().zoomBy(1.5);
  const after = useCameraStore.getState().view;
  assert.equal(after.scale, 1.5);
  assert.equal(after.panX, 42);
  assert.equal(after.panY, -17);
});
