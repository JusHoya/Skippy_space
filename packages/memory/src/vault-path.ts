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
//      (`CON`, `nul.md`, `COM1`...); 8.3 short-name segments (anything with
//      `~<digit>`, e.g. `OBSIDI~1`, which NTFS resolves to `.obsidian`); and, by
//      default, dot-prefixed segments (`.git`, `.obsidian`, `.skippy` are
//      control directories, not notes; G0 denied paths); segments ending in
//      `.lock` (the broker's proper-lockfile directories are `<note>.md.lock`,
//      so a note created inside one would pin that lock forever; M0 final
//      red-team #3); and Unicode look-alikes (#8): every segment is
//      NFC-normalized, invisible characters (format/bidi controls `Cf` such as
//      U+200B and U+202E, line/paragraph separators, non-ASCII spaces,
//      variation selectors, Hangul fillers, private use) are rejected, and a
//      segment whose NFKC form differs is re-checked in that form, so fullwidth
//      `．obsidian`, `４０_Daily` or `ｘ.lock` cannot alias a hidden, reserved
//      or control name. (A fullwidth `ｘ.md` that folds to an ordinary name is
//      accepted: it is a distinct file on NTFS, not an alias.)
//
//   2. REAL (`resolveContained`, async): resolve the vault root with native
//      realpath, then find the nearest EXISTING ancestor of the target and
//      realpath it. If a junction, symlink or other reparse point anywhere in the
//      chain resolves outside the real vault root, reject. A dangling link
//      (lstat succeeds, realpath fails) cannot be safely contained, so it is
//      rejected too. The REAL path (native realpath returns long names and the
//      on-disk case) is re-derived relative to the real root and the same
//      hidden-segment and reserved-name rules are applied to its segments, so
//      neither a short-name alias nor an in-vault junction can reach `.git` or
//      `.obsidian`. When the target itself exists it must not be a link, must be
//      a regular file, and must have a single link (a hardlink could alias a
//      file outside the vault). Comparison is case-insensitive on win32.
//
// `ensureContainedParentDir` creates missing parent directories one level at a
// time beneath the REAL parent, re-proving containment after each level, so a
// junction planted before the mkdir cannot make it create directories outside.
//
// `recheckContained` repeats step 2 under the writer's lock, immediately before
// the write, to narrow the window for a junction swap. See vault-broker.ts for
// the residual TOCTOU note.

import * as fsSync from 'node:fs';
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
  | 'short_name'
  | 'hardlinked_target'
  | 'parent_not_directory'
  | 'root_changed'
  | 'lock_segment'
  | 'invisible_char'
  | 'lookalike';

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
  /**
   * Allow ONLY these `.`-prefixed segment names (compared case-insensitively),
   * e.g. `['.skippy']` for the replay writer. Narrower than `allowHidden`: the
   * same list is applied to the REAL path, so a `.skippy` junction that
   * resolves to `.git` is still rejected.
   */
  allowHiddenNames?: readonly string[];
  /** Require a `.md` final segment. Default false; the note broker sets true. */
  requireMarkdown?: boolean;
  /** Accept an existing target that is a directory (not just a regular file). Default false. */
  allowNonFileTarget?: boolean;
  /** Accept an existing target that is itself a link, provided it resolves inside. Default false. */
  allowLinkTarget?: boolean;
  /** Accept an existing regular file with more than one hard link. Default false. */
  allowHardlinkTarget?: boolean;
  /**
   * Accept segments ending in `.lock` (e.g. `Cargo.lock` in a worktree). Default
   * false: inside the vault a `.lock` segment is a lock directory's name.
   */
  allowLockSegments?: boolean;
}

const MAX_REL_LEN = 1024;
const MAX_SEGMENT_LEN = 255;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const INVALID_SEGMENT_CHARS_RE = /[<>"|?*]/;
// Win32 device names, with or without an extension (`nul.md` is still NUL).
// Includes the superscript-digit COM/LPT variants and the console devices.
const RESERVED_RE = /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3]|conin\$|conout\$)(\..*)?$/i;

// An 8.3 short name (`OBSIDI~1`, `LONGNA~2.MD`). Fail closed: any segment with
// `~<digit>` is rejected, since NTFS may resolve it to a different long name.
const SHORT_NAME_RE = /~\d/;

// proper-lockfile's lock-directory suffix (`<note>.md.lock`).
const LOCK_SEGMENT_RE = /\.lock$/i;

