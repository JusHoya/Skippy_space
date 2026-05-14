// Costume system. PRD §12.2: hat + body + accessory + insignia + accent color,
// composited at runtime as layered Graphics.
//
// Phase 0+ is procedural-only — every costume slot is rendered with Pixi v8
// Graphics primitives. Once the atlas pipeline lands (PRD §12.5), this file
// becomes the place that swaps Graphics → Sprite without touching beercan.ts.
//
// The drawing helpers (`drawHat`, `drawBody`, `drawAccessory`, `drawInsignia`,
// `drawSkippyCape`) all take a pre-built `Graphics` instance so callers can
// supply their own layer container, draw multiple costumes into a shared
// scratch graphic, or unit-test drawing without instantiating Pixi.

import { Graphics } from 'pixi.js';
import type { BeercanRefs } from './beercan';
import { hexToNum, PALETTE_NUM } from './palette';

export type HatId =
  | 'hard_hat_with_visor'
  | 'wireframe_headset'
  | 'beret'
  | 'snapback_cap'
  | 'top_hat'
  | 'wizard_cap'
  | 'newsboy_cap'
  | 'beanie'
  | 'regal_antenna_crown';

export type BodyId =
  | 'blue_coveralls'
  | 'hoodie'
  | 'smock_paint_splatter'
  | 'bomber_jacket'
  | 'three_piece_suit'
  | 'tweed_jacket'
  | 'apron_with_pen_loops'
  | 'flannel'
  | 'cape_skippy';

export type AccessoryId =
  | 'wrench'
  | 'mechanical_keyboard'
  | 'brush'
  | 'megaphone'
  | 'monocle_and_chart'
  | 'scroll'
  | 'typewriter'
  | 'terminal_tablet'
  | 'scepter';

export type InsigniaId =
  | 'gear_circuit'
  | 'code_brackets'
  | 'palette_swirl'
  | 'growth_arrow'
  | 'coin_dollar'
  | 'book_atom'
  | 'quill_page'
  | 'terminal_carat'
  | 'magnificent_crown_gear';

/**
 * A Costume is a thin descriptor; the renderer interprets it. Names are
 * stable literal unions — `drawHat` / `drawBody` / `drawAccessory` /
 * `drawInsignia` switch on them. The `custom` escape hatch lets ad-hoc
 * costumes paint extra Graphics without extending the enums (e.g., one-off
 * holiday skins or task-agent variants).
 */
export interface Costume {
  hat?: HatId;
  body?: BodyId;
  accessory?: AccessoryId;
  insignia?: InsigniaId;
  accentColor: number;
  cape?: boolean;
  /** Ad-hoc additional drawing painted last (in front of all other layers). */
  custom?: (refs: BeercanRefs) => void;
}

const BODY_W = 48;
const BODY_H = 80;

// ── tiny utilities ────────────────────────────────────────────────────────
// Mulberry32 deterministic PRNG. Used by paint-splatter so the same costume
// renders identical dots every frame/mount.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0xffffffff;
  };
}

// Darken a 24-bit number by a 0..1 amount toward black.
function darkenNum(n: number, k: number): number {
  const r = Math.max(0, Math.min(255, Math.round(((n >> 16) & 0xff) * (1 - k))));
  const g = Math.max(0, Math.min(255, Math.round(((n >> 8) & 0xff) * (1 - k))));
  const b = Math.max(0, Math.min(255, Math.round((n & 0xff) * (1 - k))));
  return (r << 16) | (g << 8) | b;
}

// ── HATS ──────────────────────────────────────────────────────────────────
/**
 * Draw the named hat into the passed Graphics. `accent` is the costume's
 * accent color; some hats use it as a trim, others ignore it for canonical
 * board palette consistency.
 */
