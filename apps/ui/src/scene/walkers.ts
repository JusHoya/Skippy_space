// Task-agent walker system. PRD §7.2 + §14.3 (Phase 2 Zone 2).
//
// Per CLAUDE.md convention #3 the per-frame data path for walkers mirrors the
// captains: a module-scope Map of BeercanRefs that the tick loop reads and
// mutates directly. Zustand stays out of this path — it only carries the
// discrete TaskAgentSpec records (which the renderer may also keep in a
// per-frame Map alongside, as the parent SceneRoot wires up).
//
// CLAUDE.md convention #7: task agents are leaves. This system spawns and
// despawns them; it never grants them the ability to spawn anything else.

import { Container } from 'pixi.js';
import {
  createTaskAgentBeercan,
  tickBeercan,
  type BeercanRefs,
  type BoardId,
} from '@skippy/sprite-kit';
import type { AgentId, TaskAgentSpec, WalkPath } from '@skippy/shared';

// ── Per-frame ref-store for walkers ──────────────────────────────────────────
//
// Separate from `sceneRefStore` so the captain tick path and the walker tick
// path don't tread on each other's iteration. Both are plain Maps because the
// tick loop runs outside React.

export const WALKER_REF_STORE = new Map<string, BeercanRefs>();

// ── Spawn / despawn ──────────────────────────────────────────────────────────

export interface SpawnWalkerOpts {
  /** Canonical task agent id (`task.<ulid>`). */
  id: AgentId;
  /** Captain that delegated this task. */
  parentBoardId: BoardId;
  /** Pedestal the walker is heading to. */
  targetPedestalId: string;
  /** Precomputed path from captain pad → pedestal. */
  path: WalkPath;
  /** Parent board's accent color — flows into the walker costume. */
  accentColor: number;
  /** Ground-line baseY for the beercan's FSM bob math. */
  baseY: number;
  /** Stage container to add the walker's container to. */
  stage: Container;
}

/**
 * Spawn a walker beercan, register it in the per-frame ref-store, and add it
 * to the supplied stage. Returns the matching TaskAgentSpec so the caller can
 * thread it into whatever Map drives `advanceWalkers` / `tickWalkerAnimations`.
 */
export function spawnWalker(opts: SpawnWalkerOpts): TaskAgentSpec {
  const refs = createTaskAgentBeercan({
    accentColor: opts.accentColor,
    baseY: opts.baseY,
  });

  // Position the walker at the path origin before its first tick — otherwise
  // the first frame flashes at (0, 0) for one tick. `baseY` also moves so the
  // FSM's bob anchors to the captain pad, not the world origin.
  refs.container.x = opts.path.fromX;
  refs.container.y = opts.path.fromY;
  refs.baseY = opts.path.fromY;

  WALKER_REF_STORE.set(opts.id, refs);
  opts.stage.addChild(refs.container);

  return {
    id: opts.id,
    parentBoardId: opts.parentBoardId,
    targetPedestalId: opts.targetPedestalId,
    spawnedAt: performance.now(),
    path: opts.path,
    progress: 0,
  };
}

/**
 * Tear down a walker. Removes the container from its parent, destroys it,
 * and drops the ref-store entry. Safe to call for an unknown id.
 */
export function despawnWalker(id: string): void {
  const refs = WALKER_REF_STORE.get(id);
  if (!refs) return;
  // Destroy the whole container subtree so Graphics children are released too.
  refs.container.destroy({ children: true });
  WALKER_REF_STORE.delete(id);
}

// ── Path building ────────────────────────────────────────────────────────────

const DEFAULT_SPEED_PX_PER_SEC = 80;
const MIN_DURATION_SEC = 0.4;

export interface BuildWalkPathOpts {
  /** Walker linear speed; default 80 px/s. */
  speedPxPerSec?: number;
  /** Optional intermediate waypoints — split duration evenly across legs. */
  waypoints?: Array<{ x: number; y: number }>;
}

/**
 * Compute a WalkPath from `from` to `to` with optional intermediate waypoints.
 * Euclidean total distance / speed → durationSec, floored at MIN_DURATION_SEC
 * so micro-walks still feel intentional.
 */
