import type { BoardId } from './agents.js';

/**
 * Per-Board static metadata for the eight Captain processes (PRD §5.1).
 *
 * The accentHex column duplicates the palette so we have a single lookup keyed
 * by board id; renderer hot-paths should prefer this over hunting through the
 * palette by name. Models are deliberately split: the heavy-thinking boards
 * (engineering / coding / design / finance) run on Sonnet; the volume boards
 * (marketing / research / publishing / devops) run on Haiku.
 */
export interface BoardMeta {
  displayName: string;
  codename: string;
  defaultModel: string;
  accentHex: string;
}

export const BOARD_META: Record<BoardId, BoardMeta> = {
  engineering: {
    displayName: 'Engineering Captain',
    codename: 'Wrench',
    defaultModel: 'claude-sonnet-4-6',
    accentHex: '#66FCF1',
  },
  coding: {
    displayName: 'Coding Captain',
    codename: 'Caret',
    defaultModel: 'claude-sonnet-4-6',
    accentHex: '#45A29E',
  },
  design: {
    displayName: 'Design Captain',
    codename: 'Brush',
    defaultModel: 'claude-sonnet-4-6',
    accentHex: '#BC13FE',
  },
  marketing: {
    displayName: 'Marketing Captain',
    codename: 'Megaphone',
    defaultModel: 'claude-haiku-4-5-20251001',
    accentHex: '#FF6B6B',
  },
  finance: {
    displayName: 'Finance Captain',
    codename: 'Ledger',
    defaultModel: 'claude-sonnet-4-6',
    accentHex: '#F1C40F',
  },
  research: {
    displayName: 'Research Captain',
    codename: 'Scribe',
    defaultModel: 'claude-haiku-4-5-20251001',
    accentHex: '#9B59B6',
  },
  publishing: {
    displayName: 'Publishing Captain',
    codename: 'Quill',
    defaultModel: 'claude-haiku-4-5-20251001',
    accentHex: '#E67E22',
  },
  devops: {
    displayName: 'DevOps Captain',
    codename: 'Pipe',
    defaultModel: 'claude-haiku-4-5-20251001',
    accentHex: '#2ECC71',
  },
};