export function drawHat(g: Graphics, name: HatId, accent: number): void {
  const TOP = -BODY_H / 2;
  switch (name) {
    case 'hard_hat_with_visor': {
      // Engineering — yellow rounded dome with a thin cyan visor.
      g.roundRect(-12, TOP - 10, 24, 10, 5).fill({ color: PALETTE_NUM.financeGold, alpha: 1 });
      // crown ridge
      g.rect(-10, TOP - 11, 20, 2).fill({ color: darkenNum(PALETTE_NUM.financeGold, 0.25), alpha: 1 });
      // thin cyan visor line just under the dome
      g.rect(-14, TOP - 2, 28, 2).fill({ color: PALETTE_NUM.neonCyan, alpha: 0.9 });
      break;
    }

    case 'wireframe_headset': {
      // Coding — thin headband arc + two earcup ovals + small mic boom.
      // Headband as a slim arc-shaped rectangle bowed over the top.
      g.roundRect(-16, TOP - 9, 32, 3, 1.5).fill({ color: 0x2c2c2c, alpha: 1 });
      // Earcup ovals.
      g.ellipse(-16, TOP - 3, 4, 5).fill({ color: 0x1a1a1a, alpha: 1 });
      g.ellipse(16, TOP - 3, 4, 5).fill({ color: 0x1a1a1a, alpha: 1 });
      // Accent ring on the right earcup so the costume reads "headset".
      g.ellipse(16, TOP - 3, 2, 3).fill({ color: accent, alpha: 0.85 });
      // Mic boom — short bar curving down from the left cup.
      g.rect(-19, TOP + 1, 2, 5).fill({ color: 0x2c2c2c, alpha: 1 });
      g.circle(-19, TOP + 7, 1.5).fill({ color: accent, alpha: 1 });
      break;
    }

    case 'beret': {
      // Design — tilted disc with a small antenna stem.
      // Slightly off-center ellipse gives the iconic tilt.
      g.ellipse(2, TOP - 7, 16, 5).fill({ color: PALETTE_NUM.electricPurple, alpha: 1 });
      // Darker rim under the disc.
      g.ellipse(2, TOP - 5, 16, 2).fill({ color: darkenNum(PALETTE_NUM.electricPurple, 0.3), alpha: 1 });
      // Antenna stem (the little nub on top of a beret).
      g.rect(7, TOP - 12, 1.5, 5).fill({ color: darkenNum(PALETTE_NUM.electricPurple, 0.4), alpha: 1 });
      g.circle(7.75, TOP - 13, 1.2).fill({ color: PALETTE_NUM.electricPurple, alpha: 1 });
      break;
    }

    case 'snapback_cap': {
      // Marketing — visor brim + crown + tiny logo dot.
      // Crown (back/top of the cap).
      g.roundRect(-12, TOP - 9, 22, 7, 3).fill({ color: PALETTE_NUM.marketingRed, alpha: 1 });
      // Highlight along the front of the crown.
      g.rect(-12, TOP - 9, 22, 2).fill({ color: darkenNum(PALETTE_NUM.marketingRed, 0.2), alpha: 0.7 });
      // Flat visor brim out to the right.
      g.rect(-2, TOP - 3, 18, 2).fill({ color: darkenNum(PALETTE_NUM.marketingRed, 0.25), alpha: 1 });
      // Tiny logo dot on the front.
      g.circle(0, TOP - 6, 1.5).fill({ color: PALETTE_NUM.starlight, alpha: 1 });
      break;
    }

    case 'top_hat': {
      // Finance — tall rectangle + narrow brim + gold band.
      g.rect(-8, TOP - 18, 16, 16).fill({ color: 0x111111, alpha: 1 });
      // Top highlight.
      g.rect(-8, TOP - 18, 16, 1).fill({ color: 0x333333, alpha: 1 });
      // Narrow brim.
      g.rect(-13, TOP - 3, 26, 3).fill({ color: 0x111111, alpha: 1 });
      // Gold band around the base of the crown.
      g.rect(-8, TOP - 6, 16, 2).fill({ color: PALETTE_NUM.financeGold, alpha: 1 });
      break;
    }

    case 'wizard_cap': {
      // Research — tall triangle in researchPurple with a small star.
      g.poly([-10, TOP - 4, 10, TOP - 4, 0, TOP - 22]).fill({
        color: PALETTE_NUM.researchPurple,
        alpha: 1,
      });
      // A slight inner shadow for depth (right-leaning).
      g.poly([0, TOP - 22, 10, TOP - 4, 2, TOP - 4]).fill({
        color: darkenNum(PALETTE_NUM.researchPurple, 0.25),
        alpha: 0.7,
      });
      // Star near the tip — a small 5-point polygon approximated by overlapping triangles.
      const sx = 2;
      const sy = TOP - 14;
      g.poly([sx, sy - 2, sx + 1, sy, sx + 2, sy - 2, sx + 1, sy + 1]).fill({
        color: PALETTE_NUM.financeGold,
        alpha: 1,
      });
      g.poly([sx - 1, sy - 1, sx, sy - 2, sx + 3, sy - 1, sx + 1, sy + 1]).fill({
        color: PALETTE_NUM.financeGold,
        alpha: 1,
      });
      break;
    }

    case 'newsboy_cap': {
      // Publishing — rounded crown + short brim in publishingOrange.
      g.ellipse(0, TOP - 7, 13, 5).fill({ color: PALETTE_NUM.publishingOrange, alpha: 1 });
      // Top crease — a tiny darker ellipse perched on top.
      g.ellipse(-2, TOP - 9, 6, 2).fill({ color: darkenNum(PALETTE_NUM.publishingOrange, 0.3), alpha: 1 });
      // Short brim sweeping forward.
      g.rect(0, TOP - 4, 14, 2).fill({ color: darkenNum(PALETTE_NUM.publishingOrange, 0.35), alpha: 1 });
      break;
    }

    case 'beanie': {
      // DevOps — rounded skullcap with horizontal stripes in devopsGreen.
      g.roundRect(-12, TOP - 10, 24, 10, 5).fill({ color: PALETTE_NUM.devopsGreen, alpha: 1 });
      // Two darker horizontal stripes.
      g.rect(-12, TOP - 7, 24, 1.5).fill({ color: darkenNum(PALETTE_NUM.devopsGreen, 0.35), alpha: 1 });
      g.rect(-12, TOP - 4, 24, 1.5).fill({ color: darkenNum(PALETTE_NUM.devopsGreen, 0.35), alpha: 1 });
      // Folded-up cuff at the bottom edge.
      g.rect(-12, TOP - 2, 24, 2).fill({ color: darkenNum(PALETTE_NUM.devopsGreen, 0.5), alpha: 1 });
      break;
    }

    case 'regal_antenna_crown': {
      // Skippy — three small gold prongs around a central tall antenna
      // with a glowing cyan tip.
      // Crown band.
      g.rect(-10, TOP - 4, 20, 3).fill({ color: PALETTE_NUM.financeGold, alpha: 1 });
      g.rect(-10, TOP - 1, 20, 1).fill({ color: darkenNum(PALETTE_NUM.financeGold, 0.4), alpha: 1 });
      // Side prongs (short).
      g.poly([-9, TOP - 4, -7, TOP - 10, -5, TOP - 4]).fill({ color: PALETTE_NUM.financeGold, alpha: 1 });
      g.poly([5, TOP - 4, 7, TOP - 10, 9, TOP - 4]).fill({ color: PALETTE_NUM.financeGold, alpha: 1 });
      // Central tall antenna prong.
      g.rect(-1, TOP - 18, 2, 14).fill({ color: PALETTE_NUM.financeGold, alpha: 1 });
      // Glowing cyan tip — a halo + a brighter core.
      g.circle(0, TOP - 19, 3).fill({ color: PALETTE_NUM.neonCyan, alpha: 0.35 });
      g.circle(0, TOP - 19, 2).fill({ color: PALETTE_NUM.neonCyan, alpha: 1 });
      g.circle(0, TOP - 19, 1).fill({ color: 0xffffff, alpha: 0.9 });
      // Small gold gems on the side prongs for that regal flourish.
      g.circle(-7, TOP - 7, 0.8).fill({ color: PALETTE_NUM.neonCyan, alpha: 1 });
      g.circle(7, TOP - 7, 0.8).fill({ color: PALETTE_NUM.neonCyan, alpha: 1 });
      // Use `accent` as a faint inner glow line across the band to tie it
      // back to the costume's accent color.
      g.rect(-10, TOP - 3, 20, 0.5).fill({ color: accent, alpha: 0.6 });
      break;
    }

    default: {
      // Exhaustive guard — adding a new HatId without a draw fn will fail here.
      const _exhaustive: never = name;
      void _exhaustive;
      break;
    }
  }
}

