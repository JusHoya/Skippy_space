// Public surface for @skippy/sprite-kit.
//
// Consumers should import everything from the package root; relative deep
// imports are not supported and will break when the atlas pipeline lands.

import type { Costume } from './costume';
import { BOARD_COSTUMES, BOARD_IDS, BOARD_LABELS, type BoardId } from './boards';
import { SKIPPY_COSTUME, SKIPPY_LABEL } from './skippy';

export { PALETTE, PALETTE_NUM, hexToNum, numToHex, lighten, darken } from './palette';
export type { PaletteToken } from './palette';

export type { AnimationState } from './states';
export { ANIMATION_STATES, isAnimationState } from './states';

export type { BeercanRefs, CreateBeercanOpts } from './beercan';
export { createBeercan } from './beercan';

export type {
  Costume,
  HatId,
  BodyId,
  AccessoryId,
  InsigniaId,
} from './costume';
export {
  applyCostume,
  costumeFromHex,
  drawHat,
  drawBody,
  drawAccessory,
  drawInsignia,
  drawSkippyCape,
} from './costume';

export type { BoardId } from './boards';
export { BOARD_IDS, BOARD_COSTUMES, BOARD_LABELS } from './boards';

export { SKIPPY_COSTUME, SKIPPY_LABEL } from './skippy';

export { tickBeercan } from './tick';

/**
 * Enumerate every named costume in the sprite kit — Skippy first, then the
 * eight boards in canonical order. Used by the sprite gallery (and any other
 * tool that wants to render every costume side by side).
 */
export interface CostumeEntry {
  /** Stable identifier — `'skippy'` or one of the BoardId values. */
  id: 'skippy' | BoardId;
  /** Human-readable label for the gallery. */
  label: string;
  /** The actual Costume descriptor consumed by `applyCostume`. */
  costume: Costume;
}

export function listAllCostumes(): CostumeEntry[] {
  return [
    { id: 'skippy', label: SKIPPY_LABEL, costume: SKIPPY_COSTUME },
    ...BOARD_IDS.map((boardId): CostumeEntry => ({
      id: boardId,
      label: BOARD_LABELS[boardId],
      costume: BOARD_COSTUMES[boardId],
    })),
  ];
}
