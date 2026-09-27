// safe-write.ts — the in-house contained atomic replace (FR-SEC-02, FR-WIKI-02;
// M0 red-team round 2, N3).
//
// write-file-atomic 8 names its temp file `<target>.<uint32>` where the number
// is a hash of (module path, pid, threadId, per-process counter) and opens it
// with flag 'w'. The name is predictable, and 'w' opens an EXISTING path, so a
// hardlink planted at the predicted name makes the "atomic write" write straight
// through to the linked file outside the vault, then rename the now-2-link
// inode over the note. Every memory-package vault writer (broker notes,
// originals, completion markers, ingest-error sidecars) therefore uses this
// writer instead:
//
//   1. The target's directory must be its REAL path (the caller passes a target
//      under the parent returned by `ensureContainedParentDir`) and must still
//      realpath to itself (no junction swapped in since).
//   2. Temp name `.skippy-<32 hex from crypto.randomBytes(16)>.tmp` in that same
//      directory, opened with 'wx' (O_CREAT|O_EXCL / CREATE_NEW): it fails if the
//      name exists in any form, so it can never follow a planted link. The
//      leading dot and `.tmp` suffix keep the inbox watcher away from it.
//   3. The open handle must be a single-link regular file; write, fsync, close.
//   4. Recheck containment of the target (same options it was resolved with),
//      re-verify the temp file is still our single-link regular file (same
//      file identity), run the caller's `beforeCommit` (lock assertion), then
//      rename over the target (retrying transient Windows sharing errors).
//   5. Verify the final target is a single-link regular file with our file
//      identity. Any failure before the rename removes the temp file.
//
// Residual TOCTOU is the same as the broker's (see vault-broker.ts): a local
// process that swaps a directory for a junction between the final recheck and
// the rename could still redirect it; Node has no handle-relative I/O on Windows.

import { randomBytes } from 'node:crypto';
import { promises as fs, type BigIntStats } from 'node:fs';
import * as path from 'node:path';

import {
  VaultPathError,
  cmpKey,
  ensureContainedParentDir,
  isPathInside,
  recheckContained,
  type ContainedPath,
} from './vault-path.js';

export interface AtomicWriteOptions {
  /**
   * The absolute target, normally `path.join(realParent, basename)` where
   * `realParent` came from `ensureContainedParentDir(cp)`. Defaults to exactly
   * that (the parent directories are created, contained, level by level).
   */
  target?: string;
  /**
   * Refuse to replace an existing target (checked immediately before the
   * rename). Throws `TargetExistsError`. The broker's `createNote` sets it on
   * top of its own under-lock existence check.
   */
  exclusive?: boolean;
  /** Runs immediately before the rename (e.g. assert the caller's lock is still held). */
  beforeCommit?: () => void;
}

export class TargetExistsError extends Error {
  readonly code = 'VAULT_TARGET_EXISTS';
  constructor(readonly rel: string) {
    super(`Refusing to replace existing "${rel}" (exclusive create)`);
    this.name = 'TargetExistsError';
  }
}

const TEMP_PREFIX = '.skippy-';
const TEMP_SUFFIX = '.tmp';

/** True for a temp file name this module creates (watchers skip these). */
export function isSafeWriteTempName(name: string): boolean {
  return name.startsWith(TEMP_PREFIX) && name.endsWith(TEMP_SUFFIX);
}

function sameIdentity(a: BigIntStats, b: BigIntStats): boolean {
  return a.ino === b.ino && a.dev === b.dev;
}

async function assertSingleLinkFile(p: string, rel: string, expect?: BigIntStats): Promise<BigIntStats> {
  const st = await fs.lstat(p, { bigint: true });
  if (st.isSymbolicLink()) throw new VaultPathError('target_is_link', rel, `${p} became a link`);
  if (!st.isFile()) throw new VaultPathError('target_not_file', rel, `${p} is not a regular file`);
  if (st.nlink !== 1n) {
    throw new VaultPathError('hardlinked_target', rel, `${p} has ${st.nlink} hard links`);
  }
  if (expect && !sameIdentity(st, expect)) {
    throw new VaultPathError('target_not_file', rel, `${p} was replaced during the write`);
  }
  return st;
}

function isTransientRenameError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  let delay = 10;
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      // Windows: an indexer/AV/Obsidian handle without FILE_SHARE_DELETE makes
      // MoveFileEx fail transiently. A directory at the target stays an error.
      if (!isTransientRenameError(err) || attempt >= 8) throw err;
      const st = await fs.lstat(to).catch(() => null);
      if (st?.isDirectory()) throw err;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 250);
    }
  }
}

/**
 * Atomically replace (or create) the contained target `cp` with `data`.
 * See the module header for the exact sequence. Throws `VaultPathError` on
 * any containment/link violation and `TargetExistsError` for an exclusive
 * create that finds the target present.
 */
export async function atomicWriteContained(
  cp: ContainedPath,
  data: string | Buffer,
  opts: AtomicWriteOptions = {},
): Promise<void> {
  const target =
    opts.target ?? path.join(await ensureContainedParentDir(cp), path.basename(cp.abs));
  if (!isPathInside(cp.realRoot, target)) throw new VaultPathError('escapes_root', cp.rel);
  const dir = path.dirname(target);

  // The directory must be its own real path: no junction/symlink in the chain.
  let realDir: string;
  try {
    realDir = await fs.realpath(dir);
  } catch (err) {
    throw new VaultPathError('escapes_root', cp.rel, `cannot resolve ${dir}: ${String(err)}`);
  }
  if (cmpKey(realDir) !== cmpKey(dir)) {
    throw new VaultPathError('escapes_root', cp.rel, `${dir} resolves to ${realDir}`);
  }
  await recheckContained(cp, target);

  const tmp = path.join(dir, `${TEMP_PREFIX}${randomBytes(16).toString('hex')}${TEMP_SUFFIX}`);
  // 'wx' = O_CREAT|O_EXCL (CREATE_NEW on Windows): never opens an existing path.
  const handle = await fs.open(tmp, 'wx');
  let committed = false;
  try {
    let tmpStat: BigIntStats;
    try {
      tmpStat = await handle.stat({ bigint: true });
      if (!tmpStat.isFile() || tmpStat.nlink !== 1n) {
        throw new VaultPathError('hardlinked_target', cp.rel, 'temp file is not a fresh single-link file');
      }
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }

    // Immediately before the commit: containment of the target (not a link,
    // not hardlinked if it exists), and the temp file is still ours.
    const exists = await recheckContained(cp, target);
    if (exists && opts.exclusive) throw new TargetExistsError(cp.rel);
    await assertSingleLinkFile(tmp, cp.rel, tmpStat);
    if (cmpKey(await fs.realpath(dir)) !== cmpKey(dir)) {
      throw new VaultPathError('escapes_root', cp.rel, `${dir} changed during the write`);
    }
    opts.beforeCommit?.();
    await renameWithRetry(tmp, target);
    committed = true;

    // The final target must be our single-link regular file.
    await assertSingleLinkFile(target, cp.rel, tmpStat);
    const realTarget = await fs.realpath(target);
    if (!isPathInside(cp.realRoot, realTarget)) {
      throw new VaultPathError('escapes_root', cp.rel, `${target} resolves to ${realTarget}`);
    }
  } finally {
    if (!committed) await fs.rm(tmp, { force: true }).catch(() => {});
  }
}
