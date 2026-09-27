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
// Every git call runs with GIT_LITERAL_PATHSPECS=1 (E5-4) and no user path is
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
//   4. Seed a throwaway index (read-tree HEAD), `add -A -- vault` into it,
//      write-tree -> preliminary tree; the candidate list is every vault path
//      whose (mode, oid) differs between HEAD and that tree. The throwaway
//      index lives in a fresh private directory in the OS temp dir
//      (`<tmp>/skippy-ac-<16 hex>/index`, D1) — never under the git dir, so a
//      long repo/worktree path can't push `<index>.lock` past MAX_PATH — and
//      the directory (with any `.lock`) is removed in every case.
//   5. Exclusions, each restored to its HEAD state in the temp index (or
//      removed if HEAD lacks it) with ONE `update-index -z --index-info`.
//      Each excluded path gets exactly one reason (first match wins):
//        flagged            skip-worktree / assume-unchanged (step 3)
//        user-staged        user-owned (step 3)
//        gitlink            a new or changed mode-160000 entry on either side
//                           (nested repo, submodule pointer bump, D4); gitlinks
//                           already in HEAD are left exactly as they are
//        secret-filename    shared filename rules
//        too-large-to-scan  blob (or pre-filter working-tree file) larger than
//                           limits.maxScanBytes (64 MiB, D3) — fail closed
//        secret-content     shared content rules hit the exact blob the commit
//                           would contain (`cat-file --batch`, fetched in
//                           batches of at most maxScanBytes; latin1 and again
//                           with NULs stripped for UTF-16), OR — for a
//                           PRE-FILTER path (below) — its working-tree bytes,
//                           i.e. the content the user wrote
//        worktree-unscannable  pre-filter path whose working-tree file can't
//                           be read as the bytes git cleaned (missing, not a
//                           regular file — e.g. a real symlink —, non-UTF-8
//                           name)
//        changed-during-scan   pre-filter path whose scanned bytes do not
//                           provably produce the staged blob (see 5b)
//      A PRE-FILTER path is EVERY candidate except an unfiltered mode-120000
//      entry under core.symlinks=true (a real symlink: git stores readlink()
//      and never runs a filter on it, so the blob scan is exact). That covers
//      any mode with a `filter` attribute (git-lfs, custom clean filters, D2;
//      120000 included, EC5 D-A), every mode-120000 candidate when
//      core.symlinks=false (the Git for Windows default: the "symlink" is a
//      plain file whose bytes are stored, and `add` still runs the clean
//      filter on it), and every regular file whatever `check-attr` says now —
//      a `.gitattributes` flip between step 4's add and check-attr must not
//      decide whether the working-tree bytes get scanned (EC5 D-G).
//   5b. Scanned bytes == committed bytes (EC5 D-B/D-F). Each pre-filter
//      file is read ONCE; that buffer is scanned and then written, byte for
//      byte, into a private scratch work tree (plus copies of the real
//      `.gitattributes` of every ancestor directory). `git add` runs there
//      against a scratch index seeded exactly like the temp index was before
//      step 4's `add` (read-tree HEAD), so the clean filter, eol/autocrlf
//      handling and the index-dependent "CRLF already in index" rule are
//      applied to exactly the scanned bytes in the same context. Any path
//      whose scratch blob differs from the staged blob (or any failure of the
//      scratch add) is `changed-during-scan`. The file is never re-read, so a
//      key -> clean -> key flip between add, scan and verification cannot
//      pass, and an unchanged CRLF file under core.autocrlf is never
//      permanently excluded.
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
// (step 5) is the only line of defense. Pre-filter paths are scanned both
// post-filter (the blob) and pre-filter (the working-tree bytes, proven to be
// the bytes behind the blob, 5b), so an LFS pointer, a reversible clean
// filter or a filtered symlink-as-file cannot smuggle a secret into history.
//
// Test seam: `runAutocommit(root, now, { onPhase })` calls
// `onPhase('added')` after step 4's add/write-tree and
// `onPhase('scanned')` after the pre-filter reads, before 5b. Production
// callers pass nothing.

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const VAULT_PATHSPEC = 'vault';
const PENDING_MARKER_NAME = 'skippy-autocommit-pending';
const PENDING_MARKER_VERSION = 2;
const GITLINK_MODE = '160000';
const SYMLINK_MODE = '120000';
const GITATTRIBUTES = '.gitattributes';
const SYNC_RETRY_ATTEMPTS = 3;
const SYNC_RETRY_DELAY_MS = 20;
const MAX_GIT_OUTPUT = 1024 * 1024 * 1024;
const GIT_ENV = { GIT_LITERAL_PATHSPECS: '1' };
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
/** Largest blob / pre-filter file the guard will scan (and so commit). */
export const MAX_SCAN_BYTES = SECRET_PATTERNS.limits.maxScanBytes;
if (!Number.isSafeInteger(MAX_SCAN_BYTES) || MAX_SCAN_BYTES <= 0) throw new Error('limits.maxScanBytes must be a positive integer');

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
 * Content-scan blobs by oid. Returns Map<oid, 'secret-content' |
 * 'too-large-to-scan'> for the blobs that must not be committed. Blobs over
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
      if (matchesSecretContent(out.subarray(pos, pos + size))) verdicts.set(oid, 'secret-content');
      pos += size + 1; // trailing LF
    }
  }
  return verdicts;
}

