// File-pedestal field — Phase 2 / Zone 1.
//
// PRD §7.2: every project file becomes a "pedestal" on the RTS map's ground
// plane. This module builds one Pixi Container holding every pedestal Graphics
// in a precomputed `PedestalLayout[]`. The container is mounted inside the
// world Container in SceneRoot so it pans + zooms with the rest of the scene.
//
// Each pedestal is a small upright trapezoid (narrow top, wide base) filled
// with the layout's `hueHex` (encodes git age) and stroked in a darkened
// variant. Pedestals are pointer-targets so a later Zone 6 selection store can
// wire `pointertap` to selection without modifying this module.

import { Container, Graphics } from 'pixi.js';
import { hexToNum, darken } from '@skippy/sprite-kit';
import type { PedestalLayout } from '@skippy/shared';

// Trapezoid base/top widths in pixels. Base is wider so the silhouette reads
// as a pedestal at every zoom level.
const BASE_WIDTH = 18;
const TOP_WIDTH = 12;

/**
 * Container handle returned to SceneRoot. Adds a couple of mutating methods
 * so other zones can highlight active pedestals without duck-typing through
 * Pixi child iteration.
 */
export interface PedestalFieldContainer extends Container {
  /** Apply or clear a tint on the named pedestal. `null` resets to default. */
  setActiveTint: (pedestalId: string, tint: number | null) => void;
  /** Look up the layout for a pedestal by id. */
  getLayout: (pedestalId: string) => PedestalLayout | undefined;
}

/**
 * Draw an upright trapezoid at (0, 0) with `heightPx`. Base sits at y=0 and
 * the trapezoid rises in negative-y (Pixi-down-positive, so "up" on screen).
 */
function paintPedestal(g: Graphics, height: number, fillHex: string): void {
  const fill = hexToNum(fillHex);
  const stroke = hexToNum(darken(fillHex, 0.5));
  const halfBase = BASE_WIDTH / 2;
  const halfTop = TOP_WIDTH / 2;
  g.clear()
    .poly([
      -halfBase, 0,
      halfBase, 0,
      halfTop, -height,
      -halfTop, -height,
    ])
    .fill({ color: fill, alpha: 0.92 })
    .stroke({ width: 1, color: stroke, alpha: 0.9 });
}

/**
 * Build the pedestal field from a precomputed layout list. The returned
 * container is empty when given an empty list; callers can still mount it and
 * the scene will render fine.
 */
export function createPedestalField(layouts: PedestalLayout[]): PedestalFieldContainer {
  const c = new Container() as PedestalFieldContainer;
  c.label = 'pedestalField';
  c.eventMode = 'static';

  // Two parallel maps so setActiveTint + getLayout are O(1) lookups.
  const graphicsById = new Map<string, Graphics>();
  const layoutsById = new Map<string, PedestalLayout>();

  for (const layout of layouts) {
    const g = new Graphics();
    // `layout.id` is already `pedestal.<path>`; reuse it verbatim so the
    // pointertap target label is identical across emit + receive sides.
    g.label = layout.id;
    g.eventMode = 'static';
    g.cursor = 'pointer';
    paintPedestal(g, layout.heightPx, layout.hueHex);
    g.x = layout.x;
    g.y = layout.y;

    // Default tint = 0xffffff (Pixi no-op). Active tint replaces this.
    g.tint = 0xffffff;

    c.addChild(g);
    graphicsById.set(layout.id, g);
    layoutsById.set(layout.id, layout);
  }

  c.setActiveTint = (pedestalId: string, tint: number | null): void => {
    const g = graphicsById.get(pedestalId);
    if (!g) return;
    g.tint = tint ?? 0xffffff;
  };

  c.getLayout = (pedestalId: string): PedestalLayout | undefined => {
    return layoutsById.get(pedestalId);
  };

  return c;
}
