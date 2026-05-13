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
}

export interface PromptStore {
  current: CurrentPrompt | null;
  history: CurrentPrompt[];
  setPrompt: (promptId: string, text: string) => void;
  appendToken: (promptId: string, chunk: string) => void;
  completePrompt: (promptId: string) => void;
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
  clear: () => set({ current: null }),
}));
