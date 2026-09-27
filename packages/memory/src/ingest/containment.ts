// ingest/containment.ts — real containment for ingest's inbox reads, deletes
// and sidecar writes (FR-SEC-02, FR-WIKI-03; red-team E3-2, round-2 N1/N6).
//
// `vault-broker.ts` proves every NOTE write lies inside the real vault via
// `resolveContained`/`recheckContained` (vault-path.ts). Ingest additionally
// READS and later DELETES files from `00_Inbox/`, so "inside the vault" is not
// enough: an in-vault junction `00_Inbox/j -> .obsidian` (or `.git`, or
// `60_Sources/originals`) would let a drop path reach control directories or
// the only preserved copy of an original. An ingest source must therefore be:
//
//   - lexically `00_Inbox/<rest>` under the vault root (`runIngest` refuses
//     anything else, e.g. `10_Atomic/keep.md`);
//   - accepted by `resolveContained` WITHOUT hidden segments (no `allowHidden`),
//     so the 8.3 `~<digit>`, reserved-name, hidden and hardlink rules all apply,
//     on the lexical and on the real path;
//   - under a `00_Inbox` that is itself a real directory (not a reparse point);
//   - reached with NO reparse point in any segment between the inbox and the
//     file: every segment is lstat'ed (junctions/symlinks report as links) and
//     must realpath to exactly itself;
//   - a regular file with a single link, at most `MAX_INGEST_BYTES` long.
//
// Reads go through a handle whose file identity (volume + file id) is compared
// with a fresh strict resolution after the read, so a swap between the check
// and the open is detected. Sidecar writes use the same inbox rules for the
// sidecar path; when that path is not safely writable (the drop's own name or
// directory is what got rejected) the sidecar goes to
// `00_Inbox/_ingest-errors/<sha256 of the relative path>.ingest-error.json`.

import { promises as fs, type BigIntStats } from 'node:fs';
import * as path from 'node:path';

import {
  VaultPathError,
  cmpKey,
  realVaultRoot,
  resolveContained,
  type ContainedPath,
  type VaultPathOptions,
} from '../vault-path.js';

/** The inbox folder, relative to the vault root (PRD §8.2). */
export const INBOX_DIR = '00_Inbox';

/**
 * Largest drop ingest will read (64 MiB). Checked with `stat` BEFORE reading, so
 * a huge (or sparse multi-GB) file is reported as `too-large` with a sidecar
 * instead of failing inside `readFile` (N6). M0's qualified extractors are
 * plain text; 64 MiB of text is far beyond any note the distiller can use.
 */
export const MAX_INGEST_BYTES = 64 * 1024 * 1024;

/** Directory (inside the inbox) for sidecars whose natural path is unsafe. */
export const INGEST_ERRORS_DIR = '_ingest-errors';

export type IngestRejectReason =
  | 'outside-inbox'
  | 'path-rejected'
  | 'reparse-point'
  | 'hardlinked'
  | 'not-a-file'
  | 'too-large'
  | 'read-error';

/** An inbox path that ingest refuses to read, delete or write next to. */
export class IngestSourceRejectedError extends Error {
  readonly code = 'INGEST_SOURCE_REJECTED';
  constructor(
    readonly reason: IngestRejectReason,
    readonly sourcePath: string,
    detail: string,
  ) {
    super(`ingest: ${reason} for ${JSON.stringify(sourcePath)} — ${detail}; the file was not read or modified`);
    this.name = 'IngestSourceRejectedError';
  }
}

function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * The drop's path relative to the inbox (POSIX, as given — not validated), or
 * null if `absPath` does not lexically lie under `<vaultRoot>/00_Inbox/`.
 */
export function inboxRelPath(vaultRoot: string, absPath: string): string | null {
  const rel = path.relative(path.resolve(vaultRoot), path.resolve(absPath));
  if (rel === '' || path.isAbsolute(rel)) return null;
  const segs = rel.split(/[\\/]+/);
  if (segs.length < 2 || cmpKey(segs[0]!) !== cmpKey(INBOX_DIR)) return null;
  if (segs.some((s) => s === '..')) return null;
  return segs.slice(1).join('/');
}

