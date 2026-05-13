// Costume system. PRD §12.2: hat + body + accessory + insignia + accent color,
// composited at runtime as layered Graphics.
//
// Phase 0 is procedural-only — every costume slot is rendered with Pixi v8
// Graphics primitives. Once the atlas pipeline lands (PRD §12.5), this file
// becomes the place that swaps Graphics → Sprite without touching beercan.ts.

import { Container, Graphics } from 'pixi.js';
import type { BeercanRefs } from './beercan';
import { hexToNum } from './palette';

/**
 * A Costume is a thin descriptor; the renderer interprets it. Names are
 * stable identifiers (e.g. `'hard_hat_with_visor'`) — the drawing functions
 * below switch on them. Unknown values fall back to a no-op so charters can
 * ship before art does.
 */
export interface Costume {
  hat?: string;
  body?: string;
  accessory?: string;
  insignia?: string;
  accentColor: number;
  cape?: boolean;
}

const BODY_W = 48;
const BODY_H = 80;

function drawHat(name: string, accent: number): Graphics {
  const g = new Graphics();
  switch (name) {
    case 'hard_hat_with_visor':
      // Engineering — yellow dome + black visor strap.
      g.roundRect(-16, -BODY_H / 2 - 12, 32, 10, 4).fill({ color: 0xf1c40f, alpha: 1 });
      g.rect(-18, -BODY_H / 2 - 4, 36, 2).fill({ color: 0x1a1a1a, alpha: 0.9 });
      break;
    case 'wireframe_headset':
      // Coding — gunmetal headphones with cyan boom mic.
      g.roundRect(-18, -BODY_H / 2 - 10, 36, 4, 2).fill({ color: 0x2c2c2c, alpha: 1 });
      g.circle(-18, -BODY_H / 2 - 4, 5).fill({ color: 0x2c2c2c, alpha: 1 });
      g.circle(18, -BODY_H / 2 - 4, 5).fill({ color: 0x2c2c2c, alpha: 1 });
      g.moveTo(-18, -BODY_H / 2 - 1).lineTo(-22, 0).stroke({ width: 1, color: accent });
      break;
    case 'beret':
      // Design — slouched purple cap.
      g.ellipse(0, -BODY_H / 2 - 8, 18, 6).fill({ color: 0xbc13fe, alpha: 1 });
      g.circle(8, -BODY_H / 2 - 10, 2).fill({ color: 0x6a0090, alpha: 1 });
      break;
    case 'snapback_cap':
      // Marketing — red cap + flat brim.
      g.roundRect(-14, -BODY_H / 2 - 10, 28, 8, 3).fill({ color: 0xff6b6b, alpha: 1 });
      g.rect(0, -BODY_H / 2 - 4, 18, 2).fill({ color: 0xc0392b, alpha: 1 });
      break;
    case 'top_hat':
      // Finance — Monopoly Man.
      g.rect(-9, -BODY_H / 2 - 18, 18, 16).fill({ color: 0x111111, alpha: 1 });
      g.rect(-14, -BODY_H / 2 - 4, 28, 3).fill({ color: 0x111111, alpha: 1 });
      g.rect(-9, -BODY_H / 2 - 8, 18, 2).fill({ color: 0xf1c40f, alpha: 1 });
      break;
    case 'wizard_cap':
      // Research — pointed purple wizard hat with band of stars.
      g.moveTo(-12, -BODY_H / 2 - 4)
        .lineTo(12, -BODY_H / 2 - 4)
        .lineTo(0, -BODY_H / 2 - 24)
        .closePath()
        .fill({ color: 0x9b59b6, alpha: 1 });
      g.circle(-3, -BODY_H / 2 - 10, 1).fill({ color: 0xfff0a0, alpha: 1 });
      g.circle(4, -BODY_H / 2 - 14, 1).fill({ color: 0xfff0a0, alpha: 1 });
      break;
    case 'newsboy_cap':
      // Publishing — flat newsboy cap.
      g.ellipse(0, -BODY_H / 2 - 7, 14, 5).fill({ color: 0xe67e22, alpha: 1 });
      g.rect(0, -BODY_H / 2 - 5, 16, 2).fill({ color: 0xb8631a, alpha: 1 });
      break;
    case 'beanie':
      // DevOps — slouched beanie with green stripe.
      g.roundRect(-12, -BODY_H / 2 - 10, 24, 8, 4).fill({ color: 0x2c2c2c, alpha: 1 });
      g.rect(-12, -BODY_H / 2 - 4, 24, 2).fill({ color: 0x2ecc71, alpha: 1 });
      break;
    case 'crown':
      // Skippy — regal antenna crown.
      g.moveTo(-14, -BODY_H / 2 - 4)
        .lineTo(-10, -BODY_H / 2 - 16)
        .lineTo(-6, -BODY_H / 2 - 6)
        .lineTo(-2, -BODY_H / 2 - 18)
        .lineTo(2, -BODY_H / 2 - 6)
        .lineTo(6, -BODY_H / 2 - 18)
        .lineTo(10, -BODY_H / 2 - 6)
        .lineTo(14, -BODY_H / 2 - 16)
        .lineTo(14, -BODY_H / 2 - 4)
        .closePath()
        .fill({ color: 0xf1c40f, alpha: 1 })
        .stroke({ width: 0.5, color: 0xb8860b, alpha: 1 });
      g.circle(-8, -BODY_H / 2 - 14, 1.5).fill({ color: 0x66fcf1, alpha: 1 });
      g.circle(0, -BODY_H / 2 - 16, 1.5).fill({ color: 0x66fcf1, alpha: 1 });
      g.circle(8, -BODY_H / 2 - 14, 1.5).fill({ color: 0x66fcf1, alpha: 1 });
      break;
    default:
      // Unknown hat — render an empty Graphics so the layer slot exists.
      break;
  }
  return g;
}

