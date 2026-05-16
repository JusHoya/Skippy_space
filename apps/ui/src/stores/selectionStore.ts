import { create } from 'zustand';
import type { AgentId, ControlGroup, ControlGroupKey, DragBox } from '@skippy/shared';
import { useUiStore } from './uiStore';

/** Drag threshold in renderer pixels — below this, the drag-box stays inert. */
const DRAG_ACTIVATE_PX = 5;

/**
 * Multi-selection, control groups, drag-box state, and idle-cycle cursor —
 * the RTS-UX layer that extends the single-selection model in `uiStore`.
 *
 * Per CLAUDE.md, this is discrete UI-visible state (PRD §7.2 selection).
 * The drag-box itself is just data; SceneRoot draws the rubber-band rect.
 *
 * Sync rule: when `multiSelected` shrinks/grows we push the primary id into
 * `uiStore.selectedAgentId` so the existing SelectedPanel keeps working. This
 * is a one-way push — uiStore does not subscribe back.
 */
export interface SelectionStore {
  multiSelected: AgentId[];
  controlGroups: Record<ControlGroupKey, ControlGroup | undefined>;
  dragBox: DragBox | null;
  idleCycleIndex: number;

  setMulti: (ids: AgentId[]) => void;
  addToMulti: (id: AgentId) => void;
  clearMulti: () => void;
  cycleTabForward: () => void;

  bindControlGroup: (key: ControlGroupKey, members: AgentId[]) => void;
  recallControlGroup: (key: ControlGroupKey) => AgentId[] | null;
  addToControlGroup: (key: ControlGroupKey, members: AgentId[]) => void;

  startDragBox: (x: number, y: number) => void;
  updateDragBox: (x: number, y: number) => void;
  endDragBox: () => DragBox | null;

  advanceIdleCursor: () => number;
}

const EMPTY_CONTROL_GROUPS: Record<ControlGroupKey, ControlGroup | undefined> = {
  1: undefined,
  2: undefined,
  3: undefined,
  4: undefined,
  5: undefined,
  6: undefined,
  7: undefined,
  8: undefined,
  9: undefined,
};

export const useSelectionStore = create<SelectionStore>((set, get) => ({
  multiSelected: [],
  controlGroups: { ...EMPTY_CONTROL_GROUPS },
  dragBox: null,
  idleCycleIndex: -1,

  setMulti: (ids) => {
    set({ multiSelected: ids });
    // Mirror primary into uiStore so SelectedPanel renders the right agent.
    if (ids.length >= 1) {
      const primary = ids[0];
      if (primary) useUiStore.getState().setSelected(primary);
    } else {
      useUiStore.getState().clearSelected();
    }
  },

  addToMulti: (id) => {
    const existing = get().multiSelected;
    if (existing.includes(id)) return;
    const next = [...existing, id];
    set({ multiSelected: next });
    // Primary stays the same when extending; only push uiStore on first add.
    if (existing.length === 0) {
      useUiStore.getState().setSelected(id);
    }
  },

  clearMulti: () => {
    set({ multiSelected: [] });
    useUiStore.getState().clearSelected();
  },

  cycleTabForward: () => {
    const ids = get().multiSelected;
    if (ids.length <= 1) return;
    // Rotate by one: [a,b,c] → [b,c,a]; primary becomes the next member.
    const [first, ...rest] = ids;
    if (!first) return;
    const next = [...rest, first];
    set({ multiSelected: next });
    const primary = next[0];
    if (primary) useUiStore.getState().setSelected(primary);
  },

  bindControlGroup: (key, members) => {
    if (members.length === 0) return;
    const group: ControlGroup = {
      key,
      // Dedupe but preserve insertion order.
      members: Array.from(new Set(members)),
      boundAt: new Date().toISOString(),
    };
    set((s) => ({
      controlGroups: { ...s.controlGroups, [key]: group },
    }));
  },

  recallControlGroup: (key) => {
    const group = get().controlGroups[key];
    if (!group || group.members.length === 0) return null;
    return [...group.members];
  },

  addToControlGroup: (key, members) => {
    if (members.length === 0) return;
    const now = new Date().toISOString();
    set((s) => {
      const existing = s.controlGroups[key];
      const merged = existing
        ? Array.from(new Set([...existing.members, ...members]))
        : Array.from(new Set(members));
      const group: ControlGroup = { key, members: merged, boundAt: now };
      return { controlGroups: { ...s.controlGroups, [key]: group } };
    });
  },

  startDragBox: (x, y) => {
    set({ dragBox: { startX: x, startY: y, endX: x, endY: y, active: false } });
  },

  updateDragBox: (x, y) => {
    const box = get().dragBox;
    if (!box) return;
    const dx = x - box.startX;
    const dy = y - box.startY;
    const active = box.active || Math.hypot(dx, dy) > DRAG_ACTIVATE_PX;
    set({ dragBox: { ...box, endX: x, endY: y, active } });
  },

  endDragBox: () => {
    const box = get().dragBox;
    set({ dragBox: null });
    if (!box || !box.active) return null;
    return box;
  },

  advanceIdleCursor: () => {
    const next = get().idleCycleIndex + 1;
    set({ idleCycleIndex: next });
    return next;
  },
}));
