#!/usr/bin/env node
// Git auto-commit — vault/-only, isolated-index, never touches the user's
// staged work. See apps/shell/src-tauri/src/git_autocommit.rs for the Rust
// twin (A05 / FR-WIKI-06). Both implementations must stay in exact semantic
// parity; the secret lists live in ONE shared file,
// scripts/git-autocommit-secret-patterns.json, read by both.
//
// Path handling (E5-1): every path-listing git command runs with `-z` and
// its output is handled as raw bytes (a "byte string": one JS char per byte,
// latin1), so non-ASCII names are never C-quoted, never mangled, and round-
// trip exactly into pathspec files / `update-index --index-info` stdin.
// Every git call runs with GIT_LITERAL_PATHSPECS=1 (E5-4; the M0-G15 add
// fallback instead spells `:(literal)` on each entry) and no user path is
// ever put on a command line (E5-5): per-path input goes through stdin or a
// NUL-delimited --pathspec-from-file.
//
// Algorithm (no shell interpolation anywhere — execFileSync with argv):
//   0. If a pending-index-sync marker exists (<git-dir>/skippy-autocommit-pending,
//      {version, ref, new, parent}, left by a tick whose commit landed but whose
//      real-index sync failed), validate it first (E5-2, D5): recover only if
//      its version is known (absent/1 = legacy without `ref`, 2 = current, which
//      must carry `ref`), HEAD is still symbolically on `ref` and resolves to
//      exactly `new`, `new` exists as a commit, and `parent` is `new`'s first
//      parent (null <=> `new` is a root commit) and exists as a commit.
//      Otherwise (reset --hard, checkout of another branch, a user commit on
//      top, a corrupt/unknown/forged marker) drop it WITHOUT touching the
//      index and report `dropped` — a bad marker never wedges the tick. If
//      recovery is attempted and fails (e.g. a held index.lock), the tick
//      stops with an explicit error rather than stacking a commit on an
//      unsynced index.
//   1. Resolve HEAD (or note it's unborn) and the symbolic ref it points to.
//   2. Fail fast, untouched, if <git-dir>/index.lock already exists.
//   3. Snapshot the real index's vault entries (`ls-files -s -v -z`) and
//      HEAD's vault entries (`ls-tree -r -z`). A vault path is USER-OWNED
//      (E5-6/E5-7) if its real-index entry differs from HEAD in any way:
//      staged add/modify/delete, `rm --cached`, either side of a rename or
//      copy, intent-to-add, or unmerged. Skip-worktree / assume-unchanged
//      paths are FLAGGED. Neither is ever committed or re-synced.
//   4. Seed a throwaway index (read-tree HEAD; a copy of it is kept as the
//      SEED index), snapshot every attribute source (A1, below), then
//      `add -A -- vault` into the throwaway index and write-tree ->
//      preliminary tree; the candidate list is every vault path whose
//      (mode, oid) differs between HEAD and that tree. In a sparse checkout
//      `add` refuses (and fails on) out-of-cone paths; if it fails while
//      core.sparseCheckout is on, the throwaway index is reset to the seed
//      and the add is redone with `--sparse`, so a sparse checkout never
//      fails every tick (out-of-cone paths are then flagged, step 5). git
//      also dies on the whole add for ONE file it cannot convert (M0-G15: a
//      UTF-32 or BOM-less UTF-16/UTF-32 `working-tree-encoding`, an odd byte
//      count under UTF-16, an unknown encoding, a valueless
//      `working-tree-encoding`, a failing required filter). So on any add
//      failure the tick lists what add would visit (`ls-files --cached
//      --others --exclude-standard` against the seed index), evaluates
//      `filter` / `working-tree-encoding` for its present files against the
//      seed index, and — if any has one (or the checkout is sparse) — resets
//      to the seed and redoes `add -A [--sparse] -- vault` with each of them
//      excluded (`:(literal)vault` plus one `:(exclude,literal)<path>` per
//      file in a NUL-delimited `--pathspec-from-file`: the only git call run
//      without GIT_LITERAL_PATHSPECS, and every entry is still literal).
//      The withheld files are candidates excluded as `filtered-path` /
//      `encoded-path` (step 5); since git cannot tell whether they changed,
//      they are reported on every tick that needs this fallback. Any other
//      add failure still fails the tick explicitly. The
//      throwaway index lives in a fresh private directory in the OS temp dir
//      (`<tmp>/skippy-ac-<16 hex>/`, D1) — never under the git dir, so a long
//      repo/worktree path can't push `<index>.lock` past MAX_PATH — and the
//      directory (with any `.lock`) is removed in every case. It only ever
//      holds index files and pathspec lists (paths + object ids), never vault
//      file content. Every tick first sweeps `<tmp>/skippy-ac-<16 hex>`
//      directories older than one hour (left by a killed tick; exact name
//      match, real directories only, never through a symlink/junction, best
//      effort).
//   5. Exclusions, each restored to its HEAD state in the temp index (or
//      removed if HEAD lacks it) with ONE `update-index -z --index-info`.
//      Each excluded path gets exactly one reason (first match wins):
//        flagged            skip-worktree / assume-unchanged (step 3), or —
//                           when core.sparseCheckout is on — outside the
//                           sparse-checkout definition (`sparse-checkout
//                           check-rules`; no loadable patterns = inside, as
//                           git itself treats it)
//        user-staged        user-owned (step 3)
//        gitlink            a new or changed mode-160000 entry on either side
//                           (nested repo, submodule pointer bump, D4); gitlinks
//                           already in HEAD are left exactly as they are
//        secret-filename    shared filename rules
//        attributes-file    the path's last component names a
//                           `.gitattributes`: any ASCII case, plus every NTFS
//                           equivalent git itself treats as one (trailing
//                           spaces / periods, a `:stream` suffix, the
//                           `gitatt~N` / `gi7d29~N` 8.3 names; a port of
//                           git's `is_ntfs_dotgitattributes`, applied on every
//                           OS). Autocommit never adds, modifies or deletes an
//                           attributes file, so an encoding or filter rule
//                           reaches history only through a deliberate user
//                           commit (M0-G12 residuals D1-D3): a rule committed
//                           next to text stored without it would make every
//                           clone decode that text on checkout (D1: UTF-8 CJK
//                           text that UTF-16LE turns back into an ASCII key);
//                           with the rule kept out of history, a clone checks
//                           out exactly the stored bytes
//        attributes-changed an attribute source changed during the tick
//                           (A1 != A2, below): EVERY remaining candidate is
//                           deferred to the next tick
//        filtered-path      the path has a `filter` attribute (any value:
//                           `lfs`, a custom driver, even an unconfigured one)
//                           in EITHER evaluation — `check-attr` against the
//                           seed index (the pre-add attribute state; the
//                           working-tree side is pinned by A1 == A2) or
//                           against the post-add temp index. The vault is
//                           Markdown and needs no clean filter; a filter can
//                           turn any content into bytes the blob scan cannot
//                           judge (an LFS pointer, rot13), so filtered paths
//                           are never autocommitted (OQ-19)
//        encoded-path       the path has a `working-tree-encoding` attribute
//                           (any value but unspecified/unset: UTF-16LE,
//                           UTF-32, even UTF-8 or an empty value) in EITHER
//                           evaluation, same `check-attr` call and semantics
//                           as filtered-path (a path with both is
//                           filtered-path). Re-encoding is a clean filter in
//                           all but name (M0-G12): ASCII `AKIA...` bytes
//                           declared UTF-16LE are stored as CJK text holding
//                           no `AKIA` and no NUL, which no blob view can
//                           judge, and every checkout or clone turns the blob
//                           back into the plaintext key. Fail closed: a
//                           genuinely UTF-16 note under a legitimate rule is
//                           refused too (the vault is UTF-8 Markdown) (OQ-19)
//        too-large-to-scan  blob larger than limits.maxScanBytes (64 MiB, D3)
//                           — never read, fail closed
//        lfs-pointer        the blob holds a git-lfs pointer version line
//                           (shared `lfsPointer.versionLines`, all v1 spec
//                           aliases git-lfs 3.x accepts, matched anywhere in
//                           the blob: a superset of what git-lfs decodes as a
//                           pointer), whatever the attributes say. `git push`
//                           uploads the object a committed pointer names, so
//                           a pointer to a secret an earlier tick excluded
//                           (but whose `add` already stored it under
//                           .git/lfs/objects) must never reach history
//        secret-content     shared content rules hit the exact blob the commit
//                           would contain (`cat-file --batch`, fetched in
//                           batches of at most maxScanBytes; latin1 and again
//                           with NULs stripped for UTF-16)
//      With filtered and encoded paths refused, every committed blob is
//      exactly the scanned blob: the scan needs no proof step. Mode-120000
//      entries are scanned the same way (core.symlinks=false: the blob IS the
//      file's bytes; a real symlink: the blob is the link target).
//      Attribute audit (M0-G12; git's convert.c reads exactly `text`, `eol`,
//      `crlf`, `ident`, `filter` and `working-tree-encoding`, plus
//      core.autocrlf / core.eol / core.safecrlf): only `filter` and
//      `working-tree-encoding` can make the checkout differ from the blob in
//      anything but line endings, and both are refused. `text`/`eol`/`crlf`/
//      core.autocrlf only add or drop a CR right before an LF (text=auto
//      leaves binary and lone-CR files alone), and no shared content pattern
//      can consume a CR that is followed by an LF, so the blob's verdict is
//      the checkout's. `ident` only collapses `$Id: ...$` to `$Id$` on add
//      (dropping bytes, never storing them) and expands `$Id$` to the blob's
//      own object id on checkout, which the user cannot choose. `diff`,
//      `merge`, `whitespace`, `encoding` (gitk/gui display), `binary`,
//      `delta` and `conflict-marker-size` never touch blob content;
//      `export-subst` / `export-ignore` act on `git archive` only. Those stay
//      exactly as git applies them, and the blob they produce is what gets
//      scanned.
//      Attribute snapshots A1 (before the add) and A2 (after the scans and
//      both check-attr runs) cover every source git reads (M0-G13): every
//      attributes file (the attributes-file names, any case, so the
//      `.GitAttributes` git opens on a case-insensitive filesystem is seen)
//      at the repo root and anywhere under vault/ (walked without following
//      links; a directory holding a `.git` entry is skipped only if
//      `rev-parse --show-cdup` run there says it is a real nested repository
//      — `add` walks straight into one with a bogus `.git` — and that verdict
//      is recorded), `$GIT_COMMON_DIR/info/attributes`, the global file
//      (`git var GIT_ATTR_GLOBAL`: core.attributesFile or the XDG default)
//      and the system file (`git var GIT_ATTR_SYSTEM`), a relative path
//      resolved against the repository top level (where git itself opens it,
//      not the process cwd), each recorded as its path plus its full content
//      (or absent / a link / unreadable); plus `attr.tree` (every configured
//      value and the tree the last one names: git reads attributes from that
//      tree instead of the working tree) and GIT_ATTR_SOURCE (value and
//      tree). Only a flip AND flip-back entirely inside the window between
//      two observations can go unseen; a flip that is still in place at A2
//      defers the tick.
//      Residual (OQ-19, M0-G14): such an unseen flip can still store a
//      re-encoded or filtered blob for a path (e.g. the CJK text a transient
//      UTF-16LE rule makes of an ASCII key). Because autocommit never commits
//      the rule, a clone or checkout without it writes exactly those stored
//      bytes: the plaintext reappears only where a matching rule is active
//      again (the attacker's own machine or attribute files, or a user who
//      later commits such a rule by hand). The stored bytes are still a
//      reversible transform of the secret that the scanner cannot judge, so
//      anyone who knows the transform can decode them offline. Reaching this
//      takes write access to an attribute source at the right instant, i.e.
//      a local attacker who could equally write the secret into a note in
//      any encoding no content scan recognizes.
//      All are reported in `skipped` (byte order) and `skippedDetail`
//      ({path, reason}).
//   6. If nothing is left, no-op. Otherwise write-tree -> final tree.
//   7. git commit-tree <tree> [-p HEAD] -m <msg> (plumbing: no hooks run).
//   8. git update-ref HEAD <new> <old> — compare-and-swap; fails explicitly
//      if HEAD moved, before the real index was touched.
//   9. Sync the real index ONLY for the committed paths (parent -> new diff),
//      and only those whose real-index entry still equals the parent's
//      (re-read at sync time), via `reset -q <new> --pathspec-from-file`
//      (literal, NUL-delimited). Failure after bounded retries is NOT a failed
//      commit: a pending marker is written and the result is 'pending-sync'.
//
// Known window (E5-9): between step 8 and a successful sync (normally
// milliseconds; up to the next tick if the sync hit a held index.lock), the
// real index still holds the parent's blobs for the committed paths. A user
// `git commit` made inside that window records those parent blobs, i.e. it
// reverts the autocommitted vault change in the user's commit. The marker is
// then dropped (HEAD moved) and the next tick re-commits the working-tree
// content, so the revert lasts only until the next tick.
//
// The temp index / pathspec files (and their private temp directories) are
// removed in every case.
//
// Secrets: `commit-tree` never runs hooks, so a repo's own secret-scanning
// pre-commit hook can never see (or block) this commit. The built-in guard
// (step 5) is the only line of defense. It scans exactly the committed
// blobs, and refuses every path whose committed bytes could differ from what
// the user wrote or what a checkout writes back (filtered-path,
// encoded-path) or could make `git push` upload something else
// (lfs-pointer), and never commits an attributes file (attributes-file), so
// neither a clean filter, a working-tree-encoding nor git-lfs can smuggle a
// secret into history beyond the flip-and-flip-back residual above.
//
// Test seam: `runAutocommit(root, now, { onPhase })` calls
// `onPhase('added')` after step 4's add/write-tree and `onPhase('scanned')`
// after the blob scan and both `check-attr` runs, before the closing
// attribute snapshot (A2). Production callers pass nothing.

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const VAULT_PATHSPEC = 'vault';
const PENDING_MARKER_NAME = 'skippy-autocommit-pending';
const PENDING_MARKER_VERSION = 2;
const GITLINK_MODE = '160000';
/** Name of every private temp dir a tick creates (and the sweep removes). */
const TEMP_DIR_RE = /^skippy-ac-[0-9a-f]{16}$/;
/** A `skippy-ac-*` dir untouched for this long belongs to a killed tick. */
export const STALE_TEMP_DIR_MS = 60 * 60 * 1000;
const SYNC_RETRY_ATTEMPTS = 3;
const SYNC_RETRY_DELAY_MS = 20;
const MAX_GIT_OUTPUT = 1024 * 1024 * 1024;
const GIT_ENV = { GIT_LITERAL_PATHSPECS: '1' };
/** The M0-G15 fallback add only: pathspec magic on, every entry `:(literal)`. */
const MAGIC_PATHSPEC_ENV = { GIT_LITERAL_PATHSPECS: '0', GIT_GLOB_PATHSPECS: '0' };
const OID_RE = /^([0-9a-f]{40}|[0-9a-f]{64})$/;

