// vault-watcher.ts — chokidar v5 inbox watcher for the Ingest job (PRD §8.5).
//
// `watchInbox` fires `onFile(absPath)` once per *stable* file added under
// `vault/00_Inbox/` (the trigger for Job 1, `research.ingest`). The agent-runtime
// wires this to `runPipeline`; this module stays dependency-light (chokidar only)
// and never imports the jobs so it can be unit-tested in isolation.
//
// RETRY + RECOVERY (PRD §8.5 — a drop must not strand on a transient failure):
// Job 1 *removes* a drop from `00_Inbox/` only on success; a failed ingest leaves
// the file in place. So a file lingering in the inbox is, by definition, work that
// still needs doing. We treat the inbox as the queue:
//   - on startup we scan `00_Inbox/` for pre-existing drops (chokidar's
//     `ignoreInitial` would otherwise skip them) and enqueue each one;
//   - a path is added to the in-flight `seen` set only while/after a *successful*
//     `onFile`; a throwing/rejecting `onFile` drops the path back out of `seen` so
//     it's eligible to be retried;
//   - a bounded periodic re-scan re-enqueues any file still present on disk and not
//     currently in `seen` — which is exactly the set of {pre-existing drops we may
//     have missed, drops whose last ingest failed}. Successful drops are unlinked
//     by Job 1, so they never reappear in the re-scan.
//
// chokidar v5 notes (the installed version):
//   - `watch(paths, options)` returns an `FSWatcher` EventEmitter; we listen on
//     `'add'` (new file) and `'error'`.
//   - v5 DROPPED glob support, so `ignored` is a *function* matcher, not a glob.
//   - `awaitWriteFinish` lets a large/streamed drop settle before we ingest it,
//     so we don't read a half-written file (a partial-write the charter warns of).
//   - `.close()` returns a Promise — we expose it as-is.

import { promises as fs, type Dirent } from 'node:fs';
import * as path from 'node:path';

import { watch, type FSWatcher } from 'chokidar';

/** Default cadence for the recovery re-scan that retries stranded drops. */
const DEFAULT_RESCAN_MS = 60_000;

export interface WatchInboxOptions {
  /** Absolute path to the vault root (folder containing `00_Inbox/`). */
  vaultRoot: string;
  /**
   * Called once per stable added file, with its absolute path. May be async; if it
   * throws or rejects the drop is left eligible for retry (not marked as done), so
   * a transient ingest failure self-heals on the next re-scan rather than stranding.
   */
  onFile: (absPath: string) => void | Promise<void>;
  /** Override the watched directory (defaults to `<vaultRoot>/00_Inbox`). */
  dir?: string;
  /**
   * Interval (ms) for the recovery re-scan that re-enqueues stranded/failed drops.
   * Defaults to 60s. Set `0` to disable the periodic re-scan (the startup scan and
   * live `add` events still fire) — primarily for deterministic tests.
   */
  rescanMs?: number;
}

export interface InboxWatcher {
  /** Stop watching and release fs handles. */
  close(): Promise<void>;
}

