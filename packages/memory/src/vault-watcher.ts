// vault-watcher.ts — chokidar v5 inbox watcher for the Ingest job (PRD §8.5).
//
// `watchInbox` fires `onFile(absPath)` once per *stable* file added under
// `vault/00_Inbox/` (the trigger for Job 1, `research.ingest`). The agent-runtime
// wires this to `runPipeline`; this module stays dependency-light (chokidar only)
// and never imports the jobs so it can be unit-tested in isolation.
//
// chokidar v5 notes (the installed version):
//   - `watch(paths, options)` returns an `FSWatcher` EventEmitter; we listen on
//     `'add'`, `'addDir'`, `'change'` and `'error'`.
//   - v5 DROPPED glob support, so `ignored` is a *function* matcher, not a glob.
//   - `awaitWriteFinish` lets a large/streamed drop settle before we ingest it,
//     so we don't read a half-written file (a partial-write the charter warns of).
//   - `followSymlinks: false` (N1): a junction/symlink inside the inbox (e.g.
//     `00_Inbox/o -> 60_Sources/originals`, `00_Inbox/j -> .obsidian`) is never
//     descended into, so files behind it are never enqueued; the link entry
//     itself is reported as rejected (`reparse-point`).
//   - `.close()` returns a Promise — we expose it as-is.
//
// E4-2/N5 (resumability): a crash between a drop landing and the watcher
// starting (or the sidecar restarting mid-backlog) must not strand that file
// unprocessed forever. On start, before wiring chokidar, we scan the inbox
// RECURSIVELY (depth-bounded by MAX_SCAN_DEPTH, never through reparse points or
// hidden entries, skipping our sidecars and temp files) and enqueue every
// existing file; chokidar's own watch is limited to live events
// (`ignoreInitial: true`). `'change'` is listened to (not just `'add'`) so a
// file that previously failed (e.g. bad encoding) and is later overwritten with
// valid content is retried. Retry is content-hash-gated via the
// `.ingest-error.json` sidecar's recorded `contentSha256` (errors.ts):
// unchanged content is never re-enqueued (no infinite fail loop).
//
// N6: every candidate is checked with the same strict inbox rules as
// `runIngest` (ingest/containment.ts) and its size is checked with `stat`
// BEFORE reading. A rejected file (reparse point, hardlink, 8.3/reserved name,
// larger than MAX_INGEST_BYTES, unreadable) is reported through `onRejected`
// (or, if no `onRejected` is given, `onUnsupported`) — never silently dropped
// as "gone". Only ENOENT (the file really vanished) is silent.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { watch, type FSWatcher } from 'chokidar';

import {
  INGEST_ERRORS_DIR,
  IngestSourceRejectedError,
  MAX_INGEST_BYTES,
  readInboxFile,
  type IngestRejectReason,
} from './ingest/containment.js';
import { INGEST_ERROR_SUFFIX, readIngestError } from './ingest/errors.js';
import { extensionOf, isSupportedExtension } from './ingest/extractors.js';
import { sha256Hex } from './ingest/originals.js';
import { cmpKey } from './vault-path.js';

/** Maximum inbox nesting the startup scan and the live watch descend into. */
export const MAX_SCAN_DEPTH = 8;

export interface WatchInboxOptions {
  /** Absolute path to the vault root (folder containing `00_Inbox/`). */
  vaultRoot: string;
  /** Called once per stable added/changed file with a DECLARED extractor, with its absolute path. */
  onFile: (absPath: string) => void;
  /**
   * Called once per stable added/changed file whose extension has no declared
   * extractor (FR-WIKI-03: "unsupported formats stay intact with errors").
   * The file is reported here instead of being handed to `onFile` — it is
   * never read as UTF-8 or enqueued for extraction by the watcher. (Calling
   * `runIngest` directly on such a file still writes the same explicit
   * `.ingest-error.json` sidecar; this callback is the watcher-level report.)
   */
  onUnsupported?: (absPath: string, ext: string) => void;
  /**
   * Called for an inbox entry that ingest must not read (N1/N6): a
   * junction/symlink, a hardlinked file, a path the vault rules reject (8.3
   * `~<digit>`, reserved device name, ...), a file over `MAX_INGEST_BYTES`, or
   * one that cannot be read. The agent-runtime records a sidecar for it
   * (`recordIngestRejection`). Falls back to `onUnsupported` when absent.
   */
  onRejected?: (absPath: string, reason: IngestRejectReason, detail: string) => void;
  /** Override the watched directory (defaults to `<vaultRoot>/00_Inbox`). */
  dir?: string;
}

