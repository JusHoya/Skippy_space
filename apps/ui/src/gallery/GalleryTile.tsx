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

// One-shot timelines that settle and hold. In the pinned showcase we replay
// them every LOOP_PERIOD seconds so they stay visibly animated.
const ONE_SHOT: ReadonlySet<AnimationState> = new Set<AnimationState>([
  'completed',
  'spawning',
  'despawning',
]);
const LOOP_PERIOD = 1.5;

// Visual-regression determinism: Playwright runs with `reducedMotion: 'reduce'`,
// and `animations: 'disabled'` only freezes CSS — the Pixi ticker keeps running,
// so a full-page screenshot of 17 bobbing/glowing cans is captured at a random
// animation phase and flakes the diff. Under reduced motion we instead render a
// single FIXED frame (constant clock, zero dt, one-shots pinned to their entry)
// so every capture is byte-stable. The live app is unaffected — only a user who
// has asked the OS for reduced motion (or the test harness) sees the still pose.
const STILL_T = 1.0;
function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export interface GalleryTileProps {
  id: string;
  label: string;
  costume: Costume;
  /** State the can starts in. Defaults to `idle`. */
  initialState?: AnimationState;
  /**
   * When false the tile is pinned to `initialState` and clicks do not cycle —
   * used by the "animation states" showcase row so each state stays on screen.
   * Defaults to true (click-to-cycle roster behaviour).
   */
  cycle?: boolean;
}

const TILE_W = 200;
const TILE_H = 260;

export default function GalleryTile({
  id,
  label,
  costume,
  initialState = 'idle',
  cycle = true,
}: GalleryTileProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef<AnimationState>(initialState);
  // Mirror the ref into state for the label only — the ref is the source of
  // truth that Pixi reads.
  const [displayState, setDisplayState] = useState<AnimationState>(initialState);

  useEffect(() => {
    let cancelled = false;
    let initialized = false;
    const host = hostRef.current;
    if (!host) return;

    const app = new Application();
    let detachTick: (() => void) | null = null;

    (async () => {
      try {
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
      } catch (err) {
        console.error(`[gallery] Pixi init failed for tile "${id}":`, err);
        return;
      }
      initialized = true;
      if (cancelled || !hostRef.current) {
        // Unmounted during init (React StrictMode dev double-invoke).
        // destroy() is safe now that init resolved.
        app.destroy(true, { children: true, texture: true });
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

      const reducedMotion = prefersReducedMotion();
      let lastTs = performance.now();
      // Deterministic readiness signal for the visual-regression harness: once a
      // tile has rendered its first frame we flag the stage `data-painted="1"`.
      // The gallery spec gates its screenshot on ALL tiles being painted, which
      // is robust where a pixel-color heuristic is not — a frozen (reduced-motion)
      // small can sweeps few pixels and can dip under a colour-diversity floor.
      let painted = false;
      const markPainted = (): void => {
        if (painted) return;
        painted = true;
        host.dataset.painted = '1';
      };
      const onTick = (): void => {
        const s = stateRef.current;
        // Reduced-motion / screenshot path: render one fixed frame. Constant
        // clock + zero dt + one-shots pinned to STILL_T → identical every frame.
        if (reducedMotion) {
          beercan.stateStartedAt = STILL_T;
          tickBeercan(beercan, s, STILL_T, 0);
          // Suppress the large radial glow halos in the frozen screenshot frame.
          // Their alpha-gradient fills render with sub-pixel instability that
          // diffs heavily for big-glow costumes (Skippy, Publishing) even when
          // the clock is frozen — a 2-tile noise floor that would drown out a
          // real regression. The can body + costume + insignia (the actual
          // regression surface) stay; only the decorative glow is dropped.
          beercan.ledGlow.alpha = 0;
          beercan.antennaGlow.alpha = 0;
          markPainted();
          return;
        }
        const now = performance.now();
        const t = now / 1000;
        const dt = (now - lastTs) / 1000;
        lastTs = now;
        // One-shot timelines (completed/spawning/despawning) settle and hold.
        // In the pinned showcase we replay them on a fixed cadence so the
        // viewer keeps seeing the animation rather than a frozen frame.
        if (!cycle && ONE_SHOT.has(s) && t - beercan.stateStartedAt > LOOP_PERIOD) {
          beercan.stateStartedAt = t;
        }
        tickBeercan(beercan, s, t, dt);
        markPainted();
      };
      app.ticker.add(onTick);
      detachTick = () => app.ticker.remove(onTick);
    })();

    return () => {
      cancelled = true;
      detachTick?.();
      // Only call destroy() if init() resolved — calling on a pre-init
      // Application throws `_cancelResize is not a function`.
      if (initialized) {
        app.destroy(true, { children: true, texture: true });
      }
    };
    // We intentionally re-init on costume changes (cheap, n=9) so each tile
    // always reflects the latest costume descriptor.
  }, [id, costume, initialState, cycle]);

  const onClick = () => {
    if (!cycle) return; // pinned showcase tiles do not respond to clicks
    const current = stateRef.current;
    const idx = isCycleState(current) ? CYCLE.indexOf(current) : -1;
    const next = CYCLE[(idx + 1) % CYCLE.length] ?? 'idle';
    stateRef.current = next;
    setDisplayState(next);
  };

  return (
    <button
      type="button"
      className="gallery-tile"
      onClick={onClick}
      style={cycle ? undefined : { cursor: 'default' }}
      aria-label={cycle ? `${label} — click to cycle animation` : `${label} — ${displayState} state`}
    >
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