/** Matcher: ignore dotfiles, `.git`, `.obsidian`, and `*.tmp` (and our lockfiles). */
function shouldIgnore(p: string): boolean {
  const base = path.basename(p);
  if (base.startsWith('.')) return true; // dotfiles + dotdirs (.git, .obsidian, .smart-env)
  if (base.endsWith('.tmp')) return true;
  if (base.endsWith('.lock')) return true;
  // Defensive: catch nested .git/.obsidian segments regardless of basename.
  const norm = p.replace(/\\/g, '/');
  if (/\/\.git\//.test(norm) || /\/\.obsidian\//.test(norm)) return true;
  return false;
}

/**
 * Watch `vault/00_Inbox/` (or `dir`) and invoke `onFile(absPath)` once per stable
 * added file. Debounces duplicate fs events (some platforms emit `add` twice) by
 * tracking seen paths until they're unlinked. On startup it scans for pre-existing
 * drops, and a bounded periodic re-scan retries any drop whose ingest failed (it
 * was dropped from `seen`) — so nothing strands. Graceful: if the directory does
 * not exist, logs a warning and returns a no-op watcher (never throws).
 */
export function watchInbox(opts: WatchInboxOptions): InboxWatcher {
  const dir = opts.dir ?? path.join(opts.vaultRoot, '00_Inbox');
  const rescanMs = opts.rescanMs ?? DEFAULT_RESCAN_MS;

  // chokidar will happily watch a not-yet-existing path, but per the charter we
  // prefer an explicit, friendly degrade when the inbox is absent.
  let watcher: FSWatcher | null = null;
  let rescanTimer: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  // `seen` holds paths that are either in-flight or already ingested. A path is
  // only retained on success; a failed `onFile` removes it so the re-scan retries.
  const seen = new Set<string>();
  // Paths whose `onFile` is currently running — guards the re-scan from launching a
  // second ingest of the same drop while the first is still settling.
  const inFlight = new Set<string>();

  /**
   * Run `onFile` for one drop with full debounce + retry bookkeeping. Adds the path
   * to `seen` up front (so concurrent events/re-scans don't double-fire), then, if
   * the handler throws/rejects, removes it from `seen` so a later re-scan retries.
   */
  async function dispatch(abs: string): Promise<void> {
    if (closed) return;
    if (seen.has(abs) || inFlight.has(abs)) return; // debounce duplicate triggers
    seen.add(abs);
    inFlight.add(abs);
    try {
      await opts.onFile(abs);
    } catch (err) {
      // Failed ingest: make the drop retry-eligible again (it's still in 00_Inbox).
      seen.delete(abs);
      // eslint-disable-next-line no-console
      console.error('[vault-watcher] onFile failed; will retry on next scan:', err);
    } finally {
      inFlight.delete(abs);
    }
  }

  /**
   * Scan the inbox directory and enqueue every present, non-ignored file that isn't
   * already seen/in-flight. Used once at startup (to catch pre-existing drops that
   * `ignoreInitial` skips) and on each recovery interval (to retry stranded drops).
   */
  async function scanInbox(): Promise<void> {
    if (closed) return;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // dir vanished mid-session — the watcher's error path will surface it
    }
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      const abs = path.resolve(dir, ent.name);
      if (shouldIgnore(abs)) continue;
      if (seen.has(abs) || inFlight.has(abs)) continue;
      void dispatch(abs);
    }
  }

  // Kick off an existence check; if the dir is missing, stay a no-op.
  void fs
    .stat(dir)
    .then(async (st) => {
      if (closed) return;
      if (!st.isDirectory()) {
        // eslint-disable-next-line no-console
        console.warn(`[vault-watcher] ${dir} is not a directory; watcher is a no-op.`);
        return;
      }
      watcher = watch(dir, {
        persistent: true,
        ignoreInitial: true,
        ignored: (p: string) => shouldIgnore(p),
        awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
      });

      watcher.on('add', (addedPath: string) => {
        void dispatch(path.resolve(addedPath));
      });

      // Allow re-processing a path if it's removed and re-added later. (Job 1 unlinks
      // a drop on success, so this also clears the `seen` entry for completed work.)
      watcher.on('unlink', (removedPath: string) => {
        seen.delete(path.resolve(removedPath));
      });

      watcher.on('error', (err: unknown) => {
        // eslint-disable-next-line no-console
        console.error('[vault-watcher] watch error:', err);
      });

      // Startup recovery: enqueue any drop already sitting in the inbox (pre-existing
      // or stranded by a crash mid-ingest) that ignoreInitial would otherwise skip.
      await scanInbox();

      // Periodic recovery: retry drops whose last ingest failed (removed from `seen`).
      if (rescanMs > 0) {
        rescanTimer = setInterval(() => void scanInbox(), rescanMs);
        // Don't keep the process alive solely for the re-scan timer.
        rescanTimer.unref?.();
      }
    })
    .catch(() => {
      // eslint-disable-next-line no-console
      console.warn(`[vault-watcher] ${dir} does not exist; watcher is a no-op.`);
    });

  return {
    async close(): Promise<void> {
      closed = true;
      if (rescanTimer) {
        clearInterval(rescanTimer);
        rescanTimer = null;
      }
      if (watcher) {
        await watcher.close();
        watcher = null;
      }
      seen.clear();
      inFlight.clear();
    },
  };
}
