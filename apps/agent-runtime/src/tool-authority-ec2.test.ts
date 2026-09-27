// tool-authority-ec2.test.ts — M0 EC2 closure for T02 "Tool authority"
// (FR-SEC-01, FR-SEC-02, G0, OQ-18): the Grep/Glob pre-execution gate must
// enumerate EXACTLY the tree rg walks; the PostToolUse redaction is defense
// in depth, not the enforcement.
//
// Gap (red-team r4v2 p1, b3e9af0): the gate derived the Glob search root per
// brace alternative and, for a pattern without a glob metacharacter, used the
// pattern itself. The bundled CLI (2.1.162, `b3f`/`Au7`) splits the RAW
// pattern once; with no metacharacter it walks `dirname(pattern)` with
// `--glob basename(pattern)`, which matches that name at ANY depth. So
//   G1 Glob {pattern: "<wt>\sub"}          gate scanned <wt>\sub, rg walked <wt>
//   G2 Glob {pattern: "<wt>\{sub,clean}"}  gate scanned sub + clean, rg walked <wt>
// and `<wt>\deep\sub\.env` was reachable past the gate.
//
// D2 (low): a Grep over a single file prints content lines without a
// filename, so a `path` swapped to a credential location after the gate
// ran was invisible to the PostToolUse redaction.
//
// `cliGlobSplit` is checked here against a table derived from the CLI source
// (quoted in tool-policy.ts); tool-authority-ec2.live-cli.test.ts asserts the
// same function against the argv/cwd the real CLI hands rg.
//
// Run: node --import tsx --test src/tool-authority-ec2.test.ts

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Charter } from './charter.js';
import * as policyMod from './tool-policy.js';
import { derivePolicy, evaluateToolCall, redactSearchOutput, type ExecutionPolicy, type PolicyDecision } from './tool-policy.js';

delete process.env.OBSIDIAN_API_KEY;
process.env.OBSIDIAN_API_URL = 'http://127.0.0.1:55555';
process.env.LETTA_DISABLED = '1';

const isWin = process.platform === 'win32';

type Split = { baseDir: string; relativePattern: string };
/** New in EC2; resolved lazily so a test fails on its own assertion on the
 * baseline rather than at module link time. */
const cliGlobSplit = (policyMod as unknown as { cliGlobSplit?: (pattern: string, pathArg: string | undefined, cwd: string) => Split })
  .cliGlobSplit;

const createdTmpDirs: string[] = [];

async function tmpDir(prefix: string): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  createdTmpDirs.push(dir);
  return dir;
}

after(async () => {
  for (const dir of createdTmpDirs) {
    try {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* best effort */
    }
  }
});

function readPolicy(wt: string): ExecutionPolicy {
  const charter: Charter = {
    agentId: 'board.coding',
    frontmatter: { permission_mode: 'ask', tools: ['Read', 'Glob', 'Grep'] },
    body: 'synthetic body long enough',
    loaded: true,
    path: '(synthetic)',
  };
  return derivePolicy(charter, { worktreePath: wt });
}

function denied(d: PolicyDecision, label: string): Extract<PolicyDecision, { allow: false }> {
  assert.equal(d.allow, false, `${label}: expected a denial, got ${JSON.stringify(d)}`);
  return d as Extract<PolicyDecision, { allow: false }>;
}

function allowed(d: PolicyDecision, label: string): void {
  assert.equal(d.allow, true, `${label}: expected allow, got ${JSON.stringify(d)}`);
}

const fwd = (p: string): string => p.replace(/\\/g, '/');

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
}

/** The r4v2 p1 fixture: the credential-named file lives OUTSIDE the literal
 * directory the pattern names, under a same-named directory deeper down. */
async function p1Worktree(): Promise<string> {
  const wt = await tmpDir('skippy-ec2-wt-');
  await writeFiles(wt, {
    'sub/ok.txt': 'PLACEHOLDER\n',
    'deep/sub/.env': 'PLACEHOLDER_DUMMY\n',
    'clean/a.ts': 'PLACEHOLDER\n',
  });
  return wt;
}

// ── cliGlobSplit vs the CLI (`b3f` / `Au7` / `GK`) ──────────────────────────

/** Session cwd used by the table (never touched on disk: the split is pure). */
const CWD = 'C:\\fx\\wt';

/** [pattern, path, expected baseDir, expected relativePattern]. Each row is
 * what the CLI 2.1.162 source computes; the live suite checks the same shapes
 * against the argv/cwd the real CLI hands rg. */
