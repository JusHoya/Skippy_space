import { useEffect } from 'react';
import {
  Envelope,
  type AgentId,
  type AgentState,
  type BoardState,
  type ModelId,
  type ModelScope,
} from '@skippy/shared';
import { Channel, invoke, isTauri, safeInvoke } from './tauri';
import { useAgentStore } from '../stores/agentStore';
import { usePromptStore } from '../stores/promptStore';
import { useDelegationStore } from '../stores/delegationStore';
import { useClaudeCodeStore } from '../stores/claudeCodeStore';
import { useTelemetryStore } from '../stores/telemetryStore';
import { useReplayStore } from '../stores/replayStore';

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
 * Route a single raw channel message into the appropriate Zustand store
 * (PRD §5.2, §9.2). Extracted from the subscription so it can be driven
 * directly in tests and reused by the module-level singleton below.
 *
 * Per CLAUDE.md, this only carries state that has UI-visible discrete
 * changes — per-frame sprite data does not flow through here.
 */
export function dispatchEnvelope(raw: unknown): void {
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
    // ── Phase 3-prep variants — Zone 2 + Zone 5 own the real handlers,
    // wired into their respective stores. These cases are no-ops here so
    // the discriminated-union exhaustiveness check still compiles.
    case 'set_model': {
      // Renderer → sidecar direction; we shouldn't normally receive these
      // here, but if the shell echoes one back we drop it silently.
      break;
    }
    case 'claude_code_spawned': {
      // Rust shell opened a `claude` CLI PTY on behalf of a board/Skippy.
      // The renderer's TerminalCluster reads `claudeCodeStore.spawns` to
      // attach a new tab to the assigned ptyId. The task brief was stashed
      // at request time by `spawnClaudeCode` (via `setTaskBrief`); the
      // envelope itself doesn't carry it, so the upsert preserves whatever
      // we have.
      useClaudeCodeStore.getState().upsertFromSpawned(env);
      console.info(
        `[skippy/ui] claude-code spawned pty=${env.ptyId} parent=${env.parentAgentId} model=${env.model}`,
      );
      break;
    }
    case 'claude_code_exited': {
      // Mark the spawn as exited but don't drop it — the user gets to
      // close the tab manually (preserves scrollback for forensics).
      useClaudeCodeStore.getState().markExited(env);
      console.info(
        `[skippy/ui] claude-code exited pty=${env.ptyId} code=${env.exitCode}`,
      );
      break;
    }
    // ── Phase 3 telemetry / memory-job / replay (WS6/WS5/WS8) ──────────────
    case 'telemetry_span': {
      useTelemetryStore.getState().recordSpan(env);
      break;
    }
    case 'context_window': {
      useTelemetryStore.getState().recordContext(env);
      break;
    }
    case 'error_span': {
      useTelemetryStore.getState().recordError(env);
      console.warn(`[skippy/ui] error_span ${env.agentId}: ${env.errorKind} — ${env.message}`);
      break;
    }
    case 'memory_job': {
      // The four-job pipeline's progress. Surfaced as log activity for now;
      // a later pass animates a beercan walking to the source pedestal.
      console.info(
        `[skippy/ui] memory_job ${env.job}:${env.phase}${env.sourcePath ? ` ${env.sourcePath}` : ''}`,
      );
      break;
    }
    case 'replay_session': {
      // WS8: note the active session id so the ReplayScrubber's picker can
      // surface the current session boundary.
      console.info(`[skippy/ui] replay_session ${env.event}: ${env.sessionId}`);
      useReplayStore.getState().setActiveSession(env.sessionId);
      break;
    }
    default: {
      // Exhaustiveness check — TS will yell if we miss a variant.
      const _exhaustive: never = env;
      void _exhaustive;
    }
  }
}

/**
 * Module-level singleton subscription state.
 *
 * Tauri Channels have no explicit `close()` API in v2, and `events_subscribe`
 * registers a *new* live channel in the Rust EventBus on every call. So we
 * must call it exactly once per renderer — calling it again (e.g. under React
 * StrictMode's intentional double-mount, or an HMR remount) would register a
 * second channel and every envelope would be processed twice: `appendToken`
 * (string concat) duplicates streamed tokens and `recordSpan` double-bills the
 * cost meter, neither of which is idempotent.
 *
 * We guard with a ref-count of live mounts: the first mount opens the channel,
 * subsequent mounts only bump the count, and unmounts decrement it. The
 * channel itself is never torn down (the Rust side drains on renderer unload),
 * but it can only ever exist once.
 */
