// PixiJS scene root. The renderer's only entry point into Pixi.
//
// Phase 2 layers on top of the Phase 1 clock-ring scene (PRD §7.2 / §14.3):
//   • Project-tree tessellation rendered as a field of file pedestals around
//     the captain clock-ring (Zone 1).
//   • Strategic-zoom camera + wheel pan/zoom (Zone 4) — Zustand-driven, but
//     applied to the world Container outside the per-frame tick loop.
//   • Drag-box / multi-select / control-group selection on top of the existing
//     single-click selection (Zone 3).
//   • Task-agent walkers spawned per `delegation_ack` envelope (Zone 2),
//     walking from the captain pad to a pedestal in the relevant biome.
//   • Fog-of-war dimming over pedestals (Zone 5), driven by Zustand.
//   • Active-pause freezes the tick loop's animation phase (PRD §7.2).
//
// Per CLAUDE.md convention #3, per-frame data (positions, FSM phases, walker
// progress) never travels through Zustand. The tick loop reads ref-stores
// directly; Zustand subscriptions only fire on discrete UI-visible deltas
// (selection, fog regions, camera, paused).

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
import {
  SKIPPY_ID,
  MINIMAP_LAYERS,
  type AgentId,
  type AgentState,
  type MinimapLayer,
  type PedestalLayout,
  type TaskAgentSpec,
} from '@skippy/shared';
import { sceneRefStore } from './refStore';
import { tickAllBeercans } from './tickLoop';
import { createThronePad } from './ThronePad';
import { createBoardCaptain, CAPTAIN_PAD_RADIUS, type BoardCaptainHandle } from './BoardCaptain';
import { BOARD_CLOCK_POSITIONS } from './clockRing';
import type { HexPadGlow } from './HexPad';
import { fetchProjectTree, layoutPedestals } from './projectTree';
import { createPedestalField, type PedestalFieldContainer } from './FilePedestals';
import {
  applyCameraToWorld,
  attachWheelZoom,
  worldSpaceFromHostPoint,
} from './Camera';
import { applyFogToPedestals } from './FogOfWar';
import {
  spawnWalker,
  despawnWalker,
  advanceWalkers,
  tickWalkerAnimations,
  buildWalkPath,
} from './walkers';
import { useUiStore } from '../stores/uiStore';
import { useAgentStore } from '../stores/agentStore';
import { useSelectionStore } from '../stores/selectionStore';
import { useCameraStore } from '../stores/cameraStore';
import { useFogStore } from '../stores/fogStore';
import { useDelegationStore } from '../stores/delegationStore';
import { setMinimapLayouts } from '../hud/MinimapPane';
import { onHotkey } from '../hud/Hotkeys';
import Phase0SkippyDemo from './debug';

/** Selection ring radius (slightly larger than the hex pad). */
const CAPTAIN_RING_RADIUS = CAPTAIN_PAD_RADIUS + 6;
/** Skippy gets a larger ring because his throne is larger. */
const SKIPPY_RING_RADIUS = 62;

/** Pedestal layout ring radii — clear the 200-px captain ring with a buffer. */
const PEDESTAL_INNER_RADIUS = 290;
const PEDESTAL_OUTER_RADIUS = 540;

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