function mapPathViolation(err: VaultPathError): IngestRejectReason {
  switch (err.violation) {
    case 'hardlinked_target':
      return 'hardlinked';
    case 'target_is_link':
    case 'dangling_link':
    case 'escapes_root':
      return 'reparse-point';
    case 'target_not_file':
    case 'parent_not_directory':
      return 'not-a-file';
    default:
      return 'path-rejected';
  }
}

/** Real vault root and the real inbox, which must not itself be a reparse point. */
async function realInbox(vaultRoot: string, sourcePath: string): Promise<{ realRoot: string; inbox: string }> {
  const realRoot = await realVaultRoot(vaultRoot);
  const inbox = path.join(realRoot, INBOX_DIR);
  let st;
  try {
    st = await fs.lstat(inbox);
  } catch (err) {
    if (isMissing(err)) throw new IngestSourceRejectedError('not-a-file', sourcePath, `${inbox} does not exist`);
    throw err;
  }
  if (st.isSymbolicLink()) {
    throw new IngestSourceRejectedError('reparse-point', sourcePath, `${inbox} is a junction/symlink`);
  }
  if (!st.isDirectory()) throw new IngestSourceRejectedError('not-a-file', sourcePath, `${inbox} is not a directory`);
  const real = await fs.realpath(inbox);
  if (cmpKey(real) !== cmpKey(inbox)) {
    throw new IngestSourceRejectedError('reparse-point', sourcePath, `${inbox} resolves to ${real}`);
  }
  return { realRoot, inbox };
}

/** A path proven to lie inside the real inbox with no reparse point in between. */
export interface InboxTarget {
  /** The contained path (vault-relative `00_Inbox/...`), for recheck/atomic writes. */
  cp: ContainedPath;
  /** Path relative to the inbox (POSIX). */
  inboxRel: string;
  /** Whether the final entry exists (as a single-link regular file). */
  exists: boolean;
  /** lstat of the final entry when it exists. */
  stat?: BigIntStats;
}

/**
 * Prove `absPath` is (or, for a sidecar, may be created as) a file inside the
 * real inbox — see the module header for the exact rules. Throws
 * `IngestSourceRejectedError` (never follows, reads or writes anything).
 */
export async function resolveInboxPath(vaultRoot: string, absPath: string): Promise<InboxTarget> {
  const inboxRel = inboxRelPath(vaultRoot, absPath);
  if (inboxRel === null) {
    throw new IngestSourceRejectedError('outside-inbox', absPath, `not under ${INBOX_DIR}/`);
  }
  const opts: VaultPathOptions = {};
  let cp: ContainedPath;
  try {
    cp = await resolveContained(vaultRoot, `${INBOX_DIR}/${inboxRel}`, opts);
  } catch (err) {
    if (err instanceof VaultPathError) {
      throw new IngestSourceRejectedError(mapPathViolation(err), absPath, err.message);
    }
    throw err;
  }
  const { inbox } = await realInbox(vaultRoot, absPath);

  // Walk every segment below the real inbox: none may be a reparse point, and
  // each must resolve to exactly itself (catches reparse types lstat misses).
  const segs = cp.rel.split('/').slice(1);
  let cur = inbox;
  let stat: BigIntStats | undefined;
  for (let i = 0; i < segs.length; i++) {
    const next = path.join(cur, segs[i]!);
    const last = i === segs.length - 1;
    let st: BigIntStats;
    try {
      st = await fs.lstat(next, { bigint: true });
    } catch (err) {
      if (isMissing(err)) break; // the rest does not exist yet (a new sidecar)
      throw new IngestSourceRejectedError('read-error', absPath, String(err));
    }
    if (st.isSymbolicLink()) {
      throw new IngestSourceRejectedError('reparse-point', absPath, `${next} is a junction/symlink`);
    }
    const real = await fs.realpath(next).catch(() => null);
    if (real === null || cmpKey(real) !== cmpKey(next)) {
      throw new IngestSourceRejectedError('reparse-point', absPath, `${next} resolves to ${String(real)}`);
    }
    if (!last) {
      if (!st.isDirectory()) throw new IngestSourceRejectedError('not-a-file', absPath, `${next} is not a directory`);
    } else {
      if (!st.isFile()) throw new IngestSourceRejectedError('not-a-file', absPath, `${next} is not a regular file`);
      if (st.nlink !== 1n) {
        throw new IngestSourceRejectedError('hardlinked', absPath, `${next} has ${st.nlink} hard links`);
      }
      stat = st;
    }
    cur = next;
  }
  return { cp, inboxRel: segs.join('/'), exists: stat !== undefined, ...(stat ? { stat } : {}) };
}

