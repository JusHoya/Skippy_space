// vault-path.test.ts — FR-SEC-02 containment regressions (M0 WS-D, assessment A03).
//
// Run: node --import tsx --test src/vault-path.test.ts
//
// Lexical cases run on every platform. Junction cases use
// fs.symlinkSync(target, link, 'junction'), which needs no privilege on Windows
// (on POSIX the 'junction' type is ignored and a directory symlink is created).
// True symlink cases skip with an explicit reason when the OS refuses (EPERM
// without Developer Mode / SeCreateSymbolicLinkPrivilege).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  VaultPathError,
  containmentPathGuard,
  isPathInside,
  normalizeVaultRelPath,
  recheckContained,
  resolveContained,
  type VaultPathViolation,
} from './vault-path.js';

const IS_WIN = process.platform === 'win32';

/** A temp dir holding `v/` (the vault) and a sibling `vault-evil/` (prefix trick). */
async function sandbox(): Promise<{ base: string; vault: string; evil: string }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'skippy-vpath-'));
  const vault = path.join(base, 'v');
  const evil = path.join(base, 'vault-evil');
  await fs.mkdir(vault);
  await fs.mkdir(evil);
  return { base, vault, evil };
}

function rejects(violation: VaultPathViolation) {
  return (err: unknown) => {
    assert.ok(err instanceof VaultPathError, `expected VaultPathError, got ${String(err)}`);
    assert.equal(err.violation, violation, err.message);
    return true;
  };
}

/** Try to create a real symlink; returns a skip reason if the OS refuses. */
function trySymlink(target: string, link: string, type: 'file' | 'dir'): string | null {
  try {
    fsSync.symlinkSync(target, link, type);
    return null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES') {
      return `symlink creation refused (${code}): needs Developer Mode or SeCreateSymbolicLinkPrivilege; junction tests cover the reparse escape`;
    }
    throw err;
  }
}

// ── Lexical gate ─────────────────────────────────────────────────────────────

const LEXICAL_CASES: Array<[string, VaultPathViolation]> = [
  ['../../evil.md', 'traversal'],
  ['20_Topics/../../evil.md', 'traversal'],
  ['20_Topics\\..\\..\\evil.md', 'traversal'],
  ['C:\\Windows\\evil.md', 'drive'],
  ['c:/evil.md', 'drive'],
  ['C:evil.md', 'drive'], // drive-relative
  ['/etc/evil.md', 'absolute'],
  ['\\evil.md', 'absolute'], // root-relative on the current drive
  ['\\\\server\\share\\evil.md', 'unc_or_device'],
  ['//server/share/evil.md', 'unc_or_device'],
  ['\\\\?\\C:\\evil.md', 'unc_or_device'],
  ['\\\\?\\UNC\\server\\share\\evil.md', 'unc_or_device'],
  ['\\\\.\\pipe\\evil', 'unc_or_device'],
  ['\\\\.\\C:\\evil.md', 'unc_or_device'],
  ['note.md:evil', 'colon_or_ads'], // NTFS alternate data stream
  ['note.md::$DATA', 'colon_or_ads'],
  ['a\u0000b.md', 'control_char'],
  ['a\nb.md', 'control_char'],
  ['CON', 'reserved_name'],
  ['nul.md', 'reserved_name'],
  ['20_Topics/com1.md', 'reserved_name'],
  ['lpt\u00b9.md', 'reserved_name'],
  ['CONOUT$', 'reserved_name'],
  ['foo./x.md', 'trailing_dot_space'],
  ['x.md ', 'trailing_dot_space'],
  ['.. /evil.md', 'trailing_dot_space'],
  ['.obsidian/plugins/x.md', 'hidden_segment'],
  ['.git/config', 'hidden_segment'],
  ['.skippy/replays/x.md', 'hidden_segment'],
  ['a/<b>.md', 'invalid_char'],
  ['a/b?.md', 'invalid_char'],
  ['', 'empty'],
  ['./', 'empty'],
];

for (const [input, violation] of LEXICAL_CASES) {
  test(`normalizeVaultRelPath rejects ${JSON.stringify(input)} (${violation})`, () => {
    assert.throws(() => normalizeVaultRelPath(input), rejects(violation));
  });
}