export interface InboxWatcher {
  /** Stop watching and release fs handles. */
  close(): Promise<void>;
}

/**
 * Matcher: ignore dotfiles/dotdirs (`.git`, `.obsidian`, our hidden
 * `.*.ingest-tmp` staging files and `.skippy-*.tmp` atomic-write temps),
 * `*.tmp`/`*.lock`, our own `.ingest-error.json` sidecars and their
 * `_ingest-errors/` fallback folder (so a written error report is never itself
 * re-enqueued as a new drop).
 */
function shouldIgnore(dir: string, p: string): boolean {
  const base = path.basename(p);
  if (base.startsWith('.')) return true;
  if (base.endsWith('.tmp')) return true;
  if (base.endsWith('.lock')) return true;
  if (base.endsWith('.ingest-tmp')) return true;
  if (base.endsWith(INGEST_ERROR_SUFFIX)) return true;
  // Defensive: any hidden segment, or the sidecar fallback folder, anywhere
  // below the watched directory (not above it: the vault root may live under
  // a dot-directory).
  const rel = path.relative(dir, p);
  if (rel === '' || path.isAbsolute(rel) || rel.startsWith('..')) return false;
  const segs = rel.split(/[\\/]+/);
  if (segs.some((s) => s.startsWith('.'))) return true;
  if (segs.some((s) => s.toLowerCase() === INGEST_ERRORS_DIR)) return true;
  return false;
}

/**
 * Watch `vault/00_Inbox/` (or `dir`) and invoke `onFile(absPath)` once per
 * stable added/changed file. Debounces duplicate/unchanged-content fs events
 * by tracking the last content hash enqueued per path — a `change` event
 * whose bytes hash the same as last time is a no-op; different bytes (or a
 * fresh `add`) always re-evaluates. Graceful: if the directory does not
 * exist, logs a warning and returns a no-op watcher (never throws).
 */
