import { useEffect, useState } from 'react';
import {
  Envelope,
  type AgentId,
  type AgentState,
  type BoardState,
  type MemoryJobEnvelope,
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

// ── Token-stream coalescing (REVIEW-2026-06-10 §4 / perf) ───────────────────
//
// `agent_token` arrives at token rate — many per animation frame during a
// burst. The naive handler wrote BOTH `promptStore.appendToken` (re-renders
// CommandBar + SelectedPanel) and `agentStore.setAgent` (mints a fresh `agents`
// object → re-runs the SceneRoot glow subscription + TopBar + TelemetryPanel +
// SelectedPanel) on EVERY token. Per CLAUDE.md convention #3, streamed text is
// effectively per-frame data and must not thrash Zustand: a burst of N tokens
// should cost at most one render per frame, not N.
//
// So we buffer incoming tokens and flush them in a single batched store write,
// scheduled on the next animation frame (one `appendToken` with the concatenated
// run, one `setAgent` carrying the latest token). The visible narration stays
// correct because tokens are appended in arrival order and a flush always runs
// before `agent_complete` finalizes the prompt. `appendToken`'s own promptId
// guard discards a buffered run whose prompt was superseded mid-flight.

interface PendingTokenRun {
  /** Concatenated token text awaiting a single `appendToken`. */
  text: string;
  /** Newest agent id that emitted into this prompt — drives the speaking glow. */
  agentId: AgentId;
  /** Newest envelope timestamp, surfaced as the agent's `updatedAt`. */
  ts: string;
  /** Newest single token, mirrored to `agentStore` as the `lastToken` peek. */
  lastToken: string;
}

/** Buffered token runs keyed by promptId; drained by `flushTokenBatch`. */
const pendingTokens = new Map<string, PendingTokenRun>();
let tokenFlushHandle: number | null = null;

/**
 * Schedule a single coalesced flush on the next frame. Prefers
 * `requestAnimationFrame` (true per-frame batching in the browser/Tauri webview)
 * and degrades to a macrotask when rAF is unavailable (Node test env, SSR), so
 * the buffer always drains even off-screen.
 */
function scheduleTokenFlush(): void {
  if (tokenFlushHandle !== null) return;
  if (typeof requestAnimationFrame === 'function') {
    tokenFlushHandle = requestAnimationFrame(() => {
      tokenFlushHandle = null;
      flushTokenBatch();
    });
  } else {
    tokenFlushHandle = setTimeout(() => {
      tokenFlushHandle = null;
      flushTokenBatch();
    }, 0) as unknown as number;
  }
}

/**
 * Drain every buffered token run into the stores in one pass: one `appendToken`
 * per prompt and one `setAgent` per emitting agent. Idempotent when the buffer
 * is empty, so `agent_complete` can call it eagerly to guarantee ordering.
 */
export function flushTokenBatch(): void {
  // Cancel any frame/timer already scheduled: we're draining now (often eagerly
  // from agent_complete), so the pending callback would otherwise fire next frame
  // as a no-op — and in tests leave a stray timer running past the case.
  if (tokenFlushHandle !== null) {
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(tokenFlushHandle);
    else clearTimeout(tokenFlushHandle);
    tokenFlushHandle = null;
  }
  if (pendingTokens.size === 0) return;
  const runs = [...pendingTokens.values()];
  const keys = [...pendingTokens.keys()];
  pendingTokens.clear();
  // The per-prompt guards inside the stores make a single batched write
  // equivalent to N per-token writes — minus the N−1 redundant renders.
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]!;
    usePromptStore.getState().appendToken(keys[i]!, run.text);
    useAgentStore.getState().setAgent(run.agentId, {
      state: 'speaking',
      lastToken: run.lastToken,
      updatedAt: run.ts,
    });
  }
}

/** Buffer one streamed token, scheduling a coalesced flush for the next frame. */
function bufferToken(promptId: string, agentId: AgentId, text: string, ts: string): void {
  const existing = pendingTokens.get(promptId);
  if (existing) {
    existing.text += text;
    existing.agentId = agentId;
    existing.ts = ts;
    existing.lastToken = text;
  } else {
    pendingTokens.set(promptId, { text, agentId, ts, lastToken: text });
  }
  scheduleTokenFlush();
}

/** Visible for tests: how many prompts have un-flushed buffered tokens. */
export function _pendingTokenPromptCount(): number {
  return pendingTokens.size;
}

