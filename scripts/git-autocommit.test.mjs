import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, chmodSync, readFileSync, readdirSync, lstatSync, symlinkSync, utimesSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import crypto from 'node:crypto';

import { runAutocommit, commitAndAdvanceHead, resolveHead } from './git-autocommit.mjs';
// Namespace import for helpers added in round 3, so this file still loads
// (and the E5 cases fail individually) against older implementations.
import * as autocommit from './git-autocommit.mjs';

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

// =========================================================================
// Round-3 red-team regressions (E5-1 .. E5-9). Mirrors the Rust twin's
// `e5_regression_tests` module case for case.
// =========================================================================

const CAFE = 'vault/café.md';
const RESUME = 'vault/résumé.md';
const UBER = 'vault/über.md';
const KANJI = 'vault/私.md';

function e5Repo() {
  const repo = makeRepo();
  const q = (...args) => execFileSync('git', ['-C', repo.dir, '-c', 'core.quotepath=false', ...args], { encoding: 'utf8' });
  return {
    ...repo,
    q,
    ok: (...args) => q(...args).trim(),
    write: (rel, contents) => write(repo.dir, rel, contents),
    commitAll: (msg) => {
      q('add', '-A', '.');
      q('commit', '-q', '-m', msg);
    },
    headTree: () => q('ls-tree', '-r', '-z', '--name-only', 'HEAD').split('\0').filter(Boolean),
    show: (spec) => q('show', spec).trim(),
    status: () => q('status', '--porcelain', '-uno').trim(),
    marker: join(repo.dir, '.git', 'skippy-autocommit-pending'),
    lock: join(repo.dir, '.git', 'index.lock'),
  };
}

/** Reference-transaction hook that grabs the index lock right after our
 * update-ref lands, so the real-index sync fails (pending-sync). */
function armLockAfterRefUpdate(r) {
  const hooksDir = join(r.dir, '.hooks');
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, 'reference-transaction');
  writeFileSync(
    hookPath,
    `#!/bin/sh\ncat >/dev/null\nif [ "$1" = "committed" ]; then : > "${r.lock.replace(/\\/g, '/')}"\nfi\nexit 0\n`,
  );
  chmodSync(hookPath, 0o755);
  r.q('config', 'core.hooksPath', '.hooks');
}

function disarm(r) {
  r.q('config', 'core.hooksPath', '.no-hooks');
  rmSync(r.lock, { force: true });
}

function pendingCommitOf(r, path, v2) {
  r.write(path, 'v1\n');
  r.write('a', 'a\n');
  r.commitAll('init');
  armLockAfterRefUpdate(r);
  r.write(path, v2);
  const res = runAutocommit(r.dir);
  assert.equal(res.status, 'pending-sync');
  assert.ok(existsSync(r.marker), 'pending marker must be written');
  disarm(r);
}

function utf16leWithBom(s) {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]);
}

function utf16beNoBom(s) {
  const le = Buffer.from(s, 'utf16le');
  return Buffer.from(le).swap16();
}

function withRepo(fn) {
  const r = e5Repo();
  try {
    fn(r);
  } finally {
    cleanup(r);
  }
}

// --- E5-1: non-ASCII paths must not bypass any exclusion. ---------------

test('E5-1 non-ASCII path with secret content is not committed', () =>
  withRepo((r) => {
    r.write('a', 'a\n');
    r.commitAll('init');
    r.write(CAFE, 'my aws key AKIAABCDEFGHIJKLMNOP\n');
    r.write('vault/n.md', 'x\n');
    const res = runAutocommit(r.dir);
    assert.equal(res.status, 'committed');
    const tree = r.headTree();
    assert.ok(tree.includes('vault/n.md'));
    assert.ok(!tree.includes(CAFE), `AKIA key in a non-ASCII path was committed: ${tree}`);
    assert.ok(res.skipped.includes(CAFE), `skipped must name the decoded path: ${res.skipped}`);
  }));

test('E5-1 non-ASCII skip-worktree path is not committed as deleted and keeps its flag', () =>
  withRepo((r) => {
    r.write('vault/keep.md', 'k\n');
    r.write(RESUME, 's\n');
    r.commitAll('init');
    r.q('update-index', '--skip-worktree', '--', RESUME);
    rmSync(join(r.dir, RESUME));
    r.write('vault/keep.md', 'k2\n');
    assert.equal(runAutocommit(r.dir).status, 'committed');
    assert.ok(r.headTree().includes(RESUME), 'skip-worktree file committed as deleted');
    const flag = r.ok('ls-files', '-v', '--', RESUME);
    assert.ok(flag.startsWith('S '), `skip-worktree flag lost: ${flag}`);
  }));

test('E5-1 non-ASCII assume-unchanged edit is not committed and keeps its flag', () =>
  withRepo((r) => {
    r.write(KANJI, 'orig\n');
    r.write('vault/n.md', 'x\n');
    r.commitAll('init');
    r.q('update-index', '--assume-unchanged', '--', KANJI);
    r.write(KANJI, 'LOCAL PRIVATE EDIT\n');
    r.write('vault/n.md', 'y\n');
    assert.equal(runAutocommit(r.dir).status, 'committed');
    assert.equal(r.show(`HEAD:${KANJI}`), 'orig');
    const flag = r.ok('ls-files', '-v', '--', KANJI);
    assert.ok(flag.startsWith('h '), `assume-unchanged flag lost: ${flag}`);
  }));

test('E5-1 non-ASCII partially staged path is left alone', () =>
  withRepo((r) => {
    r.write(UBER, 'v1\n');
    r.commitAll('init');
    r.write(UBER, 'STAGED\n');
    r.q('add', '--', UBER);
    r.write(UBER, 'WORKTREE\n');
    try {
      runAutocommit(r.dir);
    } catch {
      /* outcome irrelevant; state is what matters */
    }
    assert.equal(r.show(`HEAD:${UBER}`), 'v1');
    assert.equal(r.show(`:${UBER}`), 'STAGED', "user's staged blob was lost");
  }));

test('E5-1 non-ASCII pending-sync recovery really syncs the index', () =>
  withRepo((r) => {
    pendingCommitOf(r, CAFE, 'v2\n');
    const next = runAutocommit(r.dir);
    assert.ok(next.recovered?.synced, `recovery must succeed: ${JSON.stringify(next.recovered)}`);
    assert.ok(!existsSync(r.marker), 'marker must be cleared after recovery');
    assert.equal(r.status(), '', 'index must match HEAD after recovery');
    r.write('a', 'user\n');
    r.q('add', 'a');
    r.q('commit', '-q', '-m', 'user');
    assert.equal(r.show(`HEAD:${CAFE}`), 'v2', "user's next commit reverted the vault change");
  }));

// --- E5-2: a stale pending marker must never re-stage anything. ---------

test('E5-2 marker is dropped after reset --hard without touching the index', () =>
  withRepo((r) => {
    pendingCommitOf(r, 'vault/n.md', 'v2 DISCARD ME\n');
    r.q('reset', '-q', '--hard', 'HEAD~1');
    const res = runAutocommit(r.dir);
    assert.ok(res.recovered?.dropped, `marker must be reported dropped: ${JSON.stringify(res.recovered)}`);
    assert.ok(!existsSync(r.marker), 'stale marker must be dropped');
    assert.equal(r.status(), '');
    assert.equal(r.show(':vault/n.md'), 'v1', 'discarded content was re-staged');
  }));

test('E5-2 marker is dropped after switching branches', () =>
  withRepo((r) => {
    // `other` holds the same vault blob as the autocommit's parent, so a
    // marker that isn't validated against HEAD would look "safe" there.
    r.write('vault/n.md', 'v1\n');
    r.commitAll('pre');
    r.q('branch', 'other');
    pendingCommitOf(r, 'vault/n.md', 'v2 main-only\n');
    r.q('checkout', '-q', '-f', 'other');
    const res = runAutocommit(r.dir);
    assert.ok(res.recovered?.dropped, `marker must be reported dropped: ${JSON.stringify(res.recovered)}`);
    assert.ok(!existsSync(r.marker), 'stale marker must be dropped');
    assert.equal(r.status(), '', "main's vault change was staged into other's index");
    assert.equal(r.ok('rev-list', '--count', 'other'), '1');
  }));

// --- E5-3: secret-named paths the user staged keep their staged blob. ---

test('E5-3 user-staged edit to a secret-named path is preserved', () =>
  withRepo((r) => {
    r.write('vault/.env', 'OLD=1\n');
    r.write('vault/n.md', 'x\n');
    r.commitAll('init');
    r.write('vault/.env', 'NEW=2\n');
    r.q('add', 'vault/.env');
    r.write('vault/n.md', 'y\n');
    assert.equal(runAutocommit(r.dir).status, 'committed');
    assert.equal(r.show('HEAD:vault/.env'), 'OLD=1');
    assert.equal(r.show('HEAD:vault/n.md'), 'y');
    assert.equal(r.show(':vault/.env'), 'NEW=2', "user's staged .env edit was wiped");
  }));

// --- E5-4: paths are literal, never pathspec magic. ---------------------

test('E5-4 glob-like vault path is matched literally', () =>
  withRepo((r) => {
    r.write('vault/a.md', 'a1\n');
    r.write('vault/[ab].md', 'x1\n');
    r.commitAll('init');
    r.write('vault/[ab].md', 'x2\n');
    r.q('add', '--', ':(literal)vault/[ab].md');
    r.write('vault/[ab].md', 'x3\n');
    r.write('vault/a.md', 'a2\n');
    assert.equal(runAutocommit(r.dir).status, 'committed');
    assert.equal(r.show('HEAD:vault/a.md'), 'a2');
    assert.equal(r.show(':vault/a.md'), 'a2', "index lags HEAD; the user's next commit would revert");
    assert.equal(r.show(':vault/[ab].md'), 'x2', "user's staged blob was lost");
  }));

// --- E5-5: no per-path command-line arguments. --------------------------

test('E5-5 many skip-worktree paths do not overflow the command line', () =>
  withRepo((r) => {
    for (let i = 0; i < 1200; i++) {
      r.write(`vault/archive/some-long-archived-note-name-number-${String(i).padStart(5, '0')}.md`, `n${i}\n`);
    }
    r.write('vault/live.md', 'l\n');
    r.commitAll('init');
    r.q('sparse-checkout', 'set', '--no-cone', '/vault/live.md');
    r.write('vault/live.md', 'l2\n');
    const res = runAutocommit(r.dir);
    assert.equal(res.status, 'committed', `must not end pending-sync: ${res.syncError ?? ''}`);
    assert.ok(!existsSync(r.marker));
    assert.equal(r.show('HEAD:vault/live.md'), 'l2');
    assert.equal(r.show(':vault/live.md'), 'l2');
    assert.equal(r.headTree().length, 1201, 'sparse (skip-worktree) files were committed as deleted');
    const flag = r.ok('ls-files', '-v', '--', 'vault/archive/some-long-archived-note-name-number-00007.md');
    assert.ok(flag.startsWith('S '), `skip-worktree flag lost: ${flag}`);
  }));

// --- E5-6 / E5-7: user-staged vault paths are user-owned. ---------------

