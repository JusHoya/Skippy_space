import { create } from 'zustand';

/**
 * Tracks the user's most recent prompt and the streamed response.
 *
 * The CommandBar reads `current` to show a "thinking…" / "speaking…" status,
 * and SelectedPanel reads the streamed text to render Skippy's narration.
 */
export interface CurrentPrompt {
  promptId: string;
  text: string;
  streamed: string;
  complete: boolean;
  startedAt: number;
  /**
   * Set when the turn ended in failure (the orchestrator hit `error`). A failed
   * turn is also `complete: true` — the distinction lets the CommandBar show an
   * error status instead of a perpetual "thinking…/speaking…" (red-team
   * ui-state-pixi #12).
   */
  error?: string | null;
}

export interface PromptStore {
  current: CurrentPrompt | null;
  history: CurrentPrompt[];
  setPrompt: (promptId: string, text: string) => void;
  appendToken: (promptId: string, chunk: string) => void;
  completePrompt: (promptId: string) => void;
  /** Terminate the current prompt as failed (sets complete + error). */
  failPrompt: (promptId: string, message?: string) => void;
  clear: () => void;
}

const HISTORY_LIMIT = 50;

export const usePromptStore = create<PromptStore>((set) => ({
  current: null,
  history: [],
  setPrompt: (promptId, text) =>
    set(() => ({
      current: {
        promptId,
        text,
        streamed: '',
        complete: false,
        startedAt: Date.now(),
        error: null,
      },
    })),
  appendToken: (promptId, chunk) =>
    set((s) => {
      if (!s.current || s.current.promptId !== promptId) return s;
      return {
        ...s,
        current: { ...s.current, streamed: s.current.streamed + chunk },
      };
    }),
  completePrompt: (promptId) =>
    set((s) => {
      if (!s.current || s.current.promptId !== promptId) return s;
      const completed: CurrentPrompt = { ...s.current, complete: true };
      const history = [completed, ...s.history].slice(0, HISTORY_LIMIT);
      return { ...s, current: completed, history };
    }),
  failPrompt: (promptId, message) =>
    set((s) => {
      if (!s.current || s.current.promptId !== promptId) return s;
      const failed: CurrentPrompt = {
        ...s.current,
        complete: true,
        error: message ?? 'error',
      };
      const history = [failed, ...s.history].slice(0, HISTORY_LIMIT);
      return { ...s, current: failed, history };
    }),
  clear: () => set({ current: null }),
}));
