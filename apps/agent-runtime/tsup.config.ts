import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  splitting: false,
  sourcemap: true,
  clean: true,
  bundle: true,
  outDir: 'dist',
  // Source-only workspace packages: their package.json points `exports` at raw
  // `./src/index.ts` with `.js` specifiers Node cannot resolve, so they MUST be
  // bundled in rather than left as external bare imports (a dead-on-arrival
  // sidecar otherwise — see docs/REVIEW-2026-06-10.md §0).
  noExternal: ['@skippy/shared', '@skippy/memory'],
  external: [
    '@anthropic-ai/sdk',
    '@opentelemetry/sdk-node',
    '@opentelemetry/exporter-trace-otlp-http',
    'pino',
    // @skippy/memory's own npm runtime deps stay external (several are CJS that
    // can't be shimmed into ESM via esbuild's `require`, e.g. write-file-atomic
    // / proper-lockfile / gray-matter). They are declared as direct deps of
    // this package so pnpm links them into node_modules and Node resolves the
    // bare imports at runtime. Only @skippy/memory's first-party TS is bundled.
    'chokidar',
    'gray-matter',
    'proper-lockfile',
    'write-file-atomic',
    '@xenova/transformers',
  ],
  banner: { js: '#!/usr/bin/env node' },
});
