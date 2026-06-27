// Procedural beercan factory. Pixi v8 fluent Graphics API.
//
// Approx body dims: 48 wide × 80 tall, anchored at the center of the Container.
// Pixi y is down-positive; "top" of the can has lower y than "bottom".
//
// Z-order (back to front, all inside the same Container):
//   shadow → body → bodyShade → highlight → rimBottom → rimTop → topBand →
//   bottomBand → pullTab → antennaGlow → antenna → ledGlow → led → mouth →
//   spark → costumeLayer → thoughtBubble
//
// All layers are stored on `BeercanRefs` so tick.ts and costume.ts can mutate
// without re-walking the display tree.
//
// Sprite v1 (Phase 4) richness — every detail below is still 100% procedural
// `Graphics`, no binary assets:
//   • brushed-aluminum vertical micro-streaks + cylindrical edge shading
//   • specular highlight streak on the lit (left) flank
//   • elliptical top + bottom rims that sell the cylinder
//   • a multi-part pull tab (ring, finger hole, rivet)
//   • an antenna whose tip is a glowing cyan LED with a soft halo
//   • a body status LED with its own halo
// New layers were appended to BeercanRefs; existing field names are unchanged
// so every prior caller (scene/BoardCaptain, ThronePad, walkers) keeps working.

import { Container, Graphics } from 'pixi.js';
import type { AnimationState } from './states';

export interface BeercanRefs {
  container: Container;
  body: Graphics;
  /** Brushed-metal micro-streaks + cylindrical edge shading over the body. */
  bodyShade: Graphics;
  highlight: Graphics;
  /** Elliptical lip at the very top of the can (the "open" disc). */
  rimTop: Graphics;
  /** Elliptical lip at the base of the can. */
  rimBottom: Graphics;
  topBand: Graphics;
  bottomBand: Graphics;
  pullTab: Graphics;
  antenna: Graphics;
  /** Soft halo behind the antenna's glowing LED tip. */
  antennaGlow: Graphics;
  led: Graphics;
  /** Soft halo behind the body status LED. */
  ledGlow: Graphics;
  mouth: Graphics;
  shadow: Graphics;
  spark: Graphics;
  thoughtBubble: Container;
  thoughtDots: [Graphics, Graphics, Graphics];
  costumeLayer: Container;
  accentColor: number;
  baseY: number;
  baseScale: number;
  currentState: AnimationState;
  stateStartedAt: number;
}

export interface CreateBeercanOpts {
  accentColor: number;
  baseY: number;
  scale?: number;
}

const BODY_W = 48;
const BODY_H = 80;

/** Canonical cyan used by both LEDs and their halos. */
const LED_CYAN = 0x4fc3f7;

// Mulberry32 deterministic PRNG so the brushed-metal streaks render identically
// every mount/frame (createBeercan is only called once per can, but keeping it
// deterministic avoids visual jitter if a can is ever rebuilt).
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

/**
 * Paint brushed-aluminum texture + cylindrical shading into `g`, clamped to the
 * body rect (inset so it respects the rounded corners). Exported so the gallery
 * / tests can render the metal treatment in isolation.
 */
export function paintBrushedMetal(g: Graphics): void {
  const inset = 3;
  const left = -BODY_W / 2 + inset;
  const right = BODY_W / 2 - inset;
  const top = -BODY_H / 2 + 4;
  const bot = BODY_H / 2 - 4;
  const h = bot - top;

  // Cylindrical shading: the can is brightest just left-of-center (the lit
  // flank) and falls off toward both rims. Right edge is darkest.
  for (let i = 0; i < 7; i++) {
    const a = i / 7;
    g.rect(right - (i + 1) * 1.6, top, 1.7, h).fill({ color: 0x000000, alpha: 0.05 + a * 0.05 });
  }
  for (let i = 0; i < 4; i++) {
    g.rect(left + i * 1.6, top, 1.7, h).fill({ color: 0x000000, alpha: 0.05 - i * 0.01 });
  }
  // A soft bright core band just left of center sells the curve.
  g.rect(-6, top, 7, h).fill({ color: 0xffffff, alpha: 0.08 });

  // Brushed vertical micro-streaks across the whole body.
  const rand = rng(0x9e3779b9);
  for (let x = left + 1; x < right - 1; x += 1.4) {
    const light = rand() > 0.5;
    g.rect(x, top, 0.55, h).fill({ color: light ? 0xffffff : 0x202024, alpha: 0.03 + rand() * 0.05 });
  }
}

