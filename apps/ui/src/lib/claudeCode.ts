// Typed wrapper around the Rust-side `claude_code_spawn` Tauri command. The
// Rust shell launches `claude` in a `portable-pty` ConPTY and returns the
// spawn metadata; the renderer attaches a TerminalCluster tab to the new
// ptyId via the existing `pty_subscribe` machinery.
//
// PRD §5.1 + §10 + R-01: the `claude` CLI must be Rust-spawned, never from
// Node — the Node-spawning-claude-code combo is known broken (issues #34 /
// #771). The renderer's only job is the IPC call; the shell owns the process.

import type {
  ClaudeCodeSpawnRequest,
  ClaudeCodeSpawnResult,
} from '@skippy/shared';
import { isTauri, safeInvoke } from './tauri';

/**
 * Spawn a `claude` CLI subprocess in a PTY owned by the Rust shell.
 *
 * Returns the spawn metadata on success, or `null` if:
 *   * we're not running inside Tauri (e.g., `pnpm dev` in a plain browser),
 *   * the Rust command rejected (claude not on PATH, cwd invalid, etc.).
 *
 * Failure cases log to the console — the caller can branch on `null` to
 * decide whether to show a toast / fall back. This keeps the renderer from
 * crashing when the dev env doesn't have `claude` installed yet.
 */
/** Mirrors `claude_spawn::SpawnAvailability` on the Rust side. */
export interface ClaudeCodeSpawnAvailability {
  available: boolean;
  reason: string | null;
  ungatedOptIn: boolean;
}

/**
 * Ask the Rust shell whether the PTY claude lane may run. The lane is
 * ineligible by default (FR-SEC-01: no enforced charter policy until T10) and
 * only a developer opt-in (`SKIPPY_ALLOW_UNGATED_CLAUDE_SPAWN=1`) enables it.
 * Outside Tauri, or if the query fails, the answer is "unavailable".
 */
export async function getClaudeCodeSpawnAvailability(): Promise<ClaudeCodeSpawnAvailability> {
  if (!isTauri()) {
    return { available: false, reason: 'not running inside the Tauri shell', ungatedOptIn: false };
  }
  const res = await safeInvoke<ClaudeCodeSpawnAvailability>('claude_code_spawn_availability');
  if (!res) {
    return { available: false, reason: 'availability query failed; treating the lane as ineligible', ungatedOptIn: false };
  }
  return res;
}

export async function spawnClaudeCode(
  req: ClaudeCodeSpawnRequest,
): Promise<ClaudeCodeSpawnResult | null> {
  if (!isTauri()) {
    console.warn(
      '[skippy/ui] spawnClaudeCode: not running inside Tauri — request ignored.',
      req,
    );
    return null;
  }
  return safeInvoke<ClaudeCodeSpawnResult>('claude_code_spawn', {
    parentAgentId: req.parentAgentId,
    taskBrief: req.taskBrief,
    model: req.model,
    cwd: req.cwd,
  });
}
