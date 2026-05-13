import { z } from 'zod';
import { AgentStateSchema } from './states.js';
import { AgentIdSchema } from './agents.js';

const Iso = z.string().datetime({ offset: true });

export const UserPromptEnvelope = z.object({
  type: z.literal('user_prompt'),
  promptId: z.string(),
  text: z.string().min(1),
  ts: Iso,
});

export const AgentStateEnvelope = z.object({
  type: z.literal('agent_state'),
  agentId: AgentIdSchema,
  state: AgentStateSchema,
  promptId: z.string().optional(),
  task: z.string().optional(),
  ts: Iso,
});

export const AgentTokenEnvelope = z.object({
  type: z.literal('agent_token'),
  agentId: AgentIdSchema,
  promptId: z.string(),
  text: z.string(),
  ts: Iso,
});

export const AgentCompleteEnvelope = z.object({
  type: z.literal('agent_complete'),
  agentId: AgentIdSchema,
  promptId: z.string(),
  totalTokens: z.number().int().nonnegative().optional(),
  ts: Iso,
});

export const LogEnvelope = z.object({
  type: z.literal('log'),
  level: z.enum(['debug', 'info', 'warn', 'error', 'fatal']),
  source: z.string(),
  message: z.string(),
  ts: Iso,
});

export const Envelope = z.discriminatedUnion('type', [
  UserPromptEnvelope,
  AgentStateEnvelope,
  AgentTokenEnvelope,
  AgentCompleteEnvelope,
  LogEnvelope,
]);

export type UserPromptEnvelope = z.infer<typeof UserPromptEnvelope>;
export type AgentStateEnvelope = z.infer<typeof AgentStateEnvelope>;
export type AgentTokenEnvelope = z.infer<typeof AgentTokenEnvelope>;
export type AgentCompleteEnvelope = z.infer<typeof AgentCompleteEnvelope>;
export type LogEnvelope = z.infer<typeof LogEnvelope>;
export type Envelope = z.infer<typeof Envelope>;
/** Alias used by agent-runtime to avoid value/type identifier collision on `Envelope`. */
export type EnvelopeT = Envelope;
