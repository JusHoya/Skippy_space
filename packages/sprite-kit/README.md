# @skippy/sprite-kit

Procedural PixiJS v8 sprite primitives for Skippy_space beercans.

## What lives here

- `palette.ts` — color tokens (PRD §3.4), hex<->num converters, lighten/darken.
- `states.ts` — `AnimationState` union: idle, thinking, speaking, working, completed, error, spawning, despawning.
- `beercan.ts` — `createBeercan({ accentColor, baseY, scale })` builds a layered `Container` (shadow, body, highlight, top/bottom bands, pull tab, antenna, LED, mouth slot, thought bubble) using only `pixi.js` v8 `Graphics`. No binary assets.
- `costume.ts` — `Costume` type + `applyCostume(refs, costume)` re-tints the body and inserts hat/accessory/insignia/cape stubs (all procedural).
- `boards.ts` — `BOARD_COSTUMES` for the eight boards (PRD §12.3).
- `skippy.ts` — `SKIPPY_COSTUME` (cape + crown + Magnificent insignia, full neon cyan).
- `tick.ts` — `tickBeercan(refs, state, t, dt)` animation FSM. Per-frame; called from the Pixi tick loop, **not** from React state.

## Why procedural

Phase 0 ships with no binary asset pipeline. Every beercan is drawn from `Graphics` primitives so the renderer can mount the scene the instant `apps/ui` boots. The same `createBeercan` API will later accept an atlas-backed `Sprite` instead of `Graphics`, swappable behind `BeercanRefs`.

## Per-frame rule

This package **never** reads from Zustand. The animation FSM in `tick.ts` is fed `state` by the host scene, which reads from a transient ref-store in `apps/ui/src/scene/refStore.ts`. See `CLAUDE.md` convention #3.