// --- Secret guard (FR-WIKI-06), shared with the Rust twin ----------------

export const SECRET_PATTERNS_FILE = fileURLToPath(new URL('./git-autocommit-secret-patterns.json', import.meta.url));
export const SECRET_PATTERNS = JSON.parse(readFileSync(SECRET_PATTERNS_FILE, 'utf8'));

const FILENAME_RULES = SECRET_PATTERNS.filename.map((r) => ({
  re: new RegExp(r.pattern),
  unless: r.unless ? new RegExp(r.unless) : null,
}));
const CONTENT_RULES = SECRET_PATTERNS.content.map((r) => ({
  re: new RegExp(r.pattern),
  ci: r.ignoreAsciiCase === true,
}));
/** Largest blob the guard will scan (and so commit). */
export const MAX_SCAN_BYTES = SECRET_PATTERNS.limits.maxScanBytes;
if (!Number.isSafeInteger(MAX_SCAN_BYTES) || MAX_SCAN_BYTES <= 0) throw new Error('limits.maxScanBytes must be a positive integer');
/** git-lfs pointer version lines (latin1 byte strings), shared with Rust. */
const LFS_POINTER_LINES = SECRET_PATTERNS.lfsPointer.versionLines;
if (!Array.isArray(LFS_POINTER_LINES) || LFS_POINTER_LINES.length === 0 || !LFS_POINTER_LINES.every((l) => typeof l === 'string' && l.length > 0)) {
  throw new Error('lfsPointer.versionLines must be a non-empty list of strings');
}

