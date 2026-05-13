// Tick loop helper. Called once per Pixi frame from SceneRoot.
//
// Reads each beercan's discrete agent state from Zustand (snapshot — no
// subscription) and forwards it into the per-frame FSM. Zustand stays a
// pull source; Pixi stays the push target.

import { tickBeercan, type AnimationState } from '@skippy/sprite-kit';
import type { AgentState } from '@skippy/shared';
import { useAgentStore } from '../stores/agentStore';
import { sceneRefStore } from './refStore';

function asAnimationState(state: AgentState | undefined): AnimationState {
  // AgentState and AnimationState are intentionally identical string unions,
  // but they live in separate packages — narrow defensively so a missing or
  // unknown value cleanly degrades to 'idle'.
  return (state ?? 'idle') as AnimationState;
}

export function tickAllBeercans(t: number, dt: number): void {
  const agents = useAgentStore.getState().agents;
  for (const [id, refs] of sceneRefStore) {
    const state = asAnimationState(agents[id]?.state);
    tickBeercan(refs, state, t, dt);
  }
}
