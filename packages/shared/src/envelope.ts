import { z } from 'zod';
import { AgentStateSchema, BoardStateSchema } from './states.js';
import { AgentIdSchema, BOARDS, type BoardId } from './agents.js';

const Iso = z.string().datetime({ offset: true });

/**
 * Zod enum derived from the canonical BOARDS const so we never have a parallel
 * list of board names drifting from agents.ts. The `BoardId` *type* is already
 * exported from agents.ts; this schema is its runtime validator. The cast
 * preserves the literal union narrowing (rather than widening to `string`)
 * so downstream `z.infer` produces BoardId, not string.
 */
export const BoardIdSchema = z.enum(BOARDS as unknown as readonly [BoardId, ...BoardId[]]);

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

/**
 * Emitted by the sidecar when a Board captain's query() process starts.
 * The board sprite should become present at idle/spawning state.
 */
export const BoardSpawnedEnvelope = z.object({
  type: z.literal('board_spawned'),
  boardId: BoardIdSchema,
  agentId: AgentIdSchema,
  ts: Iso,
  model: z.string(),
});

/**
 * Emitted once the board has loaded its charter and is awaiting orders.
 */
export const BoardReadyEnvelope = z.object({
  type: z.literal('board_ready'),
  boardId: BoardIdSchema,
  agentId: AgentIdSchema,
  ts: Iso,
});

/**
 * Generic board lifecycle pulse — `state` is one of the BoardState values.
 */
export const BoardStateEnvelope = z.object({
  type: z.literal('board_state'),
  boardId: BoardIdSchema,
  agentId: AgentIdSchema,
  state: BoardStateSchema,
  currentTaskId: z.string().optional(),
  ts: Iso,
});

/**
 * Skippy → Board delegation. PRD §5.2: delegate_to_board(board_name,
 * mission_brief, constraints, deadline).
 */
export const DelegationEnvelope = z.object({
  type: z.literal('delegation'),
  delegationId: z.string(),
  fromAgentId: AgentIdSchema,
  toBoardId: BoardIdSchema,
  missionBrief: z.string(),
  constraints: z.array(z.string()).optional(),
  deadline: Iso.optional(),
  ts: Iso,
});

/**
 * Board → Skippy delegation acknowledgement. PRD §5.2: accept | decline |
 * counter_propose, with an optional counter brief.
 */
export const DelegationAckEnvelope = z.object({
  type: z.literal('delegation_ack'),
  delegationId: z.string(),
  fromBoardId: BoardIdSchema,
  decision: z.enum(['accept', 'decline', 'counter_propose']),
  counterText: z.string().optional(),
  ts: Iso,
});

/**
 * Board → Skippy delegation completion. `summary` is plain text suitable for
 * display in the SelectedPanel briefing pane.
 */
export const DelegationCompleteEnvelope = z.object({
  type: z.literal('delegation_complete'),
  delegationId: z.string(),
  fromBoardId: BoardIdSchema,
  result: z.enum(['success', 'failure']),
  summary: z.string(),
  ts: Iso,
});

export const Envelope = z.discriminatedUnion('type', [
  UserPromptEnvelope,
  AgentStateEnvelope,
  AgentTokenEnvelope,
  AgentCompleteEnvelope,
  LogEnvelope,
  BoardSpawnedEnvelope,
  BoardReadyEnvelope,
  BoardStateEnvelope,
  DelegationEnvelope,
  DelegationAckEnvelope,
  DelegationCompleteEnvelope,
]);

export type UserPromptEnvelope = z.infer<typeof UserPromptEnvelope>;
export type AgentStateEnvelope = z.infer<typeof AgentStateEnvelope>;
export type AgentTokenEnvelope = z.infer<typeof AgentTokenEnvelope>;
export type AgentCompleteEnvelope = z.infer<typeof AgentCompleteEnvelope>;
export type LogEnvelope = z.infer<typeof LogEnvelope>;
export type BoardSpawnedEnvelope = z.infer<typeof BoardSpawnedEnvelope>;
export type BoardReadyEnvelope = z.infer<typeof BoardReadyEnvelope>;
export type BoardStateEnvelope = z.infer<typeof BoardStateEnvelope>;
export type DelegationEnvelope = z.infer<typeof DelegationEnvelope>;
export type DelegationAckEnvelope = z.infer<typeof DelegationAckEnvelope>;
export type DelegationCompleteEnvelope = z.infer<typeof DelegationCompleteEnvelope>;
export type Envelope = z.infer<typeof Envelope>;
/** Alias used by agent-runtime to avoid value/type identifier collision on `Envelope`. */
export type EnvelopeT = Envelope;
