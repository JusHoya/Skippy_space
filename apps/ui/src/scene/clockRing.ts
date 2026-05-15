// Clock-ring math for the eight Board captains. PRD §7.2 (the map).
//
// The 8 boards sit at canonical clock positions around Skippy's throne. We
// use 12 o'clock as the top (negative-y in Pixi's down-positive coordinate
// system), spaced 45° apart so each ring slot is one of {12, 1:30, 3, 4:30,
// 6, 7:30, 9, 10:30}.
//
// Order matches BOARD_IDS from @skippy/sprite-kit and PRD §6 charters:
//   engineering@12  coding@1:30   design@3      marketing@4:30
//   finance@6       research@7:30 publishing@9  devops@10:30
//
// Per CLAUDE.md convention #3 these positions are static (config, not
// per-frame state) and live in module scope rather than Zustand.

import { BOARD_IDS, type BoardId } from '@skippy/sprite-kit';

/** Default ring radius — large enough to clear the 56-px throne pad halo. */
export const DEFAULT_RING_RADIUS = 200;

export interface ClockSlot {
  /** World-local x in pixels (0 = throne center). */
  x: number;
  /** World-local y in pixels (0 = throne center). Pixi y is down-positive. */
  y: number;
  /** Clock angle in degrees measured clockwise from 12 o'clock. */
  angleDeg: number;
}

/**
 * Compute a slot on the clock-ring.
 *
 * Pixi's coordinate system has +y pointing down, but humans read 12 o'clock
 * as "up." We map clock-angle θ (degrees clockwise from 12) onto Pixi via:
 *   x =  r * sin(θ)
 *   y = -r * cos(θ)
 * which puts θ=0 at (0, -r) — top of the ring — and θ=90° at (r, 0).
 */
function slotAt(angleDeg: number, radius: number): ClockSlot {
  const rad = (angleDeg * Math.PI) / 180;
  return {
    x: Math.sin(rad) * radius,
    y: -Math.cos(rad) * radius,
    angleDeg,
  };
}

/**
 * Canonical clock-angle for each board, in degrees clockwise from 12.
 * Frozen so accidental writes throw in dev.
 */
export const BOARD_CLOCK_ANGLES: Readonly<Record<BoardId, number>> = Object.freeze({
  engineering: 0,    // 12 o'clock
  coding: 45,        // 1:30
  design: 90,        // 3 o'clock
  marketing: 135,    // 4:30
  finance: 180,      // 6 o'clock
  research: 225,     // 7:30
  publishing: 270,   // 9 o'clock
  devops: 315,       // 10:30
});

/** Precomputed default-radius positions for every board. */
export const BOARD_CLOCK_POSITIONS: Readonly<Record<BoardId, ClockSlot>> = Object.freeze(
  BOARD_IDS.reduce<Record<BoardId, ClockSlot>>((acc, id) => {
    acc[id] = slotAt(BOARD_CLOCK_ANGLES[id], DEFAULT_RING_RADIUS);
    return acc;
  }, {} as Record<BoardId, ClockSlot>),
);

/**
 * Build a ClockSlot for the given board at an arbitrary ring radius. Useful
 * for the strategic-zoom minimap (PRD §7.2) which renders the same ring at a
 * smaller scale.
 */
export function boardWorldPos(boardId: BoardId, ringRadius: number): ClockSlot {
  return slotAt(BOARD_CLOCK_ANGLES[boardId], ringRadius);
}
