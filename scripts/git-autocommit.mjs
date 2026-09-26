#!/usr/bin/env node
// Git auto-commit — vault/-only, isolated-index, never touches the user's
// real index or staged work. See apps/shell/src-tauri/src/git_autocommit.rs
// for the Rust twin and full algorithm writeup (A05 / FR-WIKI-06). Both
// implementations must stay in lockstep.
//
// Algorithm (no shell interpolation anywhere — every git invocation uses
// execFileSync with an argv array):
//   1. Resolve HEAD (or note it's unborn).
//   2. Fail fast, untouched, if <git-dir>/index.lock already exists.
//   3. Seed a throwaway index: GIT_INDEX_FILE=<tmp> git read-tree HEAD.
//   4. GIT_INDEX_FILE=<tmp> git add -A -- vault (working tree -> temp index,
//      vault pathspec only, .gitignore respected).
//   5. GIT_INDEX_FILE=<tmp> git write-tree -> candidate tree.
//   6. If candidate tree == HEAD's vault subtree, nothing to do.
//   7. git commit-tree <tree> [-p HEAD] -m <msg> (plumbing: no hooks run).
//   8. git update-ref HEAD <new> <old> — compare-and-swap; fails explicitly
//      if HEAD moved concurrently.
//   9. Only on success: git reset -q <new> -- vault brings the REAL index's
//      vault entries in line with the new commit, leaving every other
//      staged path exactly as the user left it. Any vault changes the user
//      had themselves staged are swept into the autocommit (read from the
//      working tree, not the stage) and afterwards show as clean rather
//      than staged — vault content is always auto-managed by this task.
//
// The temp index file is removed in every case (success, no-op, error).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const VAULT_PATHSPEC = 'vault';

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

function resolveHead(root) {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', '--verify', '-q', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return null; // unborn HEAD
  }
}

function buildVaultTree(root, tempIndex, head) {
  const env = { GIT_INDEX_FILE: tempIndex };
  if (head) {
    git(root, ['read-tree', head], env);
  }
  git(root, ['add', '-A', '--', VAULT_PATHSPEC], env);
  return git(root, ['write-tree'], env);
}

function vaultTreeChanged(root, head, tree) {
  const base = head ?? EMPTY_TREE;
  return gitDiffQuiet(root, ['diff', '--quiet', base, tree, '--', VAULT_PATHSPEC]);
}

function commitAndAdvanceHead(root, tree, head, message) {
  const args = ['-c', 'commit.gpgsign=false', 'commit-tree', tree];
  if (head) args.push('-p', head);
  args.push('-m', message);
  const newCommit = git(root, args);

  const old = head ?? '';
  // CAS: fails explicitly if HEAD moved concurrently.
  git(root, ['update-ref', 'HEAD', newCommit, old]);
  return newCommit;
}

function syncRealIndexToCommit(root, commit) {
  git(root, ['reset', '-q', commit, '--', VAULT_PATHSPEC]);
}

/**
 * Core algorithm. Returns `true` if a commit was created, `false` if there
 * was nothing to commit. Throws on any explicit failure (locked index, CAS
 * race, not a repo, ...) — never silently swallowed.
 *
 * @param {string} root repo root (contains `vault/`)
 * @param {() => string} [now] injectable clock for tests
 */
export function runAutocommit(root, now = () => new Date().toISOString()) {
  const vaultDir = join(root, 'vault');
  if (!existsSync(vaultDir)) return false;

  const gitDir = resolveGitDir(root);

  const lockPath = join(gitDir, 'index.lock');
  if (existsSync(lockPath)) {
    throw new Error(`git index is locked (${lockPath}); skipping autocommit`);
  }

  const head = resolveHead(root);

  const tempDir = mkdtempSync(join(tmpdir(), 'skippy-autocommit-'));
  const tempIndex = join(tempDir, `index-${crypto.randomUUID()}`);
  try {
    const tree = buildVaultTree(root, tempIndex, head);
    if (!vaultTreeChanged(root, head, tree)) return false;

    const stamp = now().replace(/\.\d+Z$/, 'Z'); // ISO8601 UTC, no ms if none given
    const message = `chore(vault): auto-commit ${stamp}`;

    const newCommit = commitAndAdvanceHead(root, tree, head, message);
    syncRealIndexToCommit(root, newCommit);
    return true;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function commitOnce() {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, '..');
  return runAutocommit(repoRoot);
}

function main() {
  const arg = process.argv[2] ?? '--once';
  if (arg === '--once') {
    try {
      commitOnce();
    } catch (e) {
      console.error(e.message);
      process.exitCode = 1;
    }
  } else {
    const ms = (parseInt(arg.match(/--interval=(\d+)/)?.[1] ?? '300', 10)) * 1000;
    setInterval(() => {
      try {
        commitOnce();
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