test('normalizeVaultRelPath canonicalizes separators and dot segments', () => {
  assert.equal(normalizeVaultRelPath('20_Topics\\sub\\x.md'), '20_Topics/sub/x.md');
  assert.equal(normalizeVaultRelPath('./a//b.md'), 'a/b.md');
  assert.equal(normalizeVaultRelPath('.obsidian/x.md', { allowHidden: true }), '.obsidian/x.md');
  assert.throws(
    () => normalizeVaultRelPath('10_Atomic/x.txt', { requireMarkdown: true }),
    rejects('not_markdown'),
  );
  assert.throws(() => normalizeVaultRelPath(42 as unknown as string), rejects('empty'));
});

test('isPathInside is segment-aware (C:\\v does not contain C:\\vault-evil)', () => {
  const root = IS_WIN ? 'C:\\v' : '/v';
  const sep = path.sep;
  assert.equal(isPathInside(root, `${root}${sep}note.md`), true);
  assert.equal(isPathInside(root, root), true);
  assert.equal(isPathInside(root, IS_WIN ? 'C:\\vault-evil\\x.md' : '/vault-evil/x.md'), false);
  assert.equal(isPathInside(root, IS_WIN ? 'C:\\v-\\x.md' : '/v-/x.md'), false);
  assert.equal(isPathInside(root, IS_WIN ? 'C:\\' : '/'), false);
  // A directory literally named `..foo` inside the root is still inside.
  assert.equal(isPathInside(root, `${root}${sep}..foo${sep}x.md`), true);
  if (IS_WIN) {
    assert.equal(isPathInside('C:\\V', 'c:\\v\\Note.md'), true, 'case-insensitive on win32');
    assert.equal(isPathInside('C:\\v', 'D:\\v\\x.md'), false, 'other drive');
    assert.equal(isPathInside('C:\\v', '\\\\server\\share\\v\\x.md'), false, 'UNC');
  }
});

// ── Real-path gate ───────────────────────────────────────────────────────────

test('resolveContained allows a new file under a not-yet-existing subdir', async () => {
  const { vault } = await sandbox();
  const cp = await resolveContained(vault, '30_Projects/new/deeper/x.md');
  assert.equal(cp.rel, '30_Projects/new/deeper/x.md');
  assert.equal(cp.exists, false);
  assert.ok(isPathInside(cp.realRoot, cp.abs));
});

test('resolveContained is case-insensitive about the vault root on win32', { skip: !IS_WIN && 'win32-only case semantics' }, async () => {
  const { vault } = await sandbox();
  await fs.mkdir(path.join(vault, '20_Topics'));
  await fs.writeFile(path.join(vault, '20_Topics', 'x.md'), 'x');
  const cp = await resolveContained(vault.toUpperCase(), '20_topics/X.md');
  assert.equal(cp.exists, true);
});

test('resolveContained rejects a junction that escapes to a prefix-sibling dir', async () => {
  const { vault, evil } = await sandbox();
  fsSync.symlinkSync(evil, path.join(vault, 'j'), 'junction');
  await assert.rejects(resolveContained(vault, 'j/x.md'), rejects('escapes_root'));
  // Also through a not-yet-existing subdirectory beneath the junction.
  await assert.rejects(resolveContained(vault, 'j/new/deeper/x.md'), rejects('escapes_root'));
  // Mixed-case spelling of the junction segment does not help.
  if (IS_WIN) await assert.rejects(resolveContained(vault, 'J/x.md'), rejects('escapes_root'));
});

test('resolveContained allows a junction that stays inside the vault', async () => {
  const { vault } = await sandbox();
  await fs.mkdir(path.join(vault, 'real'));
  fsSync.symlinkSync(path.join(vault, 'real'), path.join(vault, 'alias'), 'junction');
  const cp = await resolveContained(vault, 'alias/x.md');
  assert.equal(cp.exists, false);
});

test('resolveContained rejects a dangling junction (cannot be safely contained)', async () => {
  const { base, vault } = await sandbox();
  const gone = path.join(base, 'gone');
  await fs.mkdir(gone);
  fsSync.symlinkSync(gone, path.join(vault, 'd'), 'junction');
  await fs.rm(gone, { recursive: true });
  await assert.rejects(resolveContained(vault, 'd/x.md'), rejects('dangling_link'));
});

