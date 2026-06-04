// vault-watcher.ts — chokidar v5 inbox watcher for the Ingest job (PRD §8.5).
//
// `watchInbox` fires `onFile(absPath)` once per *stable* file added under
// `vault/00_Inbox/` (the trigger for Job 1, `research.ingest`). The agent-runtime
// wires this to `runPipeline`; this module stays dependency-light (chokidar only)
// and never imports the jobs so it can be unit-tested in isolation.
//
// chokidar v5 notes (the installed version):
//   - `watch(paths, options)` returns an `FSWatcher` EventEmitter; we listen on
//     `'add'` (new file) and `'error'`.
//   - v5 DROPPED glob support, so `ignored` is a *function* matcher, not a glob.
//   - `awaitWriteFinish` lets a large/streamed drop settle before we ingest it,
//     so we don't read a half-written file (a partial-write the charter warns of).
//   - `.close()` returns a Promise — we expose it as-is.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { watch, type FSWatcher } from 'chokidar';

export interface WatchInboxOptions {
  /** Absolute path to the vault root (folder containing `00_Inbox/`). */
  vaultRoot: string;
  /** Called once per stable added file, with its absolute path. */
  onFile: (absPath: string) => void;
  /** Override the watched directory (defaults to `<vaultRoot>/00_Inbox`). */
  dir?: string;
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
 * tracking seen paths until they're unlinked. Graceful: if the directory does not
 * exist, logs a warning and returns a no-op watcher (never throws).
 */
export function watchInbox(opts: WatchInboxOptions): InboxWatcher {
  const dir = opts.dir ?? path.join(opts.vaultRoot, '00_Inbox');

  // chokidar will happily watch a not-yet-existing path, but per the charter we
  // prefer an explicit, friendly degrade when the inbox is absent.
  let watcher: FSWatcher | null = null;
  const seen = new Set<string>();

  // Kick off an existence check; if the dir is missing, stay a no-op.
  void fs
    .stat(dir)
    .then((st) => {
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
        const abs = path.resolve(addedPath);
        if (seen.has(abs)) return; // debounce duplicate add events
        seen.add(abs);
        try {
          opts.onFile(abs);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[vault-watcher] onFile handler threw:', err);
        }
      });

      // Allow re-processing a path if it's removed and re-added later.
      watcher.on('unlink', (removedPath: string) => {
        seen.delete(path.resolve(removedPath));
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
      seen.clear();
    },
  };
}
