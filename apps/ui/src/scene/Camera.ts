// Camera — pure helpers for the strategic-zoom system (PRD §7.2).
//
// This module is intentionally state-free: every function takes the camera
// view as an explicit argument so it can be called from a Zustand subscriber,
// a wheel-event handler, or a unit test without leaking implicit state.
// Subscribers wire `applyCameraToWorld` to `useCameraStore` (Zone 6) and pass
// the world Container in; this module never imports the store.
//
// CLAUDE.md convention #3: per-frame data does not go through Zustand. The
// wheel-zoom dispatch path (`attachWheelZoom`) coalesces wheel events to at
// most one rAF tick before calling the consumer's `onZoom`, so the store gets
// at most one update per frame even if the user scrolls aggressively.

import type { Container } from 'pixi.js';
import type { CameraView, ZoomLod } from '@skippy/shared';

/**
 * Apply the supplied camera view to a Pixi `world` Container. Sets:
 *   world.scale         = view.scale (uniform)
 *   world.x             = hostWidth/2 + view.panX * view.scale
 *   world.y             = hostHeight/2 + view.panY * view.scale
 *
 * NOTE: SceneRoot today centers the world via `world.x = renderer.width/2`
 * etc. This function REPLACES that math when called — Zone 6 will swap the
 * SceneRoot `center` callback's body for `applyCameraToWorld(world, view,
 * app.renderer.width, app.renderer.height)`.
 *
 * Pure: reads only its arguments; never touches the store or the global Pixi
 * application.
 */
export function applyCameraToWorld(
  world: Container,
  view: CameraView,
  hostWidth: number,
  hostHeight: number,
): void {
  world.scale.set(view.scale);
  world.x = hostWidth / 2 + view.panX * view.scale;
  world.y = hostHeight / 2 + view.panY * view.scale;
}

/**
 * Inverse of `applyCameraToWorld` for a single point. Converts a cursor
 * position in host-relative pixels back into world-space coords (the
 * coordinate system the scene draws in, with the throne at the origin).
 *
 *   worldX = (hostX - hostWidth/2)  / scale - panX
 *   worldY = (hostY - hostHeight/2) / scale - panY
 */
export function worldSpaceFromHostPoint(
  hostX: number,
  hostY: number,
  view: CameraView,
  hostWidth: number,
  hostHeight: number,
): { x: number; y: number } {
  // Avoid divide-by-zero — DEFAULT_CAMERA_VIEW guarantees a positive scale,
  // but a misconfigured patch could in theory hit 0.
  const safeScale = view.scale === 0 ? 1 : view.scale;
  return {
    x: (hostX - hostWidth / 2) / safeScale - view.panX,
    y: (hostY - hostHeight / 2) / safeScale - view.panY,
  };
}

export interface AttachWheelZoomOptions {
  /**
   * Called once per rAF tick whenever a wheel event has been observed since
   * the last frame. `factor` multiplies the current scale (see formula
   * below); `x`, `y` are in HOST-relative pixels. Callers responsible for
   * converting to world-space via `worldSpaceFromHostPoint` when they need
   * to pin the focus point.
   */
  onZoom: (factor: number, x: number, y: number) => void;
}

/**
 * Listen for `wheel` events on `host` and translate them into a zoom-factor
 * dispatch. Uses `passive: false` + `preventDefault()` so the page never
 * scrolls when the user zooms the map.
 *
 * Wheel events fire at sub-frame frequency on high-resolution mice; we
 * coalesce them per `requestAnimationFrame` so the store sees at most one
 * update per frame. Factor accumulates multiplicatively across coalesced
 * events:  factor = Math.pow(1.0015, -deltaY)  per spec.
 *
 * Returns an unsubscribe.
 */
export function attachWheelZoom(
  host: HTMLElement,
  options: AttachWheelZoomOptions,
): () => void {
  let pendingFactor = 1;
  let pendingX = 0;
  let pendingY = 0;
  let rafHandle: number | null = null;

  const flush = (): void => {
    rafHandle = null;
    if (pendingFactor === 1) return;
    const factor = pendingFactor;
    const x = pendingX;
    const y = pendingY;
    pendingFactor = 1;
    options.onZoom(factor, x, y);
  };

  const onWheel = (evt: WheelEvent): void => {
    evt.preventDefault();
    // Spec: factor = pow(1.0015, -deltaY). Scrolling up (deltaY < 0) zooms in.
    const factor = Math.pow(1.0015, -evt.deltaY);
    pendingFactor *= factor;
    // Track the most recent cursor position — that's the focus we want to
    // pin in the resulting `zoomBy` call.
    const rect = host.getBoundingClientRect();
    pendingX = evt.clientX - rect.left;
    pendingY = evt.clientY - rect.top;
    if (rafHandle === null) {
      rafHandle = requestAnimationFrame(flush);
    }
  };

  host.addEventListener('wheel', onWheel, { passive: false });

  return (): void => {
    host.removeEventListener('wheel', onWheel);
    if (rafHandle !== null) {
      cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }
  };
}

/**
 * Declare which layers are visible at each LOD. Rules:
 *   • `sprites`       — visible at lod==='sprite'.
 *   • `pedestals`     — visible at lod in {'sprite','icon'}.
 *   • `minimap-dots`  — always visible (the strategic overlay; doubles as
 *                       the minimap face).
 */
export function lodVisibility(
  layer: 'sprites' | 'pedestals' | 'minimap-dots',
  lod: ZoomLod,
): boolean {
  switch (layer) {
    case 'sprites':
      return lod === 'sprite';
    case 'pedestals':
      return lod === 'sprite' || lod === 'icon';
    case 'minimap-dots':
      return true;
  }
}