test('resolveContained rejects a target that is itself a junction', async () => {
  const { vault } = await sandbox();
  await fs.mkdir(path.join(vault, 'inside'));
  fsSync.symlinkSync(path.join(vault, 'inside'), path.join(vault, 'linked.md'), 'junction');
  await assert.rejects(resolveContained(vault, 'linked.md'), rejects('target_is_link'));
});

test('resolveContained rejects a file symlink escaping the vault', async (t) => {
  const { vault, evil } = await sandbox();
  const outside = path.join(evil, 'secret.md');
  await fs.writeFile(outside, 'secret');
  const skip = trySymlink(outside, path.join(vault, 's.md'), 'file');
  if (skip) return t.skip(skip);
  await assert.rejects(resolveContained(vault, 's.md'), rejects('escapes_root'));
});

test('resolveContained rejects a directory symlink escaping the vault', async (t) => {
  const { vault, evil } = await sandbox();
  const skip = trySymlink(evil, path.join(vault, 'sd'), 'dir');
  if (skip) return t.skip(skip);
  await assert.rejects(resolveContained(vault, 'sd/x.md'), rejects('escapes_root'));
});

test('resolveContained accepts a vault root that is itself reached via a junction', async () => {
  const { base, vault } = await sandbox();
  const via = path.join(base, 'via');
  fsSync.symlinkSync(vault, via, 'junction');
  const cp = await resolveContained(via, '10_Atomic/x.md');
  assert.ok(isPathInside(cp.realRoot, cp.abs));
});

test('recheckContained catches a directory swapped for an escaping junction after resolution', async () => {
  const { vault, evil } = await sandbox();
  await fs.mkdir(path.join(vault, 'swap'));
  const cp = await resolveContained(vault, 'swap/x.md');
  // Attacker swaps the (empty) directory for a junction between check and write.
  await fs.rmdir(path.join(vault, 'swap'));
  fsSync.symlinkSync(evil, path.join(vault, 'swap'), 'junction');
  await assert.rejects(recheckContained(cp), rejects('escapes_root'));
});

// ── PathGuard adapter (for agent-runtime tool-policy) ────────────────────────

test('containmentPathGuard allows in-root files, dirs and new paths; rejects escapes', async () => {
  const { base, vault, evil } = await sandbox();
  await fs.mkdir(path.join(vault, 'src'));
  await fs.writeFile(path.join(vault, 'src', 'a.ts'), 'x');
  fsSync.symlinkSync(evil, path.join(vault, 'j'), 'junction');
  fsSync.symlinkSync(path.join(vault, 'src'), path.join(vault, 'inner'), 'junction');
  const roots = [vault];
  const ok = async (t: string) =>
    assert.deepEqual(await containmentPathGuard(t, roots, vault), { ok: true }, t);
  const no = async (t: string) => {
    const r = await containmentPathGuard(t, roots, vault);
    assert.equal(r.ok, false, `${t} should be rejected`);
  };
  await ok('src/a.ts');
  await ok(path.join(vault, 'src', 'a.ts'));
  await ok('src'); // directory target (Glob/Grep)
  await ok('.gitignore'); // hidden files are ordinary in a worktree
  await ok('new/dir/file.ts');
  await ok('inner'); // in-root junction target
  await ok(vault);
  await no('../vault-evil/x.md');
  await no(path.join(evil, 'x.md')); // prefix-sibling absolute path
  await no('j/x.md'); // junction escape
  await no('j/new/x.md');
  await no('C:x.md');
  await no('\\\\?\\' + path.join(vault, 'src', 'a.ts'));
  await no('\\\\server\\share\\x');
  await no('src/a.ts:ads');
  await no('src/nul.ts');
  await no('a\u0000b');
  assert.deepEqual(await containmentPathGuard('x', [], vault), {
    ok: false,
    reason: 'no roots assigned',
  });
  // Allowed if inside ANY root.
  assert.deepEqual(await containmentPathGuard(path.join(evil, 'y'), [vault, evil], base), {
    ok: true,
  });
});