export function createBeercan(opts: CreateBeercanOpts): BeercanRefs {
  const { accentColor, baseY } = opts;
  const baseScale = opts.scale ?? 1;

  const container = new Container();
  container.scale.set(baseScale);
  container.sortableChildren = false;
  container.label = 'beercan';

  // 1. Shadow — soft ellipse under the can.
  const shadow = new Graphics()
    .ellipse(0, BODY_H / 2 + 6, BODY_W / 2 + 4, 5)
    .fill({ color: 0x000000, alpha: 0.35 });

  // 2. Body — brushed-metal silver canister with rounded corners.
  const body = new Graphics()
    .roundRect(-BODY_W / 2, -BODY_H / 2, BODY_W, BODY_H, 6)
    .fill({ color: 0xc4c6cb, alpha: 1 })
    .stroke({ width: 1, color: 0x5a5a5e, alpha: 0.85 });

  // 3. Body shading — brushed aluminum micro-streaks + cylindrical falloff.
  const bodyShade = new Graphics();
  bodyShade.label = 'bodyShade';
  paintBrushedMetal(bodyShade);

  // 4. Highlight — vertical specular streak on the lit (left) flank.
  const highlight = new Graphics()
    .roundRect(-BODY_W / 2 + 4, -BODY_H / 2 + 6, 5, BODY_H - 12, 2)
    .fill({ color: 0xffffff, alpha: 0.32 });

  // 5. Bottom rim — darker elliptical lip at the base.
  const rimBottom = new Graphics()
    .ellipse(0, BODY_H / 2 - 2, BODY_W / 2 - 1, 3)
    .fill({ color: 0x8a8c90, alpha: 0.95 })
    .stroke({ width: 0.75, color: 0x4a4a4e, alpha: 0.7 });

  // 6. Top rim — bright elliptical lip at the open top of the can.
  const rimTop = new Graphics()
    .ellipse(0, -BODY_H / 2 + 2, BODY_W / 2 - 1, 3.5)
    .fill({ color: 0xdadce0, alpha: 1 })
    .stroke({ width: 0.75, color: 0x5a5a5e, alpha: 0.8 });
  // Inner shadow disc — the recessed "drink" opening.
  rimTop.ellipse(0, -BODY_H / 2 + 2.5, BODY_W / 2 - 5, 2).fill({ color: 0x8e9094, alpha: 0.7 });

  // 7. Top band — accent-colored ring near the top of the can.
  const topBand = new Graphics()
    .roundRect(-BODY_W / 2 + 1, -BODY_H / 2 + 6, BODY_W - 2, 6, 2)
    .fill({ color: accentColor, alpha: 0.9 });

  // 8. Bottom band — narrower accent stripe near the base.
  const bottomBand = new Graphics()
    .roundRect(-BODY_W / 2 + 1, BODY_H / 2 - 9, BODY_W - 2, 3, 1)
    .fill({ color: accentColor, alpha: 0.7 });

  // 9. Pull tab — ring + finger hole + rivet at the very top.
  const pullTab = new Graphics();
  pullTab.label = 'pullTab';
  pullTab
    .ellipse(1, -BODY_H / 2 - 2, 7, 2.6)
    .fill({ color: 0x9a9ca0, alpha: 1 })
    .stroke({ width: 1, color: 0x45454a, alpha: 0.9 });
  // Finger hole.
  pullTab.ellipse(3, -BODY_H / 2 - 2, 3, 1.2).fill({ color: 0x55565a, alpha: 1 });
  // Rivet anchoring the tab to the lid.
  pullTab.circle(-3.5, -BODY_H / 2 - 2, 1.1).fill({ color: 0x6a6c70, alpha: 1 }).stroke({
    width: 0.5,
    color: 0x35353a,
    alpha: 0.9,
  });

  // 10. Antenna — thin rod rising from the lid.
  const antenna = new Graphics();
  antenna.label = 'antenna';
  antenna
    .moveTo(0, -BODY_H / 2 - 3)
    .lineTo(0, -BODY_H / 2 - 15)
    .stroke({ width: 1.5, color: 0x4a4a4e, alpha: 1 });
  // Glowing cyan LED tip + bright core.
  antenna.circle(0, -BODY_H / 2 - 16, 2.2).fill({ color: LED_CYAN, alpha: 1 });
  antenna.circle(0, -BODY_H / 2 - 16, 1).fill({ color: 0xffffff, alpha: 0.95 });

  // 10b. Antenna glow — soft halo behind the LED tip (alpha animated by tick).
  const antennaGlow = new Graphics()
    .circle(0, -BODY_H / 2 - 16, 5)
    .fill({ color: LED_CYAN, alpha: 0.35 });
  antennaGlow.label = 'antennaGlow';

  // 11. LED glow — soft halo behind the body status LED.
  const ledGlow = new Graphics()
    .circle(0, -BODY_H / 2 + 16, 6)
    .fill({ color: LED_CYAN, alpha: 0.3 });
  ledGlow.label = 'ledGlow';

  // 12. LED — the canonical "blinking LED" on the can's shoulder.
  const led = new Graphics()
    .circle(0, -BODY_H / 2 + 16, 3)
    .fill({ color: LED_CYAN, alpha: 1 })
    .stroke({ width: 0.5, color: 0xffffff, alpha: 0.85 });

  // 13. Mouth slot — thin horizontal rectangle. Height is animated by tick.ts.
  const mouth = new Graphics()
    .rect(-7, 8, 14, 1)
    .fill({ color: 0x222222, alpha: 0.9 });
  mouth.pivot.set(0, 8); // animation grows from this anchor.

  // 14. Spark — tiny flicker under the can for "working" state. Hidden default.
  const spark = new Graphics()
    .star(0, BODY_H / 2 + 4, 4, 3, 1)
    .fill({ color: 0xfff0a0, alpha: 1 });
  spark.visible = false;

  // 15. Thought bubble — small cloud + 3 dots; hidden by default.
  const thoughtBubble = new Container();
  thoughtBubble.label = 'thoughtBubble';
  thoughtBubble.visible = false;
  const bubble = new Graphics()
    .roundRect(BODY_W / 2 + 4, -BODY_H / 2 - 4, 28, 16, 8)
    .fill({ color: 0xffffff, alpha: 0.9 })
    .stroke({ width: 1, color: 0x333333, alpha: 0.6 });
  // Two little trailing puffs connecting the bubble to the can.
  bubble.circle(BODY_W / 2 + 2, -BODY_H / 2 + 10, 2).fill({ color: 0xffffff, alpha: 0.85 });
  bubble.circle(BODY_W / 2 - 1, -BODY_H / 2 + 14, 1.3).fill({ color: 0xffffff, alpha: 0.8 });
  const dot = (x: number, y: number) =>
    new Graphics().circle(x, y, 2).fill({ color: 0x222222, alpha: 1 });
  const d1 = dot(BODY_W / 2 + 10, -BODY_H / 2 + 4);
  const d2 = dot(BODY_W / 2 + 18, -BODY_H / 2 + 4);
  const d3 = dot(BODY_W / 2 + 26, -BODY_H / 2 + 4);
  thoughtBubble.addChild(bubble, d1, d2, d3);

  // 16. Costume layer — empty container that applyCostume() populates.
  const costumeLayer = new Container();
  costumeLayer.label = 'costume';

  container.addChild(
    shadow,
    body,
    bodyShade,
    highlight,
    rimBottom,
    rimTop,
    topBand,
    bottomBand,
    pullTab,
    antennaGlow,
    antenna,
    ledGlow,
    led,
    mouth,
    spark,
    costumeLayer,
    thoughtBubble,
  );

  container.y = baseY;

  return {
    container,
    body,
    bodyShade,
    highlight,
    rimTop,
    rimBottom,
    topBand,
    bottomBand,
    pullTab,
    antenna,
    antennaGlow,
    led,
    ledGlow,
    mouth,
    shadow,
    spark,
    thoughtBubble,
    thoughtDots: [d1, d2, d3],
    costumeLayer,
    accentColor,
    baseY,
    baseScale,
    currentState: 'idle',
    stateStartedAt: 0,
  };
}
