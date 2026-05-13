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
  noExternal: ['@skippy/shared'],
  external: [
    '@anthropic-ai/sdk',
    '@opentelemetry/sdk-node',
    '@opentelemetry/exporter-trace-otlp-http',
    'pino',
  ],
  banner: { js: '#!/usr/bin/env node' },
});
