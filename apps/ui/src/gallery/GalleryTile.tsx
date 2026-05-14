// One Pixi tile in the sprite gallery. Mounts its own Application so each
// costume gets a clean canvas with no z-order interference.
//
// Per CLAUDE.md convention #3: the animation state for each tile lives in a
// local React ref + Pixi tick — NOT in Zustand. Clicking the tile mutates
// the ref; the Pixi ticker reads the ref every frame and feeds it to
// `tickBeercan`.

import { useEffect, useRef, useState } from 'react';
import { Application, Container } from 'pixi.js';
import {
  ANIMATION_STATES,
  applyCostume,
  createBeercan,
  tickBeercan,
  type AnimationState,
  type Costume,
} from '@skippy/sprite-kit';

// The states we cycle through on click — matches the spec's golden-path tour.
// We deliberately skip `spawning` / `despawning` since they're one-shot fades
// that read identically to idle once finished.
const CYCLE: AnimationState[] = [
  'idle',
  'thinking',
  'speaking',
  'working',
  'completed',
  'error',
];

function isCycleState(s: AnimationState): boolean {
  return (CYCLE as readonly AnimationState[]).includes(s);
}

export interface GalleryTileProps {
  id: string;
  label: string;
  costume: Costume;
}

const TILE_W = 200;
const TILE_H = 260;

export default function GalleryTile({ id, label, costume }: GalleryTileProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef<AnimationState>('idle');
  // Mirror the ref into state for the label only — the ref is the source of
  // truth that Pixi reads.
  const [displayState, setDisplayState] = useState<AnimationState>('idle');

  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (!host) return;

    const app = new Application();
    let detachTick: (() => void) | null = null;

    (async () => {
      await app.init({
        backgroundAlpha: 0,
        antialias: true,
        width: TILE_W,
        height: TILE_H,
        preference: 'webgl',
        powerPreference: 'low-power',
        resolution: typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
        autoDensity: true,
      });
      if (cancelled || !hostRef.current) {
        app.destroy(true);
        return;
      }
      host.appendChild(app.canvas);

      const world = new Container();
      world.label = `gallery-world:${id}`;
      app.stage.addChild(world);

      const beercan = createBeercan({ accentColor: costume.accentColor, baseY: 0 });
      applyCostume(beercan, costume);
      world.addChild(beercan.container);

      // Center the world in the tile.
      world.x = TILE_W / 2;
      world.y = TILE_H / 2 + 12; // nudge down so hats don't clip the top

      let lastTs = performance.now();
      const onTick = (): void => {
        const now = performance.now();
        const t = now / 1000;
        const dt = (now - lastTs) / 1000;
        lastTs = now;
        tickBeercan(beercan, stateRef.current, t, dt);
      };
      app.ticker.add(onTick);
      detachTick = () => app.ticker.remove(onTick);
    })().catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[gallery] Pixi init failed for tile "${id}":`, err);
    });

    return () => {
      cancelled = true;
      detachTick?.();
      app.destroy(true, { children: true, texture: true });
    };
    // We intentionally re-init on costume changes (cheap, n=9) so each tile
    // always reflects the latest costume descriptor.
  }, [id, costume]);

  const onClick = () => {
    const current = stateRef.current;
    const idx = isCycleState(current) ? CYCLE.indexOf(current) : -1;
    const next = CYCLE[(idx + 1) % CYCLE.length] ?? 'idle';
    stateRef.current = next;
    setDisplayState(next);
  };

  return (
    <button type="button" className="gallery-tile" onClick={onClick} aria-label={`${label} — click to cycle animation`}>
      <div className="gallery-tile-stage" ref={hostRef} style={{ width: TILE_W, height: TILE_H }} />
      <div className="gallery-tile-meta">
        <div className="gallery-tile-label">{label}</div>
        <div className="gallery-tile-state">{displayState}</div>
      </div>
    </button>
  );
}

/**
 * Re-exported list of cycle states — handy for tests / docs. Stays in the
 * canonical FSM order (matches PRD §12.4 minus the one-shot fades).
 */
export const GALLERY_CYCLE: readonly AnimationState[] = CYCLE;

// Compile-time assertion that every cycle state is a valid AnimationState.
// (Catches an upstream rename of ANIMATION_STATES without a CYCLE update.)
const _checkCycleIsSubset: ReadonlyArray<(typeof ANIMATION_STATES)[number]> = CYCLE;
void _checkCycleIsSubset;
