import { create } from 'zustand';
import type { AgentId } from '@skippy/shared';

export type PanelTab = 'selected' | 'telemetry';

/**
 * UI-only state: which agent the user has selected, whether the world is
 * actively paused (PRD §7.2 active-pause), and which side-panel tab is open.
 *
 * Selection is intentionally a discrete event store, not a hot reactive
 * subscription — Pixi's selection ring is drawn from the scene's ref-store
 * which mirrors this on change.
 */
export interface UiStore {
  selectedAgentId: AgentId | null;
  paused: boolean;
  panelTab: PanelTab;
  setSelectedAgent: (id: AgentId | null) => void;
  /** Alias for setSelectedAgent; matches the call shape used by SceneRoot. */
  setSelected: (id: AgentId) => void;
  /** Clear the current selection. */
  clearSelected: () => void;
  togglePaused: () => void;
  setPaused: (v: boolean) => void;
  setPanelTab: (tab: PanelTab) => void;
}

export const useUiStore = create<UiStore>((set) => ({
  selectedAgentId: 'skippy',
  paused: false,
  panelTab: 'selected',
  setSelectedAgent: (id) => set({ selectedAgentId: id }),
  setSelected: (id) => set({ selectedAgentId: id }),
  clearSelected: () => set({ selectedAgentId: null }),
  togglePaused: () => set((s) => ({ paused: !s.paused })),
  setPaused: (v) => set({ paused: v }),
  setPanelTab: (tab) => set({ panelTab: tab }),
}));

/** Reactive selector hook — components re-render when selection changes. */
export const useSelectedAgentId = (): AgentId | null =>
  useUiStore((s) => s.selectedAgentId);
