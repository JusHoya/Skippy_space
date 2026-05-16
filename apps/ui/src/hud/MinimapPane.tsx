/**
 * Minimap — PRD §7.2.
 *
 * SVG-based strategic overlay. Cheap to redraw (no Pixi context, no GPU
 * frame budget), and decoupled from the main scene's tick loop — we re-render
 * only when one of three pieces of state changes:
 *   1. The pedestal layout list (published by Zone 6 in SceneRoot via
 *      `setMinimapLayouts`).
 *   2. The fog region map (Zustand).
 *   3. The active overlay layer (Zustand).
 *
 * The map shows three "rings" of agents:
 *   • Skippy at the center (cyan dot, larger radius).
 *   • The 8 board captains on a clock-ring around him, using their canonical
 *     positions and accent colors.
 *   • Every pedestal in the world as a small dot at its scaled world position,
 *     tinted by the active layer (or its base hue if no layer is active) and
 *     dimmed by fog state.
 *
 * Phase 2 deliberately does NOT overlay the camera-viewport rectangle on the
 * minimap; that affordance is deferred to Phase 3+ (PRD §7.2 future work).
 */
import { useEffect, useMemo, useState } from 'react';
import {
  BOARD_META,
  MINIMAP_LAYER_KEYS,
  MINIMAP_LAYERS,
  type BoardId,
  type MinimapLayer,
  type PedestalLayout,
} from '@skippy/shared';
import { useFogStore } from '../stores/fogStore';
import { BOARD_CLOCK_POSITIONS, DEFAULT_RING_RADIUS } from '../scene/clockRing';
import { defaultRegionId, fogColorForLayer } from '../scene/FogOfWar';

// ── 1. Module-level pub/sub for pedestal layouts ────────────────────────────
//
// Zone 6 (SceneRoot integration) calls `setMinimapLayouts(layouts)` exactly
// once after building the pedestal field. Spinning up a whole Zustand store
// just for "the list of layouts" felt wasteful — it's an append-once, append-
// rarely value — so we publish through a tiny ref + Set of subscribers.

const pedestalLayoutsRef: { current: PedestalLayout[] } = { current: [] };
const subs = new Set<(l: PedestalLayout[]) => void>();

/** Renderer-side publisher. Zone 6 calls this from SceneRoot. */
export function setMinimapLayouts(layouts: PedestalLayout[]): void {
  pedestalLayoutsRef.current = layouts;
  // Snapshot the subscriber set before iterating so a subscriber that
  // unmounts itself synchronously can't shrink the live set mid-loop.
  const fns = [...subs];
  for (const f of fns) f(layouts);
}

/** React hook that mirrors the published layouts into local component state. */
export function usePedestalLayouts(): PedestalLayout[] {
  const [state, setState] = useState<PedestalLayout[]>(pedestalLayoutsRef.current);
  useEffect(() => {
    const fn = (l: PedestalLayout[]): void => setState(l);
    subs.add(fn);
    return () => {
      subs.delete(fn);
    };
  }, []);
  return state;
}

// ── 2. Geometry helpers ─────────────────────────────────────────────────────

/** The internal SVG viewBox size — CSS scales it to fit the parent panel. */
const VIEWBOX = 240;
/** Center of the viewBox in its own coordinates. */
const VB_CENTER = VIEWBOX / 2;

/**
 * Scale factor from world-local pixels (clock-ring radius 200 px) to viewBox
 * units. We allow pedestals to extend up to ~1.4× the clock-ring radius
 * outward so the minimap shows roughly two rings of detail without clipping.
 */
const WORLD_TO_MAP = (VB_CENTER - 12) / (DEFAULT_RING_RADIUS * 1.4);

function worldToMap(x: number, y: number): { mx: number; my: number } {
  return { mx: VB_CENTER + x * WORLD_TO_MAP, my: VB_CENTER + y * WORLD_TO_MAP };
}

/** Convert a "#RRGGBB" string into the `fill="…"` value used by SVG. */
function hexFill(hex: string): string {
  return hex.startsWith('#') ? hex : `#${hex}`;
}

/** Convert a 24-bit numeric color (0xRRGGBB) into a `#RRGGBB` SVG fill. */
function numFill(n: number): string {
  return `#${(n & 0xffffff).toString(16).padStart(6, '0')}`;
}

/** Opacity multiplier per fog state — matches the scene-side `FogOfWar.ts`. */
const FOG_OPACITY: Record<'unexplored' | 'shrouded' | 'bright', number> = {
  unexplored: 0,
  shrouded: 0.4,
  bright: 1,
};

// ── 3. Layer-toggle chip ────────────────────────────────────────────────────

interface LayerChipProps {
  layer: MinimapLayer;
  active: boolean;
  onClick: () => void;
}

