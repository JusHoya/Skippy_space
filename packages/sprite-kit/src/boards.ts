// Default costumes for the eight Boards. PRD §12.3.
//
// Names match Hoya_Box charters in `agent_space/boards/` (PRD §6). The
// `accentColor` here is the canonical board accent that drives selection
// rings, hex pads, and command-card buttons across the dashboard.

import type { Costume } from './costume';
import { hexToNum } from './palette';

export type BoardId =
  | 'engineering'
  | 'coding'
  | 'design'
  | 'marketing'
  | 'finance'
  | 'research'
  | 'publishing'
  | 'devops';

export const BOARD_IDS: readonly BoardId[] = [
  'engineering',
  'coding',
  'design',
  'marketing',
  'finance',
  'research',
  'publishing',
  'devops',
] as const;

export const BOARD_COSTUMES: Record<BoardId, Costume> = {
  engineering: {
    hat: 'hard_hat_with_visor',
    body: 'blue_coveralls',
    accessory: 'wrench',
    insignia: 'gear_circuit',
    accentColor: hexToNum('#66FCF1'),
  },
  coding: {
    hat: 'wireframe_headset',
    body: 'hoodie',
    accessory: 'mechanical_keyboard',
    insignia: 'code_brackets',
    accentColor: hexToNum('#45A29E'),
  },
  design: {
    hat: 'beret',
    body: 'smock_paint_splatter',
    accessory: 'brush',
    insignia: 'palette_swirl',
    accentColor: hexToNum('#BC13FE'),
  },
  marketing: {
    hat: 'snapback_cap',
    body: 'bomber_jacket',
    accessory: 'megaphone',
    insignia: 'growth_arrow',
    accentColor: hexToNum('#FF6B6B'),
  },
  finance: {
    hat: 'top_hat',
    body: 'three_piece_suit',
    accessory: 'monocle_and_chart',
    insignia: 'coin_dollar',
    accentColor: hexToNum('#F1C40F'),
  },
  research: {
    hat: 'wizard_cap',
    body: 'tweed_jacket',
    accessory: 'scroll',
    insignia: 'book_atom',
    accentColor: hexToNum('#9B59B6'),
  },
  publishing: {
    hat: 'newsboy_cap',
    body: 'apron_with_pen_loops',
    accessory: 'typewriter',
    insignia: 'quill_page',
    accentColor: hexToNum('#E67E22'),
  },
  devops: {
    hat: 'beanie',
    body: 'flannel',
    accessory: 'terminal_tablet',
    insignia: 'terminal_carat',
    accentColor: hexToNum('#2ECC71'),
  },
};

/** Human-readable label per board — used by the sprite gallery. */
export const BOARD_LABELS: Record<BoardId, string> = {
  engineering: 'Engineering',
  coding: 'Coding',
  design: 'Design',
  marketing: 'Marketing',
  finance: 'Finance',
  research: 'Research',
  publishing: 'Publishing',
  devops: 'DevOps',
};