// ── BODIES ────────────────────────────────────────────────────────────────
/**
 * Bodies recolor / overlay the mid-band of the can (roughly y ∈ [-28, +28]).
 * They preserve enough of the silver base that the can still reads as a
 * beercan; never paint the whole body opaque.
 */
export function drawBody(g: Graphics, name: BodyId, accent: number): void {
  const TOP_BODY = -BODY_H / 2 + 12; // below the top band
  const BOT_BODY = BODY_H / 2 - 12; // above the bottom band
  const BODY_REGION_H = BOT_BODY - TOP_BODY;

  switch (name) {
    case 'blue_coveralls': {
      // Vertical strap shapes in neonCyan + small chest pocket.
      const baseColor = darkenNum(PALETTE_NUM.mutedCyan, 0.2);
      // Darker base layer for the coveralls.
      g.roundRect(-BODY_W / 2 + 2, TOP_BODY, BODY_W - 4, BODY_REGION_H, 3).fill({
        color: baseColor,
        alpha: 0.85,
      });
      // Left + right straps.
      g.rect(-10, TOP_BODY, 3, 18).fill({ color: PALETTE_NUM.neonCyan, alpha: 1 });
      g.rect(7, TOP_BODY, 3, 18).fill({ color: PALETTE_NUM.neonCyan, alpha: 1 });
      // Strap buttons.
      g.circle(-8.5, TOP_BODY + 17, 1.2).fill({ color: PALETTE_NUM.financeGold, alpha: 1 });
      g.circle(8.5, TOP_BODY + 17, 1.2).fill({ color: PALETTE_NUM.financeGold, alpha: 1 });
      // Chest pocket — small rectangle.
      g.roundRect(-5, TOP_BODY + 6, 10, 7, 1).stroke({ width: 1, color: PALETTE_NUM.neonCyan, alpha: 0.8 });
      break;
    }

    case 'hoodie': {
      // V-shaped collar lines + drawstring dots.
      const baseColor = darkenNum(0x4a4a4a, 0.1);
      g.roundRect(-BODY_W / 2 + 2, TOP_BODY, BODY_W - 4, BODY_REGION_H, 3).fill({
        color: baseColor,
        alpha: 0.75,
      });
      // V-collar.
      g.poly([-10, TOP_BODY, -1, TOP_BODY + 10, 0, TOP_BODY + 11, 1, TOP_BODY + 10, 10, TOP_BODY])
        .stroke({ width: 1.5, color: accent, alpha: 1 });
      // Drawstring dots dangling from the V's apex.
      g.circle(-2, TOP_BODY + 12, 1).fill({ color: accent, alpha: 1 });
      g.circle(2, TOP_BODY + 12, 1).fill({ color: accent, alpha: 1 });
      // Inner hood opening — darker arch behind the collar.
      g.ellipse(0, TOP_BODY + 1, 6, 2).fill({ color: 0x1a1a1a, alpha: 0.7 });
      break;
    }

    case 'smock_paint_splatter': {
      // Base smock in muted off-white with random paint dots.
      g.roundRect(-BODY_W / 2 + 2, TOP_BODY, BODY_W - 4, BODY_REGION_H, 3).fill({
        color: 0xe0d8c8,
        alpha: 0.85,
      });
      // Deterministic seeded splatter — repeatable per render.
      const rand = rng(0x5d1c);
      const splatColors = [PALETTE_NUM.electricPurple, PALETTE_NUM.neonCyan];
      for (let i = 0; i < 16; i++) {
        const x = (rand() - 0.5) * (BODY_W - 8);
        const y = TOP_BODY + rand() * BODY_REGION_H;
        const r = 0.8 + rand() * 1.6;
        const color = splatColors[i % splatColors.length] ?? PALETTE_NUM.electricPurple;
        g.circle(x, y, r).fill({ color, alpha: 0.85 });
      }
      // Small accent splat highlight (drips).
      g.rect(-6, TOP_BODY + 8, 1, 4).fill({ color: PALETTE_NUM.electricPurple, alpha: 0.7 });
      break;
    }

    case 'bomber_jacket': {
      // Zipper line down center + ribbed cuff horizontals near the top.
      const baseColor = darkenNum(PALETTE_NUM.marketingRed, 0.45);
      g.roundRect(-BODY_W / 2 + 2, TOP_BODY, BODY_W - 4, BODY_REGION_H, 3).fill({
        color: baseColor,
        alpha: 0.85,
      });
      // Ribbed cuff — top stripes.
      g.rect(-BODY_W / 2 + 2, TOP_BODY + 1, BODY_W - 4, 1).fill({ color: PALETTE_NUM.marketingRed, alpha: 0.8 });
      g.rect(-BODY_W / 2 + 2, TOP_BODY + 3, BODY_W - 4, 1).fill({ color: PALETTE_NUM.marketingRed, alpha: 0.8 });
      g.rect(-BODY_W / 2 + 2, TOP_BODY + 5, BODY_W - 4, 0.5).fill({ color: PALETTE_NUM.marketingRed, alpha: 0.5 });
      // Center zipper.
      g.rect(-0.5, TOP_BODY + 6, 1, BODY_REGION_H - 8).fill({ color: PALETTE_NUM.starlight, alpha: 1 });
      // Zipper pull at top.
      g.rect(-1.5, TOP_BODY + 6, 3, 2).fill({ color: PALETTE_NUM.starlight, alpha: 1 });
      // Bottom cuff stripes.
      g.rect(-BODY_W / 2 + 2, BOT_BODY - 2, BODY_W - 4, 1).fill({ color: PALETTE_NUM.marketingRed, alpha: 0.8 });
      break;
    }

    case 'three_piece_suit': {
      // Lapel V + button column in financeGold.
      const baseColor = 0x202024;
      g.roundRect(-BODY_W / 2 + 2, TOP_BODY, BODY_W - 4, BODY_REGION_H, 3).fill({
        color: baseColor,
        alpha: 0.92,
      });
      // Lapel V — two stroke lines.
      g.moveTo(-10, TOP_BODY).lineTo(-2, TOP_BODY + 12).stroke({ width: 1.5, color: PALETTE_NUM.starlight, alpha: 0.7 });
      g.moveTo(10, TOP_BODY).lineTo(2, TOP_BODY + 12).stroke({ width: 1.5, color: PALETTE_NUM.starlight, alpha: 0.7 });
      // Waistcoat strip (a slightly lighter rectangle behind the lapel V).
      g.rect(-3, TOP_BODY + 8, 6, BODY_REGION_H - 12).fill({ color: 0x303035, alpha: 1 });
      // Gold button column.
      g.circle(0, TOP_BODY + 14, 1.2).fill({ color: PALETTE_NUM.financeGold, alpha: 1 });
      g.circle(0, TOP_BODY + 20, 1.2).fill({ color: PALETTE_NUM.financeGold, alpha: 1 });
      g.circle(0, TOP_BODY + 26, 1.2).fill({ color: PALETTE_NUM.financeGold, alpha: 1 });
      break;
    }

    case 'tweed_jacket': {
      // Hatched diagonal lines in mutedCyan.
      const baseColor = 0x3a4040;
      g.roundRect(-BODY_W / 2 + 2, TOP_BODY, BODY_W - 4, BODY_REGION_H, 3).fill({
        color: baseColor,
        alpha: 0.9,
      });
      // Diagonal hatches — 8 lines across the body.
      const left = -BODY_W / 2 + 3;
      const right = BODY_W / 2 - 3;
      const width = right - left;
      const step = width / 7;
      for (let i = 0; i < 9; i++) {
        const x0 = left + i * step;
        const y0 = TOP_BODY + 2;
        const x1 = x0 + 8;
        const y1 = y0 + 8;
        g.moveTo(x0, y0).lineTo(x1, y1).stroke({
          width: 0.6,
          color: PALETTE_NUM.mutedCyan,
          alpha: 0.7,
        });
      }
      // Same hatches offset for a denser weave look.
      for (let i = 0; i < 9; i++) {
        const x0 = left + i * step;
        const y0 = TOP_BODY + 12;
        const x1 = x0 + 8;
        const y1 = y0 + 8;
        g.moveTo(x0, y0).lineTo(x1, y1).stroke({
          width: 0.6,
          color: PALETTE_NUM.mutedCyan,
          alpha: 0.7,
        });
      }
      // Subtle lapel stripe.
      g.rect(-12, TOP_BODY, 2, 14).fill({ color: PALETTE_NUM.researchPurple, alpha: 0.5 });
      break;
    }

    case 'apron_with_pen_loops': {
      // Rectangular apron over body with 3 pen-loop notches at the top.
      const baseColor = darkenNum(PALETTE_NUM.publishingOrange, 0.4);
      g.roundRect(-BODY_W / 2 + 2, TOP_BODY, BODY_W - 4, BODY_REGION_H, 3).fill({
        color: baseColor,
        alpha: 0.6,
      });
      // The apron itself — slightly inset rectangle in publishingOrange.
      g.roundRect(-14, TOP_BODY + 4, 28, BODY_REGION_H - 6, 2).fill({
        color: PALETTE_NUM.publishingOrange,
        alpha: 0.95,
      });
      // Three pen-loop notches across the apron's top edge.
      g.rect(-10, TOP_BODY + 4, 2, 6).fill({ color: darkenNum(PALETTE_NUM.publishingOrange, 0.4), alpha: 1 });
      g.rect(-1, TOP_BODY + 4, 2, 6).fill({ color: darkenNum(PALETTE_NUM.publishingOrange, 0.4), alpha: 1 });
      g.rect(8, TOP_BODY + 4, 2, 6).fill({ color: darkenNum(PALETTE_NUM.publishingOrange, 0.4), alpha: 1 });
      // Pen heads peeking out of each loop.
      g.rect(-10, TOP_BODY + 2, 2, 3).fill({ color: PALETTE_NUM.neonCyan, alpha: 1 });
      g.rect(-1, TOP_BODY + 2, 2, 3).fill({ color: PALETTE_NUM.electricPurple, alpha: 1 });
      g.rect(8, TOP_BODY + 2, 2, 3).fill({ color: PALETTE_NUM.financeGold, alpha: 1 });
      // Apron tie strap.
      g.rect(-1, TOP_BODY, 2, 4).fill({ color: darkenNum(PALETTE_NUM.publishingOrange, 0.5), alpha: 1 });
      break;
    }

    case 'flannel': {
      // 2x2 checker pattern in devopsGreen + darker overlay.
      const lightColor = PALETTE_NUM.devopsGreen;
      const darkColor = darkenNum(PALETTE_NUM.devopsGreen, 0.55);
      g.roundRect(-BODY_W / 2 + 2, TOP_BODY, BODY_W - 4, BODY_REGION_H, 3).fill({
        color: darkColor,
        alpha: 0.85,
      });
      const cellW = (BODY_W - 4) / 4;
      const cellH = BODY_REGION_H / 6;
      for (let cy = 0; cy < 6; cy++) {
        for (let cx = 0; cx < 4; cx++) {
          if ((cx + cy) % 2 === 0) {
            g.rect(-BODY_W / 2 + 2 + cx * cellW, TOP_BODY + cy * cellH, cellW, cellH).fill({
              color: lightColor,
              alpha: 0.55,
            });
          }
        }
      }
      // Center placket line (button line down the middle).
      g.rect(-0.5, TOP_BODY, 1, BODY_REGION_H).fill({ color: darkenNum(darkColor, 0.4), alpha: 1 });
      // Buttons.
      g.circle(0, TOP_BODY + 6, 0.8).fill({ color: PALETTE_NUM.starlight, alpha: 1 });
      g.circle(0, TOP_BODY + 18, 0.8).fill({ color: PALETTE_NUM.starlight, alpha: 1 });
      g.circle(0, TOP_BODY + 30, 0.8).fill({ color: PALETTE_NUM.starlight, alpha: 1 });
      break;
    }

    case 'cape_skippy': {
      // Skippy's body is treated as the cape body — the cape graphic is the
      // primary surface. We add a chrome-ish band overlay to keep the can
      // reading like Skippy specifically.
      g.roundRect(-BODY_W / 2 + 2, TOP_BODY, BODY_W - 4, BODY_REGION_H, 3).fill({
        color: 0xe0eef0,
        alpha: 0.4,
      });
      // A subtle vertical highlight.
      g.rect(-BODY_W / 2 + 3, TOP_BODY, 2, BODY_REGION_H).fill({ color: 0xffffff, alpha: 0.25 });
      // The accent color signed across the chest in a thin glow band.
      g.rect(-12, TOP_BODY + 12, 24, 1).fill({ color: accent, alpha: 0.9 });
      g.rect(-12, TOP_BODY + 14, 24, 0.5).fill({ color: accent, alpha: 0.5 });
      break;
    }

    default: {
      const _exhaustive: never = name;
      void _exhaustive;
      break;
    }
  }
}