function drawAccessory(name: string, accent: number): Graphics {
  const g = new Graphics();
  switch (name) {
    case 'wrench':
      g.rect(BODY_W / 2 + 2, -8, 3, 18).fill({ color: 0x7f7f7f });
      g.circle(BODY_W / 2 + 3, -10, 3).fill({ color: 0x7f7f7f });
      break;
    case 'mechanical_keyboard':
      g.roundRect(-BODY_W / 2 - 4, BODY_H / 2 - 16, 8, 6, 1).fill({ color: 0x2c2c2c });
      break;
    case 'brush':
      g.rect(BODY_W / 2 + 2, -4, 2, 14).fill({ color: 0x8a4a1f });
      g.rect(BODY_W / 2 + 1, -6, 4, 4).fill({ color: 0xbc13fe });
      break;
    case 'megaphone':
      g.moveTo(BODY_W / 2 + 2, -4)
        .lineTo(BODY_W / 2 + 12, -10)
        .lineTo(BODY_W / 2 + 12, 6)
        .lineTo(BODY_W / 2 + 2, 0)
        .closePath()
        .fill({ color: 0xff6b6b });
      break;
    case 'monocle_and_chart':
      g.circle(BODY_W / 2 + 6, -10, 4)
        .stroke({ width: 1, color: 0xf1c40f })
        .fill({ color: 0xffffff, alpha: 0.3 });
      g.rect(-BODY_W / 2 - 8, 4, 6, 8).fill({ color: 0xffffff, alpha: 0.9 });
      break;
    case 'scroll':
      g.rect(BODY_W / 2 + 2, -4, 4, 14).fill({ color: 0xfff0d0 });
      g.circle(BODY_W / 2 + 4, -4, 2).fill({ color: 0x9b59b6 });
      g.circle(BODY_W / 2 + 4, 10, 2).fill({ color: 0x9b59b6 });
      break;
    case 'typewriter':
      g.roundRect(-BODY_W / 2 - 8, 4, 8, 8, 1).fill({ color: 0xe67e22 });
      break;
    case 'terminal_tablet':
      g.roundRect(BODY_W / 2 + 2, -8, 10, 14, 1).fill({ color: 0x111111 });
      g.rect(BODY_W / 2 + 4, -6, 6, 1).fill({ color: 0x2ecc71 });
      g.rect(BODY_W / 2 + 4, -3, 4, 1).fill({ color: 0x2ecc71 });
      break;
    case 'magnificent_scepter':
      g.rect(BODY_W / 2 + 4, -16, 2, 28).fill({ color: 0xf1c40f });
      g.circle(BODY_W / 2 + 5, -18, 3).fill({ color: accent });
      break;
    default:
      break;
  }
  return g;
}