/** ASCII-only lowercase (identical to Rust's `to_ascii_lowercase`). */
function asciiLower(s) {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/** @param {string} bytePath repo-relative path as a byte string (latin1). */
export function matchesSecretFilename(bytePath) {
  const p = asciiLower(bytePath);
  return FILENAME_RULES.some((r) => r.re.test(p) && !(r.unless && r.unless.test(p)));
}

/** @param {Buffer} bytes exact blob content. */
export function matchesSecretContent(bytes) {
  const raw = bytes.toString('latin1');
  const views = [raw];
  if (raw.includes('\0')) views.push(raw.replace(/\0/g, '')); // UTF-16LE/BE, any offset
  for (const view of views) {
    let lower = null;
    for (const r of CONTENT_RULES) {
      const text = r.ci ? (lower ??= asciiLower(view)) : view;
      if (r.re.test(text)) return true;
    }
  }
  return false;
}

/**
 * @param {Buffer} bytes exact blob content. True if it contains a git-lfs
 * pointer version line anywhere (a superset of what git-lfs 3.x decodes as a
 * pointer: its decoder needs `version <alias>` verbatim on a line).
 */
export function matchesLfsPointer(bytes) {
  const raw = bytes.toString('latin1');
  return LFS_POINTER_LINES.some((l) => raw.includes(l));
}

/** byte string (latin1) <-> display string (UTF-8). */
export const toBytePath = (utf8) => Buffer.from(utf8, 'utf8').toString('latin1');
const toDisplayPath = (bytePath) => Buffer.from(bytePath, 'latin1').toString('utf8');

// --- git plumbing helpers --------------------------------------------------

function gitRaw(root, args, { env = {}, input } = {}) {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      env: { ...process.env, ...GIT_ENV, ...env },
      input,
      maxBuffer: MAX_GIT_OUTPUT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    const stderr = e.stderr ? e.stderr.toString().trim() : e.message;
    const err = new Error(`git ${args.join(' ')} failed: ${stderr}`);
    err.cause = e;
    err.status = e.status;
    throw err;
  }
}

function git(root, args, opts) {
  return gitRaw(root, args, opts).toString('utf8').trim();
}

/** Split `-z` output into byte-string records. */
function splitZ(buf) {
  return buf.toString('latin1').split('\0').filter((r) => r.length > 0);
}

function resolveGitDir(root) {
  let raw;
  try {
    raw = git(root, ['rev-parse', '--git-dir']);
  } catch (e) {
    throw new Error(`not a git repository at ${root}: ${e.message}`);
  }
  return isAbsolute(raw) ? raw : resolve(root, raw);
}

export function resolveHead(root) {
  try {
    return git(root, ['rev-parse', '--verify', '-q', 'HEAD']);
  } catch {
    return null; // unborn HEAD
  }
}

/** The ref HEAD points at (`refs/heads/main`), or null when detached. */
function resolveSymbolicHead(root) {
  try {
    return git(root, ['symbolic-ref', '-q', 'HEAD']) || null;
  } catch (e) {
    if (e.status === 1) return null; // detached
    throw e;
  }
}

/** Vault entries of a tree-ish: Map<bytePath, "mode oid">. */
function treeEntries(root, treeish) {
  const map = new Map();
  if (!treeish || treeish === EMPTY_TREE) return map;
  for (const rec of splitZ(gitRaw(root, ['ls-tree', '-r', '-z', treeish, '--', VAULT_PATHSPEC]))) {
    const tab = rec.indexOf('\t');
    const [mode, , oid] = rec.slice(0, tab).split(' ');
    map.set(rec.slice(tab + 1), `${mode} ${oid}`);
  }
  return map;
}

/** Real-index vault snapshot: stage-0 entries, flagged and unmerged paths. */
function realIndexSnapshot(root) {
  const entries = new Map();
  const flagged = new Set();
  const unmerged = new Set();
  for (const rec of splitZ(gitRaw(root, ['ls-files', '-s', '-v', '-z', '--', VAULT_PATHSPEC]))) {
    const tab = rec.indexOf('\t');
    const [tag, mode, oid, stage] = rec.slice(0, tab).split(' ');
    const path = rec.slice(tab + 1);
    if (stage !== '0') {
      unmerged.add(path);
      continue;
    }
    // 'S' = skip-worktree; lowercase = assume-unchanged (ls-files -v).
    if (tag === 'S' || (tag >= 'a' && tag <= 'z')) flagged.add(path);
    entries.set(path, `${mode} ${oid}`);
  }
  return { entries, flagged, unmerged };
}

