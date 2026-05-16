// modelStore.ts — Phase 3-prep (Zone 5).
//
// Per PRD §3.3, each Board Captain has a charter-driven default model and the
// user can override it from the dashboard. Skippy himself defaults to Opus 4.7
// (1M ctx). This store is the renderer's source of truth for those bindings;
// every action also pushes a `set_model` envelope down to the sidecar so the
// next LLM call uses the new model (PRD §13.5 / §15 R-01/R-09 — cost discipline
// only works if changes propagate immediately and the user sees them stick).
//
// Per CLAUDE.md, only state with UI-visible discrete changes belongs in
// Zustand — model bindings change rarely (user action) and are read by HUD
// panels, so this is the right layer. Per-frame data still lives in the
// scene's transient ref-store.

import { create } from 'zustand';
import {
  BOARDS,
  BOARD_META,
  type BoardId,
  type ModelId,
  type ModelScope,
} from '@skippy/shared';

import { dispatchSetModel } from '../lib/channel';

/** Initial board → model map seeded from each board's charter default. */
function defaultBoardModels(): Record<BoardId, ModelId> {
  const out = {} as Record<BoardId, ModelId>;
  for (const id of BOARDS) {
    out[id] = BOARD_META[id].defaultModel as ModelId;
  }
  return out;
}

/** Sonnet 4.6 is the safe middle-tier fallback for unknown agents (PRD §3.3). */
const FALLBACK_MODEL: ModelId = 'claude-sonnet-4-6';

export interface ModelStore {
  /** Model bound to Skippy. Defaults to Opus 4.7 — heaviest reasoning. */
  skippyModel: ModelId;
  /** Per-board overrides; seeded from BOARD_META[id].defaultModel at boot. */
  boardModels: Record<BoardId, ModelId>;
  setSkippyModel: (id: ModelId) => void;
  setBoardModel: (boardId: BoardId, id: ModelId) => void;
  /** Revert a board to its `BOARD_META[id].defaultModel`. */
  resetBoardToCharterDefault: (boardId: BoardId) => void;
  reset: () => void;
}

export const useModelStore = create<ModelStore>((set) => ({
  skippyModel: 'claude-opus-4-7',
  boardModels: defaultBoardModels(),
  setSkippyModel: (id) => {
    set({ skippyModel: id });
    // Fire-and-forget: the helper is safe outside Tauri (warns + returns).
    void dispatchSetModel('skippy', id);
  },
  setBoardModel: (boardId, id) => {
    set((s) => ({ boardModels: { ...s.boardModels, [boardId]: id } }));
    void dispatchSetModel(`board.${boardId}` as ModelScope, id);
  },
  resetBoardToCharterDefault: (boardId) => {
    const charterDefault = BOARD_META[boardId].defaultModel as ModelId;
    set((s) => ({ boardModels: { ...s.boardModels, [boardId]: charterDefault } }));
    void dispatchSetModel(`board.${boardId}` as ModelScope, charterDefault);
  },
  reset: () =>
    set({
      skippyModel: 'claude-opus-4-7',
      boardModels: defaultBoardModels(),
    }),
}));

/**
 * Resolve the active model for an arbitrary agent id.
 *
 * - `skippy`              → `skippyModel`
 * - `board.<id>`          → `boardModels[id]`
 * - `staff.*` / `task.*` / anything else → Sonnet 4.6 fallback.
 *
 * Task agents will route through their parent board in a later phase; for now
 * the store does not track parent linkage, so we conservatively fall back to
 * the mid-tier model. This avoids an inadvertent Opus burn on background work
 * if a caller asks "what model should this task agent use?" before parent
 * propagation is wired.
 */
export function useModelFor(agentId: string): ModelId {
  return useModelStore((s) => {
    if (agentId === 'skippy') return s.skippyModel;
    if (agentId.startsWith('board.')) {
      const boardId = agentId.slice(6) as BoardId;
      const bound = s.boardModels[boardId];
      if (bound) return bound;
    }
    return FALLBACK_MODEL;
  });
}