// `Channel` is re-exported from ./tauri as a *value*, so reference its instance
// type via `InstanceType<typeof Channel>` rather than as a bare type.
let activeChannel: InstanceType<typeof Channel> | null = null;
let mountCount = 0;

/** Visible for tests: how many live channel subscriptions exist (0 or 1). */
export function _activeSubscriptionCount(): number {
  return activeChannel === null ? 0 : 1;
}

/** Visible for tests: how many hook mounts currently hold the subscription. */
export function _mountCount(): number {
  return mountCount;
}

// Consecutive subscribe failures, reset on success. Bounds the re-open retry so
// a persistently-down backend can't spin a failing-invoke loop.
let subscribeFailures = 0;
const MAX_RESUBSCRIBE_ATTEMPTS = 3;

function openChannel(): void {
  const ch = new Channel<unknown>();
  ch.onmessage = dispatchEnvelope;
  activeChannel = ch;

  invoke('events_subscribe', { channel: ch })
    .then(() => {
      subscribeFailures = 0;
    })
    .catch((e) => {
      console.error('[skippy/ui] events_subscribe failed:', e);
      if (activeChannel !== ch) return;
      activeChannel = null;
      // A StrictMode-interleaved cleanup can run BEFORE this rejection resolves,
      // so a later mount may have early-returned (seeing this now-doomed channel)
      // and be left holding a live mount with no subscription. If mounts are
      // still live, re-open once so the renderer isn't stranded with no events —
      // bounded so a genuinely-down backend doesn't loop.
      if (mountCount > 0 && subscribeFailures++ < MAX_RESUBSCRIBE_ATTEMPTS) {
        openChannel();
      }
    });
}

function ensureSubscribed(): void {
  mountCount += 1;
  if (activeChannel !== null) {
    // Already subscribed — a second mount (StrictMode/HMR) must NOT open a
    // second channel, or every envelope gets double-processed.
    return;
  }
  openChannel();
}

function releaseSubscription(): void {
  if (mountCount > 0) {
    mountCount -= 1;
  }
  // We deliberately keep `activeChannel` alive even at zero mounts: the Rust
  // EventBus has no per-channel unsubscribe in v2, and holding the reference
  // means a remount reuses the single existing subscription instead of opening
  // a second one. The channel drains when the renderer process unloads.
}

/**
 * The exact body React runs for `useEventChannel`'s effect, factored out so a
 * test can drive the StrictMode mount → cleanup → mount sequence directly
 * (without a DOM/React renderer) and assert the singleton invariant. Returns
 * the cleanup, mirroring `useEffect`'s contract.
 *
 * Exported under the `_`-prefix convention as a test seam; production code
 * should call `useEventChannel`, not this.
 */
export function _subscribeEffect(): () => void {
  if (!isTauri()) {
    console.info('[skippy/ui] useEventChannel: not running inside Tauri, skipping subscription.');
    return () => {};
  }

  ensureSubscribed();
  return () => {
    releaseSubscription();
  };
}

/**
 * Subscribe to the agent event stream (PRD §5.2, §9.2).
 *
 * The Rust shell exposes an `events_subscribe` command that takes a Tauri
 * `Channel<unknown>` and starts streaming JSON envelopes into it. This hook
 * routes each envelope to the appropriate Zustand store via a module-level
 * singleton, so no matter how many components call it — or how many times the
 * effect runs under StrictMode — there is at most one live channel.
 */
export function useEventChannel(): void {
  useEffect(_subscribeEffect, []);
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

/**
 * Rebind a model for a given scope (`skippy` or `board.<id>`) on the sidecar.
 *
 * The Rust shell forwards this to the agent-runtime as a `set_model` JSONL
 * envelope; the runtime's `modelRegistry` updates its in-memory binding so the
 * next call from that scope picks up the new model. In-flight calls keep
 * their original model (per `SetModelEnvelope` docstring in @skippy/shared).
 *
 * The helper is a no-op outside Tauri so the renderer can boot in a plain
 * browser tab during dev without crashing.
 */
export async function dispatchSetModel(
  scope: ModelScope,
  modelId: ModelId,
): Promise<void> {
  if (!isTauri()) {
    console.warn(
      `[skippy/ui] dispatchSetModel: not in Tauri, would have set ${scope} → ${modelId}`,
    );
    return;
  }
  await safeInvoke<void>('dispatch_set_model', { scope, modelId });
}