// ── ACCESSORIES ───────────────────────────────────────────────────────────
/** Small accents positioned to the side or front of the can. */
export function drawAccessory(g: Graphics, name: AccessoryId, accent: number): void {
  const RIGHT = BODY_W / 2; // right flank x
  const LEFT = -BODY_W / 2; // left flank x

  switch (name) {
    case 'wrench': {
      // Tiny L-shape in mutedCyan to the right of the can.
      g.rect(RIGHT + 2, -10, 3, 18).fill({ color: PALETTE_NUM.mutedCyan, alpha: 1 });
      g.rect(RIGHT + 2, -10, 8, 3).fill({ color: PALETTE_NUM.mutedCyan, alpha: 1 });
      // Wrench head detail.
      g.rect(RIGHT + 8, -11, 3, 5).fill({ color: PALETTE_NUM.mutedCyan, alpha: 1 });
      g.rect(RIGHT + 9, -10, 1, 3).fill({ color: 0x1a1a1a, alpha: 1 });
      // Small highlight on the shaft.
      g.rect(RIGHT + 2, -10, 1, 18).fill({ color: 0xffffff, alpha: 0.4 });
      break;
    }

    case 'mechanical_keyboard': {
      // Small horizontal bar with key dots, below the can's mouth slot.
      const KY = 14; // y under the mouth slot (mouth is at y≈8)
      g.roundRect(-12, KY, 24, 6, 1).fill({ color: 0x2c2c2c, alpha: 1 });
      // Three rows of key dots.
      for (let row = 0; row < 2; row++) {
        for (let col = 0; col < 6; col++) {
          g.rect(-11 + col * 4, KY + 1 + row * 2.5, 2, 1.5).fill({ color: 0x6a6a6a, alpha: 1 });
        }
      }
      // Accent line at the bottom.
      g.rect(-12, KY + 5.5, 24, 0.5).fill({ color: accent, alpha: 0.9 });
      break;
    }

    case 'brush': {
      // Vertical handle + bristle tuft in electricPurple.
      const X = RIGHT + 3;
      g.rect(X, -4, 2, 14).fill({ color: 0x8a4a1f, alpha: 1 });
      // Ferrule (metal band).
      g.rect(X - 1, -7, 4, 3).fill({ color: 0x9a9a9a, alpha: 1 });
      // Bristle tuft.
      g.poly([X - 2, -7, X + 3, -7, X + 2, -13, X - 1, -13]).fill({
        color: PALETTE_NUM.electricPurple,
        alpha: 1,
      });
      // Highlight on bristles.
      g.rect(X, -12, 0.5, 4).fill({ color: 0xffffff, alpha: 0.5 });
      break;
    }

    case 'megaphone': {
      // Horn shape pointing right.
      const baseX = RIGHT + 1;
      g.poly([
        baseX, -5,
        baseX + 12, -10,
        baseX + 12, 8,
        baseX, 3,
      ]).fill({ color: PALETTE_NUM.marketingRed, alpha: 1 });
      // Mouthpiece (small handle behind the horn).
      g.rect(baseX - 2, -2, 2, 4).fill({ color: darkenNum(PALETTE_NUM.marketingRed, 0.4), alpha: 1 });
      // Inner cone darker.
      g.poly([
        baseX + 2, -3,
        baseX + 11, -8,
        baseX + 11, 6,
        baseX + 2, 2,
      ]).fill({ color: darkenNum(PALETTE_NUM.marketingRed, 0.4), alpha: 0.8 });
      // Sound waves.
      g.moveTo(baseX + 14, -8).lineTo(baseX + 16, -10).stroke({ width: 1, color: PALETTE_NUM.starlight, alpha: 0.6 });
      g.moveTo(baseX + 14, 0).lineTo(baseX + 17, 0).stroke({ width: 1, color: PALETTE_NUM.starlight, alpha: 0.6 });
      g.moveTo(baseX + 14, 6).lineTo(baseX + 16, 8).stroke({ width: 1, color: PALETTE_NUM.starlight, alpha: 0.6 });
      break;
    }

    case 'monocle_and_chart': {
      // Small circle (monocle) on the right + tiny upward zigzag chart on the left.
      // Monocle.
      g.circle(RIGHT + 5, -8, 4).stroke({ width: 1.2, color: PALETTE_NUM.financeGold, alpha: 1 });
      g.circle(RIGHT + 5, -8, 3.5).fill({ color: 0xffffff, alpha: 0.25 });
      // Chain (3 dots curving down).
      g.circle(RIGHT + 3, -4, 0.6).fill({ color: PALETTE_NUM.financeGold, alpha: 1 });
      g.circle(RIGHT + 2, -1, 0.6).fill({ color: PALETTE_NUM.financeGold, alpha: 1 });
      g.circle(RIGHT + 1, 2, 0.6).fill({ color: PALETTE_NUM.financeGold, alpha: 1 });
      // Chart on the left flank.
      const cx = LEFT - 10;
      const cy = 0;
      g.roundRect(cx, cy - 6, 9, 12, 1).fill({ color: 0xf8f4e0, alpha: 0.95 });
      // Zigzag going upward.
      g.moveTo(cx + 1, cy + 4)
        .lineTo(cx + 3, cy + 1)
        .lineTo(cx + 5, cy + 2)
        .lineTo(cx + 7, cy - 3)
        .stroke({ width: 1, color: PALETTE_NUM.devopsGreen, alpha: 1 });
      // Arrow tip.
      g.poly([cx + 7, cy - 3, cx + 6.5, cy - 1.5, cx + 8, cy - 2]).fill({
        color: PALETTE_NUM.devopsGreen,
        alpha: 1,
      });
      break;
    }

    case 'scroll': {
      // Thin horizontal tube with curl ends.
      const Y = 0;
      const X = RIGHT + 2;
      g.rect(X + 3, Y - 4, 10, 12).fill({ color: 0xfff0d0, alpha: 1 });
      // Curl ends.
      g.circle(X + 3, Y - 4, 2).fill({ color: PALETTE_NUM.researchPurple, alpha: 1 });
      g.circle(X + 3, Y + 8, 2).fill({ color: PALETTE_NUM.researchPurple, alpha: 1 });
      g.circle(X + 13, Y - 4, 2).fill({ color: PALETTE_NUM.researchPurple, alpha: 1 });
      g.circle(X + 13, Y + 8, 2).fill({ color: PALETTE_NUM.researchPurple, alpha: 1 });
      // Three short writing lines.
      g.rect(X + 5, Y - 1, 6, 0.5).fill({ color: 0x444444, alpha: 1 });
      g.rect(X + 5, Y + 1, 4, 0.5).fill({ color: 0x444444, alpha: 1 });
      g.rect(X + 5, Y + 3, 5, 0.5).fill({ color: 0x444444, alpha: 1 });
      // Accent ribbon tying it shut.
      g.rect(X + 7, Y - 4, 2, 12).fill({ color: accent, alpha: 0.7 });
      break;
    }

    case 'typewriter': {
      // Small rectangle with 3 horizontal key rows.
      const Y = 6;
      const X = LEFT - 12;
      g.roundRect(X, Y, 11, 12, 1).fill({ color: PALETTE_NUM.publishingOrange, alpha: 1 });
      // Top paper roller.
      g.rect(X, Y - 1, 11, 2).fill({ color: darkenNum(PALETTE_NUM.publishingOrange, 0.4), alpha: 1 });
      // Paper sheet poking up.
      g.rect(X + 3, Y - 5, 5, 5).fill({ color: 0xffffff, alpha: 0.95 });
      // 3 key rows.
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 4; col++) {
          g.rect(X + 1 + col * 2.4, Y + 3 + row * 2.5, 1.6, 1.4).fill({
            color: 0x1a1a1a,
            alpha: 1,
          });
        }
      }
      break;
    }

    case 'terminal_tablet': {
      // Rectangle with 2-3 horizontal "lines of text".
      const X = RIGHT + 2;
      g.roundRect(X, -10, 11, 16, 1).fill({ color: 0x111111, alpha: 1 });
      // Screen bezel.
      g.roundRect(X + 0.5, -9.5, 10, 15, 1).stroke({ width: 0.5, color: PALETTE_NUM.devopsGreen, alpha: 0.8 });
      // Cursor prompt.
      g.rect(X + 1.5, -8, 1, 1).fill({ color: PALETTE_NUM.devopsGreen, alpha: 1 });
      // Lines of text.
      g.rect(X + 3.5, -8, 6, 0.8).fill({ color: PALETTE_NUM.devopsGreen, alpha: 1 });
      g.rect(X + 1.5, -5, 8, 0.8).fill({ color: PALETTE_NUM.devopsGreen, alpha: 0.85 });
      g.rect(X + 1.5, -2, 5, 0.8).fill({ color: PALETTE_NUM.devopsGreen, alpha: 0.85 });
      // Blinking caret (static here).
      g.rect(X + 7, -2, 1, 0.8).fill({ color: PALETTE_NUM.devopsGreen, alpha: 1 });
      break;
    }

    case 'scepter': {
      // Skippy — vertical wand with cyan glow at tip.
      const X = RIGHT + 3;
      // Wand handle.
      g.rect(X, -18, 2, 28).fill({ color: PALETTE_NUM.financeGold, alpha: 1 });
      // Gold accents along the wand.
      g.rect(X - 0.5, -12, 3, 1).fill({ color: darkenNum(PALETTE_NUM.financeGold, 0.4), alpha: 1 });
      g.rect(X - 0.5, -4, 3, 1).fill({ color: darkenNum(PALETTE_NUM.financeGold, 0.4), alpha: 1 });
      g.rect(X - 0.5, 4, 3, 1).fill({ color: darkenNum(PALETTE_NUM.financeGold, 0.4), alpha: 1 });
      // Cyan glow orb at tip.
      g.circle(X + 1, -20, 5).fill({ color: PALETTE_NUM.neonCyan, alpha: 0.25 });
      g.circle(X + 1, -20, 3.5).fill({ color: PALETTE_NUM.neonCyan, alpha: 0.75 });
      g.circle(X + 1, -20, 2).fill({ color: 0xffffff, alpha: 0.95 });
      // Subtle accent ring around the orb.
      g.circle(X + 1, -20, 3.5).stroke({ width: 0.5, color: accent, alpha: 0.6 });
      break;
    }

    default: {
      const _exhaustive: never = name;
      void _exhaustive;
      break;
    }
  }
}

