import { create } from 'zustand';
import type {
  AgentId,
  FogRegion,
  FogState,
  MinimapLayer,
} from '@skippy/shared';

/**
 * Fog-of-war + minimap-layer toggle store — PRD §7.3 (fog) and §7.2 (F1–F4).
 *
 * Per CLAUDE.md convention #3, this carries only UI-visible discrete state:
 * region fog states transition on agent activity (touch a file → shrouded;
 * tooling reads it → bright) and the minimap layer is a single F-key toggle.
 * Per-frame work — animating a pedestal's alpha down to its target — happens
 * in the Pixi tick path, NOT here.
 *
 * Regions are keyed by canonical region id (`pedestal.<relpath>` for files,
 * `biome.<top-dir>` for biomes). Treating a whole biome as one black region
 * keeps the store small until an agent actually crawls inside it.
 */
export interface FogStore {
  /** All known regions. Missing entries are treated as `'unexplored'`. */
  regions: Record<string, FogRegion>;
  /** Currently-active minimap overlay layer, or null if all toggles are off. */
  activeLayer: MinimapLayer | null;
  /**
   * Upsert a region. If the region is new, its state defaults to
   * `'unexplored'` so the caller can patch other fields (e.g. pendingChanges)
   * without accidentally revealing it.
   */
  setRegion: (regionId: string, patch: Partial<FogRegion> & { state?: FogState }) => void;
  /**
   * Mark a region as "agent saw this." Transitions unexplored→shrouded but
   * leaves a region that's already `'bright'` alone — once illuminated by a
   * tooling read, a passive sighting shouldn't dim it back down.
   */
  markSeen: (regionId: string, by: AgentId, ts: string) => void;
  /** Force a region to `'bright'` — used when a tool actually opened the file. */
  markBright: (regionId: string, ts: string) => void;
  /** Bump the pending-changes counter (positive or negative). */
  incrementPending: (regionId: string, delta: number) => void;
  /** F1–F4 toggle: same layer twice clears, different layer swaps. */
  toggleLayer: (layer: MinimapLayer) => void;
  /** Direct setter for layer (e.g. command-palette dispatch). */
  setLayer: (layer: MinimapLayer | null) => void;
  /** Drop all regions + clear the layer — used on project switch. */
  clearAll: () => void;
}

export const useFogStore = create<FogStore>((set) => ({
  regions: {},
  activeLayer: null,
  setRegion: (regionId, patch) =>
    set((s) => {
      const existing = s.regions[regionId];
      // New region: start with the smallest legal FogRegion and let the patch
      // override anything else the caller wants to set (state, pending, etc).
      const base: FogRegion = existing ?? { regionId, state: 'unexplored' };
      return {
        regions: {
          ...s.regions,
          [regionId]: { ...base, ...patch, regionId },
        },
      };
    }),
  markSeen: (regionId, by, ts) =>
    set((s) => {
      const existing = s.regions[regionId];
      // Don't downgrade a `'bright'` region — that would lose information.
      if (existing && existing.state === 'bright') {
        return {
          regions: {
            ...s.regions,
            [regionId]: { ...existing, lastSeenBy: by, lastSeenAt: ts },
          },
        };
      }
      const base: FogRegion = existing ?? { regionId, state: 'shrouded' };
      return {
        regions: {
          ...s.regions,
          [regionId]: { ...base, state: 'shrouded', lastSeenBy: by, lastSeenAt: ts },
        },
      };
    }),
  markBright: (regionId, ts) =>
    set((s) => {
      const existing = s.regions[regionId];
      const base: FogRegion = existing ?? { regionId, state: 'bright' };
      return {
        regions: {
          ...s.regions,
          [regionId]: { ...base, state: 'bright', lastSeenAt: ts },
        },
      };
    }),
  incrementPending: (regionId, delta) =>
    set((s) => {
      const existing = s.regions[regionId];
      const base: FogRegion = existing ?? { regionId, state: 'unexplored' };
      const next = Math.max(0, (base.pendingChanges ?? 0) + delta);
      return {
        regions: {
          ...s.regions,
          [regionId]: { ...base, pendingChanges: next },
        },
      };
    }),
  toggleLayer: (layer) =>
    set((s) => ({ activeLayer: s.activeLayer === layer ? null : layer })),
  setLayer: (layer) => set({ activeLayer: layer }),
  clearAll: () => set({ regions: {}, activeLayer: null }),
}));
