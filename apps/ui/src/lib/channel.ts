import { useEffect } from 'react';
import { Envelope, type AgentId, type AgentState, type BoardState } from '@skippy/shared';
import { Channel, invoke, isTauri, safeInvoke } from './tauri';
import { useAgentStore } from '../stores/agentStore';
import { usePromptStore } from '../stores/promptStore';
import { useDelegationStore } from '../stores/delegationStore';

/**
 * Map a Board lifecycle state onto the unified AgentState the sprite scene
 * already understands. Keeping the mapping in one place lets the renderer
 * treat captains and task agents uniformly.
 *
 * - spawning      → thinking   (warming up its query() process)
 * - ready         → idle       (charter loaded, awaiting orders)
 * - working       → working    (1:1 mapping; AGENT_STATES has 'working')
 * - awaiting_input → idle      (board is parked pending Skippy reply)
 * - errored      → error
 * - shutdown     → idle        (the store entry is also removed)
 */
function boardStateToAgentState(s: BoardState): AgentState {
  switch (s) {
    case 'spawning':
      return 'thinking';
    case 'ready':
      return 'idle';
    case 'working':
      return 'working';
    case 'awaiting_input':
      return 'idle';
    case 'errored':
      return 'error';
    case 'shutdown':
      return 'idle';
  }
}

/**
 * Subscribe to the agent event stream (PRD §5.2, §9.2).
 *
 * The Rust shell exposes an `events_subscribe` command that takes a Tauri
 * `Channel<unknown>` and starts streaming JSON envelopes into it. This hook
 * opens one Channel for the lifetime of the renderer and routes each envelope
 * to the appropriate Zustand store. Per CLAUDE.md, this only carries state
 * that has UI-visible discrete changes — per-frame sprite data does not flow
 * through here.
 */
