// Procedural beercan factory. Pixi v8 fluent Graphics API.
//
// Approx body dims: 48 wide × 80 tall, anchored at the center of the Container.
// Pixi y is down-positive; "top" of the can has lower y than "bottom".
//
// Z-order (back to front, all inside the same Container):
//   shadow → body → highlight → topBand → bottomBand → pullTab → antenna → led → mouth → thoughtBubble
//
// All layers are stored on `BeercanRefs` so tick.ts and costume.ts can mutate
// without re-walking the display tree.

import { Container, Graphics } from 'pixi.js';
import type { AnimationState } from './states';

export interface BeercanRefs {
  container: Container;
  body: Graphics;
  highlight: Graphics;
  topBand: Graphics;
  bottomBand: Graphics;
  pullTab: Graphics;
  antenna: Graphics;
  led: Graphics;
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
    .fill({ color: 0xc0c0c0, alpha: 1 })
    .stroke({ width: 1, color: 0x6a6a6a, alpha: 0.8 });

  // 3. Highlight — vertical specular streak on the left flank.
  const highlight = new Graphics()
    .rect(-BODY_W / 2 + 2, -BODY_H / 2 + 2, 6, BODY_H - 4)
    .fill({ color: 0xffffff, alpha: 0.25 });

  // 4. Top band — accent-colored ring near the top of the can.
  const topBand = new Graphics()
    .roundRect(-BODY_W / 2 + 1, -BODY_H / 2 + 4, BODY_W - 2, 6, 2)
    .fill({ color: accentColor, alpha: 0.9 });

  // 5. Bottom band — narrower accent stripe near the base.
  const bottomBand = new Graphics()
    .roundRect(-BODY_W / 2 + 1, BODY_H / 2 - 8, BODY_W - 2, 3, 1)
    .fill({ color: accentColor, alpha: 0.7 });

  // 6. Pull tab — small oval at the very top.
  const pullTab = new Graphics()
    .ellipse(0, -BODY_H / 2 - 2, 6, 2)
    .fill({ color: 0x8a8a8a, alpha: 1 })
    .stroke({ width: 1, color: 0x4a4a4a, alpha: 0.9 });

  // 7. Antenna — thin rod with a tiny tip ball.
  const antenna = new Graphics()
    .moveTo(0, -BODY_H / 2 - 4)
    .lineTo(0, -BODY_H / 2 - 14)
    .stroke({ width: 1.5, color: 0x4a4a4a, alpha: 1 })
    .circle(0, -BODY_H / 2 - 15, 1.5)
    .fill({ color: 0x6a6a6a, alpha: 1 });

  // 8. LED — small blue dot, the canonical "blinking LED".
  const led = new Graphics()
    .circle(0, -BODY_H / 2 + 14, 3)
    .fill({ color: 0x4fc3f7, alpha: 1 })
    .stroke({ width: 0.5, color: 0xffffff, alpha: 0.8 });

  // 9. Mouth slot — thin horizontal rectangle. Height is animated by tick.ts.
  // We set it as a known small rect; tick.ts mutates scale.y.
  const mouth = new Graphics()
    .rect(-7, 8, 14, 1)
    .fill({ color: 0x222222, alpha: 0.9 });
  mouth.pivot.set(0, 8); // animation grows from this anchor.

  // 10. Spark — tiny flicker under the can for "working" state. Hidden by default.
  const spark = new Graphics()
    .star(0, BODY_H / 2 + 4, 4, 3, 1)
    .fill({ color: 0xfff0a0, alpha: 1 });
  spark.visible = false;

  // 11. Thought bubble — small cloud + 3 dots; hidden by default.
  const thoughtBubble = new Container();
  thoughtBubble.label = 'thoughtBubble';
  thoughtBubble.visible = false;
  const bubble = new Graphics()
    .roundRect(BODY_W / 2 + 4, -BODY_H / 2 - 4, 28, 16, 8)
    .fill({ color: 0xffffff, alpha: 0.9 })
    .stroke({ width: 1, color: 0x333333, alpha: 0.6 });
  const dot = (x: number, y: number) =>
    new Graphics().circle(x, y, 2).fill({ color: 0x222222, alpha: 1 });
  const d1 = dot(BODY_W / 2 + 10, -BODY_H / 2 + 4);
  const d2 = dot(BODY_W / 2 + 18, -BODY_H / 2 + 4);
  const d3 = dot(BODY_W / 2 + 26, -BODY_H / 2 + 4);
  thoughtBubble.addChild(bubble, d1, d2, d3);

  // 12. Costume layer — empty container that applyCostume() populates.
  const costumeLayer = new Container();
  costumeLayer.label = 'costume';

  container.addChild(
    shadow,
    body,
    highlight,
    topBand,
    bottomBand,
    pullTab,
    antenna,
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
    highlight,
    topBand,
    bottomBand,
    pullTab,
    antenna,
    led,
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