// ── INSIGNIAS ─────────────────────────────────────────────────────────────
/**
 * 12-px circle badge outlined in the accent color, containing a themed glyph.
 * Centered roughly on the body at (0, 0).
 */
export function drawInsignia(g: Graphics, name: InsigniaId, accent: number): void {
  const cx = 0;
  const cy = 0;
  const R = 6; // badge radius

  // Common badge plate + outline.
  g.circle(cx, cy, R).fill({ color: 0x0b0c10, alpha: 0.75 });
  g.circle(cx, cy, R).stroke({ width: 1.2, color: accent, alpha: 1 });

  switch (name) {
    case 'gear_circuit': {
      // Gear teeth outline + small dot.
      g.circle(cx, cy, R - 2).stroke({ width: 1, color: accent, alpha: 1 });
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const x1 = cx + Math.cos(a) * (R - 2);
        const y1 = cy + Math.sin(a) * (R - 2);
        const x2 = cx + Math.cos(a) * (R - 0.5);
        const y2 = cy + Math.sin(a) * (R - 0.5);
        g.moveTo(x1, y1).lineTo(x2, y2).stroke({ width: 1.2, color: accent, alpha: 1 });
      }
      g.circle(cx, cy, 1.2).fill({ color: accent, alpha: 1 });
      break;
    }

    case 'code_brackets': {
      // `< >` glyph approximation — two angled lines.
      g.moveTo(cx - 1, cy - 2.5).lineTo(cx - 3, cy).lineTo(cx - 1, cy + 2.5).stroke({
        width: 1.2,
        color: accent,
        alpha: 1,
      });
      g.moveTo(cx + 1, cy - 2.5).lineTo(cx + 3, cy).lineTo(cx + 1, cy + 2.5).stroke({
        width: 1.2,
        color: accent,
        alpha: 1,
      });
      break;
    }

    case 'palette_swirl': {
      // 3 dots arranged like a color wheel.
      g.circle(cx - 2, cy - 1.5, 1.3).fill({ color: PALETTE_NUM.marketingRed, alpha: 1 });
      g.circle(cx + 2, cy - 1.5, 1.3).fill({ color: PALETTE_NUM.financeGold, alpha: 1 });
      g.circle(cx, cy + 2, 1.3).fill({ color: PALETTE_NUM.neonCyan, alpha: 1 });
      break;
    }

    case 'growth_arrow': {
      // Upward arrow.
      g.moveTo(cx, cy + 2.5).lineTo(cx, cy - 2.5).stroke({ width: 1.4, color: accent, alpha: 1 });
      g.poly([cx, cy - 3.5, cx - 2, cy - 1, cx + 2, cy - 1]).fill({ color: accent, alpha: 1 });
      break;
    }

    case 'coin_dollar': {
      // A $ stroke.
      g.moveTo(cx - 2, cy - 1.5).lineTo(cx + 1.5, cy - 1.5).stroke({
        width: 1,
        color: accent,
        alpha: 1,
      });
      g.moveTo(cx + 1.5, cy - 1.5).lineTo(cx + 1.5, cy + 0.5).stroke({
        width: 1,
        color: accent,
        alpha: 1,
      });
      g.moveTo(cx + 1.5, cy + 0.5).lineTo(cx - 1.5, cy + 0.5).stroke({
        width: 1,
        color: accent,
        alpha: 1,
      });
      g.moveTo(cx - 1.5, cy + 0.5).lineTo(cx - 1.5, cy + 2.5).stroke({
        width: 1,
        color: accent,
        alpha: 1,
      });
      g.moveTo(cx - 1.5, cy + 2.5).lineTo(cx + 2, cy + 2.5).stroke({
        width: 1,
        color: accent,
        alpha: 1,
      });
      // Vertical bar through the $.
      g.moveTo(cx, cy - 3).lineTo(cx, cy + 3).stroke({ width: 1, color: accent, alpha: 1 });
      break;
    }

    case 'book_atom': {
      // Small atom-orbit: ellipse cross.
      g.ellipse(cx, cy, 3.5, 1.5).stroke({ width: 0.8, color: accent, alpha: 1 });
      // Rotated by 60° → emulate by drawing a tilted-y ellipse via two angled ones.
      g.ellipse(cx, cy, 1.5, 3.5).stroke({ width: 0.8, color: accent, alpha: 1 });
      // Nucleus.
      g.circle(cx, cy, 1).fill({ color: accent, alpha: 1 });
      break;
    }

    case 'quill_page': {
      // Small angled line (quill) + dotted line (page).
      g.moveTo(cx - 2.5, cy + 2.5).lineTo(cx + 2, cy - 2.5).stroke({
        width: 1.2,
        color: accent,
        alpha: 1,
      });
      // Feather notches near the tip.
      g.moveTo(cx + 1, cy - 1.5).lineTo(cx + 2.5, cy - 2).stroke({
        width: 0.8,
        color: accent,
        alpha: 0.8,
      });
      g.moveTo(cx, cy - 0.5).lineTo(cx + 1.5, cy - 1).stroke({
        width: 0.8,
        color: accent,
        alpha: 0.8,
      });
      // Dotted page underneath.
      g.circle(cx - 2, cy + 3, 0.4).fill({ color: accent, alpha: 1 });
      g.circle(cx, cy + 3, 0.4).fill({ color: accent, alpha: 1 });
      g.circle(cx + 2, cy + 3, 0.4).fill({ color: accent, alpha: 1 });
      break;
    }

    case 'terminal_carat': {
      // `>_` glyph approximation.
      g.moveTo(cx - 3, cy - 1.5).lineTo(cx - 1, cy).lineTo(cx - 3, cy + 1.5).stroke({
        width: 1.1,
        color: accent,
        alpha: 1,
      });
      // Underscore cursor.
      g.rect(cx + 0.5, cy + 1, 3, 0.8).fill({ color: accent, alpha: 1 });
      break;
    }

    case 'magnificent_crown_gear': {
      // Tiny crown silhouette over a gear ring.
      // Gear ring.
      g.circle(cx, cy + 1, R - 2).stroke({ width: 0.9, color: accent, alpha: 1 });
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const x1 = cx + Math.cos(a) * (R - 2);
        const y1 = cy + 1 + Math.sin(a) * (R - 2);
        const x2 = cx + Math.cos(a) * (R - 0.5);
        const y2 = cy + 1 + Math.sin(a) * (R - 0.5);
        g.moveTo(x1, y1).lineTo(x2, y2).stroke({ width: 1, color: accent, alpha: 1 });
      }
      // Crown silhouette on top.
      g.poly([
        cx - 3, cy - 0.5,
        cx - 3, cy - 2.5,
        cx - 1.5, cy - 1.5,
        cx, cy - 3,
        cx + 1.5, cy - 1.5,
        cx + 3, cy - 2.5,
        cx + 3, cy - 0.5,
      ]).fill({ color: PALETTE_NUM.financeGold, alpha: 1 });
      // Cyan gem in the crown center.
      g.circle(cx, cy - 1.8, 0.6).fill({ color: PALETTE_NUM.neonCyan, alpha: 1 });
      break;
    }

    default: {
      const _exhaustive: never = name;
      void _exhaustive;
      break;
    }
  }
}