export function watchInbox(opts: WatchInboxOptions): InboxWatcher {
  const dir = opts.dir ?? path.join(opts.vaultRoot, '00_Inbox');
  const dirAbsRoot = path.resolve(dir);

  let watcher: FSWatcher | null = null;
  let closed = false;
  // abs path -> content hash (or rejection fingerprint) we last dispatched for.
  const lastEnqueuedHash = new Map<string, string>();

  function reject(abs: string, reason: IngestRejectReason, detail: string, fingerprint: string): void {
    const key = `reject:${reason}:${fingerprint}`;
    if (lastEnqueuedHash.get(abs) === key) return;
    lastEnqueuedHash.set(abs, key);
    console.warn(`[vault-watcher] rejected ${abs} (${reason}): ${detail}`);
    try {
      if (opts.onRejected) opts.onRejected(abs, reason, detail);
      else opts.onUnsupported?.(abs, extensionOf(abs));
    } catch (err) {
      console.error('[vault-watcher] onRejected handler threw:', err);
    }
  }

  /**
   * Decide whether `abs` should be (re-)enqueued and dispatch it. Checks the
   * entry with lstat (never following a link), the strict inbox rules and the
   * size cap before reading; a file that vanished mid-check is silently
   * skipped. A file whose recorded `.ingest-error.json` sidecar already covers
   * this EXACT content hash is skipped too (E4-2: no infinite fail-retry loop).
   */
  async function maybeEnqueue(abs: string): Promise<void> {
    if (closed || shouldIgnore(dirAbsRoot, abs)) return;
    let lst;
    try {
      lst = await fs.lstat(abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; // gone already
      reject(abs, 'read-error', String(err), 'lstat');
      return;
    }
    const fingerprint = `${lst.size}:${lst.mtimeMs}`;
    if (lst.isSymbolicLink()) {
      reject(abs, 'reparse-point', 'junctions/symlinks in the inbox are not followed', fingerprint);
      return;
    }
    if (lst.isDirectory()) return;
    if (!lst.isFile()) {
      reject(abs, 'not-a-file', 'not a regular file', fingerprint);
      return;
    }
    if (lst.size > MAX_INGEST_BYTES) {
      reject(abs, 'too-large', `${lst.size} bytes exceeds the ${MAX_INGEST_BYTES}-byte ingest limit`, fingerprint);
      return;
    }

    let buf: Buffer;
    try {
      buf = (await readInboxFile(opts.vaultRoot, abs)).bytes;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; // removed by a concurrent ingest
      if (err instanceof IngestSourceRejectedError) {
        reject(abs, err.reason, err.message, fingerprint);
      } else {
        reject(abs, 'read-error', String(err), fingerprint);
      }
      return;
    }
    const hash = sha256Hex(buf);
    if (lastEnqueuedHash.get(abs) === hash) return; // already handled this exact content

    const errRec = await readIngestError(opts.vaultRoot, abs).catch(() => null);
    if (errRec && errRec.contentSha256 === hash) {
      // This exact content already failed and was recorded; don't loop.
      lastEnqueuedHash.set(abs, hash);
      return;
    }

    lastEnqueuedHash.set(abs, hash);

    if (!isSupportedExtension(abs)) {
      const ext = extensionOf(abs);
      console.warn(`[vault-watcher] unsupported extension "${ext}" for ${abs}; not enqueued.`);
      try {
        opts.onUnsupported?.(abs, ext);
      } catch (err) {
        console.error('[vault-watcher] onUnsupported handler threw:', err);
      }
      return;
    }

    try {
      opts.onFile(abs);
    } catch (err) {
      console.error('[vault-watcher] onFile handler threw:', err);
    }
  }

  /** N5: depth-bounded recursive startup scan that never crosses a reparse point. */
  async function scan(dirAbs: string, depth: number): Promise<void> {
    if (closed) return;
    let names: string[];
    try {
      names = await fs.readdir(dirAbs);
    } catch (err) {
      console.error(`[vault-watcher] startup scan could not read ${dirAbs}:`, err);
      return;
    }
    for (const name of names) {
      const abs = path.resolve(path.join(dirAbs, name));
      if (shouldIgnore(dirAbsRoot, abs)) continue;
      const lst = await fs.lstat(abs).catch(() => null);
      if (!lst) continue;
      if (lst.isSymbolicLink()) {
        reject(abs, 'reparse-point', 'junctions/symlinks in the inbox are not followed', `${lst.size}:${lst.mtimeMs}`);
        continue;
      }
      if (lst.isDirectory()) {
        if (depth + 1 > MAX_SCAN_DEPTH) {
          console.warn(`[vault-watcher] ${abs} is nested deeper than ${MAX_SCAN_DEPTH}; not scanned.`);
          continue;
        }
        await scan(abs, depth + 1);
        continue;
      }
      await maybeEnqueue(abs);
    }
  }

  void (async () => {
    // The inbox itself must be a real directory, never a junction/symlink.
    let st;
    try {
      st = await fs.lstat(dir);
    } catch {
      console.warn(`[vault-watcher] ${dir} does not exist; watcher is a no-op.`);
      return;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      console.warn(`[vault-watcher] ${dir} is not a real directory (link or file); watcher is a no-op.`);
      return;
    }
    const realDir = await fs.realpath(dir).catch(() => null);
    if (realDir === null || cmpKey(realDir) !== cmpKey(dirAbsRoot)) {
      console.warn(`[vault-watcher] ${dir} resolves elsewhere (${String(realDir)}); watcher is a no-op.`);
      return;
    }

    // E4-2/N5: startup scan — queue everything already sitting in the inbox.
    try {
      await scan(dir, 0);
    } catch (err) {
      console.error('[vault-watcher] startup inbox scan failed:', err);
    }
    if (closed) return;

    watcher = watch(dir, {
      persistent: true,
      ignoreInitial: true, // the startup scan above already covered pre-existing files
      followSymlinks: false, // N1: never descend through a junction/symlink
      depth: MAX_SCAN_DEPTH,
      ignored: (p: string) => shouldIgnore(dirAbsRoot, path.resolve(p)),
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    });

    watcher.on('add', (addedPath: string) => {
      void maybeEnqueue(path.resolve(addedPath));
    });

    // A junction/symlink created live is reported, never followed.
    watcher.on('addDir', (addedPath: string) => {
      const abs = path.resolve(addedPath);
      void fs
        .lstat(abs)
        .then((l) => {
          if (l.isSymbolicLink()) {
            reject(abs, 'reparse-point', 'junctions/symlinks in the inbox are not followed', `${l.size}:${l.mtimeMs}`);
          }
        })
        .catch(() => {});
    });

    // A file overwritten after a previous failure (bad encoding, etc.) must
    // be retried once its content actually changes (E4-2).
    watcher.on('change', (changedPath: string) => {
      void maybeEnqueue(path.resolve(changedPath));
    });

    watcher.on('unlink', (removedPath: string) => {
      lastEnqueuedHash.delete(path.resolve(removedPath));
    });

    watcher.on('error', (err: unknown) => {
      console.error('[vault-watcher] watch error:', err);
    });
  })();

  return {
    async close(): Promise<void> {
      closed = true;
      if (watcher) {
        await watcher.close();
        watcher = null;
      }
      lastEnqueuedHash.clear();
    },
  };
}
