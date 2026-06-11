// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'node_modules/',
      'dist/',
      'build/',
      'out/',
      'target/',
      '**/dist/**',
      '**/.tauri/**',
      '**/target/**',
      'apps/shell/src-tauri/target/**',
      'apps/shell/src-tauri/gen/**',
      'vault/**',
      '**/*.tsbuildinfo',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
      'no-unused-vars': 'off',
      // `try { … } catch {}` to deliberately ignore a failure is an intentional,
      // widely-used pattern in the validators/clients here; only flag OTHER empty blocks.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  // The renderer runs in the Tauri webview — browser globals (window, document,
  // requestAnimationFrame, etc.). Without this every DOM/RAF reference is no-undef.
  {
    files: ['apps/ui/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
  },
  // Everything else is Node: the agent-runtime sidecar, the memory/otel/shared
  // packages, build scripts, validators, and the test files (node:test).
  {
    files: [
      'apps/agent-runtime/**/*.ts',
      'packages/**/*.ts',
      'scripts/**/*.{js,mjs,ts}',
      'tests/**/*.ts',
      '**/*.test.ts',
      '*.{js,mjs,ts}',
    ],
    languageOptions: { globals: { ...globals.node } },
  },
  // Lock-in test files are run via tsx (node:test), not type-gated by the build
  // tsconfig, and a few use `@ts-nocheck` to stay terse — allow it there.
  {
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: { '@typescript-eslint/ban-ts-comment': 'off' },
  },
);