/** Paths whose entry differs between two entry maps, sorted bytewise. */
function differingPaths(a, b) {
  const out = new Set();
  for (const [p, v] of a) if (b.get(p) !== v) out.add(p);
  for (const p of b.keys()) if (!a.has(p)) out.add(p);
  return [...out].sort(byteOrder);
}

function byteOrder(x, y) {
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Vault paths the user has staged something for (real index != HEAD). */
function userOwnedPaths(snapshot, headEntries) {
  const owned = new Set(snapshot.unmerged);
  for (const p of differingPaths(snapshot.entries, headEntries)) owned.add(p);
  return owned;
}

/** A fresh private directory in the OS temp dir: `<tmp>/skippy-ac-<16 hex>`. */
function makePrivateTempDir() {
  const dir = join(tmpdir(), `skippy-ac-${crypto.randomBytes(8).toString('hex')}`);
  mkdirSync(dir); // non-recursive: fails rather than reuse an existing dir
  return dir;
}

/**
 * Best-effort sweep of `<tmp>/skippy-ac-<16 hex>` directories not modified
 * for STALE_TEMP_DIR_MS (left behind by a killed tick). Exact name match
 * only; `lstat` must report a real directory, so a symlink or junction with
 * that name is never followed (nor removed). A live tick's directory is
 * always younger than the threshold. Returns the names removed.
 */
export function sweepStaleTempDirs(nowMs = Date.now()) {
  const removed = [];
  let names;
  try {
    names = readdirSync(tmpdir());
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!TEMP_DIR_RE.test(name)) continue;
    const dir = join(tmpdir(), name);
    try {
      const st = lstatSync(dir);
      if (!st.isDirectory() || st.isSymbolicLink()) continue;
      if (nowMs - st.mtimeMs < STALE_TEMP_DIR_MS) continue;
      rmSync(dir, { recursive: true, force: true });
      removed.push(name);
    } catch {
      /* best effort: another process may be sweeping or using it */
    }
  }
  return removed;
}

/** Blob sizes by oid (`cat-file --batch-check`); throws on a missing object. */
function blobSizes(root, oids) {
  const sizes = new Map();
  if (oids.length === 0) return sizes;
  const lines = gitRaw(root, ['cat-file', '--batch-check'], { input: oids.map((o) => `${o}\n`).join('') })
    .toString('latin1')
    .split('\n')
    .filter((l) => l.length > 0);
  if (lines.length !== oids.length) throw new Error('cat-file --batch-check: truncated output');
  oids.forEach((oid, i) => {
    const f = lines[i].split(' ');
    if (f[1] === 'missing') throw new Error(`cat-file --batch-check: blob ${oid} missing`);
    const size = Number(f[2]);
    if (f[0] !== oid || !Number.isSafeInteger(size) || size < 0) throw new Error('cat-file --batch-check: unexpected header');
    sizes.set(oid, size);
  });
  return sizes;
}

/**
 * Content-scan blobs by oid. Returns Map<oid, 'too-large-to-scan' |
 * 'lfs-pointer' | 'secret-content'> for the blobs that must not be committed
 * (an LFS pointer wins over a content hit). Blobs over
 * MAX_SCAN_BYTES are never read (D3); the rest are fetched with
 * `cat-file --batch` in groups of at most MAX_SCAN_BYTES total, so memory
 * (and Node's string/buffer limits) stay bounded however big the vault is.
 */
function scanBlobsForSecrets(root, oids) {
  const unique = [...new Set(oids)].sort(byteOrder);
  const verdicts = new Map();
  const sizes = blobSizes(root, unique);
  const groups = [];
  let group = [];
  let groupBytes = 0;
  for (const oid of unique) {
    const size = sizes.get(oid);
    if (size > MAX_SCAN_BYTES) {
      verdicts.set(oid, 'too-large-to-scan');
      continue;
    }
    if (group.length > 0 && groupBytes + size > MAX_SCAN_BYTES) {
      groups.push(group);
      group = [];
      groupBytes = 0;
    }
    group.push(oid);
    groupBytes += size;
  }
  if (group.length > 0) groups.push(group);
  for (const g of groups) {
    const out = gitRaw(root, ['cat-file', '--batch'], { input: g.map((o) => `${o}\n`).join('') });
    let pos = 0;
    for (const oid of g) {
      const nl = out.indexOf(0x0a, pos);
      if (nl < 0) throw new Error('cat-file --batch: truncated output');
      const header = out.subarray(pos, nl).toString('latin1').split(' ');
      pos = nl + 1;
      if (header[1] === 'missing') throw new Error(`cat-file --batch: blob ${oid} missing`);
      const size = Number(header[2]);
      if (header[0] !== oid || size !== sizes.get(oid) || pos + size > out.length) {
        throw new Error('cat-file --batch: unexpected header');
      }
      const blob = out.subarray(pos, pos + size);
      if (matchesLfsPointer(blob)) verdicts.set(oid, 'lfs-pointer');
      else if (matchesSecretContent(blob)) verdicts.set(oid, 'secret-content');
      pos += size + 1; // trailing LF
    }
  }
  return verdicts;
}

/** A conversion attribute value that is set to anything but "off". */
const attrIsSet = (v) => v !== 'unspecified' && v !== 'unset';

/**
 * The conversion attributes of `paths` (OQ-19): `filtered`, the subset with a
 * `filter` attribute set to anything (`set` or any driver name, e.g. `lfs`,
 * configured or not), and `encoded`, the subset with a
 * `working-tree-encoding` attribute set to anything (`set`, any encoding
 * name — even UTF-8, an unknown one or an empty value); `unspecified` /
 * `unset` mean neither. One `check-attr -z --stdin` call, raw byte paths on
 * stdin; `env` selects the index git falls back to for a `.gitattributes`
 * missing from the working tree (the seed index = the pre-add state, or the
 * temp index = the post-add state).
 */
function conversionAttributes(root, paths, env) {
  const filtered = new Set();
  const encoded = new Set();
  if (paths.length === 0) return { filtered, encoded };
  const out = gitRaw(root, ['check-attr', '-z', '--stdin', 'filter', 'working-tree-encoding'], {
    env,
    input: Buffer.from(paths.map((p) => `${p}\0`).join(''), 'latin1'),
  });
  const f = out.toString('latin1').split('\0');
  if (f.length !== paths.length * 6 + 1 || f[f.length - 1] !== '') throw new Error('check-attr: unexpected output');
  for (let i = 0; i + 5 < f.length; i += 6) {
    if (f[i + 1] !== 'filter' || f[i + 3] !== f[i] || f[i + 4] !== 'working-tree-encoding') {
      throw new Error('check-attr: unexpected output');
    }
    if (attrIsSet(f[i + 2])) filtered.add(f[i]);
    if (attrIsSet(f[i + 5])) encoded.add(f[i]);
  }
  return { filtered, encoded };
}