export function useEventChannel(): void {
  useEffect(() => {
    if (!isTauri()) {
      console.info('[skippy/ui] useEventChannel: not running inside Tauri, skipping subscription.');
      return;
    }

    const ch = new Channel<unknown>();
    ch.onmessage = (raw) => {
      const parsed = Envelope.safeParse(raw);
      if (!parsed.success) {
        console.warn('[skippy/ui] bad envelope received:', parsed.error.message, raw);
        return;
      }
      const env = parsed.data;
      switch (env.type) {
        case 'agent_state': {
          useAgentStore.getState().setAgent(env.agentId, {
            state: env.state,
            updatedAt: env.ts,
            ...(env.task !== undefined ? { task: env.task } : {}),
          });
          break;
        }
        case 'agent_token': {
          usePromptStore.getState().appendToken(env.promptId, env.text);
          useAgentStore.getState().setAgent(env.agentId, {
            state: 'speaking',
            lastToken: env.text,
            updatedAt: env.ts,
          });
          break;
        }
        case 'agent_complete': {
          usePromptStore.getState().completePrompt(env.promptId);
          useAgentStore.getState().setAgent(env.agentId, {
            state: 'idle',
            updatedAt: env.ts,
          });
          break;
        }
        case 'log': {
          const level = env.level === 'fatal' ? 'error' : env.level;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const fn = (console as any)[level] ?? console.log;
          fn.call(console, `[${env.source}] ${env.message}`);
          break;
        }
        case 'user_prompt':
          // We mirror these into the prompt store so the side panel shows the
          // outgoing prompt before any tokens come back.
          usePromptStore.getState().setPrompt(env.promptId, env.text);
          break;
        case 'board_spawned': {
          // Board captain's query() process has started — surface the sprite.
          useAgentStore.getState().setAgent(env.agentId as AgentId, {
            state: 'idle',
            updatedAt: env.ts,
          });
          console.info(`[skippy/ui] board spawned: ${env.boardId} (${env.model})`);
          break;
        }
        case 'board_ready': {
          useAgentStore.getState().setAgent(env.agentId as AgentId, {
            state: 'idle',
            updatedAt: env.ts,
          });
          console.info(`[skippy/ui] board ready: ${env.boardId}`);
          break;
        }
        case 'board_state': {
          const mapped = boardStateToAgentState(env.state);
          useAgentStore.getState().setAgent(env.agentId as AgentId, {
            state: mapped,
            updatedAt: env.ts,
            ...(env.currentTaskId !== undefined ? { task: env.currentTaskId } : {}),
          });
          if (env.state === 'shutdown') {
            useAgentStore.getState().removeAgent(env.agentId as AgentId);
          }
          break;
        }
        case 'delegation': {
          // Stash the delegation record; flip the target board into 'thinking'
          // so the sprite signals the new tasking before the board acks.
          useDelegationStore.getState().upsert(env.delegationId, {
            delegationId: env.delegationId,
            fromAgentId: env.fromAgentId,
            toBoardId: env.toBoardId,
            missionBrief: env.missionBrief,
            status: 'pending',
            createdAt: env.ts,
            updatedAt: env.ts,
            ...(env.constraints !== undefined ? { constraints: env.constraints } : {}),
            ...(env.deadline !== undefined ? { deadline: env.deadline } : {}),
          });
          const targetAgentId = `board.${env.toBoardId}` as AgentId;
          useAgentStore.getState().setAgent(targetAgentId, {
            state: 'thinking',
            updatedAt: env.ts,
            task: env.missionBrief,
          });
          console.info(
            `[skippy/ui] delegation ${env.delegationId} → ${env.toBoardId}: ${env.missionBrief.slice(0, 80)}`,
          );
          break;
        }
        case 'delegation_ack': {
          const status =
            env.decision === 'accept'
              ? 'accepted'
              : env.decision === 'decline'
                ? 'declined'
                : 'counter_proposed';
          useDelegationStore
            .getState()
            .setStatus(
              env.delegationId,
              status,
              env.ts,
              env.counterText !== undefined ? { counterText: env.counterText } : undefined,
            );
          const targetAgentId = `board.${env.fromBoardId}` as AgentId;
          const nextState: AgentState = env.decision === 'accept' ? 'speaking' : 'idle';
          useAgentStore.getState().setAgent(targetAgentId, {
            state: nextState,
            updatedAt: env.ts,
          });
          console.info(`[skippy/ui] delegation ${env.delegationId} ack: ${env.decision}`);
          break;
        }
        case 'delegation_complete': {
          const status = env.result === 'success' ? 'succeeded' : 'failed';
          useDelegationStore.getState().setStatus(env.delegationId, status, env.ts, {
            result: env.result,
            summary: env.summary,
          });
          const targetAgentId = `board.${env.fromBoardId}` as AgentId;
          useAgentStore.getState().setAgent(targetAgentId, {
            state: 'idle',
            updatedAt: env.ts,
          });
          console.info(
            `[skippy/ui] delegation ${env.delegationId} complete (${env.result}): ${env.summary.slice(0, 80)}`,
          );
          break;
        }
        default: {
          // Exhaustiveness check — TS will yell if we miss a variant.
          const _exhaustive: never = env;
          void _exhaustive;
        }
      }
    };

    invoke('events_subscribe', { channel: ch }).catch((e) => {
      console.error('[skippy/ui] events_subscribe failed:', e);
    });

    // Tauri Channels have no explicit `close()` API in v2. The Rust side is
    // expected to drain when the renderer unloads. If this hook were ever
    // remounted (HMR), we accept the resulting double-subscribe; the store
    // writes are idempotent.
    return () => {};
  }, []);
}

/**
 * Dispatch a user prompt to Skippy. The shell returns the assigned promptId
 * (a ULID) so the renderer can correlate streaming tokens back to the source
 * prompt.
 */
export async function dispatchPrompt(text: string): Promise<string | null> {
  if (!isTauri()) {
    console.warn('[skippy/ui] dispatchPrompt: not in Tauri, would have dispatched:', text);
    return null;
  }
  return safeInvoke<string>('dispatch_user_prompt', { text });
}