// ── Memory-job activity surface (REVIEW-2026-06-10 §4) ──────────────────────
//
// `memory_job` envelopes carry the four-job Karpathy pipeline's progress
// (ingest/distill/link/lint). They used to be logged and dropped. We publish
// the latest pulse through a tiny module-level ref + subscriber set — the same
// "append-rarely, don't spin up a whole Zustand store" idiom MinimapPane uses
// for pedestal layouts — so a HUD widget (or the future beercan-to-pedestal
// animation) can react to pipeline activity instead of it vanishing.
//
// These pulses are NOT per-frame (a few per pipeline run), so a plain
// React-state mirror is fine; no coalescing needed.

const lastMemoryJobRef: { current: MemoryJobEnvelope | null } = { current: null };
const memoryJobSubs = new Set<(e: MemoryJobEnvelope) => void>();

/** Publish a memory-job pulse to every subscriber and stash it as the latest. */
function publishMemoryJob(env: MemoryJobEnvelope): void {
  lastMemoryJobRef.current = env;
  // Snapshot before iterating so a subscriber unmounting itself synchronously
  // can't shrink the live set mid-loop.
  for (const fn of [...memoryJobSubs]) fn(env);
}

/** The most recent memory-job pulse seen this session, or null if none yet. */
export function latestMemoryJob(): MemoryJobEnvelope | null {
  return lastMemoryJobRef.current;
}

/**
 * React hook: mirror the latest memory-job pulse into component state so a HUD
 * widget can render pipeline progress. Re-renders only on a new pulse (a few
 * per run), never per frame.
 */
export function useMemoryJobActivity(): MemoryJobEnvelope | null {
  const [state, setState] = useState<MemoryJobEnvelope | null>(lastMemoryJobRef.current);
  useEffect(() => {
    const fn = (e: MemoryJobEnvelope): void => setState(e);
    memoryJobSubs.add(fn);
    // Catch up to any pulse that landed before this mount subscribed.
    if (lastMemoryJobRef.current !== null) setState(lastMemoryJobRef.current);
    return () => {
      memoryJobSubs.delete(fn);
    };
  }, []);
  return state;
}

/** Visible for tests: number of live `useMemoryJobActivity` subscribers. */
export function _memoryJobSubscriberCount(): number {
  return memoryJobSubs.size;
}

/**
 * Route a single raw channel message into the appropriate Zustand store
 * (PRD §5.2, §9.2). Extracted from the subscription so it can be driven
 * directly in tests and reused by the module-level singleton below.
 *
 * Per CLAUDE.md, this only carries state that has UI-visible discrete
 * changes — per-frame sprite data does not flow through here. Token-stream
 * text is the one near-per-frame signal: it's coalesced (see `bufferToken`)
 * so a burst causes at most one render per frame.
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
      // Coalesced: buffer the token and flush once per frame instead of
      // re-rendering three HUD components + the scene glow on every token.
      bufferToken(env.promptId, env.agentId, env.text, env.ts);
      break;
    }
    case 'agent_complete': {
      // Drain any tokens still buffered for this turn before finalizing, so the
      // completed prompt's `streamed` text is whole and ordering is preserved.
      flushTokenBatch();
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
    case 'sidecar_status': {
      // The agent-runtime child process died and/or came back. Without this,
      // a crash mid-turn left Skippy (and any board) stuck in 'thinking'/
      // 'speaking' forever — the dead child can never emit the agent_complete
      // that would idle them, and the only signal was a console-bound Log
      // (REVIEW §5 critic, sidecar.rs). On a crash the WHOLE runtime is gone,
      // so every board's query() process died with it: reset the roster back to
      // a lone idle Skippy. The restarted runtime re-announces its boards via
      // its own board_spawned/board_ready envelopes, so the roster rebuilds.
      if (env.event === 'crashed' || env.event === 'restarted') {
        // Drain any tokens buffered for a turn the dead child can't finish, so a
        // stale run can't flush onto the fresh generation after the reset.
        flushTokenBatch();
        useAgentStore.getState().reset();
      }
      const detail = env.detail ? ` — ${env.detail}` : '';
      const note = `[skippy/ui] sidecar ${env.event}${detail}`;
      if (env.event === 'crashed') console.warn(note);
      else console.info(note);
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
      // The four-job pipeline's progress. Previously dropped on the floor; now
      // published to a module-level surface (see `publishMemoryJob`) that the
      // HUD subscribes to via `useMemoryJobActivity`. A later pass animates a
      // beercan walking to the source pedestal off this same signal.
      publishMemoryJob(env);
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
