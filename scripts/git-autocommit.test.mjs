import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';

import { runAutocommit } from './git-autocommit.mjs';

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), `skippy-autocommit-test-${crypto.randomUUID()}-`));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Skippy Test');
  git('config', 'user.email', 'skippy-test@example.invalid');
  // Local-only guardrails so the user's global git config (gpg signing,
  // hooks path, etc.) can never interfere with the test.
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', '.no-hooks');
  return { dir, git };
}

function write(dir, rel, contents) {
  const p = join(dir, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, contents);
}

function seedInitialCommit(repo) {
  write(repo.dir, 'README.md', 'hello\n');
  repo.git('add', 'README.md');
  repo.git('commit', '-q', '-m', 'initial');
}

function logCount(repo) {
  try {
    return parseInt(repo.git('rev-list', '--count', 'HEAD').trim(), 10);
  } catch {
    return 0;
  }
}

function cleanup(repo) {
  rmSync(repo.dir, { recursive: true, force: true });
}

test('commits vault changes and advances HEAD', () => {
  const repo = makeRepo();
  try {
    seedInitialCommit(repo);
    write(repo.dir, 'vault/note.md', '---\nid: 1\n---\nhello vault\n');

    const committed = runAutocommit(repo.dir);
    assert.equal(committed, true);
    assert.equal(logCount(repo), 2);

    const msg = repo.git('log', '-1', '--pretty=%s').trim();
    assert.match(msg, /^chore\(vault\): auto-commit/);

    const status = repo.git('status', '--porcelain', 'vault/').trim();
    assert.equal(status, '', `expected vault/ clean, got: ${status}`);
  } finally {
    cleanup(repo);
  }
});

test('unrelated staged file stays staged and is not committed', () => {
  const repo = makeRepo();
  try {
    seedInitialCommit(repo);

    write(repo.dir, 'src/other.txt', 'unrelated work in progress\n');
    repo.git('add', 'src/other.txt');
    const stagedBefore = repo.git('diff', '--cached');
    assert.notEqual(stagedBefore.trim(), '', 'expected something staged');
    const nonVaultLsBefore = repo
      .git('ls-files', '-s')
      .split('\n')
      .filter((l) => !l.includes('vault/'));

    write(repo.dir, 'vault/note.md', 'vault content\n');

    const committed = runAutocommit(repo.dir);
    assert.equal(committed, true);

    const stagedAfter = repo.git('diff', '--cached');
    assert.equal(stagedAfter, stagedBefore, 'unrelated staged diff changed');

    const nonVaultLsAfter = repo
      .git('ls-files', '-s')
      .split('\n')
      .filter((l) => !l.includes('vault/'));
    assert.deepEqual(nonVaultLsAfter, nonVaultLsBefore, 'unrelated (non-vault) index entries changed');

    const committedFiles = repo.git('show', '--stat', '--pretty=format:', 'HEAD');
    assert.ok(!committedFiles.includes('other.txt'), `unrelated file leaked into autocommit: ${committedFiles}`);
    assert.ok(committedFiles.includes('note.md'));
  } finally {
    cleanup(repo);
  }
});

test('no-op when vault is unchanged', () => {
  const repo = makeRepo();
  try {
    seedInitialCommit(repo);
    write(repo.dir, 'vault/note.md', 'vault content\n');
    assert.equal(runAutocommit(repo.dir), true);
    assert.equal(logCount(repo), 2);

    const committedAgain = runAutocommit(repo.dir);
    assert.equal(committedAgain, false);
    assert.equal(logCount(repo), 2, 'no-op must not create a commit');
  } finally {
    cleanup(repo);
  }
});

test('ignored vault files are not committed', () => {
  const repo = makeRepo();
  try {
    seedInitialCommit(repo);
    write(repo.dir, '.gitignore', 'vault/*.tmp\n');
    repo.git('add', '.gitignore');
    repo.git('commit', '-q', '-m', 'add gitignore');

    write(repo.dir, 'vault/keep.md', 'keep me\n');
    write(repo.dir, 'vault/scratch.tmp', 'ignore me\n');

    const committed = runAutocommit(repo.dir);
    assert.equal(committed, true);

    const files = repo.git('ls-tree', '-r', '--name-only', 'HEAD');
    assert.ok(files.includes('vault/keep.md'));
    assert.ok(!files.includes('scratch.tmp'), `ignored file was committed: ${files}`);
  } finally {
    cleanup(repo);
  }
});

test('unborn HEAD repo commits the first vault snapshot with no parent', () => {
  const repo = makeRepo();
  try {
    write(repo.dir, 'vault/note.md', 'first ever vault note\n');

    const committed = runAutocommit(repo.dir);
    assert.equal(committed, true);
    assert.equal(logCount(repo), 1);

    const parents = repo.git('log', '-1', '--pretty=%P').trim();
    assert.equal(parents, '', 'first commit must have no parents');
  } finally {
    cleanup(repo);
  }
});

test('pre-existing index.lock fails explicitly and leaves everything untouched', () => {
  const repo = makeRepo();
  try {
    seedInitialCommit(repo);
    write(repo.dir, 'vault/note.md', 'vault content\n');

    const lockPath = join(repo.dir, '.git', 'index.lock');
    writeFileSync(lockPath, '');

    const lsBefore = repo.git('ls-files', '-s');
    const diffBefore = repo.git('diff', '--cached');
    const logBefore = logCount(repo);

    assert.throws(() => runAutocommit(repo.dir), /index is locked/);

    assert.ok(existsSync(lockPath), "must never delete someone else's index.lock");
    assert.equal(repo.git('ls-files', '-s'), lsBefore, 'real index must be untouched');
    assert.equal(repo.git('diff', '--cached'), diffBefore, 'real staged diff must be untouched');
    assert.equal(logCount(repo), logBefore, 'no commit must be created');

    rmSync(lockPath);
  } finally {
    cleanup(repo);
  }
});

test('detached HEAD still commits', () => {
  const repo = makeRepo();
  try {
    seedInitialCommit(repo);
    const head = repo.git('rev-parse', 'HEAD').trim();
    repo.git('checkout', '-q', head);

    write(repo.dir, 'vault/note.md', 'vault content on detached head\n');
    const committed = runAutocommit(repo.dir);
    assert.equal(committed, true);
    assert.equal(logCount(repo), 2);
  } finally {
    cleanup(repo);
  }
});

test('not a git repo throws', () => {
  const dir = mkdtempSync(join(tmpdir(), `skippy-not-a-repo-${crypto.randomUUID()}-`));
  try {
    mkdirSync(join(dir, 'vault'), { recursive: true });
    assert.throws(() => runAutocommit(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('missing vault dir is a quiet no-op', () => {
  const repo = makeRepo();
  try {
    seedInitialCommit(repo);
    assert.equal(runAutocommit(repo.dir), false);
  } finally {
    cleanup(repo);
  }
});
