// Camera store — strategic-zoom + pan state for the RTS scene (PRD §7.2).
//
// The Pixi `world` Container reads `view` to compute its scale + origin every
// time the camera changes; Zone 6 wires the subscription up to call
// `applyCameraToWorld` (see `apps/ui/src/scene/Camera.ts`). This store ONLY
// carries discrete, UI-visible state — the per-frame Pixi tick loop never
// reads from Zustand directly, per CLAUDE.md convention #3. Wheel-zoom
// callbacks invoke `setScale`/`zoomBy` from outside the tick loop, which is
// safe even though they fire at wheel-event frequency: the rAF throttle in
// `attachWheelZoom` coalesces them to at most one update per frame.

import { create } from 'zustand';
import {
  DEFAULT_CAMERA_VIEW,
  lodForScale,
  type CameraView,
  type ZoomLod,
} from '@skippy/shared';

export interface CameraStore {
  view: CameraView;
  /**
   * Derived from `view.scale` — recomputed on every `setScale` / `setView` /
   * `zoomBy` / `resetView` call so subscribers can branch on LOD without
   * re-running `lodForScale` themselves.
   */
  lod: ZoomLod;

  /** Clamp scale to `[minScale, maxScale]` and refresh `lod`. */
  setScale: (scale: number) => void;
  /** Add `(dx, dy)` to `panX/panY` (world-space). */
  pan: (dx: number, dy: number) => void;
  /** Partial patch of the view; clamps scale + refreshes LOD if present. */
  setView: (patch: Partial<CameraView>) => void;
  /** Restore `DEFAULT_CAMERA_VIEW` and recompute LOD. */
  resetView: () => void;
  /**
   * Zoom around a focus point (world-space). When `focusX/focusY` are given,
   * we adjust pan so the focus point remains under the cursor after the zoom
   * (per the spec):
   *   newPan = focus - (focus - oldPan) * (newScale / oldScale)
   */
  zoomBy: (factor: number, focusX?: number, focusY?: number) => void;
}

/** Clamp helper — keeps the math reads tight. */
function clampScale(scale: number, view: CameraView): number {
  if (scale < view.minScale) return view.minScale;
  if (scale > view.maxScale) return view.maxScale;
  return scale;
}

export const useCameraStore = create<CameraStore>((set) => ({
  view: { ...DEFAULT_CAMERA_VIEW },
  lod: lodForScale(DEFAULT_CAMERA_VIEW.scale),

  setScale: (scale) =>
    set((s) => {
      const next = clampScale(scale, s.view);
      return { view: { ...s.view, scale: next }, lod: lodForScale(next) };
    }),

  pan: (dx, dy) =>
    set((s) => ({
      view: { ...s.view, panX: s.view.panX + dx, panY: s.view.panY + dy },
    })),

  setView: (patch) =>
    set((s) => {
      const merged: CameraView = { ...s.view, ...patch };
      // Re-clamp scale against the (possibly patched) min/max bounds.
      merged.scale = clampScale(merged.scale, merged);
      return { view: merged, lod: lodForScale(merged.scale) };
    }),

  resetView: () =>
    set(() => ({
      view: { ...DEFAULT_CAMERA_VIEW },
      lod: lodForScale(DEFAULT_CAMERA_VIEW.scale),
    })),

  zoomBy: (factor, focusX, focusY) =>
    set((s) => {
      const oldScale = s.view.scale;
      const newScale = clampScale(oldScale * factor, s.view);
      // No-op when the clamp pinned us to the current value — avoids a churn
      // update that would still trigger subscribers.
      if (newScale === oldScale) return s;
      const ratio = newScale / oldScale;
      let panX = s.view.panX;
      let panY = s.view.panY;
      if (typeof focusX === 'number' && typeof focusY === 'number') {
        // Keep the focus point pinned: newPan = focus - (focus - oldPan)*ratio
        panX = focusX - (focusX - panX) * ratio;
        panY = focusY - (focusY - panY) * ratio;
      }
      return {
        view: { ...s.view, scale: newScale, panX, panY },
        lod: lodForScale(newScale),
      };
    }),
}));

/**
 * Reactive selector hook — components that only care about the current LOD
 * (e.g., to flip between sprite/icon/dot rendering) subscribe through this so
 * pan-only updates don't trigger re-renders.
 */
export const useLod = (): ZoomLod => useCameraStore((s) => s.lod);
