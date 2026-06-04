// replay-writer.ts — per-session .replay file writer (PRD §9.5, WS8/D5).
//
// Every sidecar session TEEs the full envelope stream to a newline-delimited
// JSON file under `vault/.skippy/replays/<sessionId>.jsonl`. The ReplayScrubber
// in the renderer later loads one of these files and lets the user scrub the
// session frame-by-frame, reconstructing "what each agent knew" at any index.
//
// Dependency inversion: this module is registered as a *sink* on protocol.ts's
// `writeEnvelope` via `registerReplaySink` (see index.ts), so protocol.ts never
// imports us — that would form an eval-time cycle.
//
// GRACEFUL DEGRADATION: a replay-disk problem must NEVER break the sidecar.
//   • If `vault/.skippy/` is unwritable, we log a warn and disable the writer
//     (append becomes a no-op); the sidecar keeps running.
//   • `appendToReplay` never throws — it logs+swallows on error.
//   • Set `SKIPPY_REPLAY=0` to disable the subsystem entirely (index.ts skips
//     `initReplayWriter`).

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';

import { ulid } from 'ulid';

import { logger } from './logger.js';

/** Open file descriptor for the active replay file, or null when disabled. */
let fd: number | null = null;
/** Whether the writer is live (a file is open and appendable). */
let enabled = false;

/**
 * Mint a ULID sessionId, ensure `<vaultRoot>/.skippy/replays/` exists, and open
 * `<sessionId>.jsonl` for append. Returns the sessionId + absolute path.
 *
 * On any filesystem error the writer is disabled (append no-ops) but we still
 * return a sessionId + the path we *would* have written, so the caller can emit
 * a coherent `replay_session` envelope. The sidecar continues regardless.
 */
export function initReplayWriter(vaultRoot: string): { sessionId: string; path: string } {
  const sessionId = ulid();
  const replaysDir = path.join(vaultRoot, '.skippy', 'replays');
  const filePath = path.join(replaysDir, `${sessionId}.jsonl`);

  try {
    if (!existsSync(replaysDir)) {
      mkdirSync(replaysDir, { recursive: true });
    }
    // 'a' = append, creating the file if absent.
    fd = openSync(filePath, 'a');
    enabled = true;
    logger.info({ msg: 'replay writer started', sessionId, path: filePath });
  } catch (err) {
    fd = null;
    enabled = false;
    logger.warn({
      msg: 'replay writer disabled — replays dir unwritable',
      path: replaysDir,
      err: String(err),
    });
  }

  return { sessionId, path: filePath };
}

/**
 * Append one envelope to the active replay file as a JSON line. Best-effort:
 * never throws. On a write error we log once and disable the writer so we don't
 * spam the log on a persistently-bad disk.
 */
export function appendToReplay(env: unknown): void {
  if (!enabled || fd === null) return;
  try {
    writeSync(fd, JSON.stringify(env) + '\n');
  } catch (err) {
    logger.warn({ msg: 'replay append failed; disabling writer', err: String(err) });
    // Disable so subsequent envelopes don't keep failing/logging.
    enabled = false;
    try {
      if (fd !== null) closeSync(fd);
    } catch {
      // already half-closed — nothing actionable.
    }
    fd = null;
  }
}

/** Flush + close the replay file. Idempotent; safe to call when disabled. */
export async function closeReplayWriter(): Promise<void> {
  if (fd === null) {
    enabled = false;
    return;
  }
  try {
    closeSync(fd);
  } catch (err) {
    logger.warn({ msg: 'replay close failed', err: String(err) });
  } finally {
    fd = null;
    enabled = false;
  }
  // Returned as a Promise so callers can `await` symmetrically with the rest of
  // the shutdown drain, even though closeSync is synchronous.
  return;
}
