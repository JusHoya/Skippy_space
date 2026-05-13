// Small debug overlay that cycles Skippy through idle → thinking → speaking → idle.
//
// PRD §14.1 exit criterion: "the user can ask Skippy a question and watch a
// beercan say 'thinking' → 'speaking' → 'idle'." Phase 0 has no real agent
// runtime yet, so this overlay drives the same FSM via setInterval until
// Agent-T wires up the actual event stream.
//
// Mount via SceneRoot. The overlay is invisible (no DOM ink) — it only
// nudges the Zustand agentStore, which the Pixi tick loop reads from.

import { useEffect } from 'react';
import { SKIPPY_ID, type AgentState } from '@skippy/shared';
import { useAgentStore } from '../stores/agentStore';

const CYCLE: AgentState[] = ['idle', 'thinking', 'speaking', 'idle'];
const STEP_MS = 1800;

export default function Phase0SkippyDemo() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!new URLSearchParams(window.location.search).has('demo')) return;

    let i = 0;
    const setAgent = useAgentStore.getState().setAgent;
    const advance = () => {
      const next = CYCLE[i % CYCLE.length] ?? 'idle';
      setAgent(SKIPPY_ID, { state: next, updatedAt: new Date().toISOString() });
      i += 1;
    };
    advance();
    const handle = window.setInterval(advance, STEP_MS);
    return () => window.clearInterval(handle);
  }, []);

  return null;
}
