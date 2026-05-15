import { z } from 'zod';

export const AGENT_STATES = [
  'idle',
  'thinking',
  'speaking',
  'working',
  'completed',
  'error',
  'spawning',
  'despawning',
] as const;

export type AgentState = (typeof AGENT_STATES)[number];

export const AgentStateSchema = z.enum(AGENT_STATES);

/**
 * Lifecycle state of a Board captain process (PRD §5.1, §5.2).
 *
 * Mapped to AgentState by the channel router so the UI can render a single
 * unified sprite state across all agent kinds. The mapping lives in
 * `apps/ui/src/lib/channel.ts`.
 */
export const BOARD_STATES = [
  'spawning',
  'ready',
  'working',
  'awaiting_input',
  'errored',
  'shutdown',
] as const;

export type BoardState = (typeof BOARD_STATES)[number];

export const BoardStateSchema = z.enum(BOARD_STATES);
