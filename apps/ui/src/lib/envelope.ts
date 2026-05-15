// Re-export the wire envelopes from @skippy/shared so HUD components don't
// need to know whether the schema lives in shared or local. If shared is not
// yet on disk (Agent D is still scaffolding), we keep this file thin so the
// only required edit is here.

export {
  Envelope,
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
  BoardIdSchema,
} from '@skippy/shared';

export type {
  Envelope as EnvelopeT,
  AgentId,
  AgentState,
  BoardId,
  BoardState,
} from '@skippy/shared';