/**
 * The subset of `paths` with a `filter` attribute set to anything (`set` or
 * any driver name, e.g. `lfs`); `unspecified` / `unset` mean no filter. One
 * `check-attr -z --stdin` call, raw byte paths on stdin. Only `filter` can
 * make the blob differ materially from the bytes the user wrote (`text`,
 * `eol`, `diff` do not; `working-tree-encoding` output is still scanned as a
 * blob, with the UTF-16 view).
 */
function filteredPaths(root, paths, env) {
  if (paths.length === 0) return new Set();
  const out = gitRaw(root, ['check-attr', '-z', '--stdin', 'filter'], {
    env,
    input: Buffer.from(paths.map((p) => `${p}\0`).join(''), 'latin1'),
  });
  const f = out.toString('latin1').split('\0');
  const filtered = new Set();
  for (let i = 0; i + 2 < f.length; i += 3) {
    if (f[i + 1] !== 'filter') throw new Error('check-attr: unexpected output');
    if (f[i + 2] !== 'unspecified' && f[i + 2] !== 'unset') filtered.add(f[i]);
  }
  return filtered;
}

/** True if a byte-string path is valid UTF-8 (round-trips). */
function isUtf8Path(bytePath) {
  return toBytePath(toDisplayPath(bytePath)) === bytePath;
}

/** Effective `core.symlinks` (git's built-in default is true). */
function coreSymlinks(root) {
  return git(root, ['config', '--type=bool', '--default=true', '--get', 'core.symlinks']) !== 'false';
}

/**
 * Read one pre-filter working-tree file exactly ONCE and scan it (D2, D-A).
 * Returns {reason: 'too-large-to-scan' | 'worktree-unscannable' |
 * 'secret-content'} or, when clean, {bytes} — the very buffer that was
 * scanned, which 5b then proves is what the staged blob was cleaned from.
 */
function readAndScanWorktreeFile(root, bytePath) {
  if (!isUtf8Path(bytePath)) return { reason: 'worktree-unscannable' };
  const full = join(root, toDisplayPath(bytePath));
  let bytes;
  try {
    const st = lstatSync(full);
    if (!st.isFile()) return { reason: 'worktree-unscannable' };
    if (st.size > MAX_SCAN_BYTES) return { reason: 'too-large-to-scan' };
    bytes = readFileSync(full);
  } catch {
    return { reason: 'worktree-unscannable' };
  }
  if (bytes.length > MAX_SCAN_BYTES) return { reason: 'too-large-to-scan' };
  return matchesSecretContent(bytes) ? { reason: 'secret-content' } : { bytes };
}

/** Write scanned bytes to `<scratch>/<path>` (5b); throws on failure. */
function writeScratchFile(scratch, bytePath, bytes) {
  const dest = join(scratch, toDisplayPath(bytePath));
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, bytes);
}

/**
 * 5b: the subset of `paths` (already written to `scratch` from their scanned
 * buffers) whose scratch `git add` — seeded with `seedIndex` (the temp index
 * as it was before step 4's add; may not exist for an unborn HEAD) and the
 * real `.gitattributes` of every ancestor directory — does NOT yield the
 * staged blob `expectedOid(p)`. Any git failure makes every path unproven
 * (fail closed).
 */
