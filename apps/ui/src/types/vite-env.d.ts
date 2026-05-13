/// <reference types="vite/client" />

// Tauri injects a global; we don't rely on it directly but declare it so
// renderer code that prefers the global API instead of `@tauri-apps/api` won't
// blow up under strict TS.
declare global {
  interface Window {
    __TAURI__?: unknown;
    __TAURI_INTERNALS__?: unknown;
  }
}

export {};