/** A clickable F-key legend chip — the keyboard route is wired by Zone 6. */
function LayerChip({ layer, active, onClick }: LayerChipProps) {
  const fkey = MINIMAP_LAYER_KEYS[layer];
  return (
    <button
      type="button"
      onClick={onClick}
      // Inline styles so we don't touch index.css. The chip is small (~28px
      // wide) and only ever lives in the minimap legend, so the cost of not
      // promoting these to classes is negligible.
      style={{
        background: active ? 'var(--c-muted-cyan)' : 'transparent',
        color: active ? 'var(--c-dark-matter)' : 'var(--c-text-dim)',
        border: '1px solid var(--c-muted-cyan)',
        font: 'inherit',
        fontSize: '9px',
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        padding: '1px 5px',
        marginLeft: 3,
        borderRadius: 2,
        cursor: 'pointer',
      }}
      aria-pressed={active}
      title={`${fkey} · ${layer}`}
    >
      {fkey}
    </button>
  );
}

// ── 4. Main component ───────────────────────────────────────────────────────

export default function MinimapPane() {
  const layouts = usePedestalLayouts();
  const regions = useFogStore((s) => s.regions);
  const activeLayer = useFogStore((s) => s.activeLayer);
  const toggleLayer = useFogStore((s) => s.toggleLayer);

  // Memoize the projected pedestal dot list so we don't recompute on every
  // unrelated parent re-render. The Pedestal layout list is large (potentially
  // thousands of files) and dot color depends on the active layer.
  const dots = useMemo(() => {
    return layouts.map((layout) => {
      const { mx, my } = worldToMap(layout.x, layout.y);
      const regionId = defaultRegionId(layout);
      const region = regions[regionId];
      const fogState = region?.state ?? 'unexplored';
      const opacity = FOG_OPACITY[fogState];
      // Active overlay layer takes priority; without one, fall back to the
      // pedestal's pre-computed git-age hue so the minimap still reads as a
      // distribution of file ages.
      const fill = activeLayer
        ? numFill(fogColorForLayer(activeLayer, layout))
        : hexFill(layout.hueHex);
      return { id: regionId, mx, my, fill, opacity };
    });
  }, [layouts, regions, activeLayer]);

  const layerLabel = activeLayer ? activeLayer.toUpperCase() : '— ALL LAYERS OFF —';

  return (
    <div className="minimap">
      <div className="panel-header">
        <span>Minimap</span>
        <span style={{ color: 'var(--c-text-dim)' }}>F1·F2·F3·F4</span>
      </div>
      <div className="minimap-canvas">
        <svg
          viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
          width="100%"
          height="100%"
          // `preserveAspectRatio` defaults to xMidYMid meet — square viewBox
          // with non-square host means we letterbox; that's fine here because
          // .minimap-canvas already has equal margins.
          aria-hidden
          style={{ display: 'block' }}
        >
          {/* ── Background ring (faint guide for the clock) ──────────────── */}
          <circle
            cx={VB_CENTER}
            cy={VB_CENTER}
            r={DEFAULT_RING_RADIUS * WORLD_TO_MAP}
            fill="none"
            stroke="var(--c-muted-cyan)"
            strokeWidth="0.6"
            strokeOpacity="0.35"
          />

          {/* ── Pedestal dots (rendered behind captains so captains pop) ─── */}
          {dots.map((d) => (
            <circle
              key={d.id}
              cx={d.mx}
              cy={d.my}
              r={1.4}
              fill={d.fill}
              opacity={d.opacity}
            />
          ))}

          {/* ── Board captain dots, in canonical clock order ────────────── */}
          {(Object.keys(BOARD_META) as BoardId[]).map((boardId) => {
            const slot = BOARD_CLOCK_POSITIONS[boardId];
            const { mx, my } = worldToMap(slot.x, slot.y);
            return (
              <circle
                key={boardId}
                cx={mx}
                cy={my}
                r={3.5}
                fill={hexFill(BOARD_META[boardId].accentHex)}
                stroke="var(--c-dark-matter)"
                strokeWidth="0.6"
              />
            );
          })}

          {/* ── Skippy, larger and dead center ───────────────────────────── */}
          <circle
            cx={VB_CENTER}
            cy={VB_CENTER}
            r={5}
            fill="var(--c-neon-cyan, #66FCF1)"
            stroke="var(--c-dark-matter)"
            strokeWidth="0.8"
          />
        </svg>
      </div>
      <div className="minimap-legend">
        <span>{layerLabel}</span>
        <span style={{ display: 'inline-flex', alignItems: 'center' }}>
          {MINIMAP_LAYERS.map((layer) => (
            <LayerChip
              key={layer}
              layer={layer}
              active={activeLayer === layer}
              onClick={() => toggleLayer(layer)}
            />
          ))}
        </span>
      </div>
    </div>
  );
}
