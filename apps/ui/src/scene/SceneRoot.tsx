// PixiJS scene root. The renderer's only entry point into Pixi.
//
// Responsibility:
//   1. Initialize a Pixi v8 Application bound to the host <div>.
//   2. Build Skippy's beercan + throne, register them in the ref-store.
//   3. Build the eight Board captains on the clock-ring (PRD §7.2) and wire
//      click → selection + hex-pad glow → activity (PRD §14.2 exit gate).
//   4. Center on the host's bounds and re-center on resize.
//   5. Pump the tick loop every frame, forwarding agent state from Zustand
//      into the FSM (per CLAUDE.md convention #3).
//
// React's role stops at mounting the canvas. After init, Pixi owns the
// frame budget. Strict-mode double-invocation is handled with `cancelled`.

import { useEffect, useRef } from 'react';
import { Application, Container, Graphics, FederatedPointerEvent } from 'pixi.js';
import {
  createBeercan,
  applyCostume,
  SKIPPY_COSTUME,
  PALETTE_NUM,
  BOARD_IDS,
  BOARD_COSTUMES,
  type BoardId,
} from '@skippy/sprite-kit';
import { SKIPPY_ID, type AgentId } from '@skippy/shared';
import { sceneRefStore } from './refStore';
import { tickAllBeercans } from './tickLoop';
import { createThronePad } from './ThronePad';
import { createBoardCaptain, CAPTAIN_PAD_RADIUS, type BoardCaptainHandle } from './BoardCaptain';
import { BOARD_CLOCK_POSITIONS } from './clockRing';
import type { HexPadGlow } from './HexPad';
import { useUiStore } from '../stores/uiStore';
import { useAgentStore } from '../stores/agentStore';
import type { AgentState } from '@skippy/shared';
import Phase0SkippyDemo from './debug';

/** Selection ring radius (slightly larger than the hex pad). */
const CAPTAIN_RING_RADIUS = CAPTAIN_PAD_RADIUS + 6;
/** Skippy gets a larger ring because his throne is larger. */
const SKIPPY_RING_RADIUS = 62;

function agentStateToGlow(state: AgentState | undefined): HexPadGlow {
  if (!state || state === 'idle' || state === 'completed' || state === 'despawning') return 0;
  if (state === 'error') return 2;
  return 1;
}

/**
 * Draw or redraw a selection ring on the supplied container. We mutate the
 * same Graphics object on every call so we never leak orphan rings.
 */
function paintSelectionRing(g: Graphics, accentColor: number, radius: number): void {
  g.clear()
    .circle(0, 0, radius)
    .stroke({ width: 2, color: accentColor, alpha: 0.95 });
}

