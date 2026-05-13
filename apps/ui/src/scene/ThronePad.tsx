// Skippy's throne tile — a hexagonal pad of cyan light at the center of the map.
//
// In Phase 0 the throne is purely visual; in later phases it becomes the
// anchor for the clock-ring of board hex-pads (PRD §7.2). This component
// exports both a procedural builder for direct use inside SceneRoot and a
// React-free factory so the function can be reused by the strategic-zoom
// minimap later without dragging React in.

import { Container, Graphics } from 'pixi.js';

const THRONE_RADIUS = 56;

/**
 * Build the throne pad at logical origin (0,0). Caller positions the
 * resulting Container under the centered beercan.
 */
export function createThronePad(accent = 0x66fcf1): Container {
  const c = new Container();
  c.label = 'thronePad';

  // Outer glow halo.
  const halo = new Graphics()
    .circle(0, 0, THRONE_RADIUS + 14)
    .fill({ color: accent, alpha: 0.06 });
  // Hex outline.
  const hex = new Graphics();
  const pts: number[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    pts.push(Math.cos(a) * THRONE_RADIUS, Math.sin(a) * THRONE_RADIUS);
  }
  hex.poly(pts)
    .stroke({ width: 2, color: accent, alpha: 0.7 })
    .fill({ color: accent, alpha: 0.08 });

  // Inner ring for depth.
  const inner = new Graphics()
    .circle(0, 0, THRONE_RADIUS - 14)
    .stroke({ width: 1, color: accent, alpha: 0.5 });

  c.addChild(halo, hex, inner);
  return c;
}
