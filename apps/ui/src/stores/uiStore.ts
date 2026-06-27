import { create } from 'zustand';
import type { AgentId } from '@skippy/shared';

export type PanelTab = 'selected' | 'telemetry';

/**
 * localStorage key for the first-run onboarding flag (PRD §14.5). Versioned so
 * a future onboarding rewrite can re-introduce itself to returning monkeys by
 * bumping the suffix without clobbering the old key's meaning.
 */
export const ONBOARDING_SEEN_KEY = 'skippy.onboarding.seen.v1';

/**
 * Read the persisted "has seen the intro" flag. Guarded for non-browser
 * environments (tests / SSR) where `localStorage` is absent or throws (private
 * mode) — a missing/erroring store means "treat as first run is dormant" so we
 * never wedge the boot path off a storage quirk; the overlay just won't auto-pop.
 */
function readOnboardingSeen(): boolean {
  try {
    if (typeof localStorage === 'undefined') return true;
    return localStorage.getItem(ONBOARDING_SEEN_KEY) === '1';
  } catch {
    return true;
  }
}

/** Persist the first-run flag; swallow storage failures (see above). */
function writeOnboardingSeen(): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(ONBOARDING_SEEN_KEY, '1');
  } catch {
    /* private-mode / quota — non-fatal, the flag just won't persist. */
  }
}

/**
 * UI-only state: which agent the user has selected, whether the world is
 * actively paused (PRD §7.2 active-pause), which side-panel tab is open, and
 * the two discrete overlay surfaces added in Phase 4 — the first-run
 * onboarding intro and the F1 in-app docs panel (PRD §14.5).
 *
 * Selection is intentionally a discrete event store, not a hot reactive
 * subscription — Pixi's selection ring is drawn from the scene's ref-store
 * which mirrors this on change. The Phase 4 overlays are likewise discrete
 * UI state (open/closed), so Zustand is the correct home for them
 * (CLAUDE.md convention #3 — per-frame data stays out, discrete UI lives here).
 */
export interface UiStore {
  selectedAgentId: AgentId | null;
  paused: boolean;
  panelTab: PanelTab;
  /** Whether the F1 in-app docs overlay is open (PRD §14.5). */
  docsOpen: boolean;
  /**
   * Whether the first-run Skippy intro overlay is showing. Initialised from the
   * persisted seen-flag: dormant for returning monkeys, popped on first launch.
   */
  onboardingOpen: boolean;
  setSelectedAgent: (id: AgentId | null) => void;
  /** Alias for setSelectedAgent; matches the call shape used by SceneRoot. */
  setSelected: (id: AgentId) => void;
  /** Clear the current selection. */
  clearSelected: () => void;
  togglePaused: () => void;
  setPaused: (v: boolean) => void;
  setPanelTab: (tab: PanelTab) => void;
  /** Open / close / toggle the F1 docs overlay. */
  openDocs: () => void;
  closeDocs: () => void;
  toggleDocs: () => void;
  /** Re-open the onboarding intro (e.g. from a TopBar button). */
  openOnboarding: () => void;
  /** Dismiss onboarding AND persist the seen-flag so it stays dormant. */
  closeOnboarding: () => void;
}

export const useUiStore = create<UiStore>((set) => ({
  selectedAgentId: 'skippy',
  paused: false,
  panelTab: 'selected',
  docsOpen: false,
  // First-run: show the intro only when the persisted flag isn't set yet.
  onboardingOpen: !readOnboardingSeen(),
  setSelectedAgent: (id) => set({ selectedAgentId: id }),
  setSelected: (id) => set({ selectedAgentId: id }),
  clearSelected: () => set({ selectedAgentId: null }),
  togglePaused: () => set((s) => ({ paused: !s.paused })),
  setPaused: (v) => set({ paused: v }),
  setPanelTab: (tab) => set({ panelTab: tab }),
  openDocs: () => set({ docsOpen: true }),
  closeDocs: () => set({ docsOpen: false }),
  toggleDocs: () => set((s) => ({ docsOpen: !s.docsOpen })),
  openOnboarding: () => set({ onboardingOpen: true }),
  closeOnboarding: () => {
    writeOnboardingSeen();
    set({ onboardingOpen: false });
  },
}));

/** Reactive selector hook — components re-render when selection changes. */
export const useSelectedAgentId = (): AgentId | null =>
  useUiStore((s) => s.selectedAgentId);