/**
 * M0-G15 fallback, only after `add -A -- vault` failed: of every path that
 * add would visit (`ls-files --cached --others --exclude-standard` against
 * the seed index; a nested repository shows as `dir/`), the ones it must not
 * be asked to convert — present files (not directories, not deleted from the
 * working tree) whose pre-add evaluation has a `filter` (`filtered-path`) or
 * a `working-tree-encoding` (`encoded-path`), as path -> reason. git dies on
 * the whole add for one file it cannot convert (UTF-32 or a BOM-less
 * UTF-16/UTF-32 rule, an odd byte count under UTF-16, an unknown encoding, a
 * valueless `working-tree-encoding`, a failing required filter), so those are
 * withheld from the redone add.
 */
function withheldAddCandidates(root, seedEnv) {
  const candidates = [
    ...new Set(splitZ(gitRaw(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', VAULT_PATHSPEC], { env: seedEnv }))),
  ].sort(byteOrder);
  const deleted = new Set(splitZ(gitRaw(root, ['ls-files', '-z', '--deleted', '--', VAULT_PATHSPEC], { env: seedEnv })));
  const files = candidates.filter((p) => !p.endsWith('/') && !deleted.has(p));
  const { filtered, encoded } = conversionAttributes(root, files, seedEnv);
  /** @type {Map<string, string>} */
  const withheld = new Map();
  for (const p of files) {
    if (filtered.has(p)) withheld.set(p, 'filtered-path');
    else if (encoded.has(p)) withheld.set(p, 'encoded-path');
  }
  return withheld;
}

/**
 * True if a path component (a byte string, latin1) names a `.gitattributes`
 * file on ANY platform: a verbatim port of git's `is_ntfs_dotgitattributes`
 * (`is_ntfs_dot_generic(name, "gitattributes", 13, "gi7d29")`, path.c) —
 * `.gitattributes` in any ASCII case, optionally followed by trailing spaces
 * / periods and an NTFS `:stream` suffix, plus the 8.3 short names
 * `gitatt~1`..`gitatt~4` and the hashed `gi7d29~N` form. Case-insensitive
 * everywhere (not just on Windows), so both engines agree on every OS.
 */
export function isAttributesFileName(name) {
  const NAME = 'gitattributes';
  const SHORT = 'gi7d29';
  const lower = asciiLower(name);
  const onlySpacesAndPeriods = (i) => {
    for (; i < name.length; i++) {
      const c = name[i];
      if (c === ':') return true;
      if (c !== ' ' && c !== '.') return false;
    }
    return true;
  };
  if (lower.startsWith(`.${NAME}`)) return onlySpacesAndPeriods(NAME.length + 1);
  if (lower.startsWith(NAME.slice(0, 6)) && name[6] === '~' && name[7] >= '1' && name[7] <= '4') return onlySpacesAndPeriods(8);
  let sawTilde = false;
  for (let i = 0; i < 8; i++) {
    if (i >= name.length) return false;
    const c = name[i];
    if (sawTilde) {
      if (c < '0' || c > '9') return false;
    } else if (c === '~') {
      i++;
      if (i >= name.length || name[i] < '1' || name[i] > '9') return false;
      sawTilde = true;
    } else if (i >= 6) return false;
    else if (c.charCodeAt(0) & 0x80) return false;
    else if (lower[i] !== SHORT[i]) return false;
  }
  return onlySpacesAndPeriods(8);
}

/** True if the last component of a repo-relative byte path names a `.gitattributes`. */
export function isAttributesFilePath(bytePath) {
  return isAttributesFileName(bytePath.slice(bytePath.lastIndexOf('/') + 1));
}

/** `.git` in any ASCII case (git refuses to track anything under it). */
const isDotGitName = (name) => asciiLower(name) === '.git';

/** Discovery variables that would make `rev-parse` ignore the directory it runs in. */
const DISCOVERY_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE'];

/**
 * True iff `dir` (which holds a `.git` entry) is itself the top of a real
 * repository: `rev-parse --show-cdup` run there, with the discovery
 * variables removed, succeeds and prints nothing. A bogus `.git` (an invalid
 * gitfile makes rev-parse die; an empty `.git` directory makes it find the
 * superproject) is NOT a repository: `git add` walks into such a directory
 * and reads its `.gitattributes`, so the snapshot must too (M0-G13).
 */
function isNestedRepository(dir) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!DISCOVERY_ENV.includes(k.toUpperCase())) env[k] = v;
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--show-cdup'], { env, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8').trim() === '';
  } catch {
    return false;
  }
}

/**
 * State of one attribute file: its full content, or absent / a link /
 * another non-regular entry / unreadable. `followLinks` is false for in-tree
 * `.gitattributes` (git refuses to read those through a symlink) and true for
 * the info/global/system files (git opens them normally).
 */
function attributeFileState(path, followLinks) {
  let st;
  try {
    st = lstatSync(path);
  } catch (e) {
    return e.code === 'ENOENT' || e.code === 'ENOTDIR' ? 'absent' : `error:${e.code}`;
  }
  if (st.isSymbolicLink()) {
    let target = '';
    try {
      target = readlinkSync(path);
    } catch {
      /* keep '' */
    }
    if (!followLinks) return `link:${target}`;
    try {
      return `link:${target}:${readFileSync(path).toString('latin1')}`;
    } catch (e) {
      return `link:${target}:error:${e.code}`;
    }
  }
  if (!st.isFile()) return 'other';
  try {
    return `file:${readFileSync(path).toString('latin1')}`;
  } catch (e) {
    return `error:${e.code}`;
  }
}

/**
 * Every attributes file under `dir` (keys `wt:vault/.../<name>` -> state):
 * each entry whose name `isAttributesFileName` accepts (any case, so the
 * `.GitAttributes` git reads on a case-insensitive filesystem is seen,
 * M0-G13), walked without following links. A directory holding a `.git`
 * entry is skipped only if it is a real nested repository (then `add` stages
 * it as a gitlink and git reads no superproject attributes inside); the
 * verdict is recorded, so a bogus `.git` turning real (or back) is a change.
 */
function walkVaultAttributes(root, rel, out) {
  const dir = join(root, rel);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    out.set(`dir:${rel}`, `error:${e.code}`);
    return;
  }
  if (entries.some((e) => isDotGitName(e.name))) {
    const nested = isNestedRepository(dir);
    out.set(`nested:${rel}`, nested ? 'repo' : 'not-a-repo');
    if (nested) return;
  }
  for (const e of entries) {
    if (isDotGitName(e.name)) continue;
    const child = `${rel}/${e.name}`;
    if (isAttributesFileName(toBytePath(e.name))) out.set(`wt:${child}`, attributeFileState(join(root, child), false));
    if (e.isDirectory() && !e.isSymbolicLink()) walkVaultAttributes(root, child, out);
  }
}

