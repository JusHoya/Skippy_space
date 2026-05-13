// Animation FSM. PRD §12.4.
//
// Called once per Pixi tick by the scene's tickLoop. `t` is in seconds since
// scene start; `dt` is the previous frame delta in seconds. Per-frame data
// (positions, rotation, scale, alpha) lives ENTIRELY on the BeercanRefs DAG
// — no Zustand reads here. See CLAUDE.md convention #3.
//
// On state transitions we stamp `stateStartedAt = t` so one-shot timelines
// (completed, spawning, despawning) can lerp from a known epoch.

import type { BeercanRefs } from './beercan';
import type { AnimationState } from './states';

const TAU = Math.PI * 2;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function resetVolatile(refs: BeercanRefs): void {
  // Cancel residual transforms before applying the new state's per-frame logic.
  refs.container.alpha = 1;
  refs.container.rotation = 0;
  refs.container.scale.set(refs.baseScale);
  refs.container.tint = 0xffffff;
  refs.mouth.scale.set(1, 1);
  refs.led.alpha = 1;
  refs.led.tint = 0xffffff;
  refs.thoughtBubble.visible = false;
  refs.thoughtBubble.alpha = 1;
  refs.spark.visible = false;
}

export function tickBeercan(
  refs: BeercanRefs,
  state: AnimationState,
  t: number,
  _dt: number,
): void {
  // Detect state edge — stamp epoch and reset transient transforms.
  if (state !== refs.currentState) {
    refs.currentState = state;
    refs.stateStartedAt = t;
    resetVolatile(refs);
  }

  const since = t - refs.stateStartedAt;

  // The idle bob is shared by idle / thinking / speaking / working — each
  // state overrides amplitude/frequency below.
  let bobAmp = 2;
  let bobHz = 1;

  switch (state) {
    case 'idle': {
      refs.container.y = refs.baseY + Math.sin(t * TAU * bobHz) * bobAmp;
      // LED cycle 0.6..1.0 at 1.5 Hz.
      refs.led.alpha = 0.8 + 0.2 * Math.sin(t * TAU * 1.5);
      refs.mouth.scale.set(1, 1);
      refs.thoughtBubble.visible = false;
      refs.spark.visible = false;
      break;
    }

    case 'thinking': {
      refs.container.y = refs.baseY + Math.sin(t * TAU * bobHz) * bobAmp;
      refs.led.alpha = 0.8 + 0.2 * Math.sin(t * TAU * 1.5);
      refs.mouth.scale.set(1, 1);
      refs.thoughtBubble.visible = true;
      refs.thoughtBubble.alpha = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(t * TAU * 1.5));
      // Dots scale 0.6..1.0 with 0.2 phase offsets.
      for (let i = 0; i < 3; i++) {
        const phase = i * 0.2;
        const s = 0.8 + 0.2 * Math.sin((t + phase) * TAU * 1.5);
        refs.thoughtDots[i]?.scale.set(s);
      }
      refs.spark.visible = false;
      break;
    }

    case 'speaking': {
      refs.container.y = refs.baseY + Math.sin(t * TAU * bobHz) * bobAmp;
      refs.led.alpha = 0.8 + 0.2 * Math.sin(t * TAU * 1.5);
      // Mouth height oscillates 1..6 at 10 Hz (center 3.5, amp 2.5).
      const mouthHeight = 3.5 + 2.5 * Math.sin(t * TAU * 10);
      refs.mouth.scale.set(1, mouthHeight);
      refs.thoughtBubble.visible = false;
      refs.spark.visible = false;
      break;
    }

    case 'working': {
      bobAmp = 4;
      bobHz = 2;
      refs.container.y = refs.baseY + Math.sin(t * TAU * bobHz) * bobAmp;
      refs.led.alpha = 0.8 + 0.2 * Math.sin(t * TAU * 2);
      refs.mouth.scale.set(1, 1);
      refs.thoughtBubble.visible = false;
      // Spark flicker at 6 Hz, alternating visibility + jitter.
      refs.spark.visible = Math.sin(t * TAU * 6) > 0;
      refs.spark.x = (Math.sin(t * TAU * 6) > 0 ? 1 : -1) * 6;
      refs.spark.rotation = Math.sin(t * TAU * 6) * 0.4;
      break;
    }

    case 'completed': {
      // Scale pulse 1.0 → 1.2 → 1.0 over 0.6s, then reset to 1.0 and hold.
      const DURATION = 0.6;
      const k = clamp01(since / DURATION);
      // Triangle wave peak at k=0.5.
      const tri = k < 0.5 ? k * 2 : (1 - k) * 2;
      const s = refs.baseScale * (1 + 0.2 * tri);
      refs.container.scale.set(s);
      refs.container.y = refs.baseY;
      refs.led.alpha = 1;
      refs.mouth.scale.set(1, 1);
      refs.thoughtBubble.visible = false;
      refs.spark.visible = false;
      break;
    }

    case 'error': {
      // Red tint, gentle rotation oscillation, LED becomes electric purple
      // (0xBC13FE) pulsing at 3 Hz.
      refs.container.tint = 0xff5555;
      refs.container.rotation = Math.sin(t * TAU * 2) * 0.05;
      refs.container.y = refs.baseY;
      refs.led.tint = 0xbc13fe;
      refs.led.alpha = 0.5 + 0.5 * Math.sin(t * TAU * 3);
      refs.mouth.scale.set(1, 1);
      refs.thoughtBubble.visible = false;
      refs.spark.visible = false;
      break;
    }

    case 'spawning': {
      // Alpha 0 → 1 linearly over 250 ms.
      const DURATION = 0.25;
      const k = clamp01(since / DURATION);
      refs.container.alpha = k;
      refs.container.y = refs.baseY + Math.sin(t * TAU) * 2;
      refs.led.alpha = k;
      refs.mouth.scale.set(1, 1);
      refs.thoughtBubble.visible = false;
      refs.spark.visible = false;
      break;
    }

    case 'despawning': {
      // Alpha 1 → 0 linearly over 250 ms.
      const DURATION = 0.25;
      const k = clamp01(since / DURATION);
      refs.container.alpha = 1 - k;
      refs.container.y = refs.baseY + Math.sin(t * TAU) * 2;
      refs.led.alpha = 1 - k;
      refs.mouth.scale.set(1, 1);
      refs.thoughtBubble.visible = false;
      refs.spark.visible = false;
      break;
    }

    default: {
      // Exhaustive switch guard — unreachable at compile time, defensive at
      // runtime. If a new AnimationState is added without updating the FSM,
      // we drop the can back to idle rather than freezing.
      const _exhaustive: never = state;
      void _exhaustive;
      refs.container.y = refs.baseY;
      break;
    }
  }
}
