// Task-agent walker costume + helper. PRD §7.2 + §12.4.
//
// A walker is a short-lived task agent rendered as a smaller beercan that
// marches from its captain's hex pad to a target file pedestal, plays the
// `working` FSM at the pedestal, then despawns. CLAUDE.md convention #7
// (no grandchildren agents) keeps task agents as leaf nodes — they never
// spawn further beercans, so this helper has no children-of-its-own logic.
//
// The costume here is intentionally minimal: a worker's beanie + flannel,
// tinted with the parent board's accent color. Insignia and accessory are
// omitted so the walker reads as "rank-and-file labor" rather than a captain
// in miniature. PRD §12.3 leaves task-agent skins ad-hoc; this is the v0
// procedural choice.

import { createBeercan, type BeercanRefs } from './beercan';
import { applyCostume, type Costume } from './costume';

/** Scale of a walker relative to a captain (which is itself 0.78 of Skippy). */
const WALKER_SCALE = 0.55;

export interface CreateTaskAgentBeercanOpts {
  /** Parent board's accent color — drives band tint and costume accent. */
  accentColor: number;
  /** World-local ground line for the inner Pixi tick FSM bob math. */
  baseY: number;
}

/**
 * Build a walker beercan with the canonical task-agent worker costume. The
 * caller is responsible for positioning the returned `container` in the world
 * and adding it to its stage.
 */
export function createTaskAgentBeercan(opts: CreateTaskAgentBeercanOpts): BeercanRefs {
  const refs = createBeercan({
    accentColor: opts.accentColor,
    baseY: opts.baseY,
    scale: WALKER_SCALE,
  });

  // Minimal worker costume — only the slots with sensible leaves are filled.
  // `accessory` and `insignia` are omitted so the can reads as a generic
  // task agent rather than a board captain. Hat + body must be leaves that
  // exist in HatId / BodyId today; `beanie` and `flannel` are DevOps' leaves
  // re-used here for the worker look.
  const costume: Costume = {
    hat: 'beanie',
    body: 'flannel',
    accentColor: opts.accentColor,
  };
  applyCostume(refs, costume);

  return refs;
}