const SPLIT_TABLE: ReadonlyArray<readonly [string, string | undefined, string, string]> = [
  // Relative pattern: rg walks `path` (GK) or the cwd; the pattern is the glob as-is.
  ['**/*.ts', undefined, CWD, '**/*.ts'],
  ['sub', undefined, CWD, 'sub'], // no metachar, relative: NOT split (b3f only for absolute)
  ['*.ts', 'clean', 'C:\\fx\\wt\\clean', '*.ts'],
  ['deep/*.ts', 'C:/fx/wt/clean', 'C:\\fx\\wt\\clean', 'deep/*.ts'],
  ['*', '  clean\\deep  ', 'C:\\fx\\wt\\clean\\deep', '*'], // GK trims
  ['*', '', CWD, '*'], // empty `path` is falsy: the cwd
  ['*', '/c/fx/wt/clean', 'C:\\fx\\wt\\clean', '*'], // GK msys form
  // Absolute, no metacharacter: dirname / basename of the RAW pattern.
  ['C:\\fx\\wt\\sub', undefined, 'C:\\fx\\wt', 'sub'],
  ['C:\\fx\\wt\\sub\\ok.txt', undefined, 'C:\\fx\\wt\\sub', 'ok.txt'],
  ['C:/fx/wt/sub/ok.txt', undefined, 'C:/fx/wt/sub', 'ok.txt'], // forward slashes kept
  ['C:\\fx\\wt\\sub\\', undefined, 'C:\\fx\\wt', 'sub'], // trailing separator
  ['C:/fx/wt/sub/', undefined, 'C:/fx/wt', 'sub'],
  ['C:\\fx', undefined, 'C:\\', 'fx'],
  // Absolute with metacharacters: cut at the last separator before the FIRST of *?[{.
  ['C:\\fx\\wt\\{sub,clean}', undefined, 'C:\\fx\\wt', '{sub,clean}'], // brace first
  ['C:\\fx\\wt\\{sub,clean}\\*.txt', undefined, 'C:\\fx\\wt', '{sub,clean}\\*.txt'],
  ['C:\\fx\\wt\\clean\\*.ts', undefined, 'C:\\fx\\wt\\clean', '*.ts'],
  ['C:/fx/wt/clean/**/*.ts', undefined, 'C:/fx/wt/clean', '**/*.ts'],
  ['C:\\fx\\wt\\cl?an\\deep\\*', undefined, 'C:\\fx\\wt', 'cl?an\\deep\\*'], // wildcard in the middle
  ['C:\\fx\\wt\\clean\\[ab].ts', undefined, 'C:\\fx\\wt\\clean', '[ab].ts'],
  ['C:/fx/wt/./clean/*.ts', undefined, 'C:/fx/wt/./clean', '*.ts'], // not normalised
  ['C:/fx/wt/sub\\x/*.ts', undefined, 'C:/fx/wt/sub\\x', '*.ts'], // mixed separators
  ['C:\\*', undefined, 'C:\\', '*'], // bare drive gets its separator back
  ['C:/*.ts', undefined, 'C:\\', '*.ts'],
  // `path` + absolute pattern: `path` is ignored.
  ['C:\\fx\\wt\\clean\\*.ts', 'sub', 'C:\\fx\\wt\\clean', '*.ts'],
  ['C:\\fx\\wt\\sub', 'clean', 'C:\\fx\\wt', 'sub'],
  // Root-relative patterns are absolute to path.win32 (the gate refuses them).
  ['/*.ts', undefined, '/', '*.ts'],
  ['\\fx\\*', undefined, '\\fx', '*'],
];

test('EC2: cliGlobSplit reproduces the CLI Glob split (b3f/Au7/GK) for every pattern shape', { skip: isWin ? false : 'Windows path semantics' }, () => {
  assert.equal(typeof cliGlobSplit, 'function', 'tool-policy exports cliGlobSplit');
  assert.ok(SPLIT_TABLE.length >= 15);
  for (const [pattern, pathArg, baseDir, relativePattern] of SPLIT_TABLE) {
    assert.deepEqual(
      cliGlobSplit?.(pattern, pathArg, CWD),
      { baseDir, relativePattern },
      `cliGlobSplit(${JSON.stringify(pattern)}, ${JSON.stringify(pathArg)})`,
    );
  }
});

// ── r4v2 p1: the gate enumerates the tree rg actually walks ─────────────────

