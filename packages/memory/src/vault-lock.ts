// vault-lock.ts — the proper-lockfile wrapper every vault read-modify-write
// uses (FR-WIKI-02; M0 final red-team #3).
//
// proper-lockfile locks `<file>` by `mkdir <file>.lock`; a held lock is an
// existing directory, and a stale one (mtime older than `stale`) is removed
// with `rmdir` and retaken. That design has two failure modes when something
// other than proper-lockfile creates the lock path:
//
//   - a NON-EMPTY directory (e.g. a note an agent created at
//     `agent_log.md.lock/pin.md`): fresh it reads as "locked" forever, stale its
//     `rmdir` fails with ENOTEMPTY forever;
//   - a FILE or a junction/symlink at the lock path: `mkdir` fails with EEXIST
//     and the stale removal fails with ENOTDIR (or would act through the link).
//
// The vault path rules now reject every `.lock` segment, so the broker can no
// longer be used to plant either. For anything planted another way this module
// inspects the lock path before and after a failed acquisition and turns such
// a squat into an explicit `VaultLockPathError` (reported to the caller, never
// an endless `locked`). It never deletes a lock path it did not create: stale
// EMPTY lock directories are reclaimed by proper-lockfile's own `rmdir` (which
// cannot remove a non-empty directory), and our own lock is released through
// the release function proper-lockfile returned for it.

import { promises as fs } from 'node:fs';

import { lock } from 'proper-lockfile';

/** A lock path that is not a proper-lockfile lock (see the module header). */
export class VaultLockPathError extends Error {
  readonly code = 'VAULT_LOCK_PATH_INVALID';
  constructor(readonly lockPath: string, detail: string) {
    super(
      `Lock path ${JSON.stringify(lockPath)} is not a lock this vault created (${detail}); ` +
        'remove it by hand after checking what it contains',
    );
    this.name = 'VaultLockPathError';
  }
}

export interface VaultLockOptions {
  /** proper-lockfile retry policy. */
  retries: { retries: number; factor: number; minTimeout: number; maxTimeout: number };
  /** Stale threshold in ms. Default 30 s. */
  stale?: number;
  /** Called if the lock is compromised while held. */
  onCompromised?: (err: Error) => void;
}

/** The lock directory proper-lockfile uses for `target`. */
export function lockPathFor(target: string): string {
  return `${target}.lock`;
}

/**
 * Throw `VaultLockPathError` if the lock path exists but is not an empty,
 * real directory (proper-lockfile's own lock is always an empty directory).
 */
export async function assertLockPathSane(target: string): Promise<void> {
  const lockPath = lockPathFor(target);
  let st;
  try {
    st = await fs.lstat(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if (st.isSymbolicLink()) throw new VaultLockPathError(lockPath, 'it is a junction/symlink');
  if (!st.isDirectory()) throw new VaultLockPathError(lockPath, 'it is a file, not a lock directory');
  let entries: string[];
  try {
    entries = await fs.readdir(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; // released meanwhile
    throw err;
  }
  if (entries.length > 0) {
    throw new VaultLockPathError(lockPath, `it is a non-empty directory (${entries.length} entries)`);
  }
}

function errCode(err: unknown): string | undefined {
  return (err as { code?: string } | null)?.code;
}

/**
 * Acquire the lock on `target`. Returns the release function, or `null` when
 * the lock is genuinely held by someone else after all retries. Throws
 * `VaultLockPathError` for a squatted lock path (non-empty directory, file,
 * link), both up front and when it is the reason acquisition failed.
 */
export async function acquireVaultLock(
  target: string,
  opts: VaultLockOptions,
): Promise<(() => Promise<void>) | null> {
  await assertLockPathSane(target);
  try {
    return await lock(target, {
      realpath: false,
      stale: opts.stale ?? 30_000,
      retries: opts.retries,
      ...(opts.onCompromised ? { onCompromised: opts.onCompromised } : {}),
    });
  } catch (err) {
    const code = errCode(err);
    if (code === 'ELOCKED') {
      // Held -- unless what "holds" it is a squat that appeared meanwhile.
      await assertLockPathSane(target);
      return null;
    }
    if (code === 'ENOTEMPTY' || code === 'ENOTDIR' || code === 'EEXIST') {
      // proper-lockfile's stale removal hit something it did not create.
      await assertLockPathSane(target);
      throw new VaultLockPathError(lockPathFor(target), `acquisition failed with ${code}`);
    }
    throw err;
  }
}
