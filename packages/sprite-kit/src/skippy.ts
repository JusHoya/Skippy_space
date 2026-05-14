// Skippy the Magnificent's costume. PRD §3.2, §3.4, §12.3.
//
// Full neon cyan accent, shimmering cape, regal antenna crown, the
// Magnificent insignia (crown overlaying a gear), and the scepter accessory.

import type { Costume } from './costume';
import { hexToNum } from './palette';

export const SKIPPY_COSTUME: Costume = {
  hat: 'regal_antenna_crown',
  body: 'cape_skippy',
  accessory: 'scepter',
  insignia: 'magnificent_crown_gear',
  accentColor: hexToNum('#66FCF1'),
  cape: true,
};

/** Human-readable label, used by the sprite gallery. */
export const SKIPPY_LABEL = 'Skippy the Magnificent';
