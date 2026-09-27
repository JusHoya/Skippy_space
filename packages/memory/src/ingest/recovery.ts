// ingest/recovery.ts — never-clobbering restore of frozen inbox drops, and the
// startup recovery of `.ingest-tmp` leftovers (FR-WIKI-03 "crashes cannot
// remove the only source copy"; M0 final red-team #2, #7).
//
// `safeRemoveInboxFile` (jobs/ingest.ts) freezes a drop before deleting it by
// renaming it to a hidden temp name in the same directory:
//
//     .<32 hex>.<original name>.ingest-tmp
//
// (`.<32 hex>.recovered<ext>.ingest-tmp` when the original name is too long;
// pre-fix builds wrote `.<32 hex>.ingest-tmp`). If the frozen bytes no longer
// hash to what was preserved, the file must go back -- but a NEWER drop may
// already sit under the original name, and `fs.rename` on Windows replaces it
// (MoveFileEx with REPLACE_EXISTING), silently destroying unpreserved content.
// `restoreNoClobber` therefore never replaces anything: it hard-links the
// frozen file to the destination (atomic, fails with EEXIST when the name is
// taken; falls back to `copyFile(COPYFILE_EXCL)` on volumes without hard links)
// and only then unlinks the temp name. When the original name is taken it uses
// `<stem>.conflict-<timestamp>[-n]<ext>` in the same directory, a visible name
// the watcher picks up as a new drop; the caller surfaces the outcome as an
// event.
//
// A crash between the freeze and the delete/restore leaves the temp file
// behind: hidden, never ingested, and (before this fix) never reported.
// `recoverIngestTemps` runs at watcher startup, before the inbox scan: every
// temp file with OUR name pattern (anything else hidden is reported, not
// touched) that is a single-link regular file inside the real inbox with no
// reparse point in between is hashed; if a completion marker exists for that
// hash and the stored original is intact, the content is provably preserved
// and the temp file is deleted; otherwise it is restored under a
// non-clobbering visible name, so the following scan re-queues it (ingest then
// dedups or completes it). `*.ingest-tmp` and `.skippy-*.tmp` are also
// git-ignored so autocommit can never commit one.

import { randomBytes } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import * as path from 'node:path';

import { cmpKey, ruleKey } from '../vault-path.js';
import { INBOX_DIR, INGEST_ERRORS_DIR, MAX_INGEST_BYTES, resolveInboxPath } from './containment.js';
import { extensionOf } from './extractors.js';
import { readMarker, sha256Hex, storedOriginalIsIntact } from './originals.js';

export const INGEST_TMP_SUFFIX = '.ingest-tmp';

const MAX_NAME = 255;
const OWN_TMP_RE = /^\.([0-9a-f]{32})(?:\.(.+))?\.ingest-tmp$/;

/** A fresh freeze name for an inbox drop called `originalName`. */
export function ingestTmpName(originalName: string): string {
  const hex = randomBytes(16).toString('hex');
  const full = `.${hex}.${originalName}${INGEST_TMP_SUFFIX}`;
  if (full.length <= MAX_NAME) return full;
  const ext = extensionOf(originalName);
  return `.${hex}.recovered${ext.length <= 32 ? ext : ''}${INGEST_TMP_SUFFIX}`;
}

/**
 * Parse one of OUR freeze names. Returns the original file name it encodes
 * (null for the pre-fix `.<hex>.ingest-tmp` form), or undefined if `name` is
 * not ours.
 */
export function parseIngestTmpName(name: string): { originalName: string | null } | undefined {
  const m = OWN_TMP_RE.exec(name);
  if (!m) return undefined;
  return { originalName: m[2] ?? null };
}

/** `<stem>.conflict-<ts>[-n]<ext>`, a visible sibling name for a displaced version. */
export function conflictName(name: string, attempt: number): string {
  const ext = extensionOf(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = attempt > 1 ? `-${attempt}` : '';
  let out = `${stem}.conflict-${ts}${suffix}${ext}`;
  if (out.length > MAX_NAME) out = `conflict-${ts}${suffix}-${randomBytes(4).toString('hex')}${ext}`;
  return out;
}

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

/** Create `to` from `from` without ever replacing an existing `to`. False if `to` exists. */
async function linkOrCopyExclusive(from: string, to: string): Promise<boolean> {
  try {
    await fs.link(from, to);
    return true;
  } catch (err) {
    const code = errCode(err);
    if (code === 'EEXIST') return false;
    if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EXDEV' && code !== 'ENOSYS' && code !== 'EINVAL') {
      throw err;
    }
  }
  // No hard links on this volume (FAT/exFAT, some shares): exclusive copy.
  try {
    await fs.copyFile(from, to, fsConstants.COPYFILE_EXCL);
    return true;
  } catch (err) {
    if (errCode(err) === 'EEXIST') return false;
    await fs.rm(to, { force: true }).catch(() => {});
    throw err;
  }
}

export interface RestoreOutcome {
  /** Absolute path the frozen content now lives at. */
  restoredAs: string;
  /** True when the original name was taken and a conflict name was used. */
  conflict: boolean;
}