test('EC2 p1 G1/G2: an absolute Glob with no metacharacter, or a brace-first one, is gated on the tree rg walks (the parent)', async () => {
  const wt = await p1Worktree();
  const policy = readPolicy(wt);
  const g1 = denied(await evaluateToolCall(policy, { toolName: 'Glob', input: { pattern: path.join(wt, 'sub') } }), 'G1');
  assert.equal(g1.code, 'credential_path', JSON.stringify(g1));
  assert.match(g1.reason, /narrow `path`/);
  assert.doesNotMatch(g1.reason, /deep|\.env/, 'the denial reports a count, never where the credential is');
  const g2 = denied(await evaluateToolCall(policy, { toolName: 'Glob', input: { pattern: path.join(wt, '{sub,clean}') } }), 'G2');
  assert.equal(g2.code, 'credential_path', JSON.stringify(g2));
  for (const pattern of [
    `${fwd(wt)}/sub`,
    `${path.join(wt, 'sub')}\\`,
    `${fwd(wt)}/sub/`,
    path.join(wt, 'sub', 'ok.txt'), // rg walks <wt>\sub: clean — see the control below
    path.join(wt, '{sub,clean}', '*.txt'),
    `${fwd(wt)}/{clean,sub}/**`,
    path.join(wt, 'cl?an'),
  ]) {
    const d = await evaluateToolCall(policy, { toolName: 'Glob', input: { pattern } });
    if (pattern.endsWith('ok.txt')) allowed(d, pattern);
    else assert.equal(denied(d, pattern).code, 'credential_path', `${pattern}: ${JSON.stringify(d)}`);
  }
  // `path` is ignored for an absolute pattern: a clean `path` does not help.
  const withPath = denied(await evaluateToolCall(policy, { toolName: 'Glob', input: { pattern: path.join(wt, 'sub'), path: path.join(wt, 'clean') } }), 'G1+path');
  assert.equal(withPath.code, 'credential_path');
});

test('EC2 p1 G3 control: the same patterns narrowed below the credential are allowed', async () => {
  const wt = await p1Worktree();
  const policy = readPolicy(wt);
  for (const input of [
    { pattern: `${path.join(wt, 'sub')}\\**` }, // G3: rg walks <wt>\sub
    { pattern: path.join(wt, 'sub', '*.txt') },
    { pattern: path.join(wt, 'clean', 'a.ts') }, // no metachar: rg walks <wt>\clean
    { pattern: path.join(wt, 'clean', '{a,b}.ts') },
    { pattern: '*.ts', path: 'clean' },
    { pattern: 'a.ts', path: path.join(wt, 'clean') },
  ]) {
    allowed(await evaluateToolCall(policy, { toolName: 'Glob', input }), JSON.stringify(input));
  }
});

test('EC2: a no-metacharacter pattern naming the root walks the root\'s parent and is refused as outside the roots', async () => {
  const wt = await tmpDir('skippy-ec2-clean-');
  await writeFiles(wt, { 'a.ts': 'x\n' });
  const policy = readPolicy(wt);
  for (const pattern of [wt, `${fwd(wt)}/`, `${wt}\\`]) {
    const d = denied(await evaluateToolCall(policy, { toolName: 'Glob', input: { pattern } }), pattern);
    assert.equal(d.code, 'path_outside_roots', JSON.stringify(d));
  }
  // Existing refusals are kept.
  for (const [pattern, code] of [
    [`${fwd(wt)}/../*`, 'path_outside_roots'],
    [path.join(os.tmpdir(), '*.ts'), 'path_outside_roots'],
    [`${fwd(wt)}/.env*`, 'credential_path'],
    [`${fwd(wt)}/{a,.aws}/*`, 'credential_path'],
    ['**/*.pem', 'credential_path'],
  ] as const) {
    const d = denied(await evaluateToolCall(policy, { toolName: 'Glob', input: { pattern } }), pattern);
    assert.equal(d.code, code, `${pattern}: ${JSON.stringify(d)}`);
  }
});

test('EC2: normal work — Grep/Glob inside apps/agent-runtime/src of this repo are allowed', async () => {
  const src = path.dirname(fileURLToPath(import.meta.url));
  const repo = path.resolve(src, '..', '..', '..');
  const policy = derivePolicy(
    { agentId: 'board.coding', frontmatter: { permission_mode: 'ask', tools: ['Read', 'Glob', 'Grep'] }, body: 'synthetic body long enough', loaded: true, path: '(synthetic)' },
    { worktreePath: repo },
  );
  for (const [toolName, input] of [
    ['Grep', { pattern: 'cliGlobSplit', path: src }],
    ['Grep', { pattern: 'cliGlobSplit', path: 'apps/agent-runtime/src', output_mode: 'content' }],
    ['Grep', { pattern: 'x', path: path.join(src, 'tool-policy.ts') }],
    ['Glob', { pattern: '*.ts', path: src }],
    ['Glob', { pattern: '**/*.test.ts', path: 'apps/agent-runtime/src' }],
    ['Glob', { pattern: path.join(src, '*.ts') }],
    ['Glob', { pattern: `${fwd(src)}/tool-*.ts` }],
    ['Glob', { pattern: path.join(src, 'tool-policy.ts') }], // no metachar: rg walks src
  ] as const) {
    allowed(await evaluateToolCall(policy, { toolName, input: { ...input } }), `${toolName} ${JSON.stringify(input)}`);
  }
});