// ── CAPE ──────────────────────────────────────────────────────────────────
/**
 * Skippy's shimmering cape — a trapezoid Graphics behind the body.
 * neonCyan with electricPurple outline, slight transparency.
 *
 * Drawn into the supplied `Graphics`; the caller decides z-order. In
 * `applyCostume` we insert the cape at the very back of the costume layer.
 */
export function drawSkippyCape(g: Graphics): void {
  // Trapezoid: narrower at the shoulders, wider at the hem.
  g.poly([
    -BODY_W / 2 - 2, -BODY_H / 2 + 10,
    BODY_W / 2 + 2, -BODY_H / 2 + 10,
    BODY_W / 2 + 12, BODY_H / 2 + 4,
    -BODY_W / 2 - 12, BODY_H / 2 + 4,
  ]).fill({ color: PALETTE_NUM.neonCyan, alpha: 0.32 });
  // Inner gradient suggestion — a smaller, slightly brighter trapezoid.
  g.poly([
    -BODY_W / 2 + 4, -BODY_H / 2 + 12,
    BODY_W / 2 - 4, -BODY_H / 2 + 12,
    BODY_W / 2 + 4, BODY_H / 2 + 2,
    -BODY_W / 2 - 4, BODY_H / 2 + 2,
  ]).fill({ color: PALETTE_NUM.neonCyan, alpha: 0.18 });
  // Electric purple outline.
  g.poly([
    -BODY_W / 2 - 2, -BODY_H / 2 + 10,
    BODY_W / 2 + 2, -BODY_H / 2 + 10,
    BODY_W / 2 + 12, BODY_H / 2 + 4,
    -BODY_W / 2 - 12, BODY_H / 2 + 4,
  ]).stroke({ width: 1, color: PALETTE_NUM.electricPurple, alpha: 0.75 });
  // Shoulder clasps — two small gold dots.
  g.circle(-BODY_W / 2 + 2, -BODY_H / 2 + 10, 1.5).fill({ color: PALETTE_NUM.financeGold, alpha: 1 });
  g.circle(BODY_W / 2 - 2, -BODY_H / 2 + 10, 1.5).fill({ color: PALETTE_NUM.financeGold, alpha: 1 });
}

