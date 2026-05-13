// Thin facade over `@tauri-apps/api` so the renderer can degrade gracefully
// when running outside the Tauri shell (e.g., a plain `pnpm dev` open in a
// regular browser tab). In Phase 0 we sometimes test without the shell — these
// no-op fallbacks keep the UI from crashing while still surfacing failures.

import { invoke as tauriInvoke, Channel as TauriChannel } from '@tauri-apps/api/core';

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: unknown;
  }
}

export function isTauri(): boolean {
  return typeof window !== 'undefined' && !!(window.__TAURI_INTERNALS__ ?? window.__TAURI__);
}

/** Re-export the Tauri Channel under our own name for ergonomic imports. */
export const Channel = TauriChannel;

/** Re-export `invoke` plus a `safeInvoke` that won't crash in a plain browser. */
export const invoke = tauriInvoke;

export async function safeInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!isTauri()) {
    console.warn(`[skippy/ui] safeInvoke('${cmd}') called outside Tauri — no-op.`);
    return null;
  }
  try {
    return await tauriInvoke<T>(cmd, args);
  } catch (err) {
    console.error(`[skippy/ui] invoke('${cmd}') failed:`, err);
    return null;
  }
}
