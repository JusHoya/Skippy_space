import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';

import { runAutocommit, commitAndAdvanceHead, resolveHead } from './git-autocommit.mjs';

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

    const result = runAutocommit(repo.dir);
    assert.equal(result.status, 'committed');
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

    const result = runAutocommit(repo.dir);
    assert.equal(result.status, 'committed');

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
    assert.equal(runAutocommit(repo.dir).status, 'committed');
    assert.equal(logCount(repo), 2);

    const again = runAutocommit(repo.dir);
    assert.equal(again.status, 'noop');
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

    const result = runAutocommit(repo.dir);
    assert.equal(result.status, 'committed');

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

    const result = runAutocommit(repo.dir);
    assert.equal(result.status, 'committed');
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
    const result = runAutocommit(repo.dir);
    assert.equal(result.status, 'committed');
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
    assert.equal(runAutocommit(repo.dir).status, 'noop');
  } finally {
    cleanup(repo);
  }
});

// --- Defect 1: failure after update-ref must self-heal, not report a
// failed commit, and must not leave the real index reverted on the next
// no-op tick. -----------------------------------------------------------

test('index-lock appearing only after HEAD moves is reported pending, not failed, and self-heals', () => {
  const repo = makeRepo();
  try {
    seedInitialCommit(repo);
    write(repo.dir, 'vault/note.md', 'vault content\n');

    // A reference-transaction hook that grabs the index lock right after
    // update-ref lands — stands in for e.g. an IDE grabbing the lock in
    // between our update-ref and our own reset.
    const hooksDir = join(repo.dir, '.hooks');
    mkdirSync(hooksDir, { recursive: true });
    const lockPath = join(repo.dir, '.git', 'index.lock');
    const hookPath = join(hooksDir, 'reference-transaction');
    // The reference-transaction hook receives the state ("prepared" /
    // "committed" / "aborted") as $1, NOT on stdin (stdin carries the
    // "<old> <new> <refname>" lines being transacted).
    writeFileSync(
      hookPath,
      `#!/bin/sh\ncat >/dev/null\nif [ "$1" = "committed" ]; then : > "${lockPath.replace(/\\/g, '/')}"\nfi\nexit 0\n`,
    );
    chmodSync(hookPath, 0o755);
    repo.git('config', 'core.hooksPath', '.hooks');

    const result = runAutocommit(repo.dir);
    assert.equal(result.status, 'pending-sync', 'commit landed but sync must be reported as pending, not failed');
    assert.equal(logCount(repo), 2, 'HEAD must have advanced despite the sync failure');

    const pendingMarker = join(repo.dir, '.git', 'skippy-autocommit-pending');
    assert.ok(existsSync(pendingMarker), 'a pending-sync marker must be persisted');

    // The lock is released (simulating the IDE letting go); the hook itself
    // won't refire since HEAD isn't moving again, but a real lock could be
    // dropped by an external actor at any time.
    rmSync(lockPath, { force: true });
    // Disarm the hook so it doesn't reintroduce the lock on our next run.
    repo.git('config', 'core.hooksPath', '.no-hooks');

    // Next tick: recovery must run BEFORE anything else and must sync the
    // real index to the new commit's vault blobs, not report a spurious
    // no-op that leaves the real index reverted to the old vault blob.
    const next = runAutocommit(repo.dir);
    assert.ok(next.recovered?.synced, 'pending sync must be recovered on the next tick');
    assert.ok(!existsSync(pendingMarker), 'pending marker must be cleared after recovery');

    const diffCached = repo.git('diff', '--cached', '--', 'vault/note.md');
    assert.equal(diffCached, '', 'real index must reflect the committed vault blob, not revert it');
  } finally {
    cleanup(repo);
  }
});

