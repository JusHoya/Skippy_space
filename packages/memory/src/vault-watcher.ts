// vault-watcher.ts — chokidar v5 inbox watcher for the Ingest job (PRD §8.5).
//
// `watchInbox` fires `onFile(absPath)` once per *stable* file added under
// `vault/00_Inbox/` (the trigger for Job 1, `research.ingest`). The agent-runtime
// wires this to `runPipeline`; this module stays dependency-light (chokidar only)
// and never imports the jobs so it can be unit-tested in isolation.
//
// chokidar v5 notes (the installed version):
//   - `watch(paths, options)` returns an `FSWatcher` EventEmitter; we listen on
//     `'add'`, `'change'` and `'error'`.
//   - v5 DROPPED glob support, so `ignored` is a *function* matcher, not a glob.
//   - `awaitWriteFinish` lets a large/streamed drop settle before we ingest it,
//     so we don't read a half-written file (a partial-write the charter warns of).
//   - `.close()` returns a Promise — we expose it as-is.
//
// E4-2 (resumability): a crash between a drop landing and the watcher starting
// (or the sidecar/agent-runtime restarting mid-backlog) must not strand that
// file unprocessed forever. On start, before wiring chokidar, we do our own
// scan of the inbox and enqueue every existing supported/unsupported file —
// chokidar's own `ignoreInitial: false` fires 'add' too eagerly (before
// `awaitWriteFinish` settles) for a manual scan's purposes, so we drive the
// startup pass ourselves and keep chokidar's own watch limited to live
// `add`/`change` events with `ignoreInitial: true`. `'change'` is listened to
// (not just `'add'`) so a file that previously failed (e.g. bad encoding) and
// is later overwritten with valid content is retried rather than ignored
// forever. Retry is content-hash-gated via the `.ingest-error.json` sidecar's
// recorded `contentSha256` (errors.ts): unchanged content is never
// re-enqueued (no infinite fail loop); changed content always is.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { watch, type FSWatcher } from 'chokidar';

import { INGEST_ERROR_SUFFIX, readIngestError } from './ingest/errors.js';
import { extensionOf, isSupportedExtension } from './ingest/extractors.js';
import { sha256Hex } from './ingest/originals.js';

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
  /** Override the watched directory (defaults to `<vaultRoot>/00_Inbox`). */
  dir?: string;
}

export interface InboxWatcher {
  /** Stop watching and release fs handles. */
  close(): Promise<void>;
}

/**
 * Matcher: ignore dotfiles, `.git`, `.obsidian`, `*.tmp`/`*.lock`, our own
 * `.ingest-error.json` sidecars (so a written error report is never itself
 * re-enqueued as a new drop), and ingest's own hidden `.ingest-tmp` staging
 * files (jobs/ingest.ts renames the inbox copy there just before deleting it).
 */
function shouldIgnore(p: string): boolean {
  const base = path.basename(p);
  if (base.startsWith('.')) return true; // dotfiles + dotdirs (.git, .obsidian, .smart-env, our .*.ingest-tmp)
  if (base.endsWith('.tmp')) return true;
  if (base.endsWith('.lock')) return true;
  if (base.endsWith('.ingest-tmp')) return true;
  if (base.endsWith(INGEST_ERROR_SUFFIX)) return true;
  // Defensive: catch nested .git/.obsidian segments regardless of basename.
  const norm = p.replace(/\\/g, '/');
  if (/\/\.git\//.test(norm) || /\/\.obsidian\//.test(norm)) return true;
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

  // chokidar will happily watch a not-yet-existing path, but per the charter we
  // prefer an explicit, friendly degrade when the inbox is absent.
  let watcher: FSWatcher | null = null;
  // abs path -> content hash we last enqueued (onFile or onUnsupported) for.
  const lastEnqueuedHash = new Map<string, string>();

  /**
   * Decide whether `abs` should be (re-)enqueued and dispatch it. Reads the
   * file's current bytes; a file that vanished mid-check (removed by a
   * concurrent ingest, or a transient rename) is silently skipped. A file
   * whose recorded `.ingest-error.json` sidecar already covers this EXACT
   * content hash is skipped too (E4-2: no infinite fail-retry loop); if the
   * sidecar's hash differs (or there is no sidecar), it proceeds.
   */
  async function maybeEnqueue(abs: string): Promise<void> {
    if (shouldIgnore(abs)) return;
    let buf: Buffer;
    try {
      buf = await fs.readFile(abs);
    } catch {
      return; // gone already (removed/renamed by a concurrent ingest)
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
      // eslint-disable-next-line no-console
      console.warn(`[vault-watcher] unsupported extension "${ext}" for ${abs}; not enqueued.`);
      try {
        opts.onUnsupported?.(abs, ext);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[vault-watcher] onUnsupported handler threw:', err);
      }
      return;
    }

    try {
      opts.onFile(abs);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[vault-watcher] onFile handler threw:', err);
    }
  }

  // Kick off an existence check; if the dir is missing, stay a no-op.
  void fs
    .stat(dir)
    .then(async (st) => {
      if (!st.isDirectory()) {
        // eslint-disable-next-line no-console
        console.warn(`[vault-watcher] ${dir} is not a directory; watcher is a no-op.`);
        return;
      }

      // E4-2: startup scan — queue everything already sitting in the inbox
      // (a crash/restart must not strand a leftover drop unprocessed).
      try {
        const entries = await fs.readdir(dir);
        for (const entry of entries) {
          const abs = path.resolve(path.join(dir, entry));
          if (shouldIgnore(abs)) continue;
          const st2 = await fs.stat(abs).catch(() => null);
          if (!st2 || !st2.isFile()) continue;
          await maybeEnqueue(abs);
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[vault-watcher] startup inbox scan failed:', err);
      }

      watcher = watch(dir, {
        persistent: true,
        ignoreInitial: true, // the startup scan above already covered pre-existing files
        ignored: (p: string) => shouldIgnore(p),
        awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
      });

      watcher.on('add', (addedPath: string) => {
        void maybeEnqueue(path.resolve(addedPath));
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
        // eslint-disable-next-line no-console
        console.error('[vault-watcher] watch error:', err);
      });
    })
    .catch(() => {
      // eslint-disable-next-line no-console
      console.warn(`[vault-watcher] ${dir} does not exist; watcher is a no-op.`);
    });

  return {
    async close(): Promise<void> {
      if (watcher) {
        await watcher.close();
        watcher = null;
      }
      lastEnqueuedHash.clear();
    },
  };
}
