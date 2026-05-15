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
  // accent. We animate this layer's alpha (or stroke alpha via re-draw) when
  // setGlow > 0, so it acts as the activity indicator.
  const innerRadius = radius * 0.78;
  const innerPts = hexagonPoints(innerRadius);
  const innerGlow = new Graphics();
  innerGlow.label = 'hexpad.innerGlow';
  innerGlow.poly(innerPts).stroke({ width: 1, color: glowColor, alpha: 0.2 });

  c.addChild(pad, innerGlow);

  // ── glow state ─────────────────────────────────────────────────────────
  // We avoid Pixi Filters here (filters are heavy on integrated GPUs and
  // CLAUDE.md flags per-frame ref-store discipline). Instead we mutate the
  // inner stroke's alpha each tick.
  let glowLevel: HexPadGlow = 0;

  c.setGlow = (intensity: HexPadGlow): void => {
    glowLevel = intensity;
    if (intensity === 0) {
      // Reset to baseline; static draw.
      innerGlow.clear().poly(innerPts).stroke({ width: 1, color: glowColor, alpha: 0.2 });
    }
  };

  c.tickGlow = (t: number): void => {
    if (glowLevel === 0) return;
    // Sine pulse, 0.45 .. 0.95 alpha at ~0.4Hz when active; 0.5 .. 1.0 at
    // ~1.4Hz and using marketingRed when erroring.
    if (glowLevel === 2) {
      const a = 0.5 + 0.5 * Math.sin(t * 2 * Math.PI * 1.4);
      innerGlow.clear().poly(innerPts).stroke({
        width: 1.5,
        color: PALETTE_NUM.marketingRed,
        alpha: 0.4 + 0.6 * a,
      });
    } else {
      const a = 0.5 + 0.5 * Math.sin(t * 2 * Math.PI * 0.4);
      innerGlow.clear().poly(innerPts).stroke({
        width: 1.25,
        color: glowColor,
        alpha: 0.35 + 0.6 * a,
      });
    }
  };

  return c;
}
