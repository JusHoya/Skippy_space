// Fog-of-war scene helpers — PRD §7.3.
//
// Pure module: no imports from stores, no subscriptions. Zone 6 in SceneRoot
// is responsible for `useFogStore.subscribe(...)` and calling
// `applyFogToPedestals` whenever the regions snapshot changes. Keeping this
// file side-effect-free means Pixi can drive the dim without burning React
// renders, and it stays unit-testable without a JSDOM/Pixi shim.
//
// Pedestal containers are produced by Zone 1; each one is labeled with the
// canonical region id (`pedestal.<relpath>`) so we can look them up here by
// `.label` without needing Zone 1 to expose its internal map.

import type { Container } from 'pixi.js';
import { hexToNum } from '@skippy/sprite-kit';
import type {
  FogRegion,
  FogState,
  MinimapLayer,
  PedestalLayout,
} from '@skippy/shared';

/** Per-state visual descriptor — Pixi reads `alpha` + `tint` directly. */
interface FogStyle {
  alpha: number;
  tint: number;
}

/**
 * Style table for the three fog states. `unexplored` is invisible — Zone 1
 * still mounts the pedestal Container, but we draw nothing on top.
 *
 * The shrouded tint is a flat slate gray; combined with alpha 0.45 it reads
 * as a desaturated silhouette next to a fully-lit `bright` neighbor.
 */
const FOG_STYLES: Record<FogState, FogStyle> = {
  unexplored: { alpha: 0, tint: 0xffffff },
  shrouded: { alpha: 0.45, tint: 0x6a6a6a },
  bright: { alpha: 1, tint: 0xffffff },
};

/** Default style applied when a pedestal has no region entry yet. */
const FOG_DEFAULT: FogStyle = FOG_STYLES.unexplored;

/**
 * Walk the pedestal container's direct children and apply the fog style for
 * each one's region. Missing region entries → `unexplored` (alpha 0). This is
 * O(n) over the pedestal count and does not allocate — safe to call inside a
 * Zustand subscription on every regions delta.
 */
export function applyFogToPedestals(
  pedestals: Container,
  regions: Record<string, FogRegion>,
): void {
  // pedestals.children is a strongly-typed Container array in Pixi v8; we
  // mutate alpha/tint in place rather than rebuilding any Graphics.
  for (const child of pedestals.children) {
    // Zone 1's contract: each pedestal container is labeled with its region id.
    const label = child.label;
    if (typeof label !== 'string' || !label.startsWith('pedestal.')) continue;
    const region = regions[label];
    const style = region ? FOG_STYLES[region.state] : FOG_DEFAULT;
    child.alpha = style.alpha;
    // Pixi v8 promoted `tint` onto Container itself (typed as ColorSource);
    // assigning a numeric color directly is the documented happy path.
    child.tint = style.tint;
  }
}

// ── Minimap overlay coloring ───────────────────────────────────────────────

/**
 * Smoothstep-style linear interpolation between two 24-bit colors. Used by
 * the size layer to fade from starlight gray (0xC5C6C7) → neon cyan
 * (0x66FCF1) as file size grows.
 */
function lerpHex(from: number, to: number, t: number): number {
  const f = Math.max(0, Math.min(1, t));
  const fr = (from >> 16) & 0xff;
  const fg = (from >> 8) & 0xff;
  const fb = from & 0xff;
  const tr = (to >> 16) & 0xff;
  const tg = (to >> 8) & 0xff;
  const tb = to & 0xff;
  const r = Math.round(fr + (tr - fr) * f);
  const g = Math.round(fg + (tg - fg) * f);
  const b = Math.round(fb + (tb - fb) * f);
  return (r << 16) | (g << 8) | b;
}

/** Bytes at which the size layer reaches max intensity (cyan). */
const SIZE_LAYER_MAX_BYTES = 50_000;

/**
 * Color a pedestal dot for the minimap overlay based on the active layer.
 *
 * Layers per PRD §7.2:
 *   F1 size           — gray→cyan ramp keyed off sizeBytes
 *   F2 gitAge         — uses the pedestal's pre-computed hueHex (green→red ramp)
 *   F3 testCoverage   — placeholder gray; real data lands in Phase 3
 *   F4 errorDensity   — placeholder dim purple; real data lands in Phase 3
 */
export function fogColorForLayer(layer: MinimapLayer, layout: PedestalLayout): number {
  switch (layer) {
    case 'size': {
      const t = Math.max(0, Math.min(1, layout.sizeBytes / SIZE_LAYER_MAX_BYTES));
      return lerpHex(0xc5c6c7, 0x66fcf1, t);
    }
    case 'gitAge': {
      // Zone 1 already computed the green→amber→red ramp into `hueHex`;
      // re-using it keeps the minimap and pedestal coloring consistent.
      return hexToNum(layout.hueHex);
    }
    case 'testCoverage':
      return 0x7b8a93;
    case 'errorDensity':
      return 0x4a1e6e;
  }
}

/**
 * Canonical region id for a pedestal layout — single source of truth.
 *
 * Zone 1's `projectTree.computeLayouts()` already produces `id` in the form
 * `pedestal.<relative/posix/path>`, and FilePedestals labels each pedestal
 * Container with that exact value. So this function is just a named accessor
 * — the spec writeup said `pedestal.${layout.id}` but with the prefix
 * already on `layout.id` that would double up to `pedestal.pedestal.<path>`
 * and the lookup in `applyFogToPedestals` (which keys off the label) would
 * miss every entry.
 */
export function defaultRegionId(layout: PedestalLayout): string {
  return layout.id;
}
