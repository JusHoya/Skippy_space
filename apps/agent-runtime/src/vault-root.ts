// vault-root.ts — resolve the project's vault/ directory.
//
// SKIPPY_VAULT_ROOT wins; otherwise walk up from this module until a `vault/`
// (or pnpm-workspace.yaml) is found. Shared by the memory jobs, the replay
// writer, and the board MCP wiring so they never drift.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function resolveVaultRoot(): string {
  const fromEnv = process.env.SKIPPY_VAULT_ROOT;
  if (fromEnv) return fromEnv;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, 'vault'))) return path.join(dir, 'vault');
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return path.join(dir, 'vault');
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(dir, 'vault');
}