export function buildWalkPath(
  from: { x: number; y: number },
  to: { x: number; y: number },
  opts?: BuildWalkPathOpts,
): WalkPath {
  const speed = opts?.speedPxPerSec ?? DEFAULT_SPEED_PX_PER_SEC;

  // Total distance walks through every leg in sequence (from → wp[0] → ... → to).
  const legs: Array<{ x: number; y: number }> = [from];
  if (opts?.waypoints) legs.push(...opts.waypoints);
  legs.push(to);

  let totalDist = 0;
  for (let i = 1; i < legs.length; i++) {
    const a = legs[i - 1]!;
    const b = legs[i]!;
    totalDist += Math.hypot(b.x - a.x, b.y - a.y);
  }

  const durationSec = Math.max(MIN_DURATION_SEC, totalDist / speed);

  // `exactOptionalPropertyTypes` forbids assigning `undefined` to an optional
  // field — spread waypoints conditionally so the property is absent when
  // unused.
  const path: WalkPath = {
    fromX: from.x,
    fromY: from.y,
    toX: to.x,
    toY: to.y,
    durationSec,
    ...(opts?.waypoints ? { waypoints: opts.waypoints } : {}),
  };
  return path;
}

// ── Position advance ─────────────────────────────────────────────────────────

/**
 * Linear interpolation across a WalkPath that may include waypoints. When
 * waypoints are present we split the total duration evenly across the N legs
 * (matches the spec) — total path progress 0..1 maps to a sub-progress within
 * the currently-active leg.
 */
function positionAlongPath(path: WalkPath, progress: number): { x: number; y: number } {
  const wp = path.waypoints ?? [];
  const points: Array<{ x: number; y: number }> = [
    { x: path.fromX, y: path.fromY },
    ...wp,
    { x: path.toX, y: path.toY },
  ];
  const legCount = points.length - 1;
  if (legCount <= 0) return { x: path.fromX, y: path.fromY };

  // Map 0..1 onto N legs of equal time share.
  const scaled = progress * legCount;
  const legIndex = Math.min(legCount - 1, Math.floor(scaled));
  const legK = scaled - legIndex;
  const a = points[legIndex]!;
  const b = points[legIndex + 1]!;
  return {
    x: a.x + (b.x - a.x) * legK,
    y: a.y + (b.y - a.y) * legK,
  };
}

/**
 * Per-frame walker position advance. Mutates `spec.path`, `spec.progress`,
 * and the matching BeercanRefs `container.x/y` in place. When a walker
 * arrives we null-out `path` and snap to the target — subsequent ticks
 * leave the position alone (the FSM keeps animating the welding loop).
 */
export function advanceWalkers(
  _t: number,
  dt: number,
  specs: Map<string, TaskAgentSpec>,
): void {
  for (const spec of specs.values()) {
    const refs = WALKER_REF_STORE.get(spec.id);
    if (!refs) continue;

    const path = spec.path;
    if (path === null) {
      // Already arrived — position is held; nothing to advance.
      continue;
    }

    spec.progress += dt / path.durationSec;
    if (spec.progress >= 1) {
      // Snap to target and mark as arrived. We mutate the spec directly —
      // the spec Map is the renderer-side source of truth, exactly like
      // the BeercanRefs DAG (CLAUDE.md #3). `baseY` is moved with the
      // container so the FSM's subsequent bob anchors to the pedestal.
      refs.container.x = path.toX;
      refs.container.y = path.toY;
      refs.baseY = path.toY;
      spec.progress = 1;
      spec.path = null;
      continue;
    }

    const { x, y } = positionAlongPath(path, spec.progress);
    refs.container.x = x;
    refs.container.y = y;
    refs.baseY = y;
  }
}

// ── Animation tick ───────────────────────────────────────────────────────────

/**
 * Drive each walker beercan through its FSM. Per PRD §7.2 the walker is in
 * `working` state both while walking and after arrival (the welding loop
 * continues; only the world position distinguishes the two visually).
 */
export function tickWalkerAnimations(
  t: number,
  dt: number,
  specs: Map<string, TaskAgentSpec>,
): void {
  for (const spec of specs.values()) {
    const refs = WALKER_REF_STORE.get(spec.id);
    if (!refs) continue;
    tickBeercan(refs, 'working', t, dt);
  }
}
