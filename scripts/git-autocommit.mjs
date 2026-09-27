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
//      real-index sync failed), validate it first (E5-2): recover only if HEAD
//      is still symbolically on `ref` and resolves to exactly `new`; otherwise
//      (reset --hard, checkout of another branch, a user commit on top, a
//      corrupt marker) drop it WITHOUT touching the index and report
//      `dropped`. If recovery is attempted and fails, the tick stops with an
//      explicit error rather than stacking a commit on an unsynced index.
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
//      whose (mode, oid) differs between HEAD and that tree.
//   5. Exclusions, each restored to its HEAD state in the temp index (or
//      removed if HEAD lacks it) with ONE `update-index -z --index-info`:
//        a. flagged paths, b. user-owned paths,
//        c. secret filename hits, d. secret content hits — the content scan
//           reads the exact blobs the commit would contain (`cat-file
//           --batch`), as latin1 and again with NULs stripped (UTF-16).
//      All are reported as `skipped`.
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
// The temp index / pathspec files are removed in every case.
//
// Secrets: `commit-tree` never runs hooks, so a repo's own secret-scanning
// pre-commit hook can never see (or block) this commit. The built-in guard
// (step 5c/5d) is the only line of defense.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const VAULT_PATHSPEC = 'vault';
const PENDING_MARKER_NAME = 'skippy-autocommit-pending';
const PENDING_MARKER_VERSION = 2;
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

/** Content-scan blobs by oid with one `cat-file --batch`. Returns hit oids. */
function scanBlobsForSecrets(root, oids) {
  const unique = [...new Set(oids)];
  const hits = new Set();
  if (unique.length === 0) return hits;
  const out = gitRaw(root, ['cat-file', '--batch'], { input: unique.map((o) => `${o}\n`).join('') });
  let pos = 0;
  for (const oid of unique) {
    const nl = out.indexOf(0x0a, pos);
    if (nl < 0) throw new Error('cat-file --batch: truncated output');
    const header = out.subarray(pos, nl).toString('latin1').split(' ');
    pos = nl + 1;
    if (header[1] === 'missing') throw new Error(`cat-file --batch: blob ${oid} missing`);
    const size = parseInt(header[2], 10);
    if (header[0] !== oid || !Number.isFinite(size)) throw new Error('cat-file --batch: unexpected header');
    if (matchesSecretContent(out.subarray(pos, pos + size))) hits.add(oid);
    pos += size + 1; // trailing LF
  }
  return hits;
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
    const dir = mkdtempSync(join(tmpdir(), 'skippy-autocommit-sync-'));
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
  if (typeof m.new !== 'string' || !OID_RE.test(m.new)) return null;
  if (!(m.parent === null || m.parent === undefined || (typeof m.parent === 'string' && OID_RE.test(m.parent)))) return null;
  const hasRef = Object.prototype.hasOwnProperty.call(m, 'ref');
  if (hasRef && !(m.ref === null || (typeof m.ref === 'string' && m.ref.startsWith('refs/')))) return null;
  return { new: m.new, parent: m.parent ?? null, hasRef, ref: hasRef ? m.ref : undefined };
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
 * @returns {{status: 'noop'|'committed'|'pending-sync', skipped: string[], recovered: object|null, syncError?: string}}
 */
export function runAutocommit(root, now = () => new Date().toISOString()) {
  if (!existsSync(join(root, 'vault'))) return { status: 'noop', skipped: [], recovered: null };

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

  const tempDir = mkdtempSync(join(tmpdir(), 'skippy-autocommit-'));
  const env = { GIT_INDEX_FILE: join(tempDir, `index-${crypto.randomUUID()}`) };
  try {
    const headEntries = treeEntries(root, head);
    const snapshot = realIndexSnapshot(root);
    const owned = userOwnedPaths(snapshot, headEntries);

    if (head) git(root, ['read-tree', head], { env });
    // -A so deletions are captured; .gitignore respected; vault/ only.
    git(root, ['add', '-A', '--', VAULT_PATHSPEC], { env });
    const preliminaryTree = git(root, ['write-tree'], { env });
    const prelimEntries = treeEntries(root, preliminaryTree);
    const allChanged = differingPaths(headEntries, prelimEntries);

    const flaggedHits = allChanged.filter((p) => snapshot.flagged.has(p));
    const ownedHits = allChanged.filter((p) => !snapshot.flagged.has(p) && owned.has(p));
    const candidates = allChanged.filter((p) => !snapshot.flagged.has(p) && !owned.has(p));
    const nameHits = candidates.filter((p) => matchesSecretFilename(p));
    const toScan = candidates.filter((p) => !nameHits.includes(p) && prelimEntries.has(p));
    const blobOf = (p) => {
      const [mode, oid] = prelimEntries.get(p).split(' ');
      return mode === '160000' ? null : oid; // gitlinks have no content here
    };
    const hitOids = scanBlobsForSecrets(root, toScan.map(blobOf).filter(Boolean));
    const contentHits = toScan.filter((p) => hitOids.has(blobOf(p)));

    const excluded = [...flaggedHits, ...ownedHits, ...nameHits, ...contentHits];
    const excludedSet = new Set(excluded);
    const commitPaths = allChanged.filter((p) => !excludedSet.has(p));
    const skipped = excluded.map(toDisplayPath);

    if (commitPaths.length === 0) return { status: 'noop', skipped, recovered };

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
    if (tree === headTree) return { status: 'noop', skipped, recovered };

    const stamp = now().replace(/\.\d+Z$/, 'Z');
    const newCommit = commitAndAdvanceHead(root, tree, head, `chore(vault): auto-commit ${stamp}`);

    try {
      syncRealIndex(root, newCommit, headEntries, commitPaths);
      return { status: 'committed', skipped, recovered };
    } catch (e) {
      // HEAD already advanced — NOT a failed commit. Next tick finishes it.
      writePendingMarker(gitDir, ref, newCommit, head);
      return { status: 'pending-sync', skipped, recovered, syncError: e.message };
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
    console.error(`autocommit: skipped vault paths (user-staged/flagged/secret): ${result.skipped.join(', ')}`);
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
