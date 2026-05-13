// Transient per-frame ref-store for Pixi sprites.
//
// PER CLAUDE.md convention #3: per-frame data does NOT flow through Zustand.
// The Pixi tick loop reads BeercanRefs directly from this Map; Zustand carries
// only discrete-state snapshots that drive UI-visible changes.
//
// The store is a plain Map (not a React hook) on purpose — the tick loop
// runs outside React's render cycle and must not subscribe to component state.

import type { BeercanRefs } from '@skippy/sprite-kit';

export const sceneRefStore = new Map<string, BeercanRefs>();
