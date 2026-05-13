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