test('pending sync recovery does not clobber a vault path the user has re-staged since', () => {
  const repo = makeRepo();
  try {
    seedInitialCommit(repo);
    write(repo.dir, 'vault/note.md', 'v1\n');
    const first = runAutocommit(repo.dir);
    assert.equal(first.status, 'committed');
    const parentSha = repo.git('rev-parse', 'HEAD').trim();

    // Manually simulate a commit whose real-index sync never happened
    // (write the marker directly, as syncRealIndexAfterCommit would have
    // failed to do it) after a second vault edit lands.
    write(repo.dir, 'vault/note.md', 'v2\n');
    repo.git('add', '-A', '--', 'vault');
    const treeSha = repo.git('write-tree').trim();
    const newSha = repo
      .git('-c', 'commit.gpgsign=false', 'commit-tree', treeSha, '-p', parentSha, '-m', 'chore(vault): auto-commit synthetic')
      .trim();
    repo.git('update-ref', 'HEAD', newSha, parentSha);
    // Revert the real index's note.md back to what it was before this
    // commit, matching what step-1's defect describes.
    repo.git('reset', '-q', parentSha, '--', 'vault');

    const markerPath = join(repo.dir, '.git', 'skippy-autocommit-pending');
    writeFileSync(markerPath, JSON.stringify({ new: newSha, parent: parentSha }));

    // Now the user stages their OWN edit to note.md before the next tick
    // runs — this must NOT be clobbered by recovery.
    write(repo.dir, 'vault/note.md', 'user edit in progress\n');
    repo.git('add', '--', 'vault/note.md');
    const userStagedBlob = repo.git('rev-parse', ':vault/note.md').trim();

    runAutocommit(repo.dir);

    const blobAfter = repo.git('rev-parse', ':vault/note.md').trim();
    assert.equal(blobAfter, userStagedBlob, "recovery must not clobber the user's own staged edit");
  } finally {
    cleanup(repo);
  }
});

// --- Defect 2: secrets must never be committed, even without hooks. ----

test('well-known secret filenames are excluded even though they are inside vault/', () => {
  const repo = makeRepo();
  try {
    seedInitialCommit(repo);
    write(repo.dir, 'vault/notes.md', 'ordinary note\n');
    write(repo.dir, 'vault/.env.production', 'API_KEY=super-secret\n');
    write(repo.dir, 'vault/credentials.json', '{"token":"x"}\n');
    write(repo.dir, 'vault/id_rsa', '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n');

    const result = runAutocommit(repo.dir);
    assert.equal(result.status, 'committed');

    const files = repo.git('ls-tree', '-r', '--name-only', 'HEAD');
    assert.ok(files.includes('vault/notes.md'));
    assert.ok(!files.includes('vault/.env.production'), 'secret filename .env.production was committed');
    assert.ok(!files.includes('vault/credentials.json'), 'secret filename credentials.json was committed');
    assert.ok(!files.includes('vault/id_rsa'), 'secret filename id_rsa was committed');

    assert.ok(result.skipped.includes('vault/.env.production'));
    assert.ok(result.skipped.includes('vault/credentials.json'));
    assert.ok(result.skipped.includes('vault/id_rsa'));
  } finally {
    cleanup(repo);
  }
});

test('secret content markers are excluded even under an innocuous filename', () => {
  const repo = makeRepo();
  try {
    seedInitialCommit(repo);
    write(repo.dir, 'vault/leaked-notes.md', 'AKIAABCDEFGHIJKLMNOP is an AWS key I found\n');
    write(repo.dir, 'vault/fine.md', 'nothing to see here\n');

    const result = runAutocommit(repo.dir);
    assert.equal(result.status, 'committed');

    const files = repo.git('ls-tree', '-r', '--name-only', 'HEAD');
    assert.ok(files.includes('vault/fine.md'));
    assert.ok(!files.includes('vault/leaked-notes.md'), 'content-scanned secret was committed');
    assert.ok(result.skipped.includes('vault/leaked-notes.md'));
  } finally {
    cleanup(repo);
  }
});

// --- Defect 3/4: skip-worktree and assume-unchanged flags must survive. -

test('skip-worktree vault file is not committed as deleted and keeps its flag', () => {
  const repo = makeRepo();
  try {
    seedInitialCommit(repo);
    write(repo.dir, 'vault/sparse.md', 'sparse content\n');
    repo.git('add', 'vault/sparse.md');
    repo.git('commit', '-q', '-m', 'add sparse vault file');
    repo.git('update-index', '--skip-worktree', 'vault/sparse.md');

    // Delete it from the working tree, as a sparse checkout would.
    rmSync(join(repo.dir, 'vault', 'sparse.md'));
    write(repo.dir, 'vault/other.md', 'other content\n');

    const result = runAutocommit(repo.dir);
    assert.equal(result.status, 'committed');

    const files = repo.git('ls-tree', '-r', '--name-only', 'HEAD');
    assert.ok(files.includes('vault/sparse.md'), 'skip-worktree file must not be committed as deleted');
    assert.ok(files.includes('vault/other.md'));

    const flag = repo.git('ls-files', '-v', '--', 'vault/sparse.md').trim();
    assert.ok(flag.startsWith('S '), `skip-worktree flag must survive, got: ${flag}`);
  } finally {
    cleanup(repo);
  }
});

