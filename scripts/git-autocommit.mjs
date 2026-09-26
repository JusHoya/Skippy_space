#!/usr/bin/env node
// Git auto-commit — vault/-only, isolated-index, never touches the user's
// real index or staged work. See apps/shell/src-tauri/src/git_autocommit.rs
// for the Rust twin and full algorithm writeup (A05 / FR-WIKI-06). Both
// implementations must stay in lockstep.
//
// Algorithm (no shell interpolation anywhere — every git invocation uses
// execFileSync with an argv array):
//   0. Before anything else, if a pending-index-sync marker file exists
//      (<git-dir>/skippy-autocommit-pending, left behind by a previous tick
//      whose commit landed but whose real-index sync failed), retry syncing
//      just the paths that are still safe to touch, then clear the marker.
//      See `recoverPendingSync`.
//   1. Resolve HEAD (or note it's unborn).
//   2. Fail fast, untouched, if <git-dir>/index.lock already exists.
//   3. Seed a throwaway index: GIT_INDEX_FILE=<tmp> git read-tree HEAD.
//   4. GIT_INDEX_FILE=<tmp> git add -A -- vault (working tree -> temp index,
//      vault pathspec only, .gitignore respected) -> preliminary tree, diffed
//      against HEAD to get the full candidate path list.
//   5. From that candidate list, compute three exclusion sets and restore
//      each matching path back to its HEAD state in the temp index (or
//      remove it if HEAD doesn't have it), so none of them are ever part of
//      this auto-commit:
//        a. skip-worktree / assume-unchanged vault paths (`listFlaggedVaultPaths`),
//        b. paths whose staged blob differs from BOTH HEAD and the working
//           tree ("staged-vs-worktree conflict", `listStagedVsWorktreeConflicts`),
//        c. well-known secret filenames (`SECRET_FILENAME_PATTERNS`) and,
//           for everything else, a content scan of the working-tree bytes
//           for high-confidence secret markers (`SECRET_CONTENT_PATTERNS`).
//      All three are reported back as `skipped`.
//   6. write-tree again (only if anything was restored) -> final tree. If
//      it equals HEAD's vault subtree, nothing to do.
//   7. git commit-tree <tree> [-p HEAD] -m <msg> (plumbing: no hooks run).
//   8. git update-ref HEAD <new> <old> — compare-and-swap; fails explicitly
//      if HEAD moved concurrently, and nothing else has happened yet, so
//      the real index and working tree are untouched.
//   9. Only on success: sync the real index for the vault paths that
//      actually changed (excluding everything from steps 5/6, which must
//      keep their original real-index flags and content untouched). If
//      this sync fails (e.g. something else grabbed the index lock right
//      after our commit landed), the commit is NOT rolled back and is NOT
//      reported as a failure — HEAD has already moved. Instead a pending
//      marker is written (new sha + parent sha) and the result is reported
//      as 'pending-sync'; the next tick's step 0 will finish the job.
//
// The temp index file is removed in every case (success, no-op, or error).
//
// Secrets: `commit-tree` is plumbing and never runs hooks, so a repo's own
// secret-scanning pre-commit hook can never see (or block) this commit.
// The built-in guard below is the only line of defense: a static pathspec
// exclude list for well-known secret file names/extensions, plus a content
// scan of every candidate blob for high-confidence secret markers. Matches
// are skipped (left exactly as HEAD has them / absent), never committed.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const VAULT_PATHSPEC = 'vault';
const PENDING_MARKER_NAME = 'skippy-autocommit-pending';
const SYNC_RETRY_ATTEMPTS = 3;
const SYNC_RETRY_DELAY_MS = 20;

// Built-in exclusion list (FR-WIKI-06 secret guard). Filenames/extensions
// that should never be swept into the vault auto-commit, matched against
// the vault-relative path. Kept in parity with the Rust twin's
// `SECRET_FILENAME_PATTERNS`.
const SECRET_FILENAME_PATTERNS = [
  /(^|\/)\.env[^/]*$/, // vault/**/.env*
  /\.pem$/,
  /\.key$/,
  /\.p12$/,
  /\.pfx$/,
  /(^|\/)id_rsa[^/]*$/,
  /(^|\/)id_ed25519[^/]*$/,
  /(^|\/)id_ecdsa[^/]*$/,
  /credentials[^/]*\.json$/i,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.netrc$/,
  /\.kdbx$/,
  /(^|\/)secrets\.[^/]*$/i,
];