export default function SceneRoot() {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    let initialized = false;
    const host = hostRef.current;
    if (!host) return;

    const app = new Application();
    let cleanupRO: (() => void) | null = null;
    let detachTick: (() => void) | null = null;
    const disposers: (() => void)[] = [];

    (async () => {
      try {
        await app.init({
          backgroundAlpha: 0,
          antialias: true,
          resizeTo: host,
          preference: 'webgl',
          powerPreference: 'high-performance',
          resolution: typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
          autoDensity: true,
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[SceneRoot] Pixi init failed:', err);
        return;
      }
      initialized = true;

      if (cancelled || !hostRef.current) {
        // Unmounted during init (React StrictMode dev double-invoke).
        app.destroy(true, { children: true, texture: true });
        return;
      }

      host.appendChild(app.canvas);

      // Logical world container — lets us reposition Skippy + throne as one.
      const world = new Container();
      world.label = 'world';
      world.eventMode = 'static';
      app.stage.addChild(world);

      // ── Background hit area for "click empty space → clear selection" ────
      // We make a transparent rectangle that always fills the stage; the
      // ResizeObserver below keeps it sized to the renderer.
      const bg = new Graphics();
      bg.label = 'world.bg';
      bg.eventMode = 'static';
      bg.cursor = 'default';
      const paintBg = () => {
        bg.clear()
          .rect(-app.renderer.width, -app.renderer.height, app.renderer.width * 2, app.renderer.height * 2)
          .fill({ color: 0x000000, alpha: 0 });
      };
      paintBg();
      world.addChildAt(bg, 0);
      bg.on('pointertap', (evt: FederatedPointerEvent) => {
        // Only treat as "background click" if the event wasn't already
        // claimed by a child. Pixi's bubbling stops on stopPropagation, so
        // child captains stop their event before it reaches here.
        if (evt.target === bg) {
          useUiStore.getState().clearSelected();
        }
      });

      // ── Skippy's throne + beercan at the origin ───────────────────────────
      const throne = createThronePad(PALETTE_NUM.neonCyan);
      world.addChild(throne);

      const baseY = 0; // world-local; world is positioned at canvas center.
      const skippy = createBeercan({ accentColor: PALETTE_NUM.neonCyan, baseY });
      applyCostume(skippy, SKIPPY_COSTUME);
      world.addChild(skippy.container);
      sceneRefStore.set(SKIPPY_ID, skippy);

      // Skippy gets click selection too — clicking him resets the panel.
      skippy.container.eventMode = 'static';
      skippy.container.cursor = 'pointer';
      skippy.container.on('pointertap', (evt: FederatedPointerEvent) => {
        evt.stopPropagation();
        useUiStore.getState().setSelected(SKIPPY_ID);
      });

      // Selection ring for Skippy (separate Graphics so we don't churn his
      // costume layer). Lives inside the world so it translates with him.
      const skippyRing = new Graphics();
      skippyRing.label = 'skippy.selectionRing';
      skippyRing.visible = false;
      // Insert ring behind Skippy so it reads as a halo around the throne.
      world.addChildAt(skippyRing, world.getChildIndex(throne) + 1);

      // ── Clock-ring captains ───────────────────────────────────────────────
      const captains: Record<BoardId, BoardCaptainHandle> = {} as Record<
        BoardId,
        BoardCaptainHandle
      >;
      const captainRings: Record<BoardId, Graphics> = {} as Record<BoardId, Graphics>;

      for (const boardId of BOARD_IDS) {
        const handle = createBoardCaptain(boardId, baseY);
        const pos = BOARD_CLOCK_POSITIONS[boardId];
        handle.container.x = pos.x;
        handle.container.y = pos.y;

        // Selection ring lives inside the captain container so it follows the
        // captain on any future formation moves.
        const ring = new Graphics();
        ring.label = `captain.${boardId}.selectionRing`;
        ring.visible = false;
        // Render behind the hex pad: child index 0 puts it underneath.
        handle.container.addChildAt(ring, 0);

        // Hit area + click handling on the captain container.
        handle.container.eventMode = 'static';
        handle.container.cursor = 'pointer';
        handle.container.on('pointertap', (evt: FederatedPointerEvent) => {
          evt.stopPropagation();
          useUiStore.getState().setSelected(handle.agentId);
        });

        world.addChild(handle.container);
        captains[boardId] = handle;
        captainRings[boardId] = ring;
      }

      // ── Centering on resize ───────────────────────────────────────────────
      const center = () => {
        world.x = app.renderer.width / 2;
        world.y = app.renderer.height / 2;
        paintBg();
      };
      center();

      const ro = new ResizeObserver(center);
      ro.observe(host);
      cleanupRO = () => ro.disconnect();

      // ── Reactive selection ring → uiStore subscription ────────────────────
      const applySelection = (selectedId: AgentId | null): void => {
        // Skippy ring.
        if (selectedId === SKIPPY_ID) {
          paintSelectionRing(skippyRing, PALETTE_NUM.neonCyan, SKIPPY_RING_RADIUS);
          skippyRing.visible = true;
        } else {
          skippyRing.visible = false;
        }
        // Captain rings.
        for (const boardId of BOARD_IDS) {
          const ring = captainRings[boardId];
          const agentId: `board.${BoardId}` = `board.${boardId}`;
          if (selectedId === agentId) {
            paintSelectionRing(ring, BOARD_COSTUMES[boardId].accentColor, CAPTAIN_RING_RADIUS);
            ring.visible = true;
          } else {
            ring.visible = false;
          }
        }
      };
      applySelection(useUiStore.getState().selectedAgentId);
      const unsubUi = useUiStore.subscribe((s, prev) => {
        if (s.selectedAgentId !== prev.selectedAgentId) {
          applySelection(s.selectedAgentId);
        }
      });
      disposers.push(unsubUi);

      // ── Reactive hex-pad glow → agentStore subscription ──────────────────
      const applyGlow = (agents: Record<string, { state: AgentState } | undefined>): void => {
        for (const boardId of BOARD_IDS) {
          const agentId: `board.${BoardId}` = `board.${boardId}`;
          const snap = agents[agentId];
          captains[boardId].hexPad.setGlow(agentStateToGlow(snap?.state));
        }
      };
      applyGlow(useAgentStore.getState().agents);
      const unsubAgents = useAgentStore.subscribe((s, prev) => {
        if (s.agents !== prev.agents) applyGlow(s.agents);
      });
      disposers.push(unsubAgents);

      // ── Pixi tick loop ────────────────────────────────────────────────────
      let lastTs = performance.now();
      const onTick = (): void => {
        const now = performance.now();
        const t = now / 1000;
        const dt = (now - lastTs) / 1000;
        lastTs = now;
        tickAllBeercans(t, dt);
        // Hex-pad pulse runs on the Pixi clock, not the React/Zustand path.
        for (const boardId of BOARD_IDS) {
          captains[boardId].hexPad.tickGlow(t);
        }
      };
      app.ticker.add(onTick);
      detachTick = () => app.ticker.remove(onTick);
    })();

    return () => {
      cancelled = true;
      for (const d of disposers) {
        try { d(); } catch { /* swallow — best-effort cleanup */ }
      }
      detachTick?.();
      cleanupRO?.();
      sceneRefStore.clear();
      // Guard against StrictMode unmount-before-init: destroy() crashes on a
      // pre-init Application.
      if (initialized) {
        app.destroy(true, { children: true, texture: true });
      }
    };
  }, []);

  return (
    <div
      ref={hostRef}
      style={{ width: '100%', height: '100%', position: 'relative' }}
      data-testid="scene-root"
    >
      <Phase0SkippyDemo />
    </div>
  );
}