/** Resolve `git var <name>`; null if git cannot say. */
function gitVarPath(root, name) {
  try {
    return git(root, ['var', name]) || null;
  } catch {
    return null;
  }
}

/** The tree a tree-ish names (`rev-parse --verify <v>^{tree}`), or 'unresolved'. */
function treeOf(root, treeish) {
  try {
    return git(root, ['rev-parse', '--verify', '-q', '--end-of-options', `${treeish}^{tree}`]) || 'unresolved';
  } catch {
    return 'unresolved';
  }
}

/**
 * `attr.tree` (git 2.42+: read attributes from that tree INSTEAD of the
 * working tree / index): every configured value in order (git uses the last;
 * an empty value means the empty tree) plus the tree the last one resolves
 * to, so both a config change and a move of the ref it names are seen.
 */
function attrTreeState(root) {
  let listing;
  try {
    listing = gitRaw(root, ['config', '-l', '-z']).toString('latin1');
  } catch (e) {
    return `error:${e.message}`;
  }
  const values = [];
  for (const rec of listing.split('\0')) {
    const nl = rec.indexOf('\n');
    const key = nl < 0 ? rec : rec.slice(0, nl);
    if (key === 'attr.tree') values.push(nl < 0 ? null : rec.slice(nl + 1));
  }
  if (values.length === 0) return 'unset';
  const last = values[values.length - 1];
  const tree = last === null || last === '' ? 'empty' : treeOf(root, Buffer.from(last, 'latin1').toString('utf8'));
  return `set:${values.map((v) => (v === null ? '\u0001' : v)).join('\0')}\0${tree}`;
}

/**
 * A1 / A2: every attribute source git reads for a vault path — every
 * attributes file (any case) at the root and anywhere under vault/, the
 * repo's info/attributes, the global and system files (paths re-resolved on
 * every call, so a core.attributesFile change is seen too; a relative path is
 * resolved against the repository top level, where git itself opens it),
 * `attr.tree` and `GIT_ATTR_SOURCE` (value + the tree they name). Two
 * snapshots are equal iff no source changed.
 */
function attributeSnapshot(root) {
  const snap = new Map();
  let rootNames = [];
  try {
    rootNames = readdirSync(root);
  } catch (e) {
    snap.set('dir:.', `error:${e.code}`);
  }
  for (const name of rootNames) {
    if (isAttributesFileName(toBytePath(name))) snap.set(`wt:${name}`, attributeFileState(join(root, name), false));
  }
  const vault = join(root, VAULT_PATHSPEC);
  let vst = null;
  try {
    vst = lstatSync(vault);
  } catch {
    /* absent */
  }
  if (vst && vst.isDirectory() && !vst.isSymbolicLink()) walkVaultAttributes(root, VAULT_PATHSPEC, snap);
  else snap.set('dir:vault', vst ? 'not-a-directory' : 'absent');
  let info = null;
  try {
    const p = git(root, ['rev-parse', '--git-path', 'info/attributes']);
    info = isAbsolute(p) ? p : resolve(root, p);
  } catch {
    /* recorded as unresolved */
  }
  snap.set('info', info ? `${info}\0${attributeFileState(info, true)}` : 'unresolved');
  let top = null;
  try {
    top = git(root, ['rev-parse', '--show-toplevel']) || null;
  } catch {
    /* recorded as unresolved */
  }
  for (const name of ['GIT_ATTR_GLOBAL', 'GIT_ATTR_SYSTEM']) {
    const raw = gitVarPath(root, name);
    const p = raw && top ? resolve(top, raw) : null;
    snap.set(name, p ? `${p}\0${attributeFileState(p, true)}` : 'unresolved');
  }
  snap.set('attr.tree', attrTreeState(root));
  const source = process.env.GIT_ATTR_SOURCE;
  snap.set('GIT_ATTR_SOURCE', source === undefined ? 'unset' : `set:${source}\0${treeOf(root, source)}`);
  return snap;
}

function sameSnapshot(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

/**
 * The subset of `paths` outside the sparse-checkout definition, when
 * core.sparseCheckout is on (`sparse-checkout check-rules -z`, which prints
 * the paths inside). If the patterns cannot be loaded, every path counts as
 * inside — exactly how git itself treats a sparse checkout without patterns.
 */
function sparseCheckoutEnabled(root) {
  return git(root, ['config', '--type=bool', '--default=false', '--get', 'core.sparseCheckout']) === 'true';
}

function outsideSparseCheckout(root, paths) {
  if (paths.length === 0) return new Set();
  if (!sparseCheckoutEnabled(root)) return new Set();
  let out;
  try {
    out = gitRaw(root, ['sparse-checkout', 'check-rules', '-z'], {
      input: Buffer.from(paths.map((p) => `${p}\0`).join(''), 'latin1'),
    });
  } catch {
    return new Set();
  }
  const inside = new Set(splitZ(out));
  return new Set(paths.filter((p) => !inside.has(p)));
}

export function commitAndAdvanceHead(root, tree, head, message) {
  const args = ['-c', 'commit.gpgsign=false', 'commit-tree', tree];
  if (head) args.push('-p', head);
  args.push('-m', message);
  const newCommit = git(root, args);
  // CAS: fails explicitly if HEAD moved concurrently.
  git(root, ['update-ref', 'HEAD', newCommit, head ?? '']);
  return newCommit;
}

function withRetries(fn, attempts = SYNC_RETRY_ATTEMPTS, delayMs = SYNC_RETRY_DELAY_MS) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return fn();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) sleepSync(delayMs);
    }
  }
  throw lastErr;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Bring the real index in line with `newCommit` for exactly `paths` (the
 * paths the autocommit changed), skipping any path whose real-index entry no
 * longer equals `parentEntries` (the user staged something since), is
 * flagged, or is unmerged. Literal, NUL-delimited pathspec file; never a
 * whole-vault reset. Returns the number of paths synced.
 */