// Invisible or look-alike-making characters (#8): format/bidi controls (Cf:
// U+00AD, U+200B-U+200F, U+202A-U+202E, U+2060-U+2064, U+2066-U+2069, U+FEFF,
// tag characters), line/paragraph separators, private use, every space other
// than U+0020, the combining grapheme joiner, variation selectors, Hangul
// fillers and the braille blank.
const INVISIBLE_RE =
  /[\p{Cf}\p{Zl}\p{Zp}\p{Co}ᅟᅠㅤﾠ⠀]|͏|\p{Variation_Selector}|(?! )\p{Zs}/u;

/**
 * Vault folder and control names (case-folded) that an NFKC look-alike may not
 * fold onto: the PRD §8.2 top-level folders, the originals store, the ingest
 * error folder and the reserved agent_log file name.
 */
const RESERVED_VAULT_NAMES: ReadonlySet<string> = new Set([
  '00_inbox',
  '10_atomic',
  '20_topics',
  '30_projects',
  '40_daily',
  '50_agents',
  '60_sources',
  '90_archive',
  '_index',
  'originals',
  '_ingest-errors',
  'agent_log.md',
]);

const IS_WIN = process.platform === 'win32';

/** Whether a `.`-prefixed segment is permitted under `opts`. */
function hiddenAllowed(seg: string, opts: VaultPathOptions): boolean {
  if (opts.allowHidden) return true;
  const names = opts.allowHiddenNames;
  if (!names || names.length === 0) return false;
  const key = seg.toLowerCase();
  return names.some((n) => n.toLowerCase() === key);
}

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

  const segments = input
    .split(/[\\/]+/)
    .filter((s) => s !== '' && s !== '.')
    .map((s) => s.normalize('NFC'));
  if (segments.length === 0) throw new VaultPathError('empty', input);

  for (const seg of segments) {
    const violation = segmentViolation(seg, opts);
    if (violation) throw new VaultPathError(violation, input);
    // NFKC look-alikes (#8): a segment that folds to something else under
    // compatibility normalization (fullwidth `．obsidian`, `４０_Daily`) must
    // pass every rule in its folded form too, and may not fold onto a reserved
    // vault name it does not literally spell.
    const folded = seg.normalize('NFKC');
    if (folded !== seg) {
      if (/[\\/:]/.test(folded) || segmentViolation(folded, opts) !== null) {
        throw new VaultPathError('lookalike', input, `"${seg}" folds to "${folded}"`);
      }
      if (RESERVED_VAULT_NAMES.has(folded.toLowerCase())) {
        throw new VaultPathError('lookalike', input, `"${seg}" looks like the reserved name "${folded}"`);
      }
    }
  }

  const last = segments[segments.length - 1]!;
  if (opts.requireMarkdown && !/\.md$/i.test(last)) {
    throw new VaultPathError('not_markdown', input);
  }
  return segments.join('/');
}

/** The first rule a single (NFC) path segment violates, or null. */
function segmentViolation(seg: string, opts: VaultPathOptions): VaultPathViolation | null {
  if (seg === '..') return 'traversal';
  if (seg.length > MAX_SEGMENT_LEN) return 'too_long';
  if (CONTROL_RE.test(seg)) return 'control_char';
  if (INVISIBLE_RE.test(seg)) return 'invisible_char';
  if (INVALID_SEGMENT_CHARS_RE.test(seg)) return 'invalid_char';
  // Win32 silently strips trailing dots/spaces (`foo.` -> `foo`, `.. ` -> `..`).
  if (/[. ]$/.test(seg)) return 'trailing_dot_space';
  if (RESERVED_RE.test(seg)) return 'reserved_name';
  if (SHORT_NAME_RE.test(seg)) return 'short_name';
  if (seg.startsWith('.') && !hiddenAllowed(seg, opts)) return 'hidden_segment';
  if (!opts.allowLockSegments && LOCK_SEGMENT_RE.test(seg)) return 'lock_segment';
  return null;
}