test('E5-6 rm --cached vault path stays staged for removal', () =>
  withRepo((r) => {
    r.write('vault/x.md', 'x\n');
    r.write('vault/n.md', 'n\n');
    r.commitAll('init');
    r.q('rm', '-q', '--cached', 'vault/x.md');
    r.write('vault/n.md', 'n2\n');
    assert.equal(runAutocommit(r.dir).status, 'committed');
    assert.equal(r.show('HEAD:vault/n.md'), 'n2');
    assert.ok(r.headTree().includes('vault/x.md'));
    const status = r.status();
    assert.ok(status.split('\n').includes('D  vault/x.md'), `staged rm --cached was undone: ${status}`);
  }));

// Intent-to-add is user-owned BY DESIGN (E5-6): the `git add -N` entry differs
// from HEAD, so the autocommit never commits it and leaves the i-t-a entry
// exactly as the user made it (an earlier red-team expectation that it be
// committed was stale).
test('E5-6 intent-to-add and fully staged vault paths are user-owned', () =>
  withRepo((r) => {
    r.write('vault/m.md', 'm1\n');
    r.write('vault/o.md', 'o1\n');
    r.commitAll('init');
    r.write('vault/new.md', 'n\n');
    r.q('add', '-N', 'vault/new.md');
    r.write('vault/m.md', 'm2 staged\n');
    r.q('add', 'vault/m.md');
    r.write('vault/o.md', 'o2\n');
    const res = runAutocommit(r.dir);
    assert.equal(res.status, 'committed');
    assert.equal(r.show('HEAD:vault/o.md'), 'o2');
    assert.equal(r.show('HEAD:vault/m.md'), 'm1');
    assert.ok(!r.headTree().includes('vault/new.md'));
    const status = r.status().split('\n');
    assert.ok(status.includes('M  vault/m.md'), status.join('|'));
    assert.ok(status.includes(' A vault/new.md'), `intent-to-add lost: ${status.join('|')}`);
  }));

test('E5-7 staged rename with an unstaged edit is left alone', () =>
  withRepo((r) => {
    r.write('vault/a.md', 'line1\nline2\nline3\nline4\nline5\n');
    r.commitAll('init');
    r.q('mv', 'vault/a.md', 'vault/b.md');
    r.write('vault/b.md', 'line1\nline2\nline3\nline4\nline5\nline6 unstaged\n');
    const before = r.status();
    assert.equal(runAutocommit(r.dir).status, 'noop');
    assert.deepEqual(r.headTree(), ['vault/a.md'], 'half of the rename was committed');
    assert.equal(r.status(), before, "the user's staged rename changed");
  }));

// --- E5-8: secret guard gaps and false positives. -----------------------

test('E5-8 secret filenames match case-insensitively', () =>
  withRepo((r) => {
    r.write('a', 'a\n');
    r.commitAll('init');
    r.write('vault/.ENV', 'API_KEY=plain-no-marker\n');
    r.write('vault/ID_RSA', 'not a pem header\n');
    r.write('vault/server.PEM', 'x\n');
    r.write('vault/Prod.Key', 'x\n');
    r.write('vault/n.md', 'x\n');
    assert.equal(runAutocommit(r.dir).status, 'committed');
    assert.deepEqual(r.headTree(), ['a', 'vault/n.md']);
  }));

test('E5-8 .env look-alike and secrets.md notes are not false positives', () =>
  withRepo((r) => {
    r.write('a', 'a\n');
    r.commitAll('init');
    r.write('vault/sub/.env.local', 'K=1\n');
    r.write('vault/.envelope.md', '# Envelope design note\n');
    r.write('vault/secrets.md', '# Secrets of the Magnificent (a normal note)\n');
    assert.equal(runAutocommit(r.dir).status, 'committed');
    const tree = r.headTree();
    assert.ok(!tree.includes('vault/sub/.env.local'));
    assert.ok(tree.includes('vault/.envelope.md'), tree.join(','));
    assert.ok(tree.includes('vault/secrets.md'), tree.join(','));
    assert.equal(r.status(), '', 'false-positive notes must be committed and synced');
  }));

test('E5-8 content scan catches PGP, UTF-16, OpenAI and AWS secret keys', () =>
  withRepo((r) => {
    r.write('a', 'a\n');
    r.commitAll('init');
    r.write('vault/key.asc', '-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBF\n-----END PGP PRIVATE KEY BLOCK-----\n');
    r.write('vault/utf16le.md', utf16leWithBom('aws AKIAABCDEFGHIJKLMNOP\n'));
    r.write('vault/utf16be.md', utf16beNoBom('aws AKIAABCDEFGHIJKLMNOP\n'));
    r.write(
      'vault/blob.bin',
      Buffer.concat([Buffer.from([0, 1, 2, 0xff, 0]), Buffer.from('AKIAABCDEFGHIJKLMNOP'), Buffer.from([0, 0xfe])]),
    );
    r.write('vault/.aws/credentials', '[default]\naws_secret_access_key = wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY\n');
    r.write('vault/openai.md', 'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789\n');
    r.write('vault/n.md', 'x\n');
    assert.equal(runAutocommit(r.dir).status, 'committed');
    assert.deepEqual(r.headTree(), ['a', 'vault/n.md']);
  }));

test('E5-8 shared secret patterns pass their self-test vectors', () => {
  assert.equal(typeof autocommit.matchesSecretFilename, 'function', 'matchesSecretFilename export missing');
  assert.equal(typeof autocommit.matchesSecretContent, 'function', 'matchesSecretContent export missing');
  const json = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'git-autocommit-secret-patterns.json'), 'utf8'),
  );
  const st = json.selfTest;
  const asBytes = (s) => Buffer.from(s, 'utf8').toString('latin1');
  const utf16 = (s, be, bom) => {
    let b = Buffer.from(s, 'utf16le');
    if (be) b = Buffer.from(b).swap16();
    return bom ? Buffer.concat([Buffer.from(be ? [0xfe, 0xff] : [0xff, 0xfe]), b]) : b;
  };
  for (const s of st.filenameHits) assert.ok(autocommit.matchesSecretFilename(asBytes(s)), `filename should be a secret: ${s}`);
  for (const s of st.filenameMisses) assert.ok(!autocommit.matchesSecretFilename(asBytes(s)), `filename false positive: ${s}`);
  for (const s of st.contentHits) {
    assert.ok(autocommit.matchesSecretContent(Buffer.from(s, 'utf8')), `content should be a secret: ${s}`);
    for (const [be, bom] of [[false, true], [false, false], [true, true], [true, false]]) {
      assert.ok(autocommit.matchesSecretContent(utf16(s, be, bom)), `UTF-16 (be=${be}, bom=${bom}) content missed: ${s}`);
    }
  }
  for (const s of st.contentMisses) {
    assert.ok(!autocommit.matchesSecretContent(Buffer.from(s, 'utf8')), `content false positive: ${s}`);
    assert.ok(!autocommit.matchesSecretContent(utf16(s, false, true)), `UTF-16 content false positive: ${s}`);
  }
  for (const s of st.lfsPointerHits) assert.ok(autocommit.matchesLfsPointer(Buffer.from(s, 'utf8')), `LFS pointer missed: ${JSON.stringify(s)}`);
  for (const s of st.lfsPointerMisses) assert.ok(!autocommit.matchesLfsPointer(Buffer.from(s, 'utf8')), `LFS pointer false positive: ${s}`);
});

// --- E5-9: documented pending window heals on the next tick. ------------

test('E5-9 user commit inside the pending window is healed on the next tick', () =>
  withRepo((r) => {
    pendingCommitOf(r, 'vault/n.md', 'v2\n');
    r.write('a', 'user\n');
    r.q('add', 'a');
    r.q('commit', '-q', '-m', 'user commit before next tick');
    // Known window: the user's commit recorded the parent blob.
    assert.equal(r.show('HEAD:vault/n.md'), 'v1');
    const res = runAutocommit(r.dir);
    assert.equal(res.status, 'committed');
    assert.ok(res.recovered?.dropped, `marker must be reported dropped: ${JSON.stringify(res.recovered)}`);
    assert.ok(!existsSync(r.marker));
    assert.equal(r.show('HEAD:vault/n.md'), 'v2', 'next tick must re-commit the vault change');
    assert.equal(r.status(), '');
  }));

// =========================================================================
// Final-round red-team regressions (EC5 D1..D5). Mirrors the Rust twin's
// `f5_regression_tests` module case for case. Every case fails on a24234e
// except D1 here: the long-path failure was Rust-only (its temp index lived
// under the git dir); this case pins the Node engine to the same semantics.
// =========================================================================

const SCAN_CAP = 64 * 1024 * 1024; // limits.maxScanBytes
const SECRET_BODY = 'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789\naws AKIAABCDEFGHIJKLMNOP\n';
const LFS_POINTER = 'version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 12345\n';

const skippyFilesIn = (dir) => readdirSync(dir).filter((f) => /skippy/.test(f));
const reasonOf = (res, path) => res.skippedDetail?.find((d) => d.path === path)?.reason;

// --- D1: temp index lives in the OS temp dir, not the git dir. -----------

