// Board captain factory — one beercan in board livery standing on its hex pad.
//
// PRD §6 (eight Boards) + §7.2 (the map) + §12 (sprite spec). Each captain is
// the visual handle for one Board agent (`board.<id>`). Clicking it lights up
// the SelectedPanel; the hex pad's glow reflects the board's current state.
//
// The captain Container groups the hex pad + beercan together so any future
// transform (zoom, ring-radius change, formation re-layout) acts on the pair
// atomically. The beercan is registered in the scene ref-store under its
// canonical AgentId so the tick loop animates it alongside Skippy.

import { Container } from 'pixi.js';
import {
  createBeercan,
  applyCostume,
  BOARD_COSTUMES,
  type BeercanRefs,
  type BoardId,
} from '@skippy/sprite-kit';
import { sceneRefStore } from './refStore';
import { createHexPad, type HexPadContainer } from './HexPad';

/** Outer hex pad radius — visually balanced against the 56-px throne. */
export const CAPTAIN_PAD_RADIUS = 36;

/** Captain beercan scale; smaller than Skippy who reads as the focal point. */
const CAPTAIN_SCALE = 0.78;

/** Vertical lift so the beercan sits *on* the pad rather than centered in it. */
const CAPTAIN_BEERCAN_OFFSET_Y = -6;

export interface BoardCaptainHandle {
  /** Outer container holding hex pad + beercan. Position this in the world. */
  container: Container;
  /** Beercan refs registered in the scene ref-store; do not destroy directly. */
  beercan: BeercanRefs;
  /** Hex pad container with setGlow / tickGlow methods. */
  hexPad: HexPadContainer;
  /** Convenience: the canonical AgentId for this captain. */
  agentId: `board.${BoardId}`;
}

/**
 * Build a captain. `baseY` is forwarded to `createBeercan` as the beercan's
 * intrinsic ground line; the outer container is what SceneRoot positions on
 * the clock-ring.
 */
export function createBoardCaptain(boardId: BoardId, baseY: number): BoardCaptainHandle {
  const costume = BOARD_COSTUMES[boardId];

  const container = new Container();
  container.label = `captain-${boardId}`;

  // 1. Hex pad sits behind the beercan in z-order.
  const hexPad = createHexPad({
    accentColor: costume.accentColor,
    radius: CAPTAIN_PAD_RADIUS,
    boardId,
  });
  container.addChild(hexPad);

  // 2. Beercan + costume layered on top.
  const beercan = createBeercan({
    accentColor: costume.accentColor,
    baseY: baseY + CAPTAIN_BEERCAN_OFFSET_Y,
    scale: CAPTAIN_SCALE,
  });
  applyCostume(beercan, costume);
  container.addChild(beercan.container);

  // 3. Register in the per-frame ref-store under the canonical agent id so
  // tickAllBeercans() animates this captain in sync with its agentStore state.
  const agentId: `board.${BoardId}` = `board.${boardId}`;
  sceneRefStore.set(agentId, beercan);

  return { container, beercan, hexPad, agentId };
}
