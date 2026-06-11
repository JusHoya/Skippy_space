// Board hex pad — a small hexagonal tile that each Board captain stands on.
//
// PRD §7.2: every board on the clock-ring has its own pad whose color and
// glow reflect that board's identity and current activity. Visually the pad
// reuses the same geometric language as Skippy's throne (ThronePad.tsx) at a
// reduced radius, so the eye reads the clock-ring as a constellation of
// smaller thrones surrounding the main one.
//
// `setGlow(intensity)` is the visual hook for the Phase 1 exit gate:
//   0   → idle, no unfinished orders
//   1   → working/thinking/speaking, captain has a live order
//   2   → error pulse (red)
// The pulse animation runs off Pixi's ticker via a registered onTick callback
// attached to the container's `onRender`-style update, NOT via Zustand, per
// CLAUDE.md convention #3.

import { Container, Graphics } from 'pixi.js';
import { darken, lighten, numToHex, hexToNum, PALETTE_NUM } from '@skippy/sprite-kit';
import type { BoardId } from '@skippy/sprite-kit';

export type HexPadGlow = 0 | 1 | 2;

export interface HexPadOpts {
  /** Accent color as a numeric Pixi color. */
  accentColor: number;
  /** Outer radius of the hexagon, in world-local px. */
  radius: number;
  /** Board this pad belongs to — used for the container's Pixi label. */
  boardId: BoardId;
}

export interface HexPadContainer extends Container {
  /** Update glow intensity. 0=idle, 1=active, 2=error. */
  setGlow: (intensity: HexPadGlow) => void;
  /** Advance internal pulse animation. Called from the tick loop. */
  tickGlow: (t: number) => void;
}

/** Compute the 12 numbers needed by `Graphics.poly()` for a regular hexagon. */
function hexagonPoints(radius: number): number[] {
  const pts: number[] = [];
  for (let i = 0; i < 6; i++) {
    // Use the same rotation as ThronePad (PI/6 offset) so the hexes are
    // pointy-side-up — matches Skippy's throne aesthetic.
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    pts.push(Math.cos(a) * radius, Math.sin(a) * radius);
  }
  return pts;
}

export function createHexPad(opts: HexPadOpts): HexPadContainer {
  const { accentColor, radius, boardId } = opts;
  const accentHex = numToHex(accentColor);
  const fillColor = hexToNum(darken(accentHex, 0.7));
  const glowColor = hexToNum(lighten(accentHex, 0.3));

  const c = new Container() as HexPadContainer;
  c.label = `hexpad-${boardId}`;

  // Outer pad: filled darkened hex with bright accent stroke.
  const pad = new Graphics();
  pad.label = 'hexpad.pad';
  const outerPts = hexagonPoints(radius);
  pad.poly(outerPts)
    .fill({ color: fillColor, alpha: 0.85 })
    .stroke({ width: 2, color: accentColor, alpha: 1 });

  // Inner 20% glow ring — a slightly smaller hex stroked in the lightened
  // accent. It acts as the activity indicator: we animate the layer's node
  // `alpha` each tick rather than re-tessellating the hex geometry.
  //
  // The "active" and "error" pulses differ in stroke color + width, both of
  // which Pixi v8 bakes into the geometry at draw time. So we pre-draw both
  // variants ONCE at full stroke alpha and toggle which one is visible in
  // `setGlow`. Per-frame work is then a pure `.alpha` write — no `clear()`,
  // no `poly()`, no re-tessellation. (We avoid Pixi Filters here: they're
  // heavy on integrated GPUs and CLAUDE.md flags per-frame ref-store
  // discipline.)
  const innerRadius = radius * 0.78;
  const innerPts = hexagonPoints(innerRadius);

  // Active/idle variant: lightened accent stroke. Drawn at alpha 1 so node
  // `.alpha` scales it linearly to the target effective alpha.
  const activeGlow = new Graphics();
  activeGlow.label = 'hexpad.innerGlow';
  activeGlow.poly(innerPts).stroke({ width: 1.25, color: glowColor, alpha: 1 });
  activeGlow.alpha = 0.2; // idle baseline (was width-1 stroke @ alpha 0.2)

  // Error variant: marketingRed stroke, slightly heavier. Hidden until needed.
  const errorGlow = new Graphics();
  errorGlow.label = 'hexpad.innerGlow.error';
  errorGlow.poly(innerPts).stroke({ width: 1.5, color: PALETTE_NUM.marketingRed, alpha: 1 });
  errorGlow.alpha = 0;
  errorGlow.visible = false;

  c.addChild(pad, activeGlow, errorGlow);

  // ── glow state ─────────────────────────────────────────────────────────
  let glowLevel: HexPadGlow = 0;

  c.setGlow = (intensity: HexPadGlow): void => {
    glowLevel = intensity;
    // Toggle which pre-built variant is live; geometry is never rebuilt.
    const erroring = intensity === 2;
    errorGlow.visible = erroring;
    if (erroring) {
      // Error variant takes over; suppress the active layer entirely.
      activeGlow.alpha = 0;
    } else {
      // Leaving error (or idling): seed the active layer's baseline so the pad
      // is coherent before the next tick. tickGlow drives the pulse from here
      // when active; for idle (0) it returns early and this 0.2 stays.
      activeGlow.alpha = 0.2;
    }
  };

  c.tickGlow = (t: number): void => {
    if (glowLevel === 0) return;
    // Sine pulse, 0.45 .. 0.95 alpha at ~0.4Hz when active; 0.4 .. 1.0 at
    // ~1.4Hz and using marketingRed when erroring. We only mutate node alpha.
    if (glowLevel === 2) {
      const a = 0.5 + 0.5 * Math.sin(t * 2 * Math.PI * 1.4);
      errorGlow.alpha = 0.4 + 0.6 * a;
    } else {
      const a = 0.5 + 0.5 * Math.sin(t * 2 * Math.PI * 0.4);
      activeGlow.alpha = 0.35 + 0.6 * a;
    }
  };

  return c;
}