function syncRealIndex(root, newCommit, parentEntries, paths) {
  return withRetries(() => {
    const snap = realIndexSnapshot(root);
    const safe = paths.filter(
      (p) => !snap.flagged.has(p) && !snap.unmerged.has(p) && snap.entries.get(p) === parentEntries.get(p),
    );
    if (safe.length === 0) return 0; // never run a pathspec-less reset
    const dir = makePrivateTempDir();
    try {
      const specFile = join(dir, 'pathspec');
      writeFileSync(specFile, Buffer.from(safe.map((p) => `${p}\0`).join(''), 'latin1'));
      gitRaw(root, ['reset', '-q', newCommit, `--pathspec-from-file=${specFile}`, '--pathspec-file-nul']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    return safe.length;
  });
}

function pendingMarkerPath(gitDir) {
  return join(gitDir, PENDING_MARKER_NAME);
}

function writePendingMarker(gitDir, ref, newSha, parentSha) {
  writeFileSync(
    pendingMarkerPath(gitDir),
    JSON.stringify({ version: PENDING_MARKER_VERSION, ref: ref ?? null, new: newSha, parent: parentSha ?? null }),
    'utf8',
  );
}

function dropMarker(markerPath) {
  try {
    rmSync(markerPath, { force: true });
  } catch {
    /* ignore */
  }
}

/** Validate a parsed marker; returns null if unusable. */
function parseMarker(raw) {
  let m;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  // Known versions only (D5): absent or 1 = legacy (no `ref`), 2 = current.
  const hasVersion = Object.prototype.hasOwnProperty.call(m, 'version');
  if (hasVersion && m.version !== 1 && m.version !== PENDING_MARKER_VERSION) return null;
  if (typeof m.new !== 'string' || !OID_RE.test(m.new)) return null;
  if (!(m.parent === null || m.parent === undefined || (typeof m.parent === 'string' && OID_RE.test(m.parent)))) return null;
  const hasRef = Object.prototype.hasOwnProperty.call(m, 'ref');
  if (hasVersion && m.version === PENDING_MARKER_VERSION && !hasRef) return null;
  if (hasRef && !(m.ref === null || (typeof m.ref === 'string' && m.ref.startsWith('refs/')))) return null;
  return { new: m.new, parent: m.parent ?? null, hasRef, ref: hasRef ? m.ref : undefined };
}

/** Parent oids of commit `oid` (header order), or null if it isn't a commit. */
function commitParents(root, oid) {
  let raw;
  try {
    if (git(root, ['cat-file', '-t', oid]) !== 'commit') return null;
    raw = gitRaw(root, ['cat-file', 'commit', oid]).toString('latin1');
  } catch {
    return null;
  }
  const end = raw.indexOf('\n\n');
  return (end < 0 ? raw : raw.slice(0, end))
    .split('\n')
    .filter((l) => l.startsWith('parent '))
    .map((l) => l.slice('parent '.length));
}

/**
 * D5: `new` must be a commit whose first parent is exactly `parent` (or a
 * root commit when `parent` is null), and `parent` must exist as a commit.
 * Returns null if the marker is consistent, else the reason to drop it.
 */
function markerObjectsProblem(root, marker) {
  const parents = commitParents(root, marker.new);
  if (!parents) return `${marker.new} is not an existing commit`;
  const first = parents[0] ?? null;
  if (first !== marker.parent) {
    return `recorded parent ${marker.parent ?? '(none)'} is not the first parent of ${marker.new} (${first ?? 'root commit'})`;
  }
  if (marker.parent !== null && !commitParents(root, marker.parent)) {
    return `parent ${marker.parent} is not an existing commit`;
  }
  return null;
}

/**
 * Step 0 of every tick. See the header. Returns null if there was no marker,
 * otherwise {synced, newSha, dropped?, error?}.
 */
function recoverPendingSync(root, gitDir) {
  const markerPath = pendingMarkerPath(gitDir);
  let raw;
  try {
    raw = readFileSync(markerPath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    return { synced: false, newSha: null, error: `cannot read pending marker: ${e.message}` };
  }

  const marker = parseMarker(raw);
  if (!marker) {
    dropMarker(markerPath);
    return { synced: false, newSha: null, dropped: 'corrupt pending marker' };
  }

  const head = resolveHead(root);
  const ref = resolveSymbolicHead(root);
  // Legacy (v1) markers carry no ref: only the HEAD check applies.
  if (head !== marker.new || (marker.hasRef && ref !== marker.ref)) {
    dropMarker(markerPath);
    return {
      synced: false,
      newSha: marker.new,
      dropped: `HEAD is no longer ${marker.new}${marker.hasRef ? ` on ${marker.ref ?? '(detached)'}` : ''}; index left untouched`,
    };
  }

  const problem = markerObjectsProblem(root, marker);
  if (problem) {
    dropMarker(markerPath);
    return { synced: false, newSha: marker.new, dropped: `inconsistent pending marker: ${problem}; index left untouched` };
  }

  try {
    const parentEntries = treeEntries(root, marker.parent);
    const newEntries = treeEntries(root, marker.new);
    syncRealIndex(root, marker.new, parentEntries, differingPaths(parentEntries, newEntries));
    dropMarker(markerPath);
    return { synced: true, newSha: marker.new };
  } catch (e) {
    return { synced: false, newSha: marker.new, error: e.message };
  }
}

/**
 * Core algorithm. Throws on any explicit failure (locked index, CAS race,
 * unresolved pending sync, not a repo, ...) — never silently swallowed.
 *
 * @param {string} root repo root (contains `vault/`)
 * @param {() => string} [now] injectable clock for tests
 * @param {{onPhase?: (phase: 'added'|'scanned') => void}} [hooks] test seam (see header)
 * @returns {{status: 'noop'|'committed'|'pending-sync', skipped: string[], skippedDetail: {path: string, reason: string}[], recovered: object|null, syncError?: string}}
 */
export function runAutocommit(root, now = () => new Date().toISOString(), { onPhase } = {}) {
  if (!existsSync(join(root, 'vault'))) return { status: 'noop', skipped: [], skippedDetail: [], recovered: null };

  sweepStaleTempDirs();
  const gitDir = resolveGitDir(root);

  // Step 0: finish (or safely discard) an interrupted sync first.
  const recovered = recoverPendingSync(root, gitDir);
  if (recovered && !recovered.synced && !recovered.dropped) {
    throw new Error(`pending index sync for ${recovered.newSha} still unresolved (${recovered.error}); skipping autocommit`);
  }

  const lockPath = join(gitDir, 'index.lock');
  if (existsSync(lockPath)) {
    throw new Error(`git index is locked (${lockPath}); skipping autocommit`);
  }

  const head = resolveHead(root);
  const ref = resolveSymbolicHead(root);

  const tempDir = makePrivateTempDir();
  const indexFile = join(tempDir, 'index');
  // The temp index as it was before `add` (absent for an unborn HEAD, which
  // git reads as an empty index): the pre-add attribute evaluation uses it.
  const seedIndex = join(tempDir, 'seed-index');
  const env = { GIT_INDEX_FILE: indexFile };
  const seedEnv = { GIT_INDEX_FILE: seedIndex };
  try {
    const headEntries = treeEntries(root, head);
    const snapshot = realIndexSnapshot(root);
    const owned = userOwnedPaths(snapshot, headEntries);

    if (head) {
      git(root, ['read-tree', head], { env });
      copyFileSync(indexFile, seedIndex);
    }
    const attrsBefore = attributeSnapshot(root); // A1
    /** @type {Map<string, string>} path -> reason, withheld from the add (M0-G15). */
    let withheld = new Map();
    // -A so deletions are captured; .gitignore respected; vault/ only.
    try {
      git(root, ['add', '-A', '--', VAULT_PATHSPEC], { env });
    } catch (e) {
      // A sparse checkout makes `add` refuse (and fail on) out-of-cone
      // paths, and a file git cannot convert (M0-G15) makes it die: redo it
      // from the seed, with --sparse (those paths are then flagged below)
      // and without the filtered / encoded files, so the tick never fails
      // for either reason.
      const sparse = sparseCheckoutEnabled(root);
      withheld = withheldAddCandidates(root, seedEnv);
      if (!sparse && withheld.size === 0) throw e;
      if (head) copyFileSync(seedIndex, indexFile);
      else rmSync(indexFile, { force: true });
      const sparseArg = sparse ? ['--sparse'] : [];
      if (withheld.size === 0) {
        git(root, ['add', '-A', ...sparseArg, '--', VAULT_PATHSPEC], { env });
      } else {
        // `add -A -- vault` minus each withheld file: the one call that runs
        // with pathspec magic, and every pathspec is still `literal`.
        const specs = [`:(literal)${VAULT_PATHSPEC}`, ...[...withheld.keys()].map((p) => `:(exclude,literal)${p}`)];
        const specFile = join(tempDir, 'pathspec');
        writeFileSync(specFile, Buffer.from(specs.map((s) => `${s}\0`).join(''), 'latin1'));
        git(root, ['add', '-A', ...sparseArg, `--pathspec-from-file=${specFile}`, '--pathspec-file-nul'], {
          env: { ...env, ...MAGIC_PATHSPEC_ENV },
        });
      }
    }
    const preliminaryTree = git(root, ['write-tree'], { env });
    onPhase?.('added');
    const prelimEntries = treeEntries(root, preliminaryTree);
    // Withheld paths are candidates too: they are excluded (and reported) below.
    const allChanged = [...new Set([...differingPaths(headEntries, prelimEntries), ...withheld.keys()])].sort(byteOrder);

    const modeOf = (entries, p) => (entries.has(p) ? entries.get(p).split(' ')[0] : null);
    const blobOf = (p) => prelimEntries.get(p).split(' ')[1];
    const outsideSparse = outsideSparseCheckout(root, allChanged);

    /** @type {Map<string, string>} path -> reason decided before the attribute check. */
    const early = new Map();
    for (const p of allChanged) {
      if (snapshot.flagged.has(p) || outsideSparse.has(p)) early.set(p, 'flagged');
      else if (owned.has(p)) early.set(p, 'user-staged');
      else if (modeOf(headEntries, p) === GITLINK_MODE || modeOf(prelimEntries, p) === GITLINK_MODE) early.set(p, 'gitlink');
      else if (matchesSecretFilename(p)) early.set(p, 'secret-filename');
      else if (isAttributesFilePath(p)) early.set(p, 'attributes-file');
    }

    // filtered-path / encoded-path: a `filter` / `working-tree-encoding`
    // attribute in the pre-add (seed index) OR the post-add (temp index)
    // evaluation. Deletions carry no blob. Withheld paths keep the reason
    // the fallback found.
    /** @type {Map<string, string>} */
    const late = new Map();
    for (const [p, r] of withheld) if (!early.has(p)) late.set(p, r);
    const present = allChanged.filter((p) => !early.has(p) && !withheld.has(p) && prelimEntries.has(p));
    const before = conversionAttributes(root, present, seedEnv);
    const after = conversionAttributes(root, present, env);
    for (const p of present) {
      if (before.filtered.has(p) || after.filtered.has(p)) late.set(p, 'filtered-path');
      else if (before.encoded.has(p) || after.encoded.has(p)) late.set(p, 'encoded-path');
    }

    // The exact blobs the commit would contain: size cap, LFS pointer, secrets.
    const toScan = present.filter((p) => !late.has(p));
    const blobVerdicts = scanBlobsForSecrets(root, toScan.map(blobOf));
    for (const p of toScan) {
      const v = blobVerdicts.get(blobOf(p));
      if (v) late.set(p, v);
    }
    onPhase?.('scanned');

    // A2: any attribute source changed since A1 -> defer the whole tick.
    const attrsChanged = !sameSnapshot(attrsBefore, attributeSnapshot(root));
    /** @type {Map<string, string>} path -> reason; first match wins. */
    const reasons = new Map();
    for (const p of allChanged) {
      const r = early.get(p) ?? (attrsChanged ? 'attributes-changed' : late.get(p));
      if (r) reasons.set(p, r);
    }
    const excluded = allChanged.filter((p) => reasons.has(p));
    const commitPaths = allChanged.filter((p) => !reasons.has(p));
    const skipped = excluded.map(toDisplayPath);
    const skippedDetail = excluded.map((p) => ({ path: toDisplayPath(p), reason: reasons.get(p) }));

    if (commitPaths.length === 0) return { status: 'noop', skipped, skippedDetail, recovered };

    let tree = preliminaryTree;
    if (excluded.length > 0) {
      const zero = '0'.repeat(preliminaryTree.length);
      const info = excluded
        .map((p) => (headEntries.has(p) ? `${headEntries.get(p)}\t${p}\0` : `0 ${zero}\t${p}\0`))
        .join('');
      gitRaw(root, ['update-index', '-z', '--index-info'], { env, input: Buffer.from(info, 'latin1') });
      tree = git(root, ['write-tree'], { env });
    }
    const headTree = head ? git(root, ['rev-parse', `${head}^{tree}`]) : EMPTY_TREE;
    if (tree === headTree) return { status: 'noop', skipped, skippedDetail, recovered };

    const stamp = now().replace(/\.\d+Z$/, 'Z');
    const newCommit = commitAndAdvanceHead(root, tree, head, `chore(vault): auto-commit ${stamp}`);

    try {
      syncRealIndex(root, newCommit, headEntries, commitPaths);
      return { status: 'committed', skipped, skippedDetail, recovered };
    } catch (e) {
      // HEAD already advanced — NOT a failed commit. Next tick finishes it.
      writePendingMarker(gitDir, ref, newCommit, head);
      return { status: 'pending-sync', skipped, skippedDetail, recovered, syncError: e.message };
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function commitOnce() {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  return runAutocommit(repoRoot);
}

function reportResult(result) {
  const r = result.recovered;
  if (r?.synced) console.error(`autocommit: recovered pending index sync for ${r.newSha}`);
  else if (r?.dropped) console.error(`autocommit: dropped stale pending index sync marker: ${r.dropped}`);
  if (result.status === 'pending-sync') {
    console.error(`autocommit: committed but index sync pending: ${result.syncError}`);
  }
  if (result.skipped?.length) {
    console.error(`autocommit: skipped vault paths: ${result.skippedDetail.map((d) => `${d.path} (${d.reason})`).join(', ')}`);
  }
}

function main() {
  const arg = process.argv[2] ?? '--once';
  if (arg === '--once') {
    try {
      reportResult(commitOnce());
    } catch (e) {
      console.error(e.message);
      process.exitCode = 1;
    }
  } else {
    const ms = parseInt(arg.match(/--interval=(\d+)/)?.[1] ?? '300', 10) * 1000;
    setInterval(() => {
      try {
        reportResult(commitOnce());
      } catch (e) {
        console.error(e.message);
      }
    }, ms);
    console.error(`auto-commit running every ${ms / 1000}s`);
  }
}

// Only run the CLI when executed directly, not when imported by tests.
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
