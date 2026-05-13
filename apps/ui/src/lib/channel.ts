import { useEffect } from 'react';
import { Envelope } from '@skippy/shared';
import { Channel, invoke, isTauri, safeInvoke } from './tauri';
import { useAgentStore } from '../stores/agentStore';
import { usePromptStore } from '../stores/promptStore';

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
