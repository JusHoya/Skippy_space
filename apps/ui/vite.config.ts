import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// Tauri expects a fixed dev port and a webview-friendly target.
// See PRD §11 — Vite 6 + React 19 + Tauri 2.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    hmr: { protocol: 'ws', host: 'localhost' },
  },
  resolve: {
    alias: {
      '@skippy/shared': fileURLToPath(new URL('../../packages/shared/src', import.meta.url)),
      '@skippy/sprite-kit': fileURLToPath(new URL('../../packages/sprite-kit/src', import.meta.url)),
    },
  },
  build: {
    target: 'esnext',
    sourcemap: true,
  },
});