function drawInsignia(name: string, accent: number): Graphics {
  const g = new Graphics();
  switch (name) {
    case 'gear_circuit':
    case 'magnificent_crown_gear': {
      // A small gear glyph centered on the can body.
      const cx = 0;
      const cy = 0;
      const r = 6;
      g.circle(cx, cy, r).stroke({ width: 1.5, color: accent });
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const x1 = cx + Math.cos(a) * r;
        const y1 = cy + Math.sin(a) * r;
        const x2 = cx + Math.cos(a) * (r + 2);
        const y2 = cy + Math.sin(a) * (r + 2);
        g.moveTo(x1, y1).lineTo(x2, y2).stroke({ width: 1.5, color: accent });
      }
      g.circle(cx, cy, 2).fill({ color: accent });
      if (name === 'magnificent_crown_gear') {
        // Skippy: tiny crown overlay above the gear.
        g.moveTo(cx - 4, cy - 8)
          .lineTo(cx - 2, cy - 11)
          .lineTo(cx, cy - 8)
          .lineTo(cx + 2, cy - 11)
          .lineTo(cx + 4, cy - 8)
          .stroke({ width: 1, color: 0xf1c40f });
      }
      break;
    }
    default:
      break;
  }
  return g;
}

function drawCape(accent: number): Graphics {
  // Behind the can: shimmering trapezoidal cape. We draw on the costume layer
  // (which is in-front-of body by container z-order), but use low alpha + low
  // y so the cape appears to drape over the shoulders.
  const g = new Graphics();
  g.moveTo(-BODY_W / 2, -BODY_H / 2 + 8)
    .lineTo(BODY_W / 2, -BODY_H / 2 + 8)
    .lineTo(BODY_W / 2 + 10, BODY_H / 2)
    .lineTo(-BODY_W / 2 - 10, BODY_H / 2)
    .closePath()
    .fill({ color: accent, alpha: 0.3 })
    .stroke({ width: 1, color: accent, alpha: 0.7 });
  return g;
}

/**
 * Apply (or re-apply) a costume to a previously-built beercan.
 *
 * Re-applying is safe: the costume layer is cleared first.
 * Body tint and band recolor are handled here too — accentColor flows from
 * the costume, overriding whatever createBeercan was passed.
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

  // Cape sits at the bottom of the costume layer.
  if (costume.cape) {
    refs.costumeLayer.addChild(drawCape(costume.accentColor));
  }

  // Body layer (currently unused — placeholder for v0+ pixel-art swap).
  if (costume.body) {
    const stub = new Container();
    stub.label = `costume.body:${costume.body}`;
    refs.costumeLayer.addChild(stub);
  }

  if (costume.insignia) {
    refs.costumeLayer.addChild(drawInsignia(costume.insignia, costume.accentColor));
  }
  if (costume.accessory) {
    refs.costumeLayer.addChild(drawAccessory(costume.accessory, costume.accentColor));
  }
  if (costume.hat) {
    refs.costumeLayer.addChild(drawHat(costume.hat, costume.accentColor));
  }
}

/** Convenience: build a costume from a hex accent color rather than numeric. */
export function costumeFromHex(c: Omit<Costume, 'accentColor'> & { accentColor: string }): Costume {
  return { ...c, accentColor: hexToNum(c.accentColor) };
}