test('assume-unchanged vault file with a local edit is not committed and keeps its flag', () => {
  const repo = makeRepo();
  try {
    seedInitialCommit(repo);
    write(repo.dir, 'vault/assumed.md', 'original\n');
    repo.git('add', 'vault/assumed.md');
    repo.git('commit', '-q', '-m', 'add assumed vault file');
    repo.git('update-index', '--assume-unchanged', 'vault/assumed.md');

    write(repo.dir, 'vault/assumed.md', 'locally edited, should not be swept up\n');
    write(repo.dir, 'vault/real-change.md', 'real change\n');

    const result = runAutocommit(repo.dir);
    assert.equal(result.status, 'committed');

    const committedContent = repo.git('show', 'HEAD:vault/assumed.md');
    assert.equal(committedContent.trim(), 'original', 'assume-unchanged local edit must not be committed');

    const flag = repo.git('ls-files', '-v', '--', 'vault/assumed.md').trim();
    assert.ok(/^h/.test(flag), `assume-unchanged flag must survive, got: ${flag}`);
  } finally {
    cleanup(repo);
  }
});

// --- Defect 5: staged-vs-worktree conflicts must be left alone. --------

test('a vault path staged differently from both HEAD and the working tree is skipped, not clobbered', () => {
  const repo = makeRepo();
  try {
    seedInitialCommit(repo);
    write(repo.dir, 'vault/partial.md', 'head version\n');
    repo.git('add', 'vault/partial.md');
    repo.git('commit', '-q', '-m', 'add partial vault file');

    // Stage one edit...
    write(repo.dir, 'vault/partial.md', 'staged version\n');
    repo.git('add', 'vault/partial.md');
    // ...then edit the working tree again without staging that.
    write(repo.dir, 'vault/partial.md', 'worktree version\n');

    const stagedBlobBefore = repo.git('rev-parse', ':vault/partial.md').trim();

    const result = runAutocommit(repo.dir);

    assert.ok(result.skipped.includes('vault/partial.md'));
    // Nothing committed for this path: HEAD must still show the original.
    const headContent = repo.git('show', 'HEAD:vault/partial.md');
    assert.equal(headContent.trim(), 'head version');
    // The user's staged blob must be untouched.
    const stagedBlobAfter = repo.git('rev-parse', ':vault/partial.md').trim();
    assert.equal(stagedBlobAfter, stagedBlobBefore, "user's staged blob must be left alone");
    // The working tree edit must still be on disk, unstaged.
    const worktreeContent = repo.git('diff', '--', 'vault/partial.md');
    assert.ok(worktreeContent.includes('worktree version'));
  } finally {
    cleanup(repo);
  }
});

// --- Defect 6: CAS race and failed-commit coverage. ---------------------

test('concurrent HEAD move (CAS) fails explicitly and leaves the real index untouched', () => {
  const repo = makeRepo();
  try {
    seedInitialCommit(repo);
    write(repo.dir, 'vault/note.md', 'vault content\n');

    // Reproduce exactly what runAutocommit does, but hold on to a stale
    // `head` value across a concurrent commit to simulate a race against
    // another writer that moved HEAD in between (mirrors the Rust twin's
    // `concurrent_head_move_fails_the_cas_and_leaves_index_untouched`).
    const staleHead = resolveHead(repo.dir);
    repo.git('add', '-A', '--', 'vault');
    const tree = repo.git('write-tree').trim();
    repo.git('reset', '-q', 'HEAD', '--', 'vault'); // undo the real-index stage from the line above

    // Someone else advances HEAD concurrently.
    write(repo.dir, 'README.md', 'concurrent writer\n');
    repo.git('add', 'README.md');
    repo.git('commit', '-q', '-m', 'concurrent commit');

    const lsBefore = repo.git('ls-files', '-s');
    const diffBefore = repo.git('diff', '--cached');

    // Attempt to advance HEAD using the now-stale `head` as the CAS
    // expected value — this must fail explicitly.
    assert.throws(
      () => commitAndAdvanceHead(repo.dir, tree, staleHead, 'chore(vault): auto-commit race-test'),
      /update-ref|failed/i,
    );

    // We never got to the index-sync step, so the real index must be
    // completely untouched.
    assert.equal(repo.git('ls-files', '-s'), lsBefore);
    assert.equal(repo.git('diff', '--cached'), diffBefore);
  } finally {
    cleanup(repo);
  }
});
