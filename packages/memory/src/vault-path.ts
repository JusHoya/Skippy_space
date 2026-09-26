// vault-path.ts — vault path containment (FR-SEC-02, FR-WIKI-02; assessment A03).
//
// Every vault write resolves its target through here. An untrusted,
// vault-relative path goes through two gates:
//
//   1. LEXICAL (`normalizeVaultRelPath`, synchronous, no I/O): reject empty or
//      control characters (including NUL); absolute POSIX (`/x`); root-relative
//      Windows paths (`\x`); UNC and device paths (`\\server\share`, `\\?\C:\`,
//      `\\.\pipe`); drive-absolute and drive-relative paths (`C:\x`, `C:x`); any
//      `:` (so no NTFS alternate data streams like `note.md:evil`); `..`
//      traversal; Windows-invalid characters; segments ending in a dot or space
//      (Win32 strips those, which aliases names); reserved device names
//      (`CON`, `nul.md`, `COM1`...); and, by default, dot-prefixed segments
//      (`.git`, `.obsidian`, `.skippy` are control directories, not notes; G0
//      denied paths).
//
//   2. REAL (`resolveContained`, async): resolve the vault root with native
//      realpath, then find the nearest EXISTING ancestor of the target and
//      realpath it. If a junction, symlink or other reparse point anywhere in the
//      chain resolves outside the real vault root, reject. A dangling link
//      (lstat succeeds, realpath fails) cannot be safely contained, so it is
//      rejected too. When the target itself exists it must not be a link and must
//      be a regular file. Comparison is case-insensitive on win32.
//
// `recheckContained` repeats step 2 under the writer's lock, immediately before
// the write, to narrow the window for a junction swap. See vault-broker.ts for
// the residual TOCTOU note.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/** Stable machine-readable reasons, so callers and tests can branch on them. */
export type VaultPathViolation =
  | 'empty'
  | 'too_long'
  | 'control_char'
  | 'absolute'
  | 'unc_or_device'
  | 'drive'
  | 'colon_or_ads'
  | 'traversal'
  | 'invalid_char'
  | 'trailing_dot_space'
  | 'reserved_name'
  | 'hidden_segment'
  | 'not_markdown'
  | 'escapes_root'
  | 'dangling_link'
  | 'target_is_link'
  | 'target_not_file'
  | 'root_changed';

export class VaultPathError extends Error {
  readonly code = 'VAULT_PATH_REJECTED';
  constructor(
    readonly violation: VaultPathViolation,
    readonly input: string,
    detail?: string,
  ) {
    super(
      `Vault path rejected (${violation}): ${JSON.stringify(input)}${detail ? ` — ${detail}` : ''}`,
    );
    this.name = 'VaultPathError';
  }
}

export interface VaultPathOptions {
  /** Allow `.`-prefixed segments such as `.obsidian`. Default false (G0 denied paths). */
  allowHidden?: boolean;
  /** Require a `.md` final segment. Default false; the note broker sets true. */
  requireMarkdown?: boolean;
}

const MAX_REL_LEN = 1024;
const MAX_SEGMENT_LEN = 255;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const INVALID_SEGMENT_CHARS_RE = /[<>"|?*]/;
// Win32 device names, with or without an extension (`nul.md` is still NUL).
// Includes the superscript-digit COM/LPT variants and the console devices.
const RESERVED_RE = /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3]|conin\$|conout\$)(\..*)?$/i;

const IS_WIN = process.platform === 'win32';

/**
 * Lexically validate an untrusted vault-relative path and return its canonical
 * POSIX form (`10_Atomic/x.md`). Both `/` and `\` are accepted as separators;
 * empty and `.` segments are dropped. Throws `VaultPathError` on any violation.
 * Pure and synchronous, so the REST client can use it before sending a request.
 */
export function normalizeVaultRelPath(input: unknown, opts: VaultPathOptions = {}): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new VaultPathError('empty', String(input));
  }
  if (input.length > MAX_REL_LEN) throw new VaultPathError('too_long', input.slice(0, 64));
  if (CONTROL_RE.test(input)) throw new VaultPathError('control_char', input);

  // UNC (`\\srv\share`), device (`\\?\`, `\\.\`) and their forward-slash forms.
  if (/^[\\/]{2}/.test(input)) throw new VaultPathError('unc_or_device', input);
  // Root-relative on Windows (`\x`) or absolute on POSIX (`/x`).
  if (/^[\\/]/.test(input)) throw new VaultPathError('absolute', input);
  // Drive-absolute (`C:\x`) and drive-relative (`C:x`).
  if (/^[A-Za-z]:/.test(input)) throw new VaultPathError('drive', input);
  // Any remaining colon is an NTFS alternate data stream (`note.md:stream`) or
  // otherwise invalid in a Windows file name.
  if (input.includes(':')) throw new VaultPathError('colon_or_ads', input);
  // Belt and braces: never let an absolute path through, whatever the host.
  if (path.win32.isAbsolute(input) || path.posix.isAbsolute(input)) {
    throw new VaultPathError('absolute', input);
  }

  const segments = input.split(/[\\/]+/).filter((s) => s !== '' && s !== '.');
  if (segments.length === 0) throw new VaultPathError('empty', input);

  for (const seg of segments) {
    if (seg === '..') throw new VaultPathError('traversal', input);
    if (seg.length > MAX_SEGMENT_LEN) throw new VaultPathError('too_long', input);
    if (INVALID_SEGMENT_CHARS_RE.test(seg)) throw new VaultPathError('invalid_char', input);
    // Win32 silently strips trailing dots/spaces (`foo.` -> `foo`, `.. ` -> `..`).
    if (/[. ]$/.test(seg)) throw new VaultPathError('trailing_dot_space', input);
    if (RESERVED_RE.test(seg)) throw new VaultPathError('reserved_name', input);
    if (!opts.allowHidden && seg.startsWith('.')) {
      throw new VaultPathError('hidden_segment', input);
    }
  }

  const last = segments[segments.length - 1]!;
  if (opts.requireMarkdown && !/\.md$/i.test(last)) {
    throw new VaultPathError('not_markdown', input);
  }
  return segments.join('/');
}

