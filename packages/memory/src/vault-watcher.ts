// vault-watcher.ts — chokidar v5 inbox watcher for the Ingest job (PRD §8.5).
//
// `watchInbox` fires `onFile(absPath)` once per *stable* file added under
// `vault/00_Inbox/` (the trigger for Job 1, `research.ingest`). The agent-runtime
// wires this to `runPipeline`; this module stays dependency-light (chokidar +
// the ingest helpers) and never imports the jobs so it can be unit-tested in
// isolation.
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
// Canonical root (M0 final #5): the configured vault root is canonicalized
// ONCE (`canonicalVaultRoot`: native realpath, so an 8.3 alias `LONGVA~1` or a
// junction root behaves exactly like its long form) and every path the watcher
// reports lies under that canonical root, which is also what the runtime hands
// to `runIngest`. A root that cannot be canonicalized, or an inbox that is
// missing or not a real directory, is reported through `onError` (and logged
// as an error) -- never a silent no-op.
//
// E4-2/N5 (resumability): a crash between a drop landing and the watcher
// starting (or the sidecar restarting mid-backlog) must not strand that file
// unprocessed forever. On start, before wiring chokidar, we first recover
// leftover `.ingest-tmp` freeze files (M0 final #7, ingest/recovery.ts: a crash
// between ingest's freeze-rename and its delete/restore), then scan the inbox
// RECURSIVELY (depth-bounded by MAX_SCAN_DEPTH, never through reparse points)
// and enqueue every existing file; chokidar's own watch is limited to live
// events (`ignoreInitial: true`). `'change'` is listened to (not just `'add'`)
// so a file that previously failed (e.g. bad encoding) and is later overwritten
// with valid content is retried. Retry is content-hash-gated via the
// `.ingest-error.json` sidecar's recorded `contentSha256` (errors.ts):
// unchanged content is never re-enqueued (no infinite fail loop).
//
// N6 / M0 final #6: nothing in the inbox is skipped silently. Every candidate
// is checked with the same strict inbox rules as `runIngest`
// (ingest/containment.ts) and its size is checked with `stat` BEFORE reading.
// Every entry that is not ingested is reported through `onRejected` (or, if no
// `onRejected` is given, `onUnsupported`) with a reason: reparse point,
// hardlink, 8.3/reserved/invisible-character name, over MAX_INGEST_BYTES,
// unreadable, `hidden` (dot-prefixed file or directory), `reserved-name`
// (`.tmp`, `.lock`, `.ingest-tmp`, `.ingest-error.json` suffixes),
// `too-deep` (a directory beyond MAX_SCAN_DEPTH) and `internal-folder` (a user
// file inside `_ingest-errors/`). The only silent skips are the pipeline's own,
// provably-owned artifacts: ingest-error sidecars whose CONTENT proves they are
// ours (`isOwnIngestErrorSidecar`, not the suffix), our `.<32 hex>.….ingest-tmp`
// freeze files (handled by the startup recovery) and, for live events only, the
// transient `.skippy-<32 hex>.tmp` atomic-write temp files. Only ENOENT (the
// file really vanished) is otherwise silent.

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
import { INGEST_ERROR_SUFFIX, isOwnIngestErrorSidecar, readIngestError } from './ingest/errors.js';
import { extensionOf, isSupportedExtension } from './ingest/extractors.js';
import { sha256Hex } from './ingest/originals.js';
import { parseIngestTmpName, recoverIngestTemps, type IngestTmpRecovery } from './ingest/recovery.js';
import { canonicalVaultRoot, cmpKey, rebaseOntoRoot } from './vault-path.js';

/** Maximum inbox nesting (directory levels) the startup scan and the live watch descend into. */
export const MAX_SCAN_DEPTH = 8;

const SAFE_WRITE_TEMP_RE = /^\.skippy-[0-9a-f]{32}\.tmp$/;
const RESERVED_SUFFIX_RE = /\.(tmp|lock|ingest-tmp)$/i;