test('F5-D1 a repo at a 190-char root commits and leaves nothing in the git dir', (t) => {
  // The length that matters is the one git sees: the canonical long real
  // path. `tmpdir()` can be an 8.3 alias of it (the GitHub Windows runner's
  // TEMP is `C:\Users\RUNNER~1\...`), which git expands past the budget.
  const base = realpathSync.native(tmpdir());
  const pre = join(base, `skippy-f5-lp-${crypto.randomBytes(4).toString('hex')}-`);
  const need = 190 - pre.length;
  if (need < 8) {
    t.skip(`OS temp dir is too long (${base.length} chars) to build a 190-char repo root`);
    return;
  }
  const dir = pre + 'a'.repeat(need);
  mkdirSync(dir, { recursive: true });
  try {
    const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
    g('init', '-q', '-b', 'main');
    g('config', 'user.name', 'Skippy Test');
    g('config', 'user.email', 'skippy-test@example.invalid');
    g('config', 'commit.gpgsign', 'false');
    g('config', 'core.hooksPath', '.no-hooks');
    g('config', 'core.longpaths', 'false'); // the default; pin it against global config
    write(dir, 'vault/n.md', 'x\n');
    g('add', '.');
    g('commit', '-q', '-m', 'init');
    write(dir, 'vault/n.md', 'y\n');
    const res = runAutocommit(dir);
    assert.equal(res.status, 'committed', JSON.stringify(res));
    assert.equal(g('show', 'HEAD:vault/n.md').trim(), 'y');
    assert.equal(g('status', '--porcelain').trim(), '');
    assert.deepEqual(skippyFilesIn(join(dir, '.git')), [], 'temp files must never be created in the git dir');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- D2 (OQ-19): paths with a `filter` attribute are never autocommitted. -

test('F5-D2 paths behind an LFS-style clean filter are refused as filtered-path, secret or not', () =>
  withRepo((r) => {
    // Simulated git-lfs: the clean filter turns content into a pointer-like
    // hash, so no blob scan could judge what the user wrote.
    r.q('config', 'filter.lfs.clean', 'git hash-object --stdin');
    r.q('config', 'filter.lfs.smudge', 'cat');
    r.q('config', 'filter.lfs.required', 'true');
    r.write('.gitattributes', 'vault/*.txt filter=lfs diff=lfs merge=lfs -text\n');
    r.write('vault/n.md', 'x\n');
    r.commitAll('init');
    r.write('vault/creds.txt', SECRET_BODY);
    r.write('vault/ok.txt', 'harmless payload\n');
    r.write('vault/n.md', 'y\n');
    const res = runAutocommit(r.dir);
    assert.equal(res.status, 'committed');
    const tree = r.headTree();
    assert.ok(!tree.includes('vault/creds.txt'), `filtered secret reached history: ${tree}`);
    assert.ok(!tree.includes('vault/ok.txt'), 'a filtered path must never be autocommitted, even when clean');
    assert.deepEqual(res.skippedDetail, [
      { path: 'vault/creds.txt', reason: 'filtered-path' },
      { path: 'vault/ok.txt', reason: 'filtered-path' },
    ]);
    assert.equal(r.show('HEAD:vault/n.md'), 'y');
    assert.equal(r.status(), '', 'the committed note must be synced to the real index');
  }));

test('F5-D2 a secret behind a reversible (rot13) clean filter is refused as filtered-path', () =>
  withRepo((r) => {
    r.q('config', 'filter.rot.clean', 'tr A-Za-z N-ZA-Mn-za-m');
    r.q('config', 'filter.rot.smudge', 'tr A-Za-z N-ZA-Mn-za-m');
    r.write('.gitattributes', 'vault/*.rot filter=rot\n');
    r.write('vault/n.rot', 'x\n');
    r.commitAll('init');
    r.write('vault/n.rot', 'my aws key AKIAABCDEFGHIJKLMNOP\n');
    r.write('vault/fine.md', 'nothing here\n');
    const res = runAutocommit(r.dir);
    assert.equal(res.status, 'committed');
    assert.deepEqual(res.skippedDetail, [{ path: 'vault/n.rot', reason: 'filtered-path' }]);
    assert.equal(r.show('HEAD:vault/n.rot'), 'k', 'rot13-encoded secret was committed');
    assert.ok(r.headTree().includes('vault/fine.md'));
  }));

test('F5-D2 a secret stored through real git-lfs is not committed', (t) => {
  try {
    execFileSync('git', ['lfs', 'version'], { stdio: 'ignore' });
  } catch {
    t.skip('git-lfs is not installed (the simulated-filter case covers the mechanism)');
    return;
  }
  withRepo((r) => {
    r.q('lfs', 'install', '--local');
    r.write('.gitattributes', 'vault/*.txt filter=lfs diff=lfs merge=lfs -text\n');
    r.write('vault/n.md', 'x\n');
    r.commitAll('init');
    r.write('vault/creds.txt', SECRET_BODY);
    r.write('vault/n.md', 'y\n');
    const res = runAutocommit(r.dir);
    assert.equal(res.status, 'committed');
    assert.deepEqual(res.skippedDetail, [{ path: 'vault/creds.txt', reason: 'filtered-path' }]);
    assert.ok(!r.headTree().includes('vault/creds.txt'));
  });
});

test('F5-D2 diff/text attributes alone never cause an exclusion', () =>
  withRepo((r) => {
    r.write('.gitattributes', 'vault/*.md diff=foo text\n');
    r.write('vault/n.md', 'x\n');
    r.commitAll('init');
    r.write('vault/n.md', 'y\n');
    const res = runAutocommit(r.dir);
    assert.equal(res.status, 'committed');
    assert.deepEqual(res.skipped, []);
  }));

// --- D3: blobs over the scan limit are excluded, never fatal. ------------

test('F5-D3 a blob over the scan limit is skipped and unrelated vault work still commits', () =>
  withRepo((r) => {
    r.write('vault/n.md', 'x\n');
    r.commitAll('init');
    r.write('vault/big.bin', Buffer.alloc(SCAN_CAP + 1, 'the magnificent skippy thinks monkeys are adorable\n'));
    r.write('vault/n.md', 'y\n');
    const res = runAutocommit(r.dir);
    assert.equal(res.status, 'committed');
    assert.ok(!r.headTree().includes('vault/big.bin'), 'unscanned blob was committed');
    assert.deepEqual(res.skipped, ['vault/big.bin']);
    assert.equal(reasonOf(res, 'vault/big.bin'), 'too-large-to-scan');
    assert.equal(r.show('HEAD:vault/n.md'), 'y');
    assert.equal(autocommit.MAX_SCAN_BYTES, SCAN_CAP, 'limits.maxScanBytes must be 64 MiB');
  }));

// --- D4: gitlinks are never added or changed. ----------------------------

function nestedRepo(dir) {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, '-c', 'user.name=x', '-c', 'user.email=x@x', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'x']);
}

// Every skip reason, byte-ordered, same strings as the Rust twin's
// `skipped_detail` (Rust: `tests::skip_reasons_match_the_node_twin`).
test('F5 skip reasons are reported per path, in byte order', () => {
  const repo = makeRepo();
  try {
    const g = repo.git;
    write(repo.dir, '.gitattributes', 'vault/rot/*.md filter=rot\nvault/pid/*.md filter=pid\nvault/*.txt working-tree-encoding=UTF-16LE\n');
    g('config', 'filter.rot.clean', 'tr A-Za-z N-ZA-Mn-za-m');
    g('config', 'filter.rot.smudge', 'tr A-Za-z N-ZA-Mn-za-m');
    // Non-deterministic clean filter (appends its own PID): refused like any
    // other filtered path, never a permanent stall for its neighbours.
    g('config', 'filter.pid.clean', 'cat; echo $$');
    g('config', 'filter.pid.smudge', 'cat');
    write(repo.dir, 'vault/flag.md', 'f1\n');
    write(repo.dir, 'vault/mine.md', 'm1\n');
    write(repo.dir, 'vault/n.md', 'x\n');
    seedInitialCommit(repo); // adds README.md only
    g('add', '-A', '.');
    g('commit', '-q', '-m', 'seed vault');
    g('update-index', '--assume-unchanged', 'vault/flag.md');
    write(repo.dir, 'vault/flag.md', 'f2\n');
    write(repo.dir, 'vault/mine.md', 'm2\n');
    g('add', 'vault/mine.md');
    write(repo.dir, 'vault/.env', 'K=1\n');
    write(repo.dir, 'vault/leak.md', 'AKIAABCDEFGHIJKLMNOP\n');
    write(repo.dir, 'vault/enc.txt', 'aws AKIAABCDEFGHIJKLMNOP ok\n'); // stored as CJK text without the rule
    write(repo.dir, 'vault/rot/leak.md', 'AKIAABCDEFGHIJKLMNOP\n');
    write(repo.dir, 'vault/pid/p.md', 'plain\n');
    write(repo.dir, 'vault/ptr.bin', LFS_POINTER);
    write(repo.dir, 'vault/big.bin', Buffer.alloc(SCAN_CAP + 1, 'the magnificent skippy\n'));
    nestedRepo(join(repo.dir, 'vault', 'sub'));
    write(repo.dir, 'vault/n.md', 'y\n');

    const res = runAutocommit(repo.dir);
    assert.equal(res.status, 'committed');
    const want = [
      ['vault/.env', 'secret-filename'],
      ['vault/big.bin', 'too-large-to-scan'],
      ['vault/enc.txt', 'encoded-path'],
      ['vault/flag.md', 'flagged'],
      ['vault/leak.md', 'secret-content'],
      ['vault/mine.md', 'user-staged'],
      ['vault/pid/p.md', 'filtered-path'],
      ['vault/ptr.bin', 'lfs-pointer'],
      ['vault/rot/leak.md', 'filtered-path'],
      ['vault/sub', 'gitlink'],
    ];
    assert.deepEqual(res.skippedDetail?.map((d) => [d.path, d.reason]), want);
    assert.deepEqual(res.skipped, want.map(([p]) => p));
    const files = g('ls-tree', '-r', '--name-only', 'HEAD').split('\n');
    assert.equal(g('show', 'HEAD:vault/n.md').trim(), 'y');
    for (const [p] of want) if (p !== 'vault/flag.md' && p !== 'vault/mine.md') assert.ok(!files.includes(p), `${p} was committed`);
  } finally {
    cleanup(repo);
  }
});

test('F5-D4 a nested repo inside the vault is not committed as an orphan gitlink', () =>
  withRepo((r) => {
    r.write('a', 'a\n');
    r.commitAll('init');
    nestedRepo(join(r.dir, 'vault', 'cloned'));
    r.write('vault/n.md', 'x\n');
    const res = runAutocommit(r.dir);
    assert.equal(res.status, 'committed');
    assert.deepEqual(res.skipped, ['vault/cloned']);
    assert.equal(reasonOf(res, 'vault/cloned'), 'gitlink');
    assert.ok(!/^160000/m.test(r.ok('ls-tree', '-r', 'HEAD')), 'orphan gitlink committed');
    assert.ok(r.headTree().includes('vault/n.md'));
  }));

test('F5-D4 a vault submodule pointer bump is not autocommitted', () =>
  withRepo((r) => {
    const src = e5Repo();
    try {
      src.write('n.md', 'v1\n');
      src.commitAll('s');
      r.write('a', 'a\n');
      r.commitAll('init');
      r.q('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', src.dir, 'vault');
      r.q('commit', '-q', '-m', 'add vault submodule');
      const before = r.ok('rev-parse', 'HEAD');
      write(r.dir, 'vault/n.md', 'v2\n');
      execFileSync('git', ['-C', join(r.dir, 'vault'), '-c', 'user.name=x', '-c', 'user.email=x@x', '-c', 'commit.gpgsign=false', 'commit', '-q', '-am', 'inner']);
      const res = runAutocommit(r.dir);
      assert.equal(res.status, 'noop');
      assert.deepEqual(res.skipped, ['vault']);
      assert.equal(r.ok('rev-parse', 'HEAD'), before, 'submodule pointer bump was committed');
    } finally {
      cleanup(src);
    }
  }));

test('F5-D4 an existing gitlink in HEAD is kept when its checkout disappears', () =>
  withRepo((r) => {
    r.write('a', 'a\n');
    r.commitAll('init');
    const inner = join(r.dir, 'vault', 'cloned');
    nestedRepo(inner);
    r.q('add', 'vault/cloned');
    r.q('commit', '-q', '-m', 'user adds a gitlink on purpose');
    rmSync(inner, { recursive: true, force: true });
    r.write('vault/n.md', 'x\n');
    const res = runAutocommit(r.dir);
    assert.equal(res.status, 'committed');
    assert.deepEqual(res.skipped, ['vault/cloned']);
    assert.match(r.ok('ls-tree', 'HEAD', 'vault/cloned'), /^160000 commit /, 'gitlink deletion was committed');
  }));

// --- D5: pending-marker hardening. ---------------------------------------

/** c1 (n=A) -> c2 (n=B) -> c3 (n=C); real index n.md reset to `resetTo`'s blob. */
function markerChain(r, resetTo) {
  const shas = {};
  for (const [name, body] of [['c1', 'A\n'], ['c2', 'B\n'], ['c3', 'C\n']]) {
    r.write('vault/n.md', body);
    r.commitAll(name);
    shas[name] = r.ok('rev-parse', 'HEAD');
  }
  r.q('reset', '-q', shas[resetTo], '--', 'vault/n.md');
  return shas;
}

test('F5-D5 a marker with an unknown version is dropped without touching the index', () =>
  withRepo((r) => {
    const { c2, c3 } = markerChain(r, 'c2');
    const before = r.ok('ls-files', '-s');
    writeFileSync(r.marker, JSON.stringify({ version: 99, ref: 'refs/heads/main', new: c3, parent: c2 }));
    const res = runAutocommit(r.dir);
    assert.ok(res.recovered?.dropped, `unknown version must be dropped: ${JSON.stringify(res.recovered)}`);
    assert.ok(!existsSync(r.marker));
    assert.equal(r.ok('ls-files', '-s'), before, 'index was touched by an unknown-version marker');
  }));

test('F5-D5 a v2 marker without a ref is dropped without touching the index', () =>
  withRepo((r) => {
    const { c2, c3 } = markerChain(r, 'c2');
    const before = r.ok('ls-files', '-s');
    writeFileSync(r.marker, JSON.stringify({ version: 2, new: c3, parent: c2 }));
    const res = runAutocommit(r.dir);
    assert.ok(res.recovered?.dropped, JSON.stringify(res.recovered));
    assert.equal(r.ok('ls-files', '-s'), before);
  }));

test('F5-D5 a marker whose parent is not the first parent of new is dropped', () =>
  withRepo((r) => {
    const { c1, c3 } = markerChain(r, 'c1');
    const before = r.ok('ls-files', '-s');
    writeFileSync(r.marker, JSON.stringify({ version: 2, ref: 'refs/heads/main', new: c3, parent: c1 }));
    const res = runAutocommit(r.dir);
    assert.ok(res.recovered?.dropped, `forged parent must be dropped: ${JSON.stringify(res.recovered)}`);
    assert.ok(!existsSync(r.marker));
    assert.equal(r.ok('ls-files', '-s'), before, 'index was synced from a forged parent');
  }));

test('F5-D5 a marker whose parent object is missing never wedges the tick', () =>
  withRepo((r) => {
    r.write('vault/n.md', 'A\n');
    r.commitAll('c1');
    const c1 = r.ok('rev-parse', 'HEAD');
    writeFileSync(r.marker, JSON.stringify({ version: 2, ref: 'refs/heads/main', new: c1, parent: '1'.repeat(40) }));
    r.write('vault/n.md', 'B\n');
    const res = runAutocommit(r.dir);
    assert.ok(res.recovered?.dropped, JSON.stringify(res.recovered));
    assert.equal(res.status, 'committed');
    assert.ok(!existsSync(r.marker), 'bad marker must not survive');
    assert.equal(r.show('HEAD:vault/n.md'), 'B');
  }));

test('F5-D5 a consistent v2 and a consistent legacy (v1) marker are still recovered', () => {
  for (const legacy of [false, true]) {
    withRepo((r) => {
      const { c2, c3 } = markerChain(r, 'c2');
      const m = legacy ? { new: c3, parent: c2 } : { version: 2, ref: 'refs/heads/main', new: c3, parent: c2 };
      writeFileSync(r.marker, JSON.stringify(m));
      const res = runAutocommit(r.dir);
      assert.ok(res.recovered?.synced, `legacy=${legacy}: ${JSON.stringify(res.recovered)}`);
      assert.ok(!existsSync(r.marker));
      assert.equal(r.show(':vault/n.md'), 'C', 'recovery must sync the index to new');
      assert.equal(r.status(), '');
    });
  }
});

// =========================================================================
// EC5 round-4 red-team regressions (D-A filtered symlink entry, D-B/D-G
// mid-tick rewrites, D-F CRLF), restated for the OQ-19 fail-closed rule:
// filtered paths are refused outright, so the scratch-tree proof they once
// exercised is gone. Mirrors the Rust twin's `r4_regression_tests`.
// =========================================================================

const AWS_LINE = 'key = AKIAABCDEFGHIJKLMNOP\n';
const rot13 = (s) => s.replace(/[A-Za-z]/g, (c) => {
  const b = c <= 'Z' ? 65 : 97;
  return String.fromCharCode(((c.charCodeAt(0) - b + 13) % 26) + b);
});

function rotFilter(r) {
  r.q('config', 'filter.rot.clean', 'tr A-Za-z N-ZA-Mn-za-m');
  r.q('config', 'filter.rot.smudge', 'tr A-Za-z N-ZA-Mn-za-m');
}

/** Commit a mode-120000 entry at `path` (target `target`), then check it out
 * as a plain file (core.symlinks=false, the Git for Windows default). */
function symlinkAsFile(r, path, target) {
  r.q('config', 'core.symlinks', 'false');
  const blob = execFileSync('git', ['-C', r.dir, 'hash-object', '-w', '--stdin'], { input: target, encoding: 'utf8' }).trim();
  r.q('update-index', '--add', '--cacheinfo', `120000,${blob},${path}`);
  r.q('commit', '-q', '-m', `symlink ${path}`);
  r.q('checkout', '--', path);
  assert.ok(lstatSync(join(r.dir, path)).isFile(), 'core.symlinks=false must check the link out as a plain file');
  return blob;
}

test('EC5-DA filtered symlink-as-file entries are refused as filtered-path (rot13 clean filter)', () =>
  withRepo((r) => {
    rotFilter(r);
    r.write('.gitattributes', 'vault/*.txt filter=rot\n');
    r.write('vault/n.md', 'x\n');
    r.commitAll('init');
    const before = symlinkAsFile(r, 'vault/link.txt', 'target.md');
    const fineBefore = symlinkAsFile(r, 'vault/fine.txt', 'other.md');
    r.write('vault/link.txt', AWS_LINE);
    r.write('vault/fine.txt', 'harmless new link body\n');
    r.write('vault/n.md', 'y\n');
    const res = runAutocommit(r.dir);
    assert.equal(res.status, 'committed');
    assert.deepEqual(res.skippedDetail, [
      { path: 'vault/fine.txt', reason: 'filtered-path' },
      { path: 'vault/link.txt', reason: 'filtered-path' },
    ]);
    assert.equal(r.ok('ls-tree', 'HEAD', '--', 'vault/link.txt'), `120000 blob ${before}\tvault/link.txt`, 'filtered symlink secret reached history');
    assert.equal(r.ok('ls-tree', 'HEAD', '--', 'vault/fine.txt'), `120000 blob ${fineBefore}\tvault/fine.txt`);
    assert.equal(r.show('HEAD:vault/n.md'), 'y');
  }));

test('EC5-DA an LFS-filtered symlink-as-file entry never reaches history or an LFS pointer', (t) => {
  try {
    execFileSync('git', ['lfs', 'version'], { stdio: 'ignore' });
  } catch {
    t.skip('git-lfs is not installed (the rot13 case covers the mechanism)');
    return;
  }
  withRepo((r) => {
    r.q('lfs', 'install', '--local');
    r.write('.gitattributes', 'vault/*.bin filter=lfs diff=lfs merge=lfs -text\n');
    r.write('vault/n.md', 'x\n');
    r.commitAll('init');
    const before = symlinkAsFile(r, 'vault/link.bin', 'target.bin');
    r.write('vault/link.bin', `bin\0${AWS_LINE}`);
    r.write('vault/n.md', 'y\n');
    const res = runAutocommit(r.dir);
    assert.equal(res.status, 'committed');
    assert.deepEqual(res.skippedDetail, [{ path: 'vault/link.bin', reason: 'filtered-path' }]);
    assert.equal(r.ok('ls-tree', 'HEAD', '--', 'vault/link.bin'), `120000 blob ${before}\tvault/link.bin`);
    assert.ok(!/oid sha256:/.test(r.q('cat-file', '-p', 'HEAD:vault/link.bin')), 'HEAD references an LFS object for the secret');
  });
});

test('EC5-DA an unfiltered symlink-as-file entry (core.symlinks=false) is scanned and still commits when clean', () =>
  withRepo((r) => {
    r.write('vault/n.md', 'x\n');
    r.commitAll('init');
    symlinkAsFile(r, 'vault/a.txt', 'target-a.md');
    symlinkAsFile(r, 'vault/b.txt', 'target-b.md');
    r.write('vault/a.txt', 'new-target.md');
    r.write('vault/b.txt', AWS_LINE);
    const res = runAutocommit(r.dir);
    assert.equal(res.status, 'committed');
    assert.deepEqual(res.skippedDetail, [{ path: 'vault/b.txt', reason: 'secret-content' }]);
    assert.equal(r.q('cat-file', '-p', 'HEAD:vault/a.txt'), 'new-target.md');
    assert.equal(r.q('cat-file', '-p', 'HEAD:vault/b.txt'), 'target-b.md');
    assert.equal(runAutocommit(r.dir).status, 'noop', 'the committed symlink-as-file must be stable');
  }));

test('EC5-DA a filtered real symlink (core.symlinks=true) is refused as filtered-path', (t) => {
  const r = e5Repo();
  try {
    rotFilter(r);
    r.q('config', 'core.symlinks', 'true');
    r.write('.gitattributes', 'vault/*.txt filter=rot\n');
    r.write('vault/n.md', 'x\n');
    r.commitAll('init');
    try {
      symlinkSync('n.md', join(r.dir, 'vault/link.txt'), 'file');
    } catch (e) {
      t.skip(`cannot create a real symlink here (${e.code}); needs Developer Mode on Windows`);
      return;
    }
    r.write('vault/n.md', 'y\n');
    const res = runAutocommit(r.dir);
    assert.equal(res.status, 'committed');
    assert.deepEqual(res.skippedDetail, [{ path: 'vault/link.txt', reason: 'filtered-path' }]);
    assert.ok(!r.headTree().includes('vault/link.txt'));
  } finally {
    cleanup(r);
  }
});

test('EC5-DB bytes written after the add never change what is committed (the scanned blob is the committed blob)', () =>
  withRepo((r) => {
    r.write('vault/s.md', 'v0\n');
    r.commitAll('init');
    const file = join(r.dir, 'vault/s.md');
    writeFileSync(file, 'clean v1\n');
    const phases = [];
    const res = runAutocommit(r.dir, undefined, {
      onPhase: (phase) => {
        phases.push(phase);
        if (phase === 'added') writeFileSync(file, AWS_LINE);
      },
    });
    assert.deepEqual(phases, ['added', 'scanned']);
    assert.equal(res.status, 'committed');
    assert.deepEqual(res.skippedDetail, []);
    assert.equal(r.show('HEAD:vault/s.md'), 'clean v1', 'the staged (scanned) bytes must be what was committed');
    const next = runAutocommit(r.dir);
    assert.deepEqual(next.skippedDetail, [{ path: 'vault/s.md', reason: 'secret-content' }], 'the later key write is caught next tick');
    assert.equal(r.show('HEAD:vault/s.md'), 'clean v1');
  }));

test('EC5-DG a vault .gitattributes flip between add and check-attr defers the tick (attributes-changed)', () =>
  withRepo((r) => {
    rotFilter(r);
    r.write('vault/.gitattributes', '*.txt filter=rot\n');
    r.write('vault/n.md', 'x\n');
    r.commitAll('init');
    r.write('vault/s.txt', AWS_LINE); // `add` cleans this through rot13
    const res = runAutocommit(r.dir, undefined, {
      onPhase: (phase) => {
        if (phase === 'added') r.write('vault/.gitattributes', '# filter removed\n'); // check-attr now says "no filter"
      },
    });
    assert.equal(res.status, 'noop');
    assert.ok(!r.headTree().includes('vault/s.txt'), 'rot13 secret reached history via an attribute flip');
    assert.deepEqual(res.skippedDetail, [{ path: 'vault/s.txt', reason: 'attributes-changed' }]);
    // Next tick: attributes are stable (no filter), so the raw key is scanned;
    // the edited .gitattributes is never autocommitted (attributes-file).
    const next = runAutocommit(r.dir);
    assert.equal(next.status, 'noop');
    assert.deepEqual(next.skippedDetail, [
      { path: 'vault/.gitattributes', reason: 'attributes-file' },
      { path: 'vault/s.txt', reason: 'secret-content' },
    ]);
    assert.equal(r.show('HEAD:vault/.gitattributes'), '*.txt filter=rot');
    assert.ok(!r.headTree().includes('vault/s.txt'));
  }));

test('EC5-DG an unfiltered note rewritten mid-tick commits the staged bytes, then the rewrite on the next tick', () =>
  withRepo((r) => {
    r.write('vault/n.md', 'v0\n');
    r.commitAll('init');
    r.write('vault/n.md', 'v1\n');
    const res = runAutocommit(r.dir, undefined, {
      onPhase: (phase) => {
        if (phase === 'added') r.write('vault/n.md', 'v2\n');
      },
    });
    assert.equal(res.status, 'committed');
    assert.deepEqual(res.skippedDetail, []);
    assert.equal(r.show('HEAD:vault/n.md'), 'v1');
    assert.equal(runAutocommit(r.dir).status, 'committed');
    assert.equal(r.show('HEAD:vault/n.md'), 'v2');
    assert.equal(r.status(), '');
  }));

test('EC5-DF an unchanged CRLF file under core.autocrlf=true commits on the first tick', () =>
  withRepo((r) => {
    r.q('config', 'core.autocrlf', 'false');
    r.write('vault/n.md', 'line1\r\nline2\r\n');
    r.commitAll('init'); // HEAD blob keeps its CRLFs
    r.q('config', 'core.autocrlf', 'true');
    r.write('vault/n.md', 'line1\r\nline2\r\nline3\r\n');
    const res = runAutocommit(r.dir);
    assert.deepEqual(res.skippedDetail, []);
    assert.equal(res.status, 'committed');
    assert.equal(r.q('cat-file', '-p', 'HEAD:vault/n.md'), 'line1\r\nline2\r\nline3\r\n', 'blob must match what `git add` stores');
    assert.equal(r.status(), '');
    assert.equal(runAutocommit(r.dir).status, 'noop');
  }));

// =========================================================================
// EC5 round-5 (OQ-19 fail-closed rule): every red-team repro from round 4's
// re-verification. Mirrors the Rust twin's `r5_regression_tests` case for
// case. R5-1 and R5-3 leak / fail on b3e9af0.
// =========================================================================

const hasGitLfs = () => {
  try {
    execFileSync('git', ['lfs', 'version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

test('EC5-R5-1 LFS pointer passthrough: a secret excluded by one tick never reaches HEAD or a file:// remote through its pointer', (t) => {
  if (!hasGitLfs()) {
    t.skip('git-lfs is not installed');
    return;
  }
  withRepo((r) => {
    r.q('config', '--unset', 'core.hooksPath'); // the LFS pre-push hook must run
    r.q('lfs', 'install', '--local');
    r.write('.gitattributes', 'vault/*.bin filter=lfs diff=lfs merge=lfs -text\n');
    r.write('vault/n.md', 'x\n');
    r.commitAll('init');
    const secret = Buffer.from(AWS_LINE);
    const sha = crypto.createHash('sha256').update(secret).digest('hex');
    const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${sha}\nsize ${secret.length}\n`;
    r.write('vault/k.bin', secret);
    const t1 = runAutocommit(r.dir);
    // The user (or a tool) swaps the file for its pointer; the same pointer
    // also lands at a path no filter attribute covers.
    r.write('vault/k.bin', pointer);
    r.write('vault/p.txt', pointer);
    r.write('vault/n.md', 'y\n');
    const t2 = runAutocommit(r.dir);
    const bare = mkdtempSync(join(tmpdir(), 'skippy-r5-remote-'));
    try {
      execFileSync('git', ['init', '-q', '--bare', bare]);
      r.q('remote', 'add', 'origin', pathToFileURL(bare).href);
      r.q('push', '-q', 'origin', 'main');
      const lfsObj = join(bare, 'lfs', 'objects', sha.slice(0, 2), sha.slice(2, 4), sha);
      assert.ok(!existsSync(lfsObj), 'git push uploaded the secret LFS object to the remote');
      const remoteTree = execFileSync('git', ['-C', bare, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' });
      assert.equal(remoteTree.trim(), '.gitattributes\nvault/n.md');
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
    assert.deepEqual(r.headTree(), ['.gitattributes', 'vault/n.md']);
    assert.ok(!r.q('log', '-p', '--all').includes(sha), 'history references the secret LFS object');
    assert.deepEqual(t1.skippedDetail, [{ path: 'vault/k.bin', reason: 'filtered-path' }]);
    assert.equal(t2.status, 'committed');
    assert.deepEqual(t2.skippedDetail, [
      { path: 'vault/k.bin', reason: 'filtered-path' },
      { path: 'vault/p.txt', reason: 'lfs-pointer' },
    ]);
  });
});

test('EC5-R5-2 LFS pointer text without any filter attribute is refused as lfs-pointer (every v1 spec alias)', () =>
  withRepo((r) => {
    r.write('vault/n.md', 'x\n');
    r.commitAll('init');
    const oid = 'oid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 12\n';
    r.write('vault/a.md', `version https://git-lfs.github.com/spec/v1\n${oid}`);
    r.write('vault/b.md', `\r\n  version https://hawser.github.com/spec/v1\r\n${oid}`);
    r.write('vault/c.md', `version http://git-media.io/v/2\n${oid}`);
    r.write('vault/d.md', 'The magnificent Skippy keeps the monkeys\' photos in git-lfs (spec: https://git-lfs.github.com/spec/v1).\n');
    const res = runAutocommit(r.dir);
    assert.equal(res.status, 'committed');
    assert.deepEqual(res.skippedDetail, [
      { path: 'vault/a.md', reason: 'lfs-pointer' },
      { path: 'vault/b.md', reason: 'lfs-pointer' },
      { path: 'vault/c.md', reason: 'lfs-pointer' },
    ]);
    assert.deepEqual(r.headTree(), ['vault/d.md', 'vault/n.md']);
  }));

test('EC5-R5-3 an attribute flip between add and the scan defers the tick; the filtered blob never reaches history', () =>
  withRepo((r) => {
    // The red-team repro: a filter active during `add` (here from the local,
    // never-committed info/attributes) is switched off right after it, and the
    // file is rewritten to what the filter produced, so every later look
    // (check-attr, the working tree) says "plain, clean file".
    rotFilter(r);
    r.q('config', 'core.autocrlf', 'false');
    const info = join(r.dir, '.git', 'info', 'attributes');
    mkdirSync(dirname(info), { recursive: true });
    writeFileSync(info, 'vault/*.txt filter=rot\n');
    r.write('vault/n.md', 'x\n');
    r.commitAll('init');
    r.write('vault/s.txt', AWS_LINE); // `add` cleans this into rot13(AWS_LINE)
    r.write('vault/n.md', 'y\n');
    const res = runAutocommit(r.dir, undefined, {
      onPhase: (phase) => {
        if (phase === 'added') {
          writeFileSync(info, '# no filter\n');
          r.write('vault/s.txt', rot13(AWS_LINE));
        }
      },
    });
    assert.ok(!r.headTree().includes('vault/s.txt'), 'the rot13-filtered secret blob reached history');
    assert.equal(res.status, 'noop');
    assert.deepEqual(res.skippedDetail, [
      { path: 'vault/n.md', reason: 'attributes-changed' },
      { path: 'vault/s.txt', reason: 'attributes-changed' },
    ]);
    assert.equal(r.show('HEAD:vault/n.md'), 'x');
    // A flip after both check-attr runs (the 'scanned' phase) defers too.
    writeFileSync(info, 'vault/*.txt filter=rot\n');
    const late = runAutocommit(r.dir, undefined, {
      onPhase: (phase) => {
        if (phase === 'scanned') writeFileSync(info, '# no filter\n');
      },
    });
    assert.equal(late.status, 'noop');
    assert.deepEqual(late.skippedDetail.map((d) => d.reason), ['attributes-changed', 'attributes-changed']);
    // Stable attributes again: the note commits; s.txt holds exactly the
    // (non-secret) bytes the user wrote, and no attribute decodes it.
    const next = runAutocommit(r.dir);
    assert.equal(next.status, 'committed');
    assert.deepEqual(next.skippedDetail, []);
    assert.equal(r.show('HEAD:vault/n.md'), 'y');
    assert.equal(r.q('cat-file', '-p', 'HEAD:vault/s.txt'), rot13(AWS_LINE));
  }));

test('EC5-R5-3 a deleted .gitattributes still applied through the index during add is refused by the pre-add evaluation', () =>
  withRepo((r) => {
    rotFilter(r);
    r.q('config', 'core.autocrlf', 'false');
    r.write('vault/sub/.gitattributes', '*.txt filter=rot\n');
    r.write('vault/sub/s.txt', 'v0\n');
    r.commitAll('init');
    rmSync(join(r.dir, 'vault/sub/.gitattributes'));
    r.write('vault/sub/s.txt', 'clean v1\n');
    const res = runAutocommit(r.dir);
    assert.equal(res.status, 'noop');
    assert.deepEqual(res.skippedDetail, [
      { path: 'vault/sub/.gitattributes', reason: 'attributes-file' },
      { path: 'vault/sub/s.txt', reason: 'filtered-path' },
    ]);
    assert.ok(r.headTree().includes('vault/sub/.gitattributes'), 'autocommit must never commit a .gitattributes deletion');
    // The user commits the deletion deliberately; then the note commits.
    r.q('add', '--', 'vault/sub/.gitattributes');
    r.q('commit', '-q', '-m', 'drop the rule');
    const next = runAutocommit(r.dir);
    assert.equal(next.status, 'committed');
    assert.deepEqual(next.skippedDetail, []);
    assert.equal(r.q('cat-file', '-p', 'HEAD:vault/sub/s.txt'), 'clean v1\n');
    assert.equal(r.status(), '');
  }));

test('EC5-R5-4 a .gitignore negation of an info/exclude or core.excludesFile rule never stalls unrelated notes', () => {
  withRepo((r) => {
    r.write('vault/.gitignore', '!keep.log\n');
    r.write('vault/a.md', 'a\n');
    r.commitAll('init');
    writeFileSync(join(r.dir, '.git', 'info', 'exclude'), '*.log\n');
    r.write('vault/keep.log', 'log line\n');
    r.write('vault/a.md', 'a2\n');
    r.write('vault/b.md', 'b\n');
    const res = runAutocommit(r.dir);
    assert.equal(res.status, 'committed');
    assert.deepEqual(res.skippedDetail, []);
    assert.deepEqual(r.headTree(), ['vault/.gitignore', 'vault/a.md', 'vault/b.md', 'vault/keep.log']);
    assert.equal(runAutocommit(r.dir).status, 'noop');
  });
  withRepo((r) => {
    const excludes = join(r.dir, '.git', 'global-excludes');
    writeFileSync(excludes, '*.tmp\n');
    r.q('config', 'core.excludesFile', excludes);
    r.write('.gitignore', '!vault/keep.tmp\n');
    r.write('vault/a.md', 'a\n');
    r.commitAll('init');
    r.write('vault/keep.tmp', 'x\n');
    r.write('vault/n.md', 'n\n');
    const res = runAutocommit(r.dir);
    assert.equal(res.status, 'committed');
    assert.deepEqual(res.skippedDetail, []);
    assert.deepEqual(r.headTree(), ['.gitignore', 'vault/a.md', 'vault/keep.tmp', 'vault/n.md']);
  });
});

test('EC5-R5-5 relative and non-deterministic filters are filtered-path for their own paths only; the rest commits', () =>
  withRepo((r) => {
    r.q('config', 'filter.rel.clean', 'sh tools/clean.sh');
    r.q('config', 'filter.rel.smudge', 'cat');
    r.q('config', 'filter.rel.required', 'true');
    r.q('config', 'filter.relopt.clean', 'sh tools/clean.sh');
    r.q('config', 'filter.nd.clean', 'cat; echo $$');
    r.q('config', 'filter.nd.smudge', 'cat');
    r.write('tools/clean.sh', 'tr a-z A-Z\n');
    r.write('.gitattributes', 'vault/*.up filter=rel\nvault/*.opt filter=relopt\nvault/*.nd filter=nd\n');
    r.write('vault/a.md', 'a\n');
    r.commitAll('init');
    r.write('vault/x.up', 'hello\n');
    r.write('vault/y.opt', 'hello\n');
    r.write('vault/z.nd', 'data\n');
    r.write('vault/note.md', 'plain note\n');
    const want = [
      { path: 'vault/x.up', reason: 'filtered-path' },
      { path: 'vault/y.opt', reason: 'filtered-path' },
      { path: 'vault/z.nd', reason: 'filtered-path' },
    ];
    const res = runAutocommit(r.dir);
    assert.equal(res.status, 'committed');
    assert.deepEqual(res.skippedDetail, want);
    assert.equal(r.show('HEAD:vault/note.md'), 'plain note');
    const again = runAutocommit(r.dir);
    assert.equal(again.status, 'noop');
    assert.deepEqual(again.skippedDetail, want);
  }));

test('EC5-R5-6 a sparse checkout never fails the tick: in-cone notes commit, out-of-cone paths are flagged', () =>
  withRepo((r) => {
    r.write('vault/a/1.md', '1\n');
    r.write('vault/b/2.md', '2\n');
    r.write('vault/c.md', 'c\n');
    r.commitAll('init');
    r.q('sparse-checkout', 'set', 'vault/a');
    assert.ok(!existsSync(join(r.dir, 'vault/b/2.md')), 'vault/b must be outside the cone');
    r.write('vault/a/1.md', '1b\n');
    r.write('vault/a/n2.md', 'new in cone\n');
    r.write('vault/c.md', 'c2\n');
    r.write('vault/b/new.md', 'new outside the cone\n');
    const want = [
      { path: 'vault/b/2.md', reason: 'flagged' },
      { path: 'vault/b/new.md', reason: 'flagged' },
    ];
    const res = runAutocommit(r.dir);
    assert.equal(res.status, 'committed');
    assert.deepEqual(res.skippedDetail, want);
    assert.deepEqual(r.headTree(), ['vault/a/1.md', 'vault/a/n2.md', 'vault/b/2.md', 'vault/c.md']);
    assert.equal(r.show('HEAD:vault/a/1.md'), '1b');
    assert.match(r.ok('ls-files', '-v', '--', 'vault/b/2.md'), /^S /, 'the skip-worktree flag must survive');
    const again = runAutocommit(r.dir);
    assert.equal(again.status, 'noop');
    assert.deepEqual(again.skippedDetail, want);
  }));

test('EC5-R5-7 stale skippy-ac temp dirs are swept (exact name, real dirs, never through a junction); a tick writes no vault content to temp', (t) => {
  const tmp = tmpdir();
  const hex = () => crypto.randomBytes(8).toString('hex');
  const stale = join(tmp, `skippy-ac-${hex()}`);
  const fresh = join(tmp, `skippy-ac-${hex()}`);
  const odd = join(tmp, `skippy-ac-${hex()}-x`);
  const link = join(tmp, `skippy-ac-${hex()}`);
  const target = mkdtempSync(join(tmp, 'skippy-r5-target-'));
  const old = new Date(Date.now() - 2 * autocommit.STALE_TEMP_DIR_MS);
  try {
    for (const d of [stale, fresh, odd]) {
      mkdirSync(join(d, 'wt', 'vault'), { recursive: true });
      writeFileSync(join(d, 'wt', 'vault', 'a.md'), 'private journal entry\n');
    }
    writeFileSync(join(target, 'keep.md'), 'not ours\n');
    let haveLink = true;
    try {
      symlinkSync(target, link, 'junction');
    } catch {
      haveLink = false;
    }
    for (const d of [stale, odd]) utimesSync(d, old, old);
    const before = new Set(readdirSync(tmp).filter((n) => n.startsWith('skippy-ac-')));
    const seen = [];
    withRepo((r) => {
      r.write('vault/a.md', 'a\n');
      r.commitAll('init');
      r.write('vault/a.md', 'private journal entry, edited\n');
      const res = runAutocommit(r.dir, undefined, {
        onPhase: () => {
          for (const n of readdirSync(tmp).filter((x) => x.startsWith('skippy-ac-') && !before.has(x))) {
            for (const e of readdirSync(join(tmp, n), { withFileTypes: true })) seen.push(`${e.isDirectory() ? 'dir' : 'file'}:${e.name}`);
          }
        },
      });
      assert.equal(res.status, 'committed');
    });
    assert.ok(!existsSync(stale), 'a stale skippy-ac dir must be swept');
    assert.ok(existsSync(fresh), 'a fresh skippy-ac dir (a live tick) must be kept');
    assert.ok(existsSync(odd), 'a dir that only resembles the name must be kept');
    if (haveLink) {
      assert.ok(lstatSync(link).isSymbolicLink(), 'a junction named like a temp dir must not be removed');
      assert.ok(existsSync(join(target, 'keep.md')), 'the sweep must never follow a junction');
    } else {
      t.diagnostic('junction creation unavailable; junction sub-case not exercised');
    }
    assert.ok(seen.includes('file:seed-index'), 'the tick must have created its own temp dir');
    // Another process's tick may run concurrently (its dir can show the sync
    // step's pathspec file or a transient index.lock): same invariant as the
    // Rust twin — index/pathspec files only, never a directory or content.
    const allowed = new Set(['file:index', 'file:seed-index', 'file:pathspec', 'file:index.lock']);
    assert.deepEqual(seen.filter((s) => !allowed.has(s)), [], 'only index/pathspec files may live in a tick\'s temp dir');
  } finally {
    for (const d of [stale, fresh, odd, target]) rmSync(d, { recursive: true, force: true });
    try {
      rmSync(link, { force: true });
    } catch {
      /* already gone */
    }
  }
});

// =========================================================================
// M0-G12 / M0-G15 (OQ-19): a `working-tree-encoding` is a clean filter in all
// but name. Mirrors the Rust twin's `g12_regression_tests` case for case.
// The smuggling and stall cases leak / fail on 10f6654. Fixtures live on the
// canonical long temp path (the Windows runner's TEMP is an 8.3 alias).
// =========================================================================

const G12_KEY = 'aws AKIAABCDEFGHIJKLMNOP ok\n'; // 26 bytes: an even count

function g12Repo() {
  const dir = mkdtempSync(join(realpathSync.native(tmpdir()), 'skippy-g12-'));
  const q = (...args) => execFileSync('git', ['-C', dir, '-c', 'core.quotepath=false', ...args], { encoding: 'utf8', stdio: 'pipe' });
  q('init', '-q', '-b', 'main');
  q('config', 'user.name', 'Skippy Test');
  q('config', 'user.email', 'skippy-test@example.invalid');
  q('config', 'commit.gpgsign', 'false');
  q('config', 'core.hooksPath', '.no-hooks');
  return {
    dir,
    q,
    write: (rel, contents) => write(dir, rel, contents),
    commitAll: (msg) => {
      q('add', '-A', '.');
      q('commit', '-q', '-m', msg);
    },
    headTree: () => q('ls-tree', '-r', '-z', '--name-only', 'HEAD').split('\0').filter(Boolean),
    show: (spec) => q('show', spec).trim(),
    status: () => q('status', '--porcelain', '-uno').trim(),
  };
}

function withG12Repo(fn) {
  const r = g12Repo();
  try {
    fn(r);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
}

/** Every file of a checkout (skipping .git), as latin1 text. */
function checkoutText(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...checkoutText(p));
    else out.push(readFileSync(p).toString('latin1'));
  }
  return out;
}

for (const enc of ['UTF-16LE', 'UTF-16BE']) {
  test(`M0-G12 an ASCII secret declared ${enc} is refused as encoded-path; it never reaches HEAD or a fresh clone`, () =>
    withG12Repo((r) => {
      r.write('vault/n.md', 'x\n');
      r.commitAll('init');
      r.write('vault/.gitattributes', `*.txt working-tree-encoding=${enc}\n`);
      r.write('vault/note.txt', G12_KEY); // git would store it as CJK text: no AKIA, no NUL
      r.write('vault/n.md', 'y\n');
      const res = runAutocommit(r.dir);
      // The leak itself first: a fresh clone (file://, reachable objects only).
      const clone = mkdtempSync(join(realpathSync.native(tmpdir()), 'skippy-g12-clone-'));
      try {
        execFileSync('git', ['clone', '-q', pathToFileURL(r.dir).href, join(clone, 'c')], { stdio: 'pipe' });
        assert.ok(!checkoutText(join(clone, 'c')).some((t) => t.includes('AKIA')), 'a fresh clone checks the secret out');
        const objects = execFileSync('git', ['-C', join(clone, 'c'), 'rev-list', '--objects', '--all'], { encoding: 'utf8' });
        assert.ok(!objects.includes('vault/note.txt'), 'history of a fresh clone names the encoded note');
      } finally {
        rmSync(clone, { recursive: true, force: true });
      }
      assert.throws(() => r.q('cat-file', '--filters', 'HEAD:vault/note.txt'), 'the encoded note reached HEAD');
      const want = [
        { path: 'vault/.gitattributes', reason: 'attributes-file' },
        { path: 'vault/note.txt', reason: 'encoded-path' },
      ];
      assert.deepEqual(res.skippedDetail, want);
      assert.equal(res.status, 'committed');
      assert.deepEqual(r.headTree(), ['vault/n.md']);
      assert.equal(r.show('HEAD:vault/n.md'), 'y', 'an unrelated note must still commit');
      const again = runAutocommit(r.dir);
      assert.equal(again.status, 'noop');
      assert.deepEqual(again.skippedDetail, want);
    }));
}

test('M0-G15 an unconvertible working-tree-encoding (UTF-32, valueless) or a failing required filter excludes only its own paths; other notes still commit', () =>
  withG12Repo((r) => {
    r.q('config', 'core.autocrlf', 'false');
    r.q('config', 'filter.bad.clean', 'exit 1');
    r.q('config', 'filter.bad.smudge', 'cat');
    r.q('config', 'filter.bad.required', 'true');
    r.write('vault/n.md', 'x\n');
    r.write('vault/gone.md', 'bye\n');
    r.write('vault/old.u32', 'abc\n'); // committed before any rule: unchanged, now unconvertible
    r.commitAll('init');
    const oldBlob = r.q('rev-parse', 'HEAD:vault/old.u32').trim();
    r.write(
      'vault/.gitattributes',
      [
        '*.u32 working-tree-encoding=UTF-32', // BOM required: git dies on the add
        '*.le working-tree-encoding=UTF-32LE', // 6 bytes: not a UTF-32 sequence
        '*.set working-tree-encoding', // valueless: git dies ("true/false ...")
        '*.off -working-tree-encoding', // unset: no conversion at all
        '*.bad filter=bad',
        '',
      ].join('\n'),
    );
    r.write('vault/a.u32', 'abc\n');
    r.write('vault/b.le', 'abcde\n');
    r.write('vault/c.set', 'plain\n');
    r.write('vault/d.off', 'plain note under an unset rule\n');
    r.write('vault/e.bad', 'clean filter fails\n');
    r.write('vault/n.md', 'y\n');
    r.write('vault/new.md', 'the magnificent Skippy approves\n');
    rmSync(join(r.dir, 'vault/gone.md'));
    const want = [
      { path: 'vault/.gitattributes', reason: 'attributes-file' },
      { path: 'vault/a.u32', reason: 'encoded-path' },
      { path: 'vault/b.le', reason: 'encoded-path' },
      { path: 'vault/c.set', reason: 'encoded-path' },
      { path: 'vault/e.bad', reason: 'filtered-path' },
      { path: 'vault/old.u32', reason: 'encoded-path' },
    ];
    const res = runAutocommit(r.dir);
    assert.equal(res.status, 'committed');
    assert.deepEqual(res.skippedDetail, want);
    assert.deepEqual(r.headTree(), ['vault/d.off', 'vault/n.md', 'vault/new.md', 'vault/old.u32']);
    assert.equal(r.show('HEAD:vault/n.md'), 'y');
    assert.equal(r.q('rev-parse', 'HEAD:vault/old.u32').trim(), oldBlob, 'the unconvertible tracked note must be left as HEAD has it');
    const again = runAutocommit(r.dir);
    assert.equal(again.status, 'noop');
    assert.deepEqual(again.skippedDetail, want);
  }));

test('M0-G15 a sparse checkout plus an unconvertible encoding: in-cone notes commit, out-of-cone paths stay flagged', () =>
  withG12Repo((r) => {
    r.write('vault/a/1.md', '1\n');
    r.write('vault/b/2.md', '2\n');
    r.commitAll('init');
    r.q('sparse-checkout', 'set', 'vault/a');
    r.write('vault/a/.gitattributes', '*.u32 working-tree-encoding=UTF-32\n');
    r.write('vault/a/[x].u32', 'abc\n'); // glob-like name: excluded literally
    r.write('vault/a/x.md', 'x\n');
    r.write('vault/a/1.md', '1b\n');
    r.write('vault/b/new.md', 'new outside the cone\n');
    const want = [
      { path: 'vault/a/.gitattributes', reason: 'attributes-file' },
      { path: 'vault/a/[x].u32', reason: 'encoded-path' },
      { path: 'vault/b/2.md', reason: 'flagged' },
      { path: 'vault/b/new.md', reason: 'flagged' },
    ];
    const res = runAutocommit(r.dir);
    assert.equal(res.status, 'committed');
    assert.deepEqual(res.skippedDetail, want);
    assert.deepEqual(r.headTree(), ['vault/a/1.md', 'vault/a/x.md', 'vault/b/2.md']);
    assert.equal(r.show('HEAD:vault/a/1.md'), '1b');
    const again = runAutocommit(r.dir);
    assert.equal(again.status, 'noop');
    assert.deepEqual(again.skippedDetail, want);
  }));

test('M0-G12 a legitimate working-tree-encoding rule on a genuinely UTF-16 note is refused too (fail closed); unrelated notes commit', () =>
  withG12Repo((r) => {
    r.write('vault/n.md', 'x\n');
    r.commitAll('init');
    r.write('vault/.gitattributes', '*.u16 working-tree-encoding=UTF-16\n*.txt working-tree-encoding=UTF-16LE\n*.md8 working-tree-encoding=UTF-8\n');
    r.write('vault/bom.u16', utf16leWithBom('The magnificent Skippy, in UTF-16 with a BOM\n'));
    r.write('vault/le.txt', Buffer.from('Monkeys write UTF-16LE without a BOM\n', 'utf16le'));
    r.write('vault/same.md8', 'declared UTF-8: a no-op for git, refused all the same\n');
    r.write('vault/n.md', 'y\n');
    const res = runAutocommit(r.dir);
    assert.equal(res.status, 'committed');
    assert.deepEqual(res.skippedDetail, [
      { path: 'vault/.gitattributes', reason: 'attributes-file' },
      { path: 'vault/bom.u16', reason: 'encoded-path' },
      { path: 'vault/le.txt', reason: 'encoded-path' },
      { path: 'vault/same.md8', reason: 'encoded-path' },
    ]);
    assert.deepEqual(r.headTree(), ['vault/n.md']);
    assert.equal(r.show('HEAD:vault/n.md'), 'y');
    assert.equal(r.status(), '');
  }));

test('M0-G12 a path with both a filter and a working-tree-encoding is filtered-path; notes without either are unaffected', () =>
  withG12Repo((r) => {
    r.q('config', 'filter.rot.clean', 'tr A-Za-z N-ZA-Mn-za-m');
    r.q('config', 'filter.rot.smudge', 'tr A-Za-z N-ZA-Mn-za-m');
    r.write('vault/n.md', 'x\n');
    r.commitAll('init');
    r.write('vault/.gitattributes', '*.both filter=rot working-tree-encoding=UTF-16LE\n*.enc working-tree-encoding=UTF-16LE\n');
    r.write('vault/x.both', G12_KEY);
    r.write('vault/y.enc', G12_KEY);
    r.write('vault/z.md', 'plain\n');
    const res = runAutocommit(r.dir);
    assert.equal(res.status, 'committed');
    assert.deepEqual(res.skippedDetail, [
      { path: 'vault/.gitattributes', reason: 'attributes-file' },
      { path: 'vault/x.both', reason: 'filtered-path' },
      { path: 'vault/y.enc', reason: 'encoded-path' },
    ]);
    assert.deepEqual(r.headTree(), ['vault/n.md', 'vault/z.md']);
  }));

test('M0-G12 audit: text/eol/ident are not excluded; the checkout differs from the scanned blob only by CRs before LFs and the $Id$ expansion', () =>
  withG12Repo((r) => {
    r.q('config', 'core.autocrlf', 'false');
    r.write('vault/.gitattributes', '*.md text eol=crlf ident\n');
    r.write('vault/n.md', 'x\r\n');
    r.commitAll('init');
    r.write('vault/n.md', 'id $Id: dropped on add $\r\nline two\r\n');
    const res = runAutocommit(r.dir);
    assert.equal(res.status, 'committed');
    assert.deepEqual(res.skippedDetail, []);
    const blob = r.q('cat-file', '-p', 'HEAD:vault/n.md');
    assert.equal(blob, 'id $Id$\nline two\n', 'add drops the CRs and collapses $Id: ...$');
    const oid = r.q('rev-parse', 'HEAD:vault/n.md').trim();
    assert.equal(r.q('cat-file', '--filters', 'HEAD:vault/n.md'), `id $Id: ${oid} $\r\nline two\r\n`);
  }));

// =========================================================================
// M0-G12 residuals / M0-G13 (OQ-19): autocommit never adds, modifies or
// deletes a `.gitattributes` (`attributes-file`), so an encoding / filter
// rule only enters history through a deliberate user commit; the attribute
// snapshot sees case variants, a relative core.attributesFile, attr.tree and
// directories holding a bogus `.git`. Mirrors the Rust twin's
// `g12_residual_tests` case for case. The D1 case leaks on 2e9f778.
// =========================================================================

/** UTF-8 text git would store for the ASCII key declared UTF-16LE. */
const G12_CJK = Buffer.from(Buffer.from(G12_KEY, 'latin1').toString('utf16le'), 'utf8');
const G12_RESIDUAL_TICKS = Number(process.env.SKIPPY_G12_TICKS ?? 100);
const G13_TOGGLER_TICKS = Number(process.env.SKIPPY_G13_TICKS ?? 30);

/** Clone `dir` over file:// and return every checked-out file (latin1), plus k.txt's exact bytes. */
function cloneCheckout(dir, keyPath) {
  const clone = mkdtempSync(join(realpathSync.native(tmpdir()), 'skippy-g12-clone-'));
  try {
    execFileSync('git', ['-c', 'core.autocrlf=false', 'clone', '-q', pathToFileURL(dir).href, join(clone, 'c')], { stdio: 'pipe' });
    const key = keyPath && existsSync(join(clone, 'c', keyPath)) ? readFileSync(join(clone, 'c', keyPath)) : null;
    return { files: checkoutText(join(clone, 'c')), key };
  } finally {
    rmSync(clone, { recursive: true, force: true });
  }
}

/** Every path any commit reachable from HEAD ever named. */
const historyPaths = (r) => r.q('log', '--format=', '--name-only', 'HEAD').split('\n').filter(Boolean);

test('M0-G12 predicate: every name git treats as .gitattributes (any case, NTFS trailing dots/spaces/streams, 8.3 short names) and nothing else', () => {
  const yes = ['.gitattributes', '.GitAttributes', '.GITATTRIBUTES', '.gitattributes.', '.gitattributes . ', '.gitattributes:$DATA', 'gitatt~1', 'GITATT~4', 'gi7d29~1', 'GI7D2~12', 'gitatt~2. '];
  const no = ['gitattributes', '.gitattribute', '.gitattributesx', 'x.gitattributes', '.gitignore', 'gitatt~5', 'gitatt~1x', 'gi7d29~0', 'gi7d29~', '.gitattributes.md', ''];
  for (const n of yes) assert.equal(autocommit.isAttributesFileName(n), true, n);
  for (const n of no) assert.equal(autocommit.isAttributesFileName(n), false, n);
});

test('M0-G12 D1: a pre-encoded note plus a later encoding rule: the .gitattributes is attributes-file, never in history, and a clone checks out the stored bytes', () =>
  withG12Repo((r) => {
    r.q('config', 'core.autocrlf', 'false');
    r.write('vault/n.md', 'x\n');
    r.commitAll('init');
    r.write('vault/k.txt', G12_CJK); // plain UTF-8 CJK text: no AKIA, no NUL
    const t1 = runAutocommit(r.dir);
    assert.equal(t1.status, 'committed');
    assert.deepEqual(t1.skippedDetail, []);
    r.write('vault/.gitattributes', '*.txt working-tree-encoding=UTF-16LE\n');
    r.write('vault/n.md', 'y\n');
    const want = [
      { path: 'vault/.gitattributes', reason: 'attributes-file' },
      { path: 'vault/k.txt', reason: 'encoded-path' },
    ];
    const t2 = runAutocommit(r.dir);
    const t3 = runAutocommit(r.dir);
    // The leak itself first: a fresh clone (file://, reachable objects only).
    const { files, key } = cloneCheckout(r.dir, 'vault/k.txt');
    assert.ok(!files.some((t) => t.includes('AKIA')), 'a fresh clone decodes the stored CJK text into the plaintext key');
    assert.deepEqual(key, G12_CJK, 'a clone must check out exactly the stored bytes');
    assert.deepEqual(t2.skippedDetail, want);
    assert.equal(t2.status, 'committed', 'the unrelated note still commits');
    assert.equal(t3.status, 'noop');
    assert.deepEqual(t3.skippedDetail, want);
    assert.deepEqual(r.headTree(), ['vault/k.txt', 'vault/n.md']);
    assert.ok(!historyPaths(r).includes('vault/.gitattributes'), 'the .gitattributes reached history');
    assert.equal(r.show('HEAD:vault/n.md'), 'y');
  }));

test('M0-G12 attributes-file: case variants, edits and deletions of an attributes file are never autocommitted; HEAD keeps the user-committed rule', () =>
  withG12Repo((r) => {
    r.q('config', 'core.autocrlf', 'false');
    r.write('vault/.gitattributes', '*.txt working-tree-encoding=UTF-16LE\n');
    r.write('vault/old/.gitattributes', '*.md text\n');
    r.write('vault/n.md', 'x\n');
    r.commitAll('init'); // the user commits the rule deliberately
    const rule = r.show('HEAD:vault/.gitattributes');
    r.write('vault/sub/.GitAttributes', '*.txt filter=rot\n');
    r.write('vault/.gitattributes', '# rule dropped in the working tree\n');
    rmSync(join(r.dir, 'vault/old/.gitattributes'));
    r.write('vault/k.txt', G12_KEY);
    r.write('vault/n.md', 'y\n');
    const res = runAutocommit(r.dir);
    assert.equal(res.status, 'committed');
    assert.deepEqual(res.skippedDetail, [
      { path: 'vault/.gitattributes', reason: 'attributes-file' },
      { path: 'vault/k.txt', reason: 'secret-content' },
      { path: 'vault/old/.gitattributes', reason: 'attributes-file' },
      { path: 'vault/sub/.GitAttributes', reason: 'attributes-file' },
    ]);
    assert.deepEqual(r.headTree(), ['vault/.gitattributes', 'vault/n.md', 'vault/old/.gitattributes']);
    assert.equal(r.show('HEAD:vault/.gitattributes'), rule);
    assert.equal(r.show('HEAD:vault/n.md'), 'y');
    // The user-committed rule is still respected once it is back in the working tree.
    r.write('vault/.gitattributes', `${rule}\n`);
    const again = runAutocommit(r.dir);
    assert.deepEqual(
      again.skippedDetail.filter((d) => d.path === 'vault/k.txt'),
      [{ path: 'vault/k.txt', reason: 'encoded-path' }],
    );
  }));

/** Flip `file` between `on` and `off` every 2-32 ms in a child process until killed. */
function spawnToggler(file, on, off) {
  const code =
    "const fs=require('fs');const [f,on,off]=process.argv.slice(1);let i=0;" +
    '(function t(){try{fs.writeFileSync(f,(i++%2)?on:off)}catch{}setTimeout(t,2+Math.random()*30)})()';
  return spawn(process.execPath, ['-e', code, file, on, off], { stdio: 'ignore' });
}

async function togglerNeverLeaks(t, { attrFile, relConfig = false, ticks }) {
  const r = g12Repo();
  let tog = null;
  try {
    r.q('config', 'core.autocrlf', 'false');
    if (relConfig) r.q('config', 'core.attributesFile', attrFile);
    r.write('vault/n.md', 'x\n');
    r.commitAll('init');
    r.write('vault/sub/s.txt', G12_KEY);
    r.write(attrFile, '# none\n');
    tog = spawnToggler(join(r.dir, attrFile), '*.txt working-tree-encoding=UTF-16LE\n', '# none\n');
    const seen = new Set([r.q('rev-parse', 'HEAD').trim()]);
    const reasons = {};
    let failed = 0;
    for (let i = 0; i < ticks; i++) {
      try {
        const res = runAutocommit(r.dir);
        for (const d of res.skippedDetail) reasons[`${d.path}:${d.reason}`] = (reasons[`${d.path}:${d.reason}`] ?? 0) + 1;
      } catch (e) {
        // A file rewritten while `add` reads it ("short read while indexing")
        // fails the tick explicitly, before any commit: allowed, but checked.
        assert.match(e.message, /^git add -A/, `tick ${i}: unexpected failure`);
        failed++;
      }
      const head = r.q('rev-parse', 'HEAD').trim();
      if (seen.has(head)) continue;
      seen.add(head);
      assert.ok(!r.headTree().some((p) => autocommit.isAttributesFilePath(p)), `tick ${i}: an attributes file reached HEAD`);
      const { files } = cloneCheckout(r.dir);
      assert.ok(!files.some((x) => x.includes('AKIA')), `tick ${i}: a clone of HEAD checks the plaintext key out`);
    }
    t.diagnostic(`${ticks} ticks (${failed} failed in add), ${seen.size - 1} new HEADs, reasons ${JSON.stringify(reasons)}`);
    assert.ok(failed < ticks / 2, 'most ticks must complete');
  } finally {
    if (tog) {
      const exited = new Promise((res) => tog.once('exit', res));
      tog.kill();
      await exited;
    }
    rmSync(r.dir, { recursive: true, force: true });
  }
}

test(`M0-G12 D2: a toggler flipping vault/sub/.gitattributes never yields a HEAD whose clone checks the key out (${G12_RESIDUAL_TICKS} ticks)`, (t) =>
  togglerNeverLeaks(t, { attrFile: 'vault/sub/.gitattributes', ticks: G12_RESIDUAL_TICKS }));

test(`M0-G13 D3: a toggler flipping a case-variant vault/sub/.GitAttributes never yields a leaking HEAD (${G13_TOGGLER_TICKS} ticks)`, (t) =>
  togglerNeverLeaks(t, { attrFile: 'vault/sub/.GitAttributes', ticks: G13_TOGGLER_TICKS }));

test(`M0-G13 D3: a toggler flipping a relative core.attributesFile never yields a leaking HEAD (${G13_TOGGLER_TICKS} ticks)`, (t) =>
  togglerNeverLeaks(t, { attrFile: 'relattrs', relConfig: true, ticks: G13_TOGGLER_TICKS }));

/**
 * The M0-G13 blind spots, deterministically: `setup` installs an encoding
 * rule for vault/sub/s.txt through one attribute source, `flip` removes it
 * right after the add (so the add stored CJK text and both check-attr runs
 * say "no encoding"). The snapshot must see the flip: attributes-changed.
 */
function flipDefersTick(r, setup, flip) {
  r.q('config', 'core.autocrlf', 'false');
  r.write('vault/n.md', 'x\n');
  setup();
  r.commitAll('init');
  r.write('vault/sub/s.txt', G12_KEY);
  r.write('vault/n.md', 'y\n');
  const res = runAutocommit(r.dir, undefined, {
    onPhase: (phase) => {
      if (phase === 'added') flip();
    },
  });
  assert.ok(!r.headTree().includes('vault/sub/s.txt'), 'the re-encoded key reached HEAD');
  assert.equal(res.status, 'noop');
  assert.deepEqual(res.skippedDetail, [
    { path: 'vault/n.md', reason: 'attributes-changed' },
    { path: 'vault/sub/s.txt', reason: 'attributes-changed' },
  ]);
  return runAutocommit(r.dir);
}

const ENC_RULE = '*.txt working-tree-encoding=UTF-16LE\n';

test('M0-G13 a flip of a case-variant vault/sub/.GitAttributes defers the tick (attributes-changed)', () =>
  withG12Repo((r) => {
    const next = flipDefersTick(
      r,
      () => r.write('vault/sub/.GitAttributes', ENC_RULE),
      () => r.write('vault/sub/.GitAttributes', '# none\n'),
    );
    assert.deepEqual(next.skippedDetail, [
      { path: 'vault/sub/.GitAttributes', reason: 'attributes-file' },
      { path: 'vault/sub/s.txt', reason: 'secret-content' },
    ]);
  }));

test('M0-G13 a flip of a relative core.attributesFile (resolved against the top level, not the cwd) defers the tick', () =>
  withG12Repo((r) => {
    const next = flipDefersTick(
      r,
      () => {
        r.q('config', 'core.attributesFile', 'relattrs');
        r.write('relattrs', ENC_RULE);
      },
      () => r.write('relattrs', '# none\n'),
    );
    assert.deepEqual(next.skippedDetail, [{ path: 'vault/sub/s.txt', reason: 'secret-content' }]);
  }));

/** A tree holding one root `.gitattributes` with `rule`, under `ref`. */
function attrTree(r, ref, rule) {
  const blob = execFileSync('git', ['-C', r.dir, 'hash-object', '-w', '--stdin'], { input: rule, encoding: 'utf8' }).trim();
  const tree = execFileSync('git', ['-C', r.dir, 'mktree'], { input: `100644 blob ${blob}\t.gitattributes\n`, encoding: 'utf8' }).trim();
  r.q('update-ref', ref, tree);
}

test('M0-G13 attr.tree: a move of the ref it names, or a change of the setting, defers the tick; a stable attr.tree rule is honoured', () =>
  withG12Repo((r) => {
    const next = flipDefersTick(
      r,
      () => {
        attrTree(r, 'refs/skippy/attrs', ENC_RULE);
        r.q('config', 'attr.tree', 'refs/skippy/attrs');
      },
      () => attrTree(r, 'refs/skippy/attrs', '# none\n'),
    );
    assert.deepEqual(next.skippedDetail, [{ path: 'vault/sub/s.txt', reason: 'secret-content' }]);
    // A stable rule read from attr.tree is refused like any other source.
    attrTree(r, 'refs/skippy/attrs', ENC_RULE);
    assert.deepEqual(runAutocommit(r.dir).skippedDetail, [{ path: 'vault/sub/s.txt', reason: 'encoded-path' }]);
    // Dropping the setting mid-tick defers too.
    const res = runAutocommit(r.dir, undefined, {
      onPhase: (phase) => {
        if (phase === 'added') r.q('config', '--unset', 'attr.tree');
      },
    });
    assert.deepEqual(res.skippedDetail, [{ path: 'vault/sub/s.txt', reason: 'attributes-changed' }]);
  }));

test('M0-G13 a directory holding a bogus .git is still walked: a flip of its .gitattributes defers the tick', () =>
  withG12Repo((r) => {
    const next = flipDefersTick(
      r,
      () => {
        r.write('vault/sub/.git', 'gitdir: nowhere\n'); // not a repository: `add` walks straight in
        r.write('vault/sub/.gitattributes', ENC_RULE);
      },
      () => r.write('vault/sub/.gitattributes', '# none\n'),
    );
    assert.deepEqual(next.skippedDetail, [
      { path: 'vault/sub/.gitattributes', reason: 'attributes-file' },
      { path: 'vault/sub/s.txt', reason: 'secret-content' },
    ]);
  }));

test('M0-G13 a real nested repository is still skipped: its own .gitattributes changing mid-tick does not defer the tick', () =>
  withG12Repo((r) => {
    r.write('vault/n.md', 'x\n');
    r.commitAll('init');
    const nested = join(r.dir, 'vault', 'nested');
    mkdirSync(nested, { recursive: true });
    execFileSync('git', ['-C', nested, 'init', '-q']);
    write(nested, '.gitattributes', '# nested v1\n');
    execFileSync('git', ['-C', nested, '-c', 'user.name=n', '-c', 'user.email=n@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'n']);
    r.write('vault/n.md', 'y\n');
    const res = runAutocommit(r.dir, undefined, {
      onPhase: (phase) => {
        if (phase === 'added') write(nested, '.gitattributes', '# nested v2\n');
      },
    });
    assert.equal(res.status, 'committed');
    assert.deepEqual(res.skippedDetail, [{ path: 'vault/nested', reason: 'gitlink' }]);
    assert.equal(r.show('HEAD:vault/n.md'), 'y');
  }));
