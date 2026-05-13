// Animation state union. PRD §12.4.
//
// Mirrors the eight canonical agent visual states. Kept as a string-literal
// union so external code can pattern-match without importing an enum.

export type AnimationState =
  | 'idle'
  | 'thinking'
  | 'speaking'
  | 'working'
  | 'completed'
  | 'error'
  | 'spawning'
  | 'despawning';

export const ANIMATION_STATES: readonly AnimationState[] = [
  'idle',
  'thinking',
  'speaking',
  'working',
  'completed',
  'error',
  'spawning',
  'despawning',
] as const;

export function isAnimationState(s: string): s is AnimationState {
  return (ANIMATION_STATES as readonly string[]).includes(s);
}