function unprovenPaths(root, gitDir, scratch, seedIndex, specFile, paths, expectedOid) {
  if (paths.length === 0) return new Set();
  const dirs = new Set(['']);
  for (const p of paths) {
    for (let i = p.indexOf('/'); i >= 0; i = p.indexOf('/', i + 1)) dirs.add(p.slice(0, i));
  }
  for (const d of [...dirs].sort(byteOrder)) {
    const rel = toDisplayPath(d ? `${d}/${GITATTRIBUTES}` : GITATTRIBUTES);
    const dest = join(scratch, rel);
    if (existsSync(dest)) continue; // a scanned candidate itself: its scanned bytes win
    try {
      const src = join(root, rel);
      if (!lstatSync(src).isFile()) continue; // git ignores a non-regular .gitattributes too
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
    } catch {
      /* absent: git falls back to the index copy, in both trees alike */
    }
  }
  const env = { GIT_DIR: gitDir, GIT_WORK_TREE: scratch, GIT_INDEX_FILE: seedIndex };
  const staged = new Map();
  try {
    writeFileSync(specFile, Buffer.from(paths.map((p) => `${p}\0`).join(''), 'latin1'));
    // fsmonitor off: never spawn a daemon for the scratch tree; longpaths on:
    // the scratch prefix is longer than the repo root's, and a path that
    // only fails there would otherwise be excluded forever.
    const cfg = ['-c', 'core.fsmonitor=false', '-c', 'core.longpaths=true'];
    gitRaw(scratch, [...cfg, 'add', `--pathspec-from-file=${specFile}`, '--pathspec-file-nul'], { env });
    for (const rec of splitZ(gitRaw(scratch, ['ls-files', '-s', '-z', '--', VAULT_PATHSPEC], { env }))) {
      const tab = rec.indexOf('\t');
      const [, oid, stage] = rec.slice(0, tab).split(' ');
      if (stage === '0') staged.set(rec.slice(tab + 1), oid);
    }
  } catch {
    return new Set(paths);
  }
  return new Set(paths.filter((p) => staged.get(p) !== expectedOid(p)));
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
  const seedIndex = join(tempDir, 'seed-index'); // 5b: the temp index before add
  const scratch = join(tempDir, 'wt'); // 5b: scanned bytes, never re-read from the real tree
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    const headEntries = treeEntries(root, head);
    const snapshot = realIndexSnapshot(root);
    const owned = userOwnedPaths(snapshot, headEntries);

    if (head) {
      git(root, ['read-tree', head], { env });
      copyFileSync(indexFile, seedIndex);
    }
    // -A so deletions are captured; .gitignore respected; vault/ only.
    git(root, ['add', '-A', '--', VAULT_PATHSPEC], { env });
    const preliminaryTree = git(root, ['write-tree'], { env });
    onPhase?.('added');
    const prelimEntries = treeEntries(root, preliminaryTree);
    const allChanged = differingPaths(headEntries, prelimEntries);

    const modeOf = (entries, p) => (entries.has(p) ? entries.get(p).split(' ')[0] : null);
    const blobOf = (p) => prelimEntries.get(p).split(' ')[1];

    /** @type {Map<string, string>} path -> reason; first match wins. */
    const reasons = new Map();
    for (const p of allChanged) {
      if (snapshot.flagged.has(p)) reasons.set(p, 'flagged');
      else if (owned.has(p)) reasons.set(p, 'user-staged');
      else if (modeOf(headEntries, p) === GITLINK_MODE || modeOf(prelimEntries, p) === GITLINK_MODE) reasons.set(p, 'gitlink');
      else if (matchesSecretFilename(p)) reasons.set(p, 'secret-filename');
    }

    // Post-filter scan: the exact blobs the commit would contain.
    const toScan = allChanged.filter((p) => !reasons.has(p) && prelimEntries.has(p));
    const blobVerdicts = scanBlobsForSecrets(root, toScan.map(blobOf));
    for (const p of toScan) {
      const v = blobVerdicts.get(blobOf(p));
      if (v) reasons.set(p, v);
    }

    // Pre-filter scan (D2, D-A, D-G): every remaining candidate except an
    // unfiltered real symlink (core.symlinks=true). Each file is read once;
    // the scanned buffer goes to the scratch tree, and 5b proves it is what
    // the staged blob holds.
    const remaining = toScan.filter((p) => !reasons.has(p));
    const isSymlink = (p) => modeOf(prelimEntries, p) === SYMLINK_MODE;
    const symlinkCandidates = remaining.filter(isSymlink);
    const filteredLinks = filteredPaths(root, symlinkCandidates, env);
    const realSymlinks = symlinkCandidates.length > 0 && coreSymlinks(root);
    const scanned = [];
    for (const p of remaining) {
      if (realSymlinks && isSymlink(p) && !filteredLinks.has(p)) continue;
      const r = readAndScanWorktreeFile(root, p);
      if (r.reason) {
        reasons.set(p, r.reason);
        continue;
      }
      try {
        writeScratchFile(scratch, p, r.bytes);
        scanned.push(p);
      } catch {
        reasons.set(p, 'changed-during-scan'); // cannot prove it: fail closed
      }
    }
    onPhase?.('scanned');
    const specFile = join(tempDir, 'verify-pathspec');
    for (const p of unprovenPaths(root, gitDir, scratch, seedIndex, specFile, scanned, blobOf)) {
      reasons.set(p, 'changed-during-scan');
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
