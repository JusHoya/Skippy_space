// shutdown.ts — the single, ordered, idempotent graceful-exit path.
//
// There used to be TWO competing shutdown paths: the signal handlers here
// exited after only the OTel drain, racing main()'s full drain in index.ts.
// Whichever won, the loser's work was lost — and SIGTERM/SIGINT never reached
// the full drain at all, so the replay `ended` boundary, the memory-job
// teardown, and board shutdown were silently skipped on a normal app close.
//
// Now there is ONE drain. The caller hands us the complete ordered teardown
// (replay writer flush/close -> memory jobs -> boards -> OTel) once, and we
// guarantee it runs exactly once for whichever trigger fires first:
//   • stdin EOF — the Rust shell closed our stdin; we have no more work.
//   • SIGTERM   — the shell asks us to stop (app close).
//   • SIGINT    — Ctrl+C surfaces here in dev.
// A second signal arriving mid-drain can neither double-run the drain nor abort
// it: it's coalesced onto the in-flight drain promise. After the drain settles
// we exit 0. See PRD §5.1, §14.2.

import { logger } from './logger.js';

/** Async teardown to run exactly once on shutdown. Must not throw fatally. */
export type DrainFn = () => Promise<void>;

/** Hard cap on the drain before we force-exit, so a hung step can't wedge close. */
const DRAIN_TIMEOUT_MS = 8000;

/**
 * Handle returned by {@link setupGracefulShutdown}. `triggerShutdown` lets the
 * caller drive the same single drain from a non-signal path — specifically the
 * stdin-EOF case, where index.ts's readline loop ends naturally and falls
 * through to here rather than waiting for the `process.stdin 'end'` event.
 */
export interface ShutdownHandle {
  /**
   * Run the drain (if not already running/done) and then exit. Resolves once the
   * drain has settled; callers may `await` it, though the process exits anyway.
   */
  triggerShutdown: (reason: string) => Promise<void>;
}

/**
 * Wire SIGTERM/SIGINT to a single ordered, idempotent drain and return a handle
 * the caller can use to trigger that same drain from stdin EOF. The drain runs
 * at most once across all triggers; the first trigger wins and every later one
 * (including a second Ctrl+C) awaits the same in-flight promise instead of
 * starting a second teardown or short-circuiting to `process.exit`.
 *
 * @param drain  the complete ordered teardown (replay -> memory -> boards -> otel).
 * @param exit   process-exit hook; injectable so tests can assert without killing
 *               the test runner. Defaults to `process.exit`.
 */
export function setupGracefulShutdown(
  drain: DrainFn,
  exit: (code: number) => void = (code) => process.exit(code),
): ShutdownHandle {
  // The single in-flight (or settled) drain promise. Null until the first
  // trigger; non-null forever after, which is exactly what makes this
  // idempotent — every later trigger awaits this same promise.
  let draining: Promise<void> | null = null;

  const runDrain = (reason: string): Promise<void> => {
    if (draining) {
      // A drain is already in flight (or finished). Coalesce onto it: a second
      // signal must not double-run the teardown or abort the first one.
      logger.info({ msg: 'shutdown already in progress; ignoring', reason });
      return draining;
    }
    logger.info({ msg: 'shutdown signal', reason });
    // Watchdog: a drain step that HANGS (not just rejects) would never reach
    // exit(0), wedging the sidecar on app-close — the exact failure this path
    // exists to prevent. Race the drain against a force-exit timeout so a stuck
    // teardown still releases the process.
    let timer: ReturnType<typeof setTimeout> | undefined;
    draining = Promise.race([
      drain().catch((err: unknown) => {
        // A failed drain still has to let the process exit — a partial teardown
        // beats a hung sidecar. We log and proceed.
        logger.error({ msg: 'shutdown drain failed', reason, err: String(err) });
      }),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          logger.error({
            msg: 'shutdown drain timed out; forcing exit',
            reason,
            timeoutMs: DRAIN_TIMEOUT_MS,
          });
          resolve();
        }, DRAIN_TIMEOUT_MS);
      }),
    ]).then(() => {
      if (timer) clearTimeout(timer);
      logger.info({ msg: 'shutdown drain complete', reason });
      exit(0);
    });
    return draining;
  };

  process.on('SIGTERM', () => {
    void runDrain('SIGTERM');
  });
  process.on('SIGINT', () => {
    void runDrain('SIGINT');
  });

  return {
    triggerShutdown: (reason: string) => runDrain(reason),
  };
}
