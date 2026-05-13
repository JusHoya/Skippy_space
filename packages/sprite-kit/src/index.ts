// Public surface for @skippy/sprite-kit.
//
// Consumers should import everything from the package root; relative deep
// imports are not supported and will break when the atlas pipeline lands.

export { PALETTE, PALETTE_NUM, hexToNum, numToHex, lighten, darken } from './palette';
export type { PaletteToken } from './palette';

export type { AnimationState } from './states';
export { ANIMATION_STATES, isAnimationState } from './states';

export type { BeercanRefs, CreateBeercanOpts } from './beercan';
export { createBeercan } from './beercan';

export type { Costume } from './costume';
export { applyCostume, costumeFromHex } from './costume';

export type { BoardId } from './boards';
export { BOARD_IDS, BOARD_COSTUMES } from './boards';

export { SKIPPY_COSTUME } from './skippy';

export { tickBeercan } from './tick';