// ── D2: TOCTOU swap of a single-file Grep `path` ────────────────────────────

test('EC2 D2: a Grep `path` swapped to a credential location after the gate is withheld at PostToolUse', { skip: isWin ? false : 'junctions are Windows-only' }, async () => {
  const wt = await tmpDir('skippy-ec2-toctou-');
  // The secret line looks like an absolute path, so no line-based rule sees
  // it: only the re-resolved `path` reveals where rg actually read.
  const secretLine = 'C:\\ProgramData\\app\\token=SECRET_AWS';
  await writeFiles(wt, { 'clean/notes.txt': 'BENIGN\n', '.aws/notes.txt': `${secretLine}\n` });
  const lnk = path.join(wt, 'lnk');
  await fs.symlink(path.join(wt, 'clean'), lnk, 'junction');
  const policy = readPolicy(wt);
  const input = { pattern: 'SECRET|BENIGN', path: 'lnk/notes.txt', output_mode: 'content', '-n': false };
  allowed(await evaluateToolCall(policy, { toolName: 'Grep', input }), 'gate (before the swap)');
  // rg over a single file prints no filename: nothing in the output names a credential.
  const benign = redactSearchOutput(policy, 'Grep', input, { mode: 'content', numFiles: 0, filenames: [], content: 'BENIGN', numLines: 1 });
  assert.equal(benign, null, 'control: an unswapped single-file search passes');
  // Swap the junction to the credential directory (between the gate and rg).
  await fs.rm(lnk, { recursive: true, force: true });
  await fs.symlink(path.join(wt, '.aws'), lnk, 'junction');
  const verdict = redactSearchOutput(policy, 'Grep', input, { mode: 'content', numFiles: 0, filenames: [], content: secretLine, numLines: 1 });
  assert.ok(verdict, 'the swapped search is withheld');
  assert.doesNotMatch(JSON.stringify(verdict.replacement), /SECRET/);
  assert.match(verdict.reason, /credential/);
  // The gate itself now refuses the same call.
  assert.equal(denied(await evaluateToolCall(policy, { toolName: 'Grep', input }), 'gate (after the swap)').code, 'credential_path');
});

test('EC2 D2: a single-file Grep `path` swapped to a symlink onto `.env` is withheld (needs symlink privilege)', async (t) => {
  const wt = await tmpDir('skippy-ec2-toctou-file-');
  await writeFiles(wt, { 'notes.txt': 'BENIGN\n', '.env': 'API_TOKEN=SECRET_ENV\n' });
  const policy = readPolicy(wt);
  // Gate on a clean tree (the `.env` is created below, after the gate).
  await fs.rename(path.join(wt, '.env'), path.join(wt, '..', `${path.basename(wt)}.env-hold`));
  const input = { pattern: 'SECRET', path: 'notes.txt', output_mode: 'content' };
  allowed(await evaluateToolCall(policy, { toolName: 'Grep', input }), 'gate');
  await fs.rename(path.join(wt, '..', `${path.basename(wt)}.env-hold`), path.join(wt, '.env'));
  await fs.rm(path.join(wt, 'notes.txt'));
  try {
    await fs.symlink(path.join(wt, '.env'), path.join(wt, 'notes.txt'), 'file');
  } catch (err) {
    t.skip(`file symlinks unavailable (${(err as NodeJS.ErrnoException).code})`);
    return;
  }
  const verdict = redactSearchOutput(policy, 'Grep', input, { mode: 'content', numFiles: 0, filenames: [], content: '1:API_TOKEN=SECRET_ENV', numLines: 1 });
  assert.ok(verdict, 'withheld');
});

test('EC2: redaction resolves a relative output path against the session cwd, as the CLI prints it (JBH)', { skip: isWin ? false : 'junctions are Windows-only' }, async () => {
  const wt = await tmpDir('skippy-ec2-jbh-');
  await writeFiles(wt, { 'sub/x.txt': 'x\n', '.aws/x.txt': 'x\n' });
  // `sub/j` -> `.aws`: an alias only its real path reveals.
  await fs.symlink(path.join(wt, '.aws'), path.join(wt, 'sub', 'j'), 'junction');
  const policy = readPolicy(wt);
  // Grep {path: "sub"} lists `sub\j\x.txt` (relative to the cwd, not to `sub`).
  const v = redactSearchOutput(policy, 'Grep', { pattern: 'x', path: 'sub' }, { mode: 'files_with_matches', numFiles: 1, filenames: ['sub\\j\\x.txt'] });
  assert.ok(v, 'withheld through the real path of the cwd-relative name');
});
