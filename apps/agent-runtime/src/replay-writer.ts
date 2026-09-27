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
// CONTAINMENT (FR-SEC-02; M0 red-team round 2, N2). The replay stream is a vault
// write that does not go through the note broker (it is listed, with this
// justification, in vault-broker.ts's exempt-writer header): it is an
// append-only JSONL log with no §8.3 frontmatter that needs one long-lived fd.
// It still gets the broker's containment proof:
//   • the path `.skippy/replays/<ulid>.jsonl` is resolved with
//     `resolveContained`, allowing ONLY the `.skippy` hidden segment (on the
//     lexical AND the real path, so a `.skippy` junction to `.git`, or to
//     anywhere outside the vault, is rejected);
//   • `.skippy/` and `replays/` are created one level at a time with
//     `ensureContainedParentDir`, re-proving containment after each level;
//   • containment is rechecked immediately before the open; the file is created
//     with 'wx' (O_CREAT|O_EXCL — never opens or follows an existing path) and
//     the open fd must be a single-link regular file, rechecked after the open.
// If any of that fails the writer disables itself with a logged ERROR — it never
// falls back to writing somewhere else.
//
// The containment helpers are async while `initReplayWriter` stays synchronous
// (index.ts emits the `replay_session: started` envelope right after it), so
// envelopes appended while the file is being opened are buffered (bounded) and
// flushed once it is open; `closeReplayWriter` awaits the open first.
//
// GRACEFUL DEGRADATION: a replay-disk problem must NEVER break the sidecar.
//   • `appendToReplay` never throws — it logs+swallows on error.
//   • Set `SKIPPY_REPLAY=0` to disable the subsystem entirely (index.ts skips
//     `initReplayWriter`).

import { closeSync, fstatSync, openSync, writeSync } from 'node:fs';
import path from 'node:path';

import {
  ensureContainedParentDir,
  recheckContained,
  resolveContained,
} from '@skippy/memory';
import { ulid } from 'ulid';

import { logger } from './logger.js';

/** Max envelopes buffered while the replay file is being opened. */
const MAX_PENDING_LINES = 10_000;

/** Open file descriptor for the active replay file, or null when not open. */
let fd: number | null = null;
/** 'opening' buffers, 'open' writes, 'disabled' drops. */
let state: 'idle' | 'opening' | 'open' | 'disabled' = 'idle';
let pendingLines: string[] = [];
let opening: Promise<void> | null = null;
let overflowLogged = false;

/** Contained, O_EXCL open of `.skippy/replays/<sessionId>.jsonl`. Returns the fd. */
async function openContainedReplay(vaultRoot: string, sessionId: string): Promise<number> {
  const rel = `.skippy/replays/${sessionId}.jsonl`;
  const cp = await resolveContained(vaultRoot, rel, { allowHiddenNames: ['.skippy'] });
  const realParent = await ensureContainedParentDir(cp);
  const target = path.join(realParent, path.basename(cp.abs));
  if (await recheckContained(cp, target)) {
    throw new Error(`replay file ${rel} already exists; refusing to reuse it`);
  }
  // 'wx' = O_CREAT|O_EXCL: fails on any existing entry, so it cannot follow a
  // planted hardlink/symlink.
  const newFd = openSync(target, 'wx');
  try {
    const st = fstatSync(newFd);
    if (!st.isFile() || st.nlink !== 1) {
      throw new Error(`replay file ${rel} is not a fresh single-link regular file`);
    }
    // Re-prove containment now that it exists (not a link, single link, contained).
    await recheckContained(cp, target);
    return newFd;
  } catch (err) {
    try {
      closeSync(newFd);
    } catch {
      // nothing actionable
    }
    throw err;
  }
}

function disable(): void {
  state = 'disabled';
  pendingLines = [];
  if (fd !== null) {
    try {
      closeSync(fd);
    } catch {
      // already half-closed — nothing actionable.
    }
  }
  fd = null;
}

/**
 * Mint a ULID sessionId and start opening `<vaultRoot>/.skippy/replays/<sessionId>.jsonl`
 * (contained, see the module header). Returns the sessionId + the path it will
 * write. Envelopes appended before the open completes are buffered.
 *
 * On any containment or filesystem error the writer is disabled (append no-ops,
 * an error is logged) but we still return a sessionId + the path we *would* have
 * written, so the caller can emit a coherent `replay_session` envelope. The
 * sidecar continues regardless.
 */
export function initReplayWriter(vaultRoot: string): { sessionId: string; path: string } {
  if (fd !== null || state === 'opening') disable();
  const sessionId = ulid();
  const filePath = path.join(vaultRoot, '.skippy', 'replays', `${sessionId}.jsonl`);
  state = 'opening';
  pendingLines = [];
  overflowLogged = false;

  const thisOpen: Promise<void> = openContainedReplay(vaultRoot, sessionId).then(
    (newFd) => {
      if (opening !== thisOpen || state !== 'opening') {
        // Superseded or closed while opening.
        try {
          closeSync(newFd);
        } catch {
          // nothing actionable
        }
        return;
      }
      fd = newFd;
      state = 'open';
      const lines = pendingLines;
      pendingLines = [];
      try {
        if (lines.length > 0) writeSync(newFd, lines.join(''));
      } catch (err) {
        logger.warn({ msg: 'replay flush failed; disabling writer', err: String(err) });
        disable();
        return;
      }
      logger.info({ msg: 'replay writer started', sessionId, path: filePath });
    },
    (err: unknown) => {
      if (opening === thisOpen) disable();
      logger.error({
        msg: 'replay writer disabled — replay path failed vault containment or is unwritable; nothing was written',
        path: filePath,
        err: String(err),
      });
    },
  );
  opening = thisOpen;
  return { sessionId, path: filePath };
}

/**
 * Append one envelope to the active replay file as a JSON line. Best-effort:
 * never throws. On a write error we log once and disable the writer so we don't
 * spam the log on a persistently-bad disk.
 */
export function appendToReplay(env: unknown): void {
  if (state === 'opening') {
    if (pendingLines.length >= MAX_PENDING_LINES) {
      if (!overflowLogged) {
        overflowLogged = true;
        logger.warn({ msg: 'replay buffer full while opening; dropping envelopes' });
      }
      return;
    }
    try {
      pendingLines.push(JSON.stringify(env) + '\n');
    } catch (err) {
      logger.warn({ msg: 'replay envelope not serializable', err: String(err) });
    }
    return;
  }
  if (state !== 'open' || fd === null) return;
  try {
    writeSync(fd, JSON.stringify(env) + '\n');
  } catch (err) {
    logger.warn({ msg: 'replay append failed; disabling writer', err: String(err) });
    // Disable so subsequent envelopes don't keep failing/logging.
    disable();
  }
}

/** Flush + close the replay file. Idempotent; safe to call when disabled. */
export async function closeReplayWriter(): Promise<void> {
  if (opening) await opening.catch(() => {});
  opening = null;
  if (fd === null) {
    state = 'idle';
    pendingLines = [];
    return;
  }
  try {
    closeSync(fd);
  } catch (err) {
    logger.warn({ msg: 'replay close failed', err: String(err) });
  } finally {
    fd = null;
    state = 'idle';
    pendingLines = [];
  }
}