export interface WatchInboxOptions {
  /** Absolute path to the vault root (folder containing `00_Inbox/`). Canonicalized once. */
  vaultRoot: string;
  /** Called once per stable added/changed file with a DECLARED extractor, with its (canonical) absolute path. */
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
   * Called for every inbox entry that is not ingested (N1/N6, M0 final #6): a
   * junction/symlink, a hardlinked file, a path the vault rules reject, a file
   * over `MAX_INGEST_BYTES`, one that cannot be read, a hidden entry, a
   * reserved-suffix name, a too-deep directory, or a user file inside
   * `_ingest-errors/`. The agent-runtime records a sidecar for it
   * (`recordIngestRejection`). Falls back to `onUnsupported` when absent.
   */
  onRejected?: (absPath: string, reason: IngestRejectReason, detail: string) => void;
  /**
   * Called when the watcher cannot work at all (root not canonicalizable,
   * inbox missing / not a real directory) or chokidar reports an error.
   */
  onError?: (err: Error) => void;
  /** Called once per leftover `.ingest-tmp` file handled by the startup recovery (M0 final #7). */
  onRecovered?: (r: IngestTmpRecovery) => void;
  /** Override the watched directory (defaults to `<vaultRoot>/00_Inbox`). */
  dir?: string;
}

export interface InboxWatcher {
  /** Stop watching and release fs handles. */
  close(): Promise<void>;
}

function relSegments(dir: string, p: string): string[] | null {
  const rel = path.relative(dir, p);
  if (rel === '' || path.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${path.sep}`)) return null;
  return rel.split(/[\\/]+/);
}

/**
 * Watch `vault/00_Inbox/` (or `dir`) and invoke `onFile(absPath)` once per
 * stable added/changed file. Debounces duplicate/unchanged-content fs events
 * by tracking the last content hash enqueued per path — a `change` event
 * whose bytes hash the same as last time is a no-op; different bytes (or a
 * fresh `add`) always re-evaluates. Never throws; failures go to `onError`.
 */
export function watchInbox(opts: WatchInboxOptions): InboxWatcher {
  let watcher: FSWatcher | null = null;
  let closed = false;
  // abs path -> content hash (or rejection fingerprint) we last dispatched for.
  const lastEnqueuedHash = new Map<string, string>();
  // Set once the root is canonical.
  let vaultRoot = '';
  let inboxDir = '';

  function fail(err: Error): void {
    console.error(`[vault-watcher] ${err.message}`);
    try {
      opts.onError?.(err);
    } catch (e) {
      console.error('[vault-watcher] onError handler threw:', e);
    }
  }

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

  /** chokidar matcher: skip only what lies INSIDE an already-reported entry. */
  function ignoredByWatch(p: string): boolean {
    const segs = relSegments(inboxDir, path.resolve(p));
    if (segs === null) return false;
    if (segs.slice(0, -1).some((s) => s.startsWith('.'))) return true; // inside a (reported) hidden dir
    return segs.length > MAX_SCAN_DEPTH + 1; // inside a (reported) too-deep dir
  }

  /**
   * Classify one inbox entry and either report it, skip it (provably ours),
   * or dispatch it. Checks the entry with lstat (never following a link), the
   * strict inbox rules and the size cap before reading; a file that vanished
   * mid-check is silently skipped. A file whose recorded `.ingest-error.json`
   * sidecar already covers this EXACT content hash is skipped too (E4-2).
   */
  async function handleEntry(abs: string, origin: 'scan' | 'live'): Promise<void> {
    if (closed) return;
    const segs = relSegments(inboxDir, abs);
    if (segs === null || ignoredByWatch(abs)) return;
    const name = segs[segs.length - 1]!;
    const inErrorsDir = segs.slice(0, -1).some((s) => s.toLowerCase() === INGEST_ERRORS_DIR);

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
    if (lst.isDirectory()) {
      if (name.startsWith('.')) {
        reject(abs, 'hidden', 'hidden directories in the inbox are not scanned', fingerprint);
      } else if (inErrorsDir) {
        reject(abs, 'internal-folder', `${INGEST_ERRORS_DIR}/ holds ingest error records, not drops`, fingerprint);
      } else if (segs.length > MAX_SCAN_DEPTH) {
        reject(abs, 'too-deep', `nested deeper than ${MAX_SCAN_DEPTH} directory levels; its contents are not scanned`, fingerprint);
      }
      return;
    }
    if (!lst.isFile()) {
      reject(abs, 'not-a-file', 'not a regular file', fingerprint);
      return;
    }

    // The pipeline's own artifacts (provably ours) are the only silent skips.
    if (parseIngestTmpName(name)) return; // freeze file: transient, or handled by the startup recovery
    if (SAFE_WRITE_TEMP_RE.test(name)) {
      if (origin === 'live') return; // an atomic write in flight (renamed within milliseconds)
      reject(abs, 'reserved-name', 'leftover atomic-write temp file from an interrupted write', fingerprint);
      return;
    }
    if (name.toLowerCase().endsWith(INGEST_ERROR_SUFFIX)) {
      if (await isOwnIngestErrorSidecar(vaultRoot, abs)) return;
      reject(abs, 'reserved-name', `"${INGEST_ERROR_SUFFIX}" is reserved for ingest error records`, fingerprint);
      return;
    }
    if (inErrorsDir) {
      reject(abs, 'internal-folder', `${INGEST_ERRORS_DIR}/ holds ingest error records, not drops`, fingerprint);
      return;
    }
    if (name.startsWith('.')) {
      reject(abs, 'hidden', 'hidden files in the inbox are not ingested', fingerprint);
      return;
    }
    if (RESERVED_SUFFIX_RE.test(name)) {
      reject(abs, 'reserved-name', 'the .tmp/.lock/.ingest-tmp suffixes are reserved for temporary and lock files', fingerprint);
      return;
    }
    if (lst.size > MAX_INGEST_BYTES) {
      reject(abs, 'too-large', `${lst.size} bytes exceeds the ${MAX_INGEST_BYTES}-byte ingest limit`, fingerprint);
      return;
    }

    let buf: Buffer;
    try {
      buf = (await readInboxFile(vaultRoot, abs)).bytes;
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

    const errRec = await readIngestError(vaultRoot, abs).catch(() => null);
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
      fail(new Error(`startup scan could not read ${dirAbs}: ${String(err)}`));
      return;
    }
    for (const name of names) {
      const abs = path.join(dirAbs, name);
      const lst = await fs.lstat(abs).catch(() => null);
      if (!lst) continue;
      if (lst.isDirectory() && !lst.isSymbolicLink()) {
        const segs = relSegments(inboxDir, abs) ?? [];
        const inErrorsDir = segs.slice(0, -1).some((s) => s.toLowerCase() === INGEST_ERRORS_DIR);
        if (name.startsWith('.') || inErrorsDir || depth + 1 > MAX_SCAN_DEPTH) {
          await handleEntry(abs, 'scan'); // reported, not descended into
          continue;
        }
        await scan(abs, depth + 1);
        continue;
      }
      await handleEntry(abs, 'scan');
    }
  }

  void (async () => {
    // M0 final #5: one canonical root; failures are loud.
    try {
      vaultRoot = await canonicalVaultRoot(opts.vaultRoot);
    } catch (err) {
      fail(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    inboxDir = opts.dir
      ? rebaseOntoRoot(opts.vaultRoot, vaultRoot, opts.dir)
      : path.join(vaultRoot, '00_Inbox');

    // The inbox itself must be a real directory, never a junction/symlink.
    let st;
    try {
      st = await fs.lstat(inboxDir);
    } catch (err) {
      fail(new Error(`inbox ${inboxDir} does not exist or cannot be read (${String(err)}); nothing is watched`));
      return;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      fail(new Error(`inbox ${inboxDir} is not a real directory (link or file); nothing is watched`));
      return;
    }
    const realDir = await fs.realpath(inboxDir).catch(() => null);
    if (realDir === null || cmpKey(realDir) !== cmpKey(inboxDir)) {
      fail(new Error(`inbox ${inboxDir} resolves elsewhere (${String(realDir)}); nothing is watched`));
      return;
    }
    inboxDir = realDir;

    // M0 final #7: recover leftover freeze files before scanning, so restored
    // content is picked up by the scan below.
    if (cmpKey(inboxDir) === cmpKey(path.join(vaultRoot, '00_Inbox'))) {
      try {
        for (const r of await recoverIngestTemps(vaultRoot, MAX_SCAN_DEPTH)) {
          const log = r.action === 'left' ? console.error : console.warn;
          log(`[vault-watcher] ingest-tmp recovery: ${r.tmpPath} ${r.action}: ${r.detail}`);
          try {
            opts.onRecovered?.(r);
          } catch (err) {
            console.error('[vault-watcher] onRecovered handler threw:', err);
          }
        }
      } catch (err) {
        fail(new Error(`ingest-tmp recovery failed: ${String(err)}`));
      }
    }

    // E4-2/N5: startup scan — queue everything already sitting in the inbox.
    try {
      await scan(inboxDir, 0);
    } catch (err) {
      fail(new Error(`startup inbox scan failed: ${String(err)}`));
    }
    if (closed) return;

    watcher = watch(inboxDir, {
      persistent: true,
      ignoreInitial: true, // the startup scan above already covered pre-existing files
      followSymlinks: false, // N1: never descend through a junction/symlink
      ignored: (p: string) => ignoredByWatch(p),
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    });

    watcher.on('add', (addedPath: string) => {
      void handleEntry(path.resolve(addedPath), 'live');
    });

    // A junction/symlink, hidden, too-deep or internal directory created live is reported.
    watcher.on('addDir', (addedPath: string) => {
      void handleEntry(path.resolve(addedPath), 'live');
    });

    // A file overwritten after a previous failure (bad encoding, etc.) must
    // be retried once its content actually changes (E4-2).
    watcher.on('change', (changedPath: string) => {
      void handleEntry(path.resolve(changedPath), 'live');
    });

    watcher.on('unlink', (removedPath: string) => {
      lastEnqueuedHash.delete(path.resolve(removedPath));
    });

    watcher.on('error', (err: unknown) => {
      fail(err instanceof Error ? err : new Error(`watch error: ${String(err)}`));
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