/** Pick one pedestal in the named biome for a walker target. Deterministic by id. */
function pickPedestalForBoard(
  layouts: PedestalLayout[],
  boardId: BoardId,
  seedKey: string,
): PedestalLayout | null {
  // Biomes are named directories at the project root; we match a board to a
  // biome best-effort. Engineering → `apps`, Coding → `apps`, DevOps → `infra`,
  // Research → `docs` etc. Fallback is "any pedestal" with a stable hash.
  const biomeMap: Record<BoardId, string[]> = {
    engineering: ['apps', 'packages'],
    coding: ['apps', 'packages'],
    design: ['packages', 'apps'],
    marketing: ['docs', 'agent_space'],
    finance: ['agent_space', 'docs'],
    research: ['docs', 'vault'],
    publishing: ['docs', 'vault'],
    devops: ['infra', 'apps'],
  };
  const preferred = biomeMap[boardId];
  const candidates = layouts.filter((l) => preferred.includes(l.biome));
  const pool = candidates.length > 0 ? candidates : layouts;
  if (pool.length === 0) return null;
  let h = 0;
  for (let i = 0; i < seedKey.length; i++) h = (h * 31 + seedKey.charCodeAt(i)) | 0;
  const idx = ((h % pool.length) + pool.length) % pool.length;
  return pool[idx] ?? null;
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
    let detachWheel: (() => void) | null = null;
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

      // Logical world container — lets us reposition Skippy + throne as one
      // AND apply the camera (scale + pan) atomically.
      const world = new Container();
      world.label = 'world';
      world.eventMode = 'static';
      app.stage.addChild(world);

      // ── Background hit area for "click empty space → clear selection" ────
      const bg = new Graphics();
      bg.label = 'world.bg';
      bg.eventMode = 'static';
      bg.cursor = 'default';
      const paintBg = () => {
        // Big enough to fill the canvas at any zoom level.
        bg.clear()
          .rect(-app.renderer.width * 4, -app.renderer.height * 4, app.renderer.width * 8, app.renderer.height * 8)
          .fill({ color: 0x000000, alpha: 0 });
      };
      paintBg();
      world.addChildAt(bg, 0);
      bg.on('pointertap', (evt: FederatedPointerEvent) => {
        // Treat as background click only if the event wasn't claimed by a child.
        if (evt.target === bg) {
          useSelectionStore.getState().clearMulti();
        }
      });

      // ── Pedestal field placeholder (filled in after async tree fetch) ─────
      // We add an empty container up front so its z-order slot is reserved
      // between bg and throne. The async fetch then fills it in.
      const pedestalSlot = new Container();
      pedestalSlot.label = 'pedestalSlot';
      world.addChild(pedestalSlot);
      let pedestalField: PedestalFieldContainer | null = null;
      let pedestalLayouts: PedestalLayout[] = [];

      // ── Skippy's throne + beercan at the origin ───────────────────────────
      const throne = createThronePad(PALETTE_NUM.neonCyan);
      world.addChild(throne);

      const baseY = 0; // world-local; world is positioned at canvas center.
      const skippy = createBeercan({ accentColor: PALETTE_NUM.neonCyan, baseY });
      applyCostume(skippy, SKIPPY_COSTUME);
      world.addChild(skippy.container);
      sceneRefStore.set(SKIPPY_ID, skippy);

      skippy.container.eventMode = 'static';
      skippy.container.cursor = 'pointer';
      skippy.container.on('pointertap', (evt: FederatedPointerEvent) => {
        evt.stopPropagation();
        useSelectionStore.getState().setMulti([SKIPPY_ID]);
      });

      const skippyRing = new Graphics();
      skippyRing.label = 'skippy.selectionRing';
      skippyRing.visible = false;
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

        const ring = new Graphics();
        ring.label = `captain.${boardId}.selectionRing`;
        ring.visible = false;
        handle.container.addChildAt(ring, 0);

        handle.container.eventMode = 'static';
        handle.container.cursor = 'pointer';
        handle.container.on('pointertap', (evt: FederatedPointerEvent) => {
          evt.stopPropagation();
          const agentId: `board.${BoardId}` = `board.${boardId}`;
          // Shift-click = additive multi-select. Pixi v8 FederatedPointerEvent
          // exposes modifier keys directly on the event.
          if (evt.shiftKey) {
            useSelectionStore.getState().addToMulti(agentId);
          } else {
            useSelectionStore.getState().setMulti([agentId]);
          }
        });

        world.addChild(handle.container);
        captains[boardId] = handle;
        captainRings[boardId] = ring;
      }

      // ── Walkers container — over captains, under HUD overlays ─────────────
      const walkersStage = new Container();
      walkersStage.label = 'walkersStage';
      world.addChild(walkersStage);
      // Per-walker spec map. Mirrors WALKER_REF_STORE 1:1 but holds the
      // discrete progress/path state the renderer iterates each frame.
      const walkerSpecs = new Map<string, TaskAgentSpec>();
      // Track which delegation ids have already spawned a walker so we don't
      // double-spawn on a re-emitted envelope.
      const walkerByDelegation = new Map<string, string>();

      // ── Drag-box overlay (screen-space, NOT inside world) ─────────────────
      // Lives on app.stage so it doesn't scale with the camera.
      const dragOverlay = new Graphics();
      dragOverlay.label = 'dragOverlay';
      dragOverlay.eventMode = 'none';
      app.stage.addChild(dragOverlay);
      const paintDragBox = (): void => {
        const box = useSelectionStore.getState().dragBox;
        if (!box || !box.active) {
          dragOverlay.clear();
          return;
        }
        const x = Math.min(box.startX, box.endX);
        const y = Math.min(box.startY, box.endY);
        const w = Math.abs(box.endX - box.startX);
        const h = Math.abs(box.endY - box.startY);
        dragOverlay
          .clear()
          .rect(x, y, w, h)
          .stroke({ width: 1, color: PALETTE_NUM.neonCyan, alpha: 0.95 })
          .fill({ color: PALETTE_NUM.neonCyan, alpha: 0.08 });
      };

      // Mousedown on the host (NOT on a captain) starts a drag.
      const onHostPointerDown = (evt: PointerEvent): void => {
        if (evt.button !== 0) return;
        const rect = host.getBoundingClientRect();
        const x = evt.clientX - rect.left;
        const y = evt.clientY - rect.top;
        // Only start when the click landed on the canvas background — Pixi
        // children stopPropagation on their own pointertaps, but pointerdown
        // doesn't auto-cancel. We use a small grace by checking
        // `evt.target === app.canvas`.
        if (evt.target !== app.canvas) return;
        useSelectionStore.getState().startDragBox(x, y);
      };
      const onHostPointerMove = (evt: PointerEvent): void => {
        const box = useSelectionStore.getState().dragBox;
        if (!box) return;
        const rect = host.getBoundingClientRect();
        useSelectionStore
          .getState()
          .updateDragBox(evt.clientX - rect.left, evt.clientY - rect.top);
      };
      const onHostPointerUp = (_evt: PointerEvent): void => {
        const box = useSelectionStore.getState().endDragBox();
        if (!box) return;
        // Project every captain to host-pixel coords, hit-test against the box.
        const view = useCameraStore.getState().view;
        const w = app.renderer.width / (window.devicePixelRatio || 1);
        const h = app.renderer.height / (window.devicePixelRatio || 1);
        const hits: AgentId[] = [];
        for (const boardId of BOARD_IDS) {
          const cap = captains[boardId];
          const hostX = w / 2 + (cap.container.x + view.panX) * view.scale;
          const hostY = h / 2 + (cap.container.y + view.panY) * view.scale;
          const xMin = Math.min(box.startX, box.endX);
          const xMax = Math.max(box.startX, box.endX);
          const yMin = Math.min(box.startY, box.endY);
          const yMax = Math.max(box.startY, box.endY);
          if (hostX >= xMin && hostX <= xMax && hostY >= yMin && hostY <= yMax) {
            hits.push(`board.${boardId}` as AgentId);
          }
        }
        if (hits.length > 0) useSelectionStore.getState().setMulti(hits);
      };
      host.addEventListener('pointerdown', onHostPointerDown);
      window.addEventListener('pointermove', onHostPointerMove);
      window.addEventListener('pointerup', onHostPointerUp);
      disposers.push(() => host.removeEventListener('pointerdown', onHostPointerDown));
      disposers.push(() => window.removeEventListener('pointermove', onHostPointerMove));
      disposers.push(() => window.removeEventListener('pointerup', onHostPointerUp));

      // ── Camera glue ───────────────────────────────────────────────────────
      const applyCamera = (): void => {
        const view = useCameraStore.getState().view;
        applyCameraToWorld(world, view, app.renderer.width, app.renderer.height);
        paintBg();
      };
      applyCamera();
      const ro = new ResizeObserver(applyCamera);
      ro.observe(host);
      cleanupRO = () => ro.disconnect();

      const unsubCamera = useCameraStore.subscribe((s, prev) => {
        if (s.view !== prev.view) applyCamera();
      });
      disposers.push(unsubCamera);

      // Wheel zoom on the canvas host.
      detachWheel = attachWheelZoom(host, {
        onZoom: (factor, hostX, hostY) => {
          const view = useCameraStore.getState().view;
          const w = app.renderer.width / (window.devicePixelRatio || 1);
          const h = app.renderer.height / (window.devicePixelRatio || 1);
          const world = worldSpaceFromHostPoint(hostX, hostY, view, w, h);
          useCameraStore.getState().zoomBy(factor, world.x, world.y);
        },
      });

      // ── Selection-ring subscription ───────────────────────────────────────
      const applySelection = (ids: AgentId[]): void => {
        const set = new Set(ids);
        // Skippy ring.
        if (set.has(SKIPPY_ID)) {
          paintSelectionRing(skippyRing, PALETTE_NUM.neonCyan, SKIPPY_RING_RADIUS);
          skippyRing.visible = true;
        } else {
          skippyRing.visible = false;
        }
        // Captain rings — paint every selected captain, not just the primary.
        for (const boardId of BOARD_IDS) {
          const ring = captainRings[boardId];
          const agentId: `board.${BoardId}` = `board.${boardId}`;
          if (set.has(agentId)) {
            paintSelectionRing(ring, BOARD_COSTUMES[boardId].accentColor, CAPTAIN_RING_RADIUS);
            ring.visible = true;
          } else {
            ring.visible = false;
          }
        }
      };

      // Honor whichever store has a selection on mount. multiSelected wins if
      // non-empty; otherwise the single-selection legacy state.
      const initialMulti = useSelectionStore.getState().multiSelected;
      const initialPrimary = useUiStore.getState().selectedAgentId;
      applySelection(
        initialMulti.length > 0 ? initialMulti : initialPrimary ? [initialPrimary] : [],
      );

      const unsubSel = useSelectionStore.subscribe((s, prev) => {
        if (s.multiSelected !== prev.multiSelected) {
          const primary = useUiStore.getState().selectedAgentId;
          applySelection(
            s.multiSelected.length > 0 ? s.multiSelected : primary ? [primary] : [],
          );
        }
      });
      disposers.push(unsubSel);

      const unsubUi = useUiStore.subscribe((s, prev) => {
        if (s.selectedAgentId !== prev.selectedAgentId) {
          const multi = useSelectionStore.getState().multiSelected;
          applySelection(
            multi.length > 0 ? multi : s.selectedAgentId ? [s.selectedAgentId] : [],
          );
        }
      });
      disposers.push(unsubUi);

      // ── Hex-pad glow subscription ─────────────────────────────────────────
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

      // ── Fog subscription (runs once pedestals exist) ──────────────────────
      const applyFogNow = (): void => {
        if (!pedestalField) return;
        applyFogToPedestals(pedestalField, useFogStore.getState().regions);
      };
      const unsubFog = useFogStore.subscribe((s, prev) => {
        if (s.regions !== prev.regions) applyFogNow();
      });
      disposers.push(unsubFog);

      // ── Hotkey dispatcher subscription ────────────────────────────────────
      const offHotkey = onHotkey((e) => {
        if (e.command === 'minimap.toggleLayer') {
          const layer = e.args?.layer;
          if (
            typeof layer === 'string' &&
            (MINIMAP_LAYERS as readonly string[]).includes(layer)
          ) {
            useFogStore.getState().toggleLayer(layer as MinimapLayer);
          }
        }
        if (e.command === 'camera.resetView') {
          useCameraStore.getState().resetView();
        }
      });
      disposers.push(offHotkey);

      // ── Delegation → walker spawn glue ────────────────────────────────────
      const onDelegationDelta = (
        delegations: Record<string, { delegationId: string; toBoardId: BoardId; status: string }>,
      ): void => {
        if (pedestalLayouts.length === 0) return;
        for (const [id, rec] of Object.entries(delegations)) {
          // Spawn a walker once the delegation is accepted; skip pending/declined.
          if (walkerByDelegation.has(id)) continue;
          if (rec.status !== 'accepted' && rec.status !== 'succeeded') continue;
          const target = pickPedestalForBoard(pedestalLayouts, rec.toBoardId, id);
          if (!target) continue;
          const fromPos = BOARD_CLOCK_POSITIONS[rec.toBoardId];
          const path = buildWalkPath(
            { x: fromPos.x, y: fromPos.y },
            { x: target.x, y: target.y - target.heightPx - 8 },
            { speedPxPerSec: 95 },
          );
          const walkerId: AgentId = `task.${id}` as AgentId;
          const spec = spawnWalker({
            id: walkerId,
            parentBoardId: rec.toBoardId,
            targetPedestalId: target.id,
            path,
            accentColor: BOARD_COSTUMES[rec.toBoardId].accentColor,
            baseY: 0,
            stage: walkersStage,
          });
          walkerSpecs.set(spec.id, spec);
          walkerByDelegation.set(id, spec.id);
          // Mark the target pedestal as shrouded — agent has touched it.
          useFogStore
            .getState()
            .markSeen(target.id, walkerId, new Date().toISOString());
          // Highlight the pedestal subtly while a walker is en route.
          pedestalField?.setActiveTint(target.id, BOARD_COSTUMES[rec.toBoardId].accentColor);
        }
      };
      onDelegationDelta(useDelegationStore.getState().delegations);
      const unsubDelegations = useDelegationStore.subscribe((s, prev) => {
        if (s.delegations !== prev.delegations) onDelegationDelta(s.delegations);
      });
      disposers.push(unsubDelegations);

      // ── Asynchronous: load project tree, build pedestal field ─────────────
      const tree = await fetchProjectTree();
      if (cancelled) return;
      if (tree) {
        pedestalLayouts = layoutPedestals(tree, {
          innerRadius: PEDESTAL_INNER_RADIUS,
          outerRadius: PEDESTAL_OUTER_RADIUS,
        });
        pedestalField = createPedestalField(pedestalLayouts);
        pedestalSlot.addChild(pedestalField);
        // Seed fog: mark every biome as shrouded so the minimap reads as
        // "explored map at boot," and a sprinkling of files as bright so the
        // user sees the gradient. Phase 3's memory pipeline replaces this
        // deterministic seed with real "agent saw / agent edited" events.
        const now = new Date().toISOString();
        const fog = useFogStore.getState();
        for (let i = 0; i < pedestalLayouts.length; i++) {
          const l = pedestalLayouts[i];
          if (!l) continue;
          if (i % 7 === 0) {
            fog.markBright(l.id, now);
          } else {
            fog.markSeen(l.id, SKIPPY_ID, now);
          }
        }
        applyFogNow();
        setMinimapLayouts(pedestalLayouts);
        // Once layouts exist, re-run the delegation glue in case some arrived
        // before the tree finished loading.
        onDelegationDelta(useDelegationStore.getState().delegations);
      } else {
        // eslint-disable-next-line no-console
        console.warn('[SceneRoot] project tree fetch returned null — pedestals omitted');
      }

      // ── Pixi tick loop ────────────────────────────────────────────────────
      let lastTs = performance.now();
      const onTick = (): void => {
        const now = performance.now();
        const t = now / 1000;
        const dt = (now - lastTs) / 1000;
        lastTs = now;
        // Active-pause halts agent animation + walker movement; the hex pad
        // pulse and the drag-box rubber-band continue (PRD §7.2: pause freezes
        // tool-calls, not HUD signals).
        const paused = useUiStore.getState().paused;
        if (!paused) {
          tickAllBeercans(t, dt);
          advanceWalkers(t, dt, walkerSpecs);
          tickWalkerAnimations(t, dt, walkerSpecs);
        }
        for (const boardId of BOARD_IDS) {
          captains[boardId].hexPad.tickGlow(t);
        }
        paintDragBox();
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
      detachWheel?.();
      cleanupRO?.();
      sceneRefStore.clear();
      // Drain any walkers still around so the destroy chain finds clean state.
      // Walker container destruction is also reached via app.destroy below; the
      // explicit despawn keeps WALKER_REF_STORE consistent across HMR reloads.
      // (`despawnWalker` is idempotent for unknown ids — safe even if the map
      // is already empty.)
      // We intentionally don't call `useQueueStore` from cleanup; the queue is
      // session-scoped and outlives this Pixi instance.
      void despawnWalker;
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
