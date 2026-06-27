// Animation FSM. PRD §12.4.
//
// Called once per Pixi tick by the scene's tickLoop. `t` is in seconds since
// scene start; `dt` is the previous frame delta in seconds. Per-frame data
// (positions, rotation, scale, alpha) lives ENTIRELY on the BeercanRefs DAG
// — no Zustand reads here. See CLAUDE.md convention #3.
//
// On state transitions we stamp `stateStartedAt = t` so one-shot timelines
// (completed, spawning, despawning) can lerp from a known epoch.
//
// Sprite v1 (Phase 4) polish: the two LED halos (ledGlow, antennaGlow) breathe
// with each state, idle gained a soft secondary sway + breathing scale,
// speaking drives a synced LED flicker, working leans into its work, error is a
// pulsing red flash rather than a flat tint, and spawn/despawn add a scale pop.

import type { BeercanRefs } from './beercan';
import type { AnimationState } from './states';

const TAU = Math.PI * 2;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// Smootherstep — C2-continuous ease used for one-shot timelines.
function smooth(k: number): number {
  const x = clamp01(k);
  return x * x * x * (x * (x * 6 - 15) + 10);
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
  refs.ledGlow.alpha = 0.3;
  refs.ledGlow.tint = 0xffffff;
  refs.antennaGlow.alpha = 0.35;
  refs.antennaGlow.tint = 0xffffff;
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

  switch (state) {
    case 'idle': {
      // Gentle bob + a slow secondary sway + barely-there breathing scale, so
      // even at rest the can feels alive rather than frozen.
      refs.container.y = refs.baseY + Math.sin(t * TAU * 0.75) * 2;
      refs.container.rotation = Math.sin(t * TAU * 0.45) * 0.012;
      refs.container.scale.set(refs.baseScale * (1 + 0.012 * Math.sin(t * TAU * 0.6)));
      const led = 0.75 + 0.25 * (0.5 + 0.5 * Math.sin(t * TAU * 1.2));
      refs.led.alpha = led;
      refs.ledGlow.alpha = 0.18 + 0.18 * (0.5 + 0.5 * Math.sin(t * TAU * 1.2));
      refs.antennaGlow.alpha = 0.22 + 0.18 * (0.5 + 0.5 * Math.sin(t * TAU * 1.2 + 1));
      break;
    }

    case 'thinking': {
      refs.container.y = refs.baseY + Math.sin(t * TAU * 0.9) * 1.6;
      // The antenna "computes" — its glow pulses brighter/faster than idle.
      refs.led.alpha = 0.7 + 0.3 * Math.sin(t * TAU * 2);
      refs.ledGlow.alpha = 0.25 + 0.25 * (0.5 + 0.5 * Math.sin(t * TAU * 2));
      refs.antennaGlow.alpha = 0.3 + 0.4 * (0.5 + 0.5 * Math.sin(t * TAU * 3));
      refs.thoughtBubble.visible = true;
      refs.thoughtBubble.alpha = 0.5 + 0.5 * (0.5 + 0.5 * Math.sin(t * TAU * 1.5));
      // Dots pulse in sequence with a travelling phase offset.
      for (let i = 0; i < 3; i++) {
        const phase = i * 0.22;
        const s = 0.7 + 0.45 * (0.5 + 0.5 * Math.sin((t - phase) * TAU * 2));
        refs.thoughtDots[i]?.scale.set(s);
      }
      break;
    }

    case 'speaking': {
      refs.container.y = refs.baseY + Math.sin(t * TAU * 1.1) * 1.6;
      // Mouth height oscillates 1..6 at 9 Hz (center 3.5, amp 2.5).
      const mouthHeight = 3.5 + 2.5 * Math.sin(t * TAU * 9);
      refs.mouth.scale.set(1, Math.max(0.4, mouthHeight));
      // LED + glow flicker in sympathy with the voice.
      const flick = 0.6 + 0.4 * Math.abs(Math.sin(t * TAU * 9));
      refs.led.alpha = flick;
      refs.ledGlow.alpha = 0.2 + 0.3 * Math.abs(Math.sin(t * TAU * 9));
      refs.antennaGlow.alpha = 0.3;
      break;
    }

    case 'working': {
      // Faster, larger bob + a subtle forward lean as it leans into the work.
      refs.container.y = refs.baseY + Math.sin(t * TAU * 2) * 3.5;
      refs.container.rotation = Math.sin(t * TAU * 2) * 0.03;
      refs.led.alpha = 0.7 + 0.3 * Math.sin(t * TAU * 3);
      refs.ledGlow.alpha = 0.35 + 0.2 * Math.sin(t * TAU * 3);
      refs.antennaGlow.alpha = 0.45 + 0.25 * Math.sin(t * TAU * 4);
      // Spark flicker at 6 Hz, alternating visibility + jitter.
      const phase = Math.sin(t * TAU * 6);
      refs.spark.visible = phase > 0;
      refs.spark.x = (phase > 0 ? 1 : -1) * 6;
      refs.spark.rotation = phase * 0.4;
      refs.spark.scale.set(0.8 + 0.4 * Math.abs(phase));
      break;
    }

    case 'completed': {
      // Squash-and-stretch pop: overshoot to 1.22 then settle to 1.0, with a
      // celebratory little hop, over 0.6s.
      const DURATION = 0.6;
      const k = clamp01(since / DURATION);
      const tri = k < 0.5 ? smooth(k * 2) : smooth((1 - k) * 2);
      refs.container.scale.set(refs.baseScale * (1 + 0.22 * tri));
      refs.container.y = refs.baseY - 6 * tri;
      refs.container.rotation = 0;
      refs.led.alpha = 1;
      refs.ledGlow.alpha = 0.4 + 0.4 * tri;
      refs.antennaGlow.alpha = 0.4 + 0.5 * tri;
      // A brief congratulatory spark at the apex.
      refs.spark.visible = tri > 0.4;
      refs.spark.scale.set(0.9 + 0.6 * tri);
      break;
    }

    case 'error': {
      // Pulsing red flash + an irritated wobble + purple LED alarm.
      const flash = 0.5 + 0.5 * Math.sin(t * TAU * 4);
      // Lerp container tint white → red with the flash.
      const r = 0xff;
      const g = Math.round(0xff - 0xaa * flash);
      const b = Math.round(0xff - 0xaa * flash);
      refs.container.tint = (r << 16) | (g << 8) | b;
      refs.container.rotation = Math.sin(t * TAU * 6) * 0.05;
      refs.container.y = refs.baseY + Math.sin(t * TAU * 6) * 1;
      refs.led.tint = 0xbc13fe;
      refs.led.alpha = 0.5 + 0.5 * Math.sin(t * TAU * 4);
      refs.ledGlow.tint = 0xbc13fe;
      refs.ledGlow.alpha = 0.3 + 0.4 * flash;
      refs.antennaGlow.tint = 0xff5555;
      refs.antennaGlow.alpha = 0.3 + 0.3 * flash;
      break;
    }

    case 'spawning': {
      // Fade in + scale pop from 0.6 → 1.0 over 300 ms (eased).
      const DURATION = 0.3;
      const k = smooth(since / DURATION);
      refs.container.alpha = k;
      refs.container.scale.set(refs.baseScale * (0.6 + 0.4 * k));
      refs.container.y = refs.baseY + (1 - k) * 8;
      refs.led.alpha = k;
      refs.ledGlow.alpha = 0.3 * k;
      refs.antennaGlow.alpha = 0.35 * k;
      break;
    }

    case 'despawning': {
      // Fade out + shrink + sink over 300 ms (eased).
      const DURATION = 0.3;
      const k = smooth(since / DURATION);
      refs.container.alpha = 1 - k;
      refs.container.scale.set(refs.baseScale * (1 - 0.3 * k));
      refs.container.y = refs.baseY + k * 6;
      refs.led.alpha = 1 - k;
      refs.ledGlow.alpha = 0.3 * (1 - k);
      refs.antennaGlow.alpha = 0.35 * (1 - k);
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