/** Case-normalize for comparison: NTFS is case-insensitive on win32. */
export function cmpKey(p: string): string {
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
  /** The options it was resolved with; `recheckContained` re-applies them. */
  opts?: VaultPathOptions;
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

/** The configured vault root cannot be canonicalized (missing, unreadable, dangling). */
export class VaultRootError extends Error {
  readonly code = 'VAULT_ROOT_UNRESOLVABLE';
  constructor(readonly vaultRoot: string, cause: unknown) {
    super(`Vault root ${JSON.stringify(vaultRoot)} cannot be canonicalized: ${String(cause)}`);
    this.name = 'VaultRootError';
  }
}

/**
 * The canonical form of a configured vault root (M0 final red-team #5): the
 * native realpath, i.e. long names instead of 8.3 aliases (`LONGVA~1`), on-disk
 * case, junctions resolved. Components that compare paths against the root
 * (the inbox watcher, runIngest, the runtime wiring) canonicalize ONCE through
 * here, so an alias root behaves exactly like its long form. Never creates
 * anything; throws `VaultRootError` when the root cannot be resolved, so the
 * caller fails loudly instead of silently doing nothing.
 */
export async function canonicalVaultRoot(vaultRoot: string): Promise<string> {
  let real: string;
  try {
    real = await fs.realpath(path.resolve(vaultRoot));
    if (!(await fs.stat(real)).isDirectory()) throw new Error('not a directory');
  } catch (err) {
    throw new VaultRootError(vaultRoot, err);
  }
  return real;
}

/** Synchronous `canonicalVaultRoot` (native realpath) for synchronous startup wiring. */
export function canonicalVaultRootSync(vaultRoot: string): string {
  let real: string;
  try {
    real = fsSync.realpathSync.native(path.resolve(vaultRoot));
    if (!fsSync.statSync(real).isDirectory()) throw new Error('not a directory');
  } catch (err) {
    throw new VaultRootError(vaultRoot, err);
  }
  return real;
}

/**
 * Re-base `absPath` from `givenRoot` onto `canonicalRoot` when it lies
 * lexically under `givenRoot` (e.g. an 8.3-form path under an 8.3-form root);
 * otherwise return it resolved but otherwise unchanged.
 */
export function rebaseOntoRoot(givenRoot: string, canonicalRoot: string, absPath: string): string {
  const given = path.resolve(givenRoot);
  const target = path.resolve(absPath);
  if (!isPathInside(given, target)) return target;
  const rel = path.relative(given, target);
  return rel === '' ? canonicalRoot : path.join(canonicalRoot, rel);
}

/**
 * Apply the segment rules to a REAL path: re-derive it relative to the real
 * root and reject hidden (unless allowed) and reserved-name segments. Native
 * realpath yields long names, so this is what stops an 8.3 alias or an in-vault
 * junction from reaching `.git`/`.obsidian`/`.skippy`.
 */
function assertRealSegments(
  realRoot: string,
  real: string,
  input: string,
  opts: VaultPathOptions,
): void {
  const rel = path.relative(realRoot, real);
  if (rel === '') return;
  for (const seg of rel.split(/[\\/]+/)) {
    if (RESERVED_RE.test(seg)) {
      throw new VaultPathError('reserved_name', input, `real path segment "${seg}"`);
    }
    if (seg.startsWith('.') && !hiddenAllowed(seg, opts)) {
      throw new VaultPathError('hidden_segment', input, `real path segment "${seg}"`);
    }
    if (!opts.allowLockSegments && LOCK_SEGMENT_RE.test(seg)) {
      throw new VaultPathError('lock_segment', input, `real path segment "${seg}"`);
    }
    if (INVISIBLE_RE.test(seg)) {
      throw new VaultPathError('invisible_char', input, `real path segment ${JSON.stringify(seg)}`);
    }
    const folded = seg.normalize('NFKC');
    if (folded !== seg && folded.startsWith('.') && !hiddenAllowed(folded, opts)) {
      throw new VaultPathError('lookalike', input, `real path segment "${seg}" folds to "${folded}"`);
    }
  }
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
  opts: VaultPathOptions = {},
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
    assertRealSegments(realRoot, real, input, opts);
    if (cur === abs) {
      if (st.isSymbolicLink() && !opts.allowLinkTarget) {
        throw new VaultPathError('target_is_link', input, 'the target is a symlink or junction');
      }
      if (!opts.allowNonFileTarget && !st.isSymbolicLink() && !st.isFile()) {
        throw new VaultPathError('target_not_file', input);
      }
      if (!opts.allowHardlinkTarget && st.isFile() && st.nlink > 1) {
        throw new VaultPathError(
          'hardlinked_target',
          input,
          `the target has ${st.nlink} hard links and may alias a file outside the vault`,
        );
      }
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
  const exists = await assertRealContainment(realRoot, abs, untrustedRelPath, opts);
  return { rel, vaultRoot, realRoot, abs, exists, opts: { ...opts } };
}

async function assertRootUnchanged(cp: ContainedPath): Promise<void> {
  const realRootNow = await fs.realpath(cp.realRoot).catch(() => null);
  if (realRootNow === null || cmpKey(realRootNow) !== cmpKey(cp.realRoot)) {
    throw new VaultPathError('root_changed', cp.rel, `vault root no longer resolves to ${cp.realRoot}`);
  }
}

/**
 * Create the target's missing parent directories one level at a time and
 * return the REAL parent directory (FR-SEC-02; red-team E3-4). Each level is
 * created beneath the real path of the level above it, then its own real path
 * is re-proven inside the vault and rule-checked before the next level is
 * created. A junction swapped in after resolution is therefore detected at the
 * first level it affects and nothing is created beneath it (`mkdir -p` would
 * follow it and build the whole chain outside the vault).
 */
export async function ensureContainedParentDir(cp: ContainedPath): Promise<string> {
  const opts = cp.opts ?? {};
  await assertRootUnchanged(cp);
  let cur = cp.realRoot;
  for (const seg of cp.rel.split('/').slice(0, -1)) {
    const next = path.join(cur, seg);
    try {
      await fs.mkdir(next);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    let real: string;
    try {
      real = await fs.realpath(next);
    } catch (err) {
      if (isMissing(err)) {
        throw new VaultPathError('dangling_link', cp.rel, `${next} is an unresolvable reparse point`);
      }
      throw err;
    }
    if (!isPathInside(cp.realRoot, real)) {
      throw new VaultPathError('escapes_root', cp.rel, `${next} resolves to ${real}`);
    }
    assertRealSegments(cp.realRoot, real, cp.rel, opts);
    if (!(await fs.stat(real)).isDirectory()) {
      throw new VaultPathError('parent_not_directory', cp.rel, `${real} is not a directory`);
    }
    cur = real;
  }
  return cur;
}

/** Result shape of `containmentPathGuard` (structurally tool-policy's PathGuardResult). */
export type ContainmentGuardResult = { ok: true } | { ok: false; reason: string };

/**
 * Adapter with the shape of agent-runtime tool-policy's `PathGuard`
 * `(target, roots, base) => Promise<{ok} | {ok:false, reason}>`, so the WS-C
 * tool broker can use the same FR-SEC-02 containment as the vault broker.
 *
 * `target` may be absolute or relative to `base`. The raw string is screened
 * for NUL/control chars, UNC/device prefixes, drive-relative forms and NTFS
 * ADS (a colon anywhere but the drive letter). It is then allowed if it lies
 * inside ANY root, lexically and by the real (junction/symlink-resolved)
 * nearest existing ancestor, with every segment below the root passing the
 * lexical gate. Hidden segments, directories and in-root link targets are
 * allowed, since built-in tools read and write ordinary worktrees.
 * Never throws.
 */
export async function containmentPathGuard(
  target: string,
  roots: readonly string[],
  base: string,
): Promise<ContainmentGuardResult> {
  if (typeof target !== 'string' || target.length === 0) return { ok: false, reason: 'empty path' };
  if (CONTROL_RE.test(target)) return { ok: false, reason: 'control character in path' };
  if (/^[\\/]{2}/.test(target)) return { ok: false, reason: 'UNC/device paths are not permitted' };
  if (/^[A-Za-z]:(?![\\/])/.test(target)) {
    return { ok: false, reason: 'drive-relative paths are not permitted' };
  }
  const afterDrive = /^[A-Za-z]:[\\/]/.test(target) ? target.slice(2) : target;
  if (afterDrive.includes(':')) return { ok: false, reason: 'NTFS alternate data streams are not permitted' };
  if (roots.length === 0) return { ok: false, reason: 'no roots assigned' };

  const lexical = path.resolve(base, target);
  const reasons: string[] = [];
  for (const root of roots) {
    const rootAbs = path.resolve(root);
    if (!isPathInside(rootAbs, lexical)) {
      reasons.push(`outside ${root}`);
      continue;
    }
    try {
      const realRoot = await fs.realpath(rootAbs);
      const rel = path.relative(rootAbs, lexical);
      if (rel === '') return { ok: true };
      const safeRel = normalizeVaultRelPath(rel, { allowHidden: true, allowLockSegments: true });
      const abs = path.join(realRoot, ...safeRel.split('/'));
      await assertRealContainment(realRoot, abs, target, {
        allowHidden: true,
        allowNonFileTarget: true,
        allowLinkTarget: true,
        allowHardlinkTarget: true, // pnpm stores hardlink package files
        allowLockSegments: true, // Cargo.lock, yarn.lock, ...
      });
      return { ok: true };
    } catch (err) {
      reasons.push(err instanceof Error ? err.message : String(err));
    }
  }
  return { ok: false, reason: `path not contained: ${reasons.join('; ')}` };
}

/**
 * Re-prove containment at write time (under the caller's lock): the vault root
 * must still resolve to the same real path, and the target's nearest existing
 * ancestor must still resolve inside it and pass the segment rules, under the
 * options the path was resolved with. Returns whether the target exists now.
 */
export async function recheckContained(cp: ContainedPath, target = cp.abs): Promise<boolean> {
  await assertRootUnchanged(cp);
  if (!isPathInside(cp.realRoot, target)) throw new VaultPathError('escapes_root', cp.rel);
  return assertRealContainment(cp.realRoot, target, cp.rel, cp.opts ?? {});
}