function matchesSecretFilename(vaultRelativePath) {
  return SECRET_FILENAME_PATTERNS.some((re) => re.test(vaultRelativePath));
}

// High-confidence secret content markers. A hit on any candidate blob's
// working-tree content excludes that path from the commit, regardless of
// its name. Kept in parity with the Rust twin's `SECRET_CONTENT_PATTERNS`.
const SECRET_CONTENT_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /AKIA[0-9A-Z]{16}/,
  /sk-ant-/,
  /gh[po]_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]+/,
];

function git(root, args, extraEnv = {}) {
  try {
    const out = execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...extraEnv },
    });
    return out.trim();
  } catch (e) {
    const stderr = e.stderr ? e.stderr.toString().trim() : e.message;
    const err = new Error(`git ${args.join(' ')} failed: ${stderr}`);
    err.cause = e;
    throw err;
  }
}

/** Like git() but tolerates git's own nonzero "found a diff" exit code. */
function gitDiffQuiet(root, args) {
  try {
    execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    return false; // exit 0 => no diff
  } catch (e) {
    if (typeof e.status === 'number' && e.status === 1) return true; // diff found
    const stderr = e.stderr ? e.stderr.toString().trim() : e.message;
    throw new Error(`git ${args.join(' ')} exited abnormally: ${stderr}`);
  }
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
    return execFileSync('git', ['-C', root, 'rev-parse', '--verify', '-q', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return null; // unborn HEAD
  }
}

function vaultTreeChanged(root, head, tree) {
  const base = head ?? EMPTY_TREE;
  return gitDiffQuiet(root, ['diff', '--quiet', base, tree, '--', VAULT_PATHSPEC]);
}

function changedVaultPaths(root, base, tree) {
  let out;
  try {
    out = git(root, ['diff', '--name-only', base, tree, '--', VAULT_PATHSPEC]);
  } catch {
    return [];
  }
  return out.split('\n').filter(Boolean);
}

/** skip-worktree ('S' tag) and assume-unchanged (any lowercase tag) vault paths. */
function listFlaggedVaultPaths(root) {
  let out;
  try {
    out = git(root, ['ls-files', '-v', '--', VAULT_PATHSPEC]);
  } catch {
    return new Set();
  }
  const flagged = new Set();
  for (const line of out.split('\n')) {
    if (!line) continue;
    const tag = line[0];
    const path = line.slice(2);
    if (tag === 'S') flagged.add(path);
    else if (tag >= 'a' && tag <= 'z') flagged.add(path); // assume-unchanged
  }
  return flagged;
}

/** Vault paths whose staged blob differs from BOTH HEAD and the working tree. */
function listStagedVsWorktreeConflicts(root) {
  let staged = [];
  let worktree = [];
  try {
    staged = git(root, ['diff', '--cached', '--name-only', '--', VAULT_PATHSPEC])
      .split('\n')
      .filter(Boolean);
  } catch {
    staged = [];
  }
  try {
    worktree = git(root, ['diff', '--name-only', '--', VAULT_PATHSPEC])
      .split('\n')
      .filter(Boolean);
  } catch {
    worktree = [];
  }
  const worktreeSet = new Set(worktree);
  return new Set(staged.filter((p) => worktreeSet.has(p)));
}

/** Restore `path` in the temp index to its HEAD state, or remove it entirely
 * if HEAD doesn't have it — undoing whatever `add -A` staged there so it's
 * never part of this auto-commit. */
function restorePathToHead(root, tempIndex, head, path) {
  const env = { GIT_INDEX_FILE: tempIndex };
  let headEntry = '';
  if (head) {
    try {
      headEntry = git(root, ['ls-tree', head, '--', path]);
    } catch {
      headEntry = '';
    }
  }
  const m = headEntry.match(/^(\d+) blob ([0-9a-f]+)\t/);
  if (m) {
    // --add: the path may have been removed from the temp index entirely
    // (e.g. `add -A` staged a deletion for a skip-worktree file that no
    // longer exists on disk), in which case a bare --cacheinfo update
    // would fail with "missing --add option".
    git(root, ['update-index', '--add', '--cacheinfo', `${m[1]},${m[2]},${path}`], env);
    return;
  }
  try {
    git(root, ['update-index', '--force-remove', '--', path], env);
  } catch {
    // Already absent from the temp index — nothing to undo.
  }
}

function scanWorkingTreeForSecrets(root, paths) {
  const hits = [];
  for (const p of paths) {
    const abs = join(root, p);
    if (!existsSync(abs)) continue; // deletion: nothing to leak
    let content;
    try {
      content = readFileSync(abs, 'utf8');
    } catch {
      continue; // unreadable (e.g. binary/permissions) — best-effort scan only
    }
    if (SECRET_CONTENT_PATTERNS.some((re) => re.test(content))) hits.push(p);
  }
  return hits;
}

export function commitAndAdvanceHead(root, tree, head, message) {
  const args = ['-c', 'commit.gpgsign=false', 'commit-tree', tree];
  if (head) args.push('-p', head);
  args.push('-m', message);
  const newCommit = git(root, args);

  const old = head ?? '';
  // CAS: fails explicitly if HEAD moved concurrently.
  git(root, ['update-ref', 'HEAD', newCommit, old]);
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
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

/** Bring the real index's vault entries that actually changed in line with
 * `commit`, excluding every path in `excludedPaths` (skip-worktree,
 * assume-unchanged, staged-vs-worktree conflicts, secret hits — none of
 * which changed in `commit` to begin with, but excluded defensively so a
 * `git reset` can never strip their flags). */
function syncRealIndexAfterCommit(root, commit, excludedPaths) {
  const excludeArgs = [...excludedPaths].map((p) => `:(exclude)${p}`);
  withRetries(() => git(root, ['reset', '-q', commit, '--', VAULT_PATHSPEC, ...excludeArgs]));
}

function pendingMarkerPath(gitDir) {
  return join(gitDir, PENDING_MARKER_NAME);
}

function writePendingMarker(gitDir, newSha, parentSha) {
  writeFileSync(pendingMarkerPath(gitDir), JSON.stringify({ new: newSha, parent: parentSha ?? null }), 'utf8');
}

function realIndexBlobFor(root, path) {
  let line;
  try {
    line = git(root, ['ls-files', '-s', '--', path]);
  } catch {
    return null;
  }
  return line.match(/^\d+ ([0-9a-f]+) /)?.[1] ?? null;
}

function treeBlobFor(root, tree, path) {
  if (tree === EMPTY_TREE) return null;
  let line;
  try {
    line = git(root, ['ls-tree', tree, '--', path]);
  } catch {
    return null;
  }
  return line.match(/^\d+ blob ([0-9a-f]+)\t/)?.[1] ?? null;
}

/**
 * Step 0 of every tick: if a previous tick's commit landed but its
 * real-index sync failed, finish the job now, before touching anything
 * else. Only paths whose real-index entry still equals the PARENT commit's
 * blob (i.e. untouched by the user since) are synced — anything the user
 * has since staged differently is left alone and stays pending forever
 * rather than being clobbered.
 *
 * @returns {{synced: boolean, newSha: string, error?: string}|null} null if
 *   there was no pending marker.
 */
function recoverPendingSync(root, gitDir) {
  const markerPath = pendingMarkerPath(gitDir);
  if (!existsSync(markerPath)) return null;

  let marker;
  try {
    marker = JSON.parse(readFileSync(markerPath, 'utf8'));
  } catch {
    // Corrupt marker: drop it rather than getting stuck forever.
    try {
      rmSync(markerPath);
    } catch {
      /* ignore */
    }
    return null;
  }

  const newSha = marker.new;
  const parentSha = marker.parent ?? null;
  const base = parentSha ?? EMPTY_TREE;

  try {
    withRetries(() => {
      const changed = changedVaultPaths(root, base, newSha);
      const safe = changed.filter((p) => realIndexBlobFor(root, p) === treeBlobFor(root, base, p));
      if (safe.length > 0) {
        git(root, ['reset', '-q', newSha, '--', ...safe]);
      }
    });
    rmSync(markerPath);
    return { synced: true, newSha };
  } catch (e) {
    return { synced: false, newSha, error: e.message };
  }
}

/**
 * Core algorithm. Throws on any explicit failure (locked index, CAS race,
 * not a repo, ...) — never silently swallowed.
 *
 * @param {string} root repo root (contains `vault/`)
 * @param {() => string} [now] injectable clock for tests
 * @returns {{status: 'noop'|'committed'|'pending-sync', skipped: string[], recovered: object|null, syncError?: string}}
 */
export function runAutocommit(root, now = () => new Date().toISOString()) {
  const vaultDir = join(root, 'vault');
  if (!existsSync(vaultDir)) return { status: 'noop', skipped: [], recovered: null };

  const gitDir = resolveGitDir(root);

  // Step 0: finish any interrupted sync from a previous tick first.
  const recovered = recoverPendingSync(root, gitDir);

  const lockPath = join(gitDir, 'index.lock');
  if (existsSync(lockPath)) {
    throw new Error(`git index is locked (${lockPath}); skipping autocommit`);
  }

  const head = resolveHead(root);

  const tempDir = mkdtempSync(join(tmpdir(), 'skippy-autocommit-'));
  const tempIndex = join(tempDir, `index-${crypto.randomUUID()}`);
  try {
    const flagged = listFlaggedVaultPaths(root);
    const conflicts = listStagedVsWorktreeConflicts(root);
    const excluded = new Set([...flagged, ...conflicts]);

    const env = { GIT_INDEX_FILE: tempIndex };
    if (head) git(root, ['read-tree', head], env);
    // -A (not just add) so vault deletions are captured too; pathspec keeps
    // this scoped to vault/ only. .gitignore is respected by default.
    git(root, ['add', '-A', '--', VAULT_PATHSPEC], env);

    const base = head ?? EMPTY_TREE;
    const preliminaryTree = git(root, ['write-tree'], env);
    const allChanged = changedVaultPaths(root, base, preliminaryTree);

    const secretNameHits = allChanged.filter((p) => !excluded.has(p) && matchesSecretFilename(p));
    const remaining = allChanged.filter((p) => !excluded.has(p) && !secretNameHits.includes(p));
    const secretContentHits = scanWorkingTreeForSecrets(root, remaining);

    const toRestore = new Set([...excluded, ...secretNameHits, ...secretContentHits]);
    for (const p of toRestore) restorePathToHead(root, tempIndex, head, p);

    const tree = toRestore.size > 0 ? git(root, ['write-tree'], env) : preliminaryTree;
    const skipped = [...flagged, ...conflicts, ...secretNameHits, ...secretContentHits];

    if (!vaultTreeChanged(root, head, tree)) {
      return { status: 'noop', skipped, recovered };
    }

    const stamp = now().replace(/\.\d+Z$/, 'Z'); // ISO8601 UTC, no ms if none given
    const message = `chore(vault): auto-commit ${stamp}`;

    const newCommit = commitAndAdvanceHead(root, tree, head, message);

    try {
      syncRealIndexAfterCommit(root, newCommit, excluded);
      return { status: 'committed', skipped, recovered };
    } catch (e) {
      // HEAD already advanced — this is NOT a failed commit. Leave a marker
      // so the next tick finishes the real-index sync.
      writePendingMarker(gitDir, newCommit, head);
      return { status: 'pending-sync', skipped, recovered, syncError: e.message };
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function commitOnce() {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, '..');
  return runAutocommit(repoRoot);
}

function reportResult(result) {
  if (result.recovered?.synced) {
    console.error(`autocommit: recovered pending index sync for ${result.recovered.newSha}`);
  } else if (result.recovered && !result.recovered.synced) {
    console.error(`autocommit: pending index sync still unresolved: ${result.recovered.error}`);
  }
  if (result.status === 'pending-sync') {
    console.error(`autocommit: committed but index sync pending: ${result.syncError}`);
  }
  if (result.skipped?.length) {
    console.error(`autocommit: skipped vault paths (excluded/secret): ${result.skipped.join(', ')}`);
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
    const ms = (parseInt(arg.match(/--interval=(\d+)/)?.[1] ?? '300', 10)) * 1000;
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

// Only run the CLI when executed directly (`node scripts/git-autocommit.mjs`),
// not when imported (e.g. by the test file).
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