/**
 * Apply (or re-apply) a costume to a previously-built beercan.
 *
 * Re-applying is safe: the costume layer is cleared first.
 * Body tint and band recolor are handled here too — accentColor flows from
 * the costume, overriding whatever createBeercan was passed.
 *
 * Z-order inside the costume layer (back to front):
 *   cape → body → insignia → accessory → hat → custom
 */
export function applyCostume(refs: BeercanRefs, costume: Costume): void {
  refs.costumeLayer.removeChildren();
  refs.accentColor = costume.accentColor;

  // Repaint the accent bands so a costume swap visibly retints the can.
  refs.topBand.clear().roundRect(-BODY_W / 2 + 1, -BODY_H / 2 + 4, BODY_W - 2, 6, 2).fill({
    color: costume.accentColor,
    alpha: 0.9,
  });
  refs.bottomBand.clear().roundRect(-BODY_W / 2 + 1, BODY_H / 2 - 8, BODY_W - 2, 3, 1).fill({
    color: costume.accentColor,
    alpha: 0.7,
  });

  // 1. Cape (Skippy only) — sits at the bottom of the costume layer.
  if (costume.cape) {
    const cape = new Graphics();
    cape.label = 'costume.cape';
    drawSkippyCape(cape);
    refs.costumeLayer.addChild(cape);
  }

  // 2. Body overlay.
  if (costume.body) {
    const body = new Graphics();
    body.label = `costume.body:${costume.body}`;
    drawBody(body, costume.body, costume.accentColor);
    refs.costumeLayer.addChild(body);
  }

  // 3. Insignia badge centered on the body.
  if (costume.insignia) {
    const insignia = new Graphics();
    insignia.label = `costume.insignia:${costume.insignia}`;
    drawInsignia(insignia, costume.insignia, costume.accentColor);
    refs.costumeLayer.addChild(insignia);
  }

  // 4. Accessory.
  if (costume.accessory) {
    const accessory = new Graphics();
    accessory.label = `costume.accessory:${costume.accessory}`;
    drawAccessory(accessory, costume.accessory, costume.accentColor);
    refs.costumeLayer.addChild(accessory);
  }

  // 5. Hat sits on top of the can.
  if (costume.hat) {
    const hat = new Graphics();
    hat.label = `costume.hat:${costume.hat}`;
    drawHat(hat, costume.hat, costume.accentColor);
    refs.costumeLayer.addChild(hat);
  }

  // 6. Custom escape hatch — anything the caller wants in front of all the
  // standard layers. We give them the full BeercanRefs so they can also
  // mutate base layers if needed.
  if (costume.custom) {
    costume.custom(refs);
  }
}

/** Convenience: build a costume from a hex accent color rather than numeric. */
export function costumeFromHex(c: Omit<Costume, 'accentColor'> & { accentColor: string }): Costume {
  return { ...c, accentColor: hexToNum(c.accentColor) };
}