/** Bytes of an inbox drop, read under the rules above. */
export interface InboxRead {
  target: InboxTarget;
  bytes: Buffer;
}

/**
 * Read an inbox drop: strict resolution, size cap via `stat` before reading,
 * a single-link regular-file handle, a bounded read, then a fresh strict
 * resolution whose file identity must match the handle's. A missing file
 * rethrows the ENOENT error; everything else is `IngestSourceRejectedError`.
 */
export async function readInboxFile(vaultRoot: string, absPath: string): Promise<InboxRead> {
  const target = await resolveInboxPath(vaultRoot, absPath);
  if (!target.exists || !target.stat) {
    const err = new Error(`ENOENT: ${absPath} no longer exists`) as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  }
  if (target.stat.size > BigInt(MAX_INGEST_BYTES)) {
    throw new IngestSourceRejectedError(
      'too-large',
      absPath,
      `${target.stat.size} bytes exceeds the ${MAX_INGEST_BYTES}-byte ingest limit`,
    );
  }

  let handle;
  try {
    handle = await fs.open(target.cp.abs, 'r');
  } catch (err) {
    if (isMissing(err)) throw err;
    throw new IngestSourceRejectedError('read-error', absPath, String(err));
  }
  let bytes: Buffer;
  let st: BigIntStats;
  try {
    st = await handle.stat({ bigint: true });
    if (!st.isFile()) throw new IngestSourceRejectedError('not-a-file', absPath, 'not a regular file');
    if (st.nlink !== 1n) {
      throw new IngestSourceRejectedError('hardlinked', absPath, `${st.nlink} hard links`);
    }
    if (st.size > BigInt(MAX_INGEST_BYTES)) {
      throw new IngestSourceRejectedError('too-large', absPath, `${st.size} bytes`);
    }
    // Bounded read: never more than the cap + 1, however the file grows.
    const cap = MAX_INGEST_BYTES + 1;
    const buf = Buffer.alloc(Math.min(cap, Number(st.size) + 1));
    let off = 0;
    for (;;) {
      if (off === buf.length) break;
      const { bytesRead } = await handle.read(buf, off, buf.length - off, off);
      if (bytesRead === 0) break;
      off += bytesRead;
    }
    if (off > MAX_INGEST_BYTES || off > Number(st.size)) {
      throw new IngestSourceRejectedError('too-large', absPath, 'the file grew during the read');
    }
    bytes = buf.subarray(0, off);
  } catch (err) {
    if (err instanceof IngestSourceRejectedError) throw err;
    throw new IngestSourceRejectedError('read-error', absPath, String(err));
  } finally {
    await handle.close();
  }

  // The path must still strictly resolve to the very file we read.
  const again = await resolveInboxPath(vaultRoot, absPath);
  if (!again.stat || again.stat.ino !== st.ino || again.stat.dev !== st.dev) {
    throw new IngestSourceRejectedError('reparse-point', absPath, 'the path changed while it was being read');
  }
  return { target, bytes };
}

export { recheckContained } from '../vault-path.js';