/**
 * Move the frozen file `tmpAbs` to `dir/preferredName`, or to a
 * `.conflict-<ts>` sibling when that name exists. Never replaces an existing
 * file. The temp file is removed only after the content exists under the new
 * name; if that removal fails the content exists twice (never zero times).
 */
export async function restoreNoClobber(
  tmpAbs: string,
  dir: string,
  preferredName: string,
): Promise<RestoreOutcome> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const name = attempt === 0 ? preferredName : conflictName(preferredName, attempt);
    const dest = path.join(dir, name);
    if (await linkOrCopyExclusive(tmpAbs, dest)) {
      await fs.unlink(tmpAbs);
      return { restoredAs: dest, conflict: attempt > 0 };
    }
  }
  throw new Error(`no free name to restore ${tmpAbs} as ${preferredName} in ${dir}`);
}

export type IngestTmpRecoveryAction = 'deleted-preserved' | 'restored' | 'left';

export interface IngestTmpRecovery {
  /** The leftover temp file. */
  tmpPath: string;
  action: IngestTmpRecoveryAction;
  /** Where it was restored to (`restored`). */
  restoredAs?: string;
  detail: string;
}

/**
 * Startup recovery of frozen inbox drops (see the module header). `vaultRoot`
 * should be canonical (`canonicalVaultRoot`). Never follows a reparse point,
 * never descends into hidden directories or `_ingest-errors/`, and never
 * throws: every leftover produces one entry in the returned list.
 */
export async function recoverIngestTemps(vaultRoot: string, maxDepth: number): Promise<IngestTmpRecovery[]> {
  const out: IngestTmpRecovery[] = [];
  const inbox = path.join(vaultRoot, INBOX_DIR);

  async function walk(dir: string, depth: number): Promise<void> {
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const abs = path.join(dir, name);
      const lst = await fs.lstat(abs).catch(() => null);
      if (!lst || lst.isSymbolicLink()) continue;
      if (lst.isDirectory()) {
        // Never walks `_ingest-errors/`: ingest never freezes a file there, so
        // the watcher reports any freeze-named file in it (D4).
        if (name.startsWith('.') || ruleKey(name) === INGEST_ERRORS_DIR || depth + 1 > maxDepth) continue;
        await walk(abs, depth + 1);
        continue;
      }
      const parsed = parseIngestTmpName(name);
      if (!parsed || !lst.isFile()) continue;
      out.push(await recoverOne(vaultRoot, abs, dir, parsed.originalName));
    }
  }

  await walk(inbox, 0);
  return out;
}

async function recoverOne(
  vaultRoot: string,
  tmpAbs: string,
  dir: string,
  originalName: string | null,
): Promise<IngestTmpRecovery> {
  const left = (detail: string): IngestTmpRecovery => ({ tmpPath: tmpAbs, action: 'left', detail });
  try {
    // The directory chain must be reparse-free inside the real inbox: prove it
    // through a visible probe name in the same directory.
    const probe = await resolveInboxPath(vaultRoot, path.join(dir, 'recovery-probe.md')).catch((err: unknown) => err);
    if (probe instanceof Error) return left(`its directory is not a safe inbox directory: ${probe.message}`);
    const realDir = await fs.realpath(dir);
    if (cmpKey(realDir) !== cmpKey(dir)) return left(`${dir} resolves to ${realDir}`);

    const handle = await fs.open(tmpAbs, 'r');
    let bytes: Buffer;
    try {
      const st = await handle.stat();
      if (!st.isFile() || st.nlink !== 1) return left('not a single-link regular file');
      if (st.size > MAX_INGEST_BYTES) return left(`${st.size} bytes exceeds the ingest limit`);
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
    const hash = sha256Hex(bytes);

    const marker = await readMarker(vaultRoot, hash);
    if (marker && (await storedOriginalIsIntact(vaultRoot, hash, marker.ext).catch(() => false))) {
      await fs.rm(tmpAbs, { force: true });
      return {
        tmpPath: tmpAbs,
        action: 'deleted-preserved',
        detail: `content ${hash} is preserved in the originals store and committed; the leftover was removed`,
      };
    }

    const ext = originalName ? extensionOf(originalName) : (marker?.ext ?? '.txt');
    let preferred = originalName ?? `recovered-${hash.slice(0, 12)}${ext}`;
    // The encoded name must itself be a valid, visible inbox name.
    const ok = await resolveInboxPath(vaultRoot, path.join(dir, preferred)).then(
      () => true,
      () => false,
    );
    if (!ok) preferred = `recovered-${hash.slice(0, 12)}${ext}`;
    const r = await restoreNoClobber(tmpAbs, dir, preferred);
    return {
      tmpPath: tmpAbs,
      action: 'restored',
      restoredAs: r.restoredAs,
      detail: `content ${hash} was not provably preserved; restored as ${path.basename(r.restoredAs)} for re-ingest`,
    };
  } catch (err) {
    return left(`recovery failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
