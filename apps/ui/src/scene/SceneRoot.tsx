// PixiJS scene root. The renderer's only entry point into Pixi.
//
// Responsibility:
//   1. Initialize a Pixi v8 Application bound to the host <div>.
//   2. Build Skippy's beercan + throne, register them in the ref-store.
//   3. Center on the host's bounds and re-center on resize.
//   4. Pump the tick loop every frame, forwarding agent state from Zustand
//      into the FSM (per CLAUDE.md convention #3).
//
// React's role stops at mounting the canvas. After init, Pixi owns the
// frame budget. Strict-mode double-invocation is handled with `cancelled`.

import { useEffect, useRef } from 'react';
import { Application, Container } from 'pixi.js';
import {
  createBeercan,
  applyCostume,
  SKIPPY_COSTUME,
  PALETTE_NUM,
} from '@skippy/sprite-kit';
import { SKIPPY_ID } from '@skippy/shared';
import { sceneRefStore } from './refStore';
import { tickAllBeercans } from './tickLoop';
import { createThronePad } from './ThronePad';
import Phase0SkippyDemo from './debug';

export default function SceneRoot() {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (!host) return;

    const app = new Application();
    let cleanupRO: (() => void) | null = null;
    let detachTick: (() => void) | null = null;

    (async () => {
      await app.init({
        backgroundAlpha: 0,
        antialias: true,
        resizeTo: host,
        preference: 'webgl',
        powerPreference: 'high-performance',
        resolution: typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
        autoDensity: true,
      });

      if (cancelled || !hostRef.current) {
        app.destroy(true);
        return;
      }

      host.appendChild(app.canvas);

      // Logical world container — lets us reposition Skippy + throne as one.
      const world = new Container();
      world.label = 'world';
      app.stage.addChild(world);

      const throne = createThronePad(PALETTE_NUM.neonCyan);
      world.addChild(throne);

      const baseY = 0; // world-local; world is positioned at canvas center.
      const skippy = createBeercan({ accentColor: PALETTE_NUM.neonCyan, baseY });
      applyCostume(skippy, SKIPPY_COSTUME);
      world.addChild(skippy.container);
      sceneRefStore.set(SKIPPY_ID, skippy);

      const center = () => {
        world.x = app.renderer.width / 2;
        world.y = app.renderer.height / 2;
      };
      center();

      const ro = new ResizeObserver(center);
      ro.observe(host);
      cleanupRO = () => ro.disconnect();

      // Pixi tick loop — drives the animation FSM at display refresh rate.
      let lastTs = performance.now();
      const onTick = (): void => {
        const now = performance.now();
        const t = now / 1000;
        const dt = (now - lastTs) / 1000;
        lastTs = now;
        tickAllBeercans(t, dt);
      };
      app.ticker.add(onTick);
      detachTick = () => app.ticker.remove(onTick);
    })().catch((err) => {
      // Cleanly surface init failures — Pixi sometimes throws on WebGL2
      // context creation when GPU drivers misbehave; we want a console
      // breadcrumb rather than a silent black canvas.
      // eslint-disable-next-line no-console
      console.error('[SceneRoot] Pixi init failed:', err);
    });

    return () => {
      cancelled = true;
      detachTick?.();
      cleanupRO?.();
      sceneRefStore.clear();
      app.destroy(true, { children: true, texture: true });
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