/** Case-normalize for comparison: NTFS is case-insensitive on win32. */
function cmpKey(p: string): string {
  const resolved = path.resolve(p);
  return IS_WIN ? resolved.toLowerCase() : resolved;
}

/**
 * True iff `candidate` is `root` or lies beneath it. Both must already be real
 * (resolved) paths. Uses a segment-aware comparison, so `C:\v` does not contain
 * `C:\vault-evil`, and a different drive or UNC share is never contained.
 */
export function isPathInside(root: string, candidate: string): boolean {
  const r = cmpKey(root);
  const c = cmpKey(candidate);
  if (r === c) return true;
  const rel = path.relative(r, c);
  if (rel === '' ) return true;
  if (path.isAbsolute(rel)) return false; // other drive / share
  return rel !== '..' && !rel.startsWith(`..${path.sep}`);
}

function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** A target proven to lie inside the vault at resolution time. */
export interface ContainedPath {
  /** Canonical POSIX vault-relative path, e.g. `20_Topics/plasma.md`. */
  rel: string;
  /** The caller-supplied vault root (used for reporting; never for containment). */
  vaultRoot: string;
  /** Native realpath of the vault root at resolution time. */
  realRoot: string;
  /** Absolute target built beneath `realRoot`. */
  abs: string;
  /** Whether the target existed (as a regular file) at resolution time. */
  exists: boolean;
}

/**
 * Native realpath of the vault root. The root is trusted configuration, so it
 * is created if missing (matching the prior `mkdir -p` behavior of the writers).
 */
export async function realVaultRoot(vaultRoot: string): Promise<string> {
  const abs = path.resolve(vaultRoot);
  await fs.mkdir(abs, { recursive: true });
  return fs.realpath(abs);
}

/**
 * Walk up from `abs` to the nearest existing entry, realpath it, and assert it
 * lies inside `realRoot`. Rejects dangling links. Also rejects the target
 * itself if it exists as a link or a non-file. Returns whether the target exists.
 */
async function assertRealContainment(
  realRoot: string,
  abs: string,
  input: string,
): Promise<boolean> {
  let cur = abs;
  for (;;) {
    let st;
    try {
      st = await fs.lstat(cur);
    } catch (err) {
      if (!isMissing(err)) throw err;
      const parent = path.dirname(cur);
      if (parent === cur) throw new VaultPathError('escapes_root', input, 'no existing ancestor');
      cur = parent;
      continue;
    }
    let real: string;
    try {
      real = await fs.realpath(cur);
    } catch (err) {
      if (isMissing(err)) {
        throw new VaultPathError('dangling_link', input, `${cur} is an unresolvable reparse point`);
      }
      throw err;
    }
    if (!isPathInside(realRoot, real)) {
      throw new VaultPathError('escapes_root', input, `${cur} resolves to ${real}`);
    }
    if (cur === abs) {
      if (st.isSymbolicLink()) {
        throw new VaultPathError('target_is_link', input, 'the target is a symlink or junction');
      }
      if (!st.isFile()) throw new VaultPathError('target_not_file', input);
      return true;
    }
    return false;
  }
}

/**
 * Resolve an untrusted vault-relative path to a contained absolute target.
 * Performs the lexical checks, resolves the real vault root, and proves the
 * nearest existing real ancestor (or the target itself) is inside it. New files
 * under not-yet-existing subdirectories are allowed.
 */
export async function resolveContained(
  vaultRoot: string,
  untrustedRelPath: string,
  opts: VaultPathOptions = {},
): Promise<ContainedPath> {
  const rel = normalizeVaultRelPath(untrustedRelPath, opts);
  const realRoot = await realVaultRoot(vaultRoot);
  const abs = path.join(realRoot, ...rel.split('/'));
  // Lexical sanity: the joined path must sit under the real root.
  if (!isPathInside(realRoot, abs)) throw new VaultPathError('escapes_root', untrustedRelPath);
  const exists = await assertRealContainment(realRoot, abs, untrustedRelPath);
  return { rel, vaultRoot, realRoot, abs, exists };
}

/**
 * Re-prove containment at write time (under the caller's lock): the vault root
 * must still resolve to the same real path, and the target's nearest existing
 * ancestor must still resolve inside it. Returns whether the target exists now.
 */
export async function recheckContained(cp: ContainedPath, target = cp.abs): Promise<boolean> {
  const realRootNow = await fs.realpath(cp.realRoot).catch(() => null);
  if (realRootNow === null || cmpKey(realRootNow) !== cmpKey(cp.realRoot)) {
    throw new VaultPathError('root_changed', cp.rel, `vault root no longer resolves to ${cp.realRoot}`);
  }
  if (!isPathInside(cp.realRoot, target)) throw new VaultPathError('escapes_root', cp.rel);
  return assertRealContainment(cp.realRoot, target, cp.rel);
}
