// tool-authority-rtf3.test.ts — regression suite for the F3 red-team pass on
// T02 "Tool authority" (FR-SEC-01, FR-SEC-02, G0), which defeated the F2
// Grep/Glob credential containment twice:
//
//   Cause 1  the anchored negative globs were computed relative to the Grep
//            `path`, but rg evaluates `--glob` relative to the CLI's cwd, so
//            `Grep {path: "sub"}` returned `sub\.env.local` (r3v2 g2/g3/g6)
//   Cause 2  the PostToolUse redaction parsed at most 64 `:`/`-` boundaries
//            per line, so a path with >= 64 dashes was never judged (g6);
//            likewise count mode, `-A` context and the `node_modules`
//            carve-out with or without `.gitignore` (g7)
//   Low      non-normalised absolute Glob patterns were mis-split (gl1);
//            the `.env*` rule missed `.envrc`, `.env-prod`, `.env_local`
//
// F3 design (fail closed by construction): the tree rg walks is enumerated
// in full (bounded, no carve-outs) and ANY credential entry in it denies the
// call; the PostToolUse hook judges every path-separator-bounded substring
// of every output line with no caps and withholds the whole output.
//
// Every test here fails on 75b245f and passes after the fix. The probes
// mirror the red-team's r3v2/u1.mts, u4.mts and scen-g2/g3/g6/g7/gl1/s1.
//
// Run: node --import tsx --test src/tool-authority-rtf3.test.ts

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Charter } from './charter.js';
import * as policyMod from './tool-policy.js';
import {
  buildClaudeSdkPermissionOptions,
  credentialPathRejection,
  derivePolicy,
  evaluateToolCall,
  redactSearchOutput,
  scanForCredentials,
  type ExecutionPolicy,
  type PolicyDecision,
} from './tool-policy.js';

delete process.env.OBSIDIAN_API_KEY;
process.env.OBSIDIAN_API_URL = 'http://127.0.0.1:55555';
process.env.LETTA_DISABLED = '1';

const isWin = process.platform === 'win32';

/** Exports new in F3, resolved lazily so a test fails on its own assertion
 * on the baseline rather than at module link time. */
type F3Extras = {
  lineCredentialRejection?: (line: string, searchRoot: string) => string | null;
  MAX_REDACTION_BYTES?: number;
  MAX_BOUNDARY_PAIRS_PER_LINE?: number;
};
const extras = policyMod as unknown as F3Extras;

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

function synthetic(frontmatter: Record<string, unknown>): Charter {
  return { agentId: 'board.coding', frontmatter, body: 'synthetic body long enough', loaded: true, path: '(synthetic)' };
}

function readPolicy(wt: string): ExecutionPolicy {
  return derivePolicy(synthetic({ permission_mode: 'ask', tools: ['Read', 'Glob', 'Grep', 'Agent'] }), { worktreePath: wt });
}

function denied(d: PolicyDecision, label = ''): Extract<PolicyDecision, { allow: false }> {
  assert.equal(d.allow, false, `${label}: expected a denial, got ${JSON.stringify(d)}`);
  return d as Extract<PolicyDecision, { allow: false }>;
}

function allowed(d: PolicyDecision, label = ''): Extract<PolicyDecision, { allow: true }> {
  assert.equal(d.allow, true, `${label}: expected allow, got ${JSON.stringify(d)}`);
  return d as Extract<PolicyDecision, { allow: true }>;
}

const fwd = (p: string): string => p.replace(/\\/g, '/');

/** 66 dashes: past the F2 redaction cap of 64 boundaries. */
export const DASHY = `${'b-'.repeat(66)}z`;
const NM_DASHY = `${'a-'.repeat(66)}z`;

/** The r3v2 red-team fixture. */
async function f3Worktree(opts: { gitignore?: boolean } = {}): Promise<string> {
  const wt = await tmpDir('skippy-rtf3-wt-');
  const files: Record<string, string> = {
    '.aws/credentials': 'SECRET=AWS\n',
    '.env': 'SECRET=ROOT_ENV\n',
    'server.pem': 'SECRET=PEM\n',
    'node_modules/.env': 'SECRET=NM_ENV\n',
    [`node_modules/${NM_DASHY}/.env`]: 'SECRET=NM_DASH\n',
    'sub/.env.local': 'SECRET=SUBENV\n',
    [`sub/${DASHY}/.env`]: 'SECRET=SUB_DASH\n',
    [`sub/${DASHY}/readme.txt`]: 'hi BENIGN\n',
    'sub/cfg/deploy.key': 'SECRET=SUB_PEM\n',
    'sub/ok2.txt': 'BENIGN\n',
    'up/.ENV': 'SECRET=UP\n',
    'envs/.envrc': 'SECRET=ENVRC\n',
    'envs/.env-prod': 'SECRET=ENV_PROD\n',
    'envs/.env_local': 'SECRET=ENV_LOCAL\n',
    'envs/.envelope.md': 'SECRET=ENVELOPE\n',
    'clean/a.ts': 'const x = process.env.FOO; // BENIGN\n',
    'clean/deep/b.ts': '// BENIGN\n',
    'ok.txt': 'BENIGN\n',
    'notes.txt': 'BENIGN\n',
  };
  if (opts.gitignore) files['.gitignore'] = 'node_modules\n';
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(wt, ...rel.split('/'));
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  await fs.mkdir(path.join(wt, 'late'));
  if (isWin) {
    await fs.symlink(path.join(wt, '.aws'), path.join(wt, 'j1'), 'junction');
    await fs.symlink(path.join(wt, 'sub'), path.join(wt, 'jsub'), 'junction');
  }
  return wt;
}

// ── Low: the `.env*` rule is literal ─────────────────────────────────────────

test('F3: every basename starting with `.env` is a credential name (`.envrc`, `.env-prod`, `.env_local`, `.envelope.md`)', async () => {
  for (const name of ['.env', '.envrc', '.env-prod', '.env_local', '.env.local', '.ENV', '.envelope.md', '.env.example']) {
    assert.ok(credentialPathRejection(name), `${name} is a credential name`);
  }
  for (const name of ['env', 'environment.ts', 'my.env', 'dotenv.md', '.envy'.slice(0, 3)]) {
    assert.equal(credentialPathRejection(name), null, `${name} is benign`);
  }
  const wt = await f3Worktree();
  const policy = readPolicy(wt);
  for (const rel of ['envs/.envrc', 'envs/.env-prod', 'envs/.env_local', 'envs/.envelope.md']) {
    assert.equal(denied(await evaluateToolCall(policy, { toolName: 'Read', input: { file_path: path.join(wt, rel) } }), rel).code, 'credential_path');
  }
  assert.equal(denied(await evaluateToolCall(policy, { toolName: 'Grep', input: { pattern: 'SECRET', path: 'envs' } })).code, 'credential_path');
  assert.equal(denied(await evaluateToolCall(policy, { toolName: 'Glob', input: { pattern: '*', path: path.join(wt, 'envs') } })).code, 'credential_path');
});

// ── H4: the vault's ingest-sidecar HMAC key ─────────────────────────────────

test('H4: `vault/.skippy/ingest-sidecar.key` is unreachable through Read/Grep/Glob even when a project root contains the vault', async () => {
  assert.ok(credentialPathRejection('ingest-sidecar.key'));
  assert.ok(credentialPathRejection('vault/.skippy/ingest-sidecar.key'));
  const root = await tmpDir('skippy-rtf3-vault-');
  const keyFile = path.join(root, 'vault', '.skippy', 'ingest-sidecar.key');
  await fs.mkdir(path.dirname(keyFile), { recursive: true });
  await fs.writeFile(keyFile, 'SECRET=HMAC\n');
  await fs.mkdir(path.join(root, 'vault', 'notes'), { recursive: true });
  await fs.writeFile(path.join(root, 'vault', 'notes', 'a.md'), '# BENIGN\n');
  const policy = derivePolicy(synthetic({ permission_mode: 'ask', tools: ['Read', 'Glob', 'Grep'] }), { projectRoot: root });
  assert.equal(denied(await evaluateToolCall(policy, { toolName: 'Read', input: { file_path: keyFile } })).code, 'credential_path');
  for (const input of [{ pattern: 'SECRET' }, { pattern: 'SECRET', path: 'vault' }, { pattern: 'SECRET', path: 'vault/.skippy' }, { pattern: 'SECRET', glob: '*.md' }]) {
    assert.equal(denied(await evaluateToolCall(policy, { toolName: 'Grep', input }), JSON.stringify(input)).code, 'credential_path');
  }
  for (const input of [{ pattern: '**/*' }, { pattern: 'vault/**/*.md' }, { pattern: '*', path: 'vault/.skippy' }]) {
    assert.equal(denied(await evaluateToolCall(policy, { toolName: 'Glob', input }), JSON.stringify(input)).code, 'credential_path');
  }
  allowed(await evaluateToolCall(policy, { toolName: 'Grep', input: { pattern: 'BENIGN', path: 'vault/notes' } }));
  allowed(await evaluateToolCall(policy, { toolName: 'Read', input: { file_path: path.join(root, 'vault', 'notes', 'a.md') } }));
  const r = redactSearchOutput(policy, 'Grep', { pattern: 'S' }, { mode: 'files_with_matches', numFiles: 1, filenames: ['vault/.skippy/ingest-sidecar.key'] });
  assert.ok(r && r.replacement['numFiles'] === 0);
});

// ── Cause 1: Grep is gated on the tree rg walks (g2 / g3 / g6) ──────────────

test('F3 g2/g3/g6: Grep with a `path` below the cwd is denied when that subtree holds a credential, in every output mode', async () => {
  const wt = await f3Worktree();
  const policy = readPolicy(wt);
  const probes: Array<Record<string, unknown>> = [
    { pattern: 'NM_DASH', output_mode: 'content' },
    { pattern: 'SECRET', path: 'sub', output_mode: 'content' },
    { pattern: 'SECRET', path: `${fwd(wt)}/sub`, output_mode: 'content' },
    { pattern: 'SECRET', glob: '**', output_mode: 'content' },
    { pattern: 'SECRET', glob: '.a[w]s/**', output_mode: 'content' },
    { pattern: 'SECRET', glob: '*.local', output_mode: 'content' },
    { pattern: 'SECRET', output_mode: 'count' },
    { pattern: 'SECRET', output_mode: 'files_with_matches' },
    { pattern: 'NM_DASH', output_mode: 'content', '-A': 2, '-n': false },
    { pattern: 'SUB_DASH', path: 'sub', output_mode: 'content' },
    { pattern: 'SUB_DASH', path: 'sub', output_mode: 'count' },
    { pattern: 'SUB_PEM', path: 'sub', output_mode: 'content' },
    { pattern: 'SUB_PEM', path: 'sub/cfg', output_mode: 'content' },
    { pattern: 'SUB_DASH', path: `sub/${DASHY}`, output_mode: 'content' },
    { pattern: 'UP', path: 'up', output_mode: 'content' },
    { pattern: 'SECRET', path: 'jsub', output_mode: 'content' }, // junction to sub
    { pattern: 'SECRET', path: 'j1', output_mode: 'content' }, // junction to .aws
    { pattern: 'SECRET', path: 'sub', glob: '*.txt', output_mode: 'content' }, // a narrowing glob is not modelled
  ];
  for (const input of probes) {
    const d = denied(await evaluateToolCall(policy, { toolName: 'Grep', input }), JSON.stringify(input));
    assert.equal(d.code, 'credential_path', JSON.stringify(input));
    assert.match(d.reason, /narrow `path`|credential/, JSON.stringify(input));
    assert.ok(!('updatedInput' in d), 'no input rewrite');
  }
  // Narrowed to a subtree without credential files, the search runs as given.
  for (const input of [
    { pattern: 'BENIGN', path: 'clean', output_mode: 'content' },
    { pattern: 'BENIGN', path: path.join(wt, 'clean'), glob: '**/*', output_mode: 'content' },
    { pattern: 'BENIGN', path: 'clean/deep', output_mode: 'count' },
    { pattern: 'x', path: 'late' }, // empty directory
    { pattern: 'BENIGN', path: 'ok.txt' }, // a file root
    { pattern: 'BENIGN', path: `sub/${DASHY}/readme.txt` },
  ]) {
    const d = allowed(await evaluateToolCall(policy, { toolName: 'Grep', input }), JSON.stringify(input));
    assert.ok(!('updatedInput' in d), 'no input rewrite');
  }
});

// ── Cause 2 (pre-execution side): no node_modules / VCS carve-out (g7) ──────

test('F3 g7: node_modules is enumerated like any directory, with or without a .gitignore', async () => {
  for (const gitignore of [false, true]) {
    const wt = await f3Worktree({ gitignore });
    const policy = readPolicy(wt);
    const scan = scanForCredentials(wt);
    assert.ok(scan.ok);
    for (const rel of ['node_modules/.env', `node_modules/${NM_DASHY}/.env`, `sub/${DASHY}/.env`, 'sub/cfg/deploy.key', 'up/.ENV', 'envs/.envrc', '.env']) {
      assert.ok(scan.scan.files.includes(rel), `scan (gitignore=${gitignore}) lists ${rel}: ${JSON.stringify(scan.scan.files)}`);
    }
    for (const input of [
      { pattern: 'NM_DASH', output_mode: 'content' },
      { pattern: 'NM_DASH', glob: 'node_modules/**', output_mode: 'content' },
      { pattern: 'NM_DASH', glob: '**/*', output_mode: 'content' },
      { pattern: 'NM_DASH', path: 'node_modules', output_mode: 'content' },
      { pattern: 'NM_DASH', path: `node_modules/${NM_DASHY}`, output_mode: 'content' },
    ]) {
      assert.equal(denied(await evaluateToolCall(policy, { toolName: 'Grep', input }), `gitignore=${gitignore} ${JSON.stringify(input)}`).code, 'credential_path');
    }
    for (const input of [{ pattern: 'node_modules/**' }, { pattern: '**/*', path: path.join(wt, 'node_modules') }, { pattern: '*', path: 'node_modules' }]) {
      assert.equal(denied(await evaluateToolCall(policy, { toolName: 'Glob', input }), `gitignore=${gitignore} ${JSON.stringify(input)}`).code, 'credential_path');
    }
  }
});

// ── Low: Glob, including non-normalised absolute patterns (gl1) ─────────────

test('F3 gl1: Glob is gated on the tree rg walks; non-normalised absolute patterns resolve to the right prefix', async () => {
  const wt = await f3Worktree();
  const policy = readPolicy(wt);
  for (const input of [
    { pattern: '**/*' },
    { pattern: '*', path: 'sub' },
    { pattern: `${fwd(wt)}//////.en?` },
    { pattern: `${fwd(wt)}/./././sub/cfg/*.k?y` },
    { pattern: `${fwd(wt)}/./sub/cfg/*` },
    { pattern: `${fwd(wt)}/sub/../clean/*` }, // `..` is refused outright
    { pattern: 'node_modules/**' },
    { pattern: 'sub/b*/.e*' },
    { pattern: 'clean/**/*.ts' }, // rg walks the cwd tree for a relative pattern
    { pattern: '*.txt' },
    { pattern: 'j1/*' },
    { pattern: '*', path: 'jsub' },
  ]) {
    const d = denied(await evaluateToolCall(policy, { toolName: 'Glob', input }), JSON.stringify(input));
    assert.ok(d.code === 'credential_path' || d.code === 'path_outside_roots', JSON.stringify(d));
  }
  for (const input of [
    { pattern: '**/*.ts', path: 'clean' },
    { pattern: '*', path: path.join(wt, 'clean', 'deep') },
    { pattern: `${fwd(wt)}/./clean/*.ts` },
    { pattern: `${fwd(wt)}//////clean/**/*.ts` },
    { pattern: `${fwd(wt)}/clean/./deep/*` },
    { pattern: '*', path: 'late' },
  ]) {
    allowed(await evaluateToolCall(policy, { toolName: 'Glob', input }), JSON.stringify(input));
  }
});

// ── s1: the same gate applies inside a spawned task agent ───────────────────

test('F3 s1: a task agent gets the same denials (and may not spawn)', async () => {
  const wt = await f3Worktree();
  const policy = readPolicy(wt);
  const sub = 'agent-sub-1';
  assert.equal(denied(await evaluateToolCall(policy, { toolName: 'Grep', input: { pattern: 'SECRET', output_mode: 'content' }, subagentId: sub })).code, 'credential_path');
  assert.equal(denied(await evaluateToolCall(policy, { toolName: 'Grep', input: { pattern: 'SUB_DASH', path: 'sub', output_mode: 'content' }, subagentId: sub })).code, 'credential_path');
  assert.equal(denied(await evaluateToolCall(policy, { toolName: 'Glob', input: { pattern: '**/*' }, subagentId: sub })).code, 'credential_path');
  assert.equal(denied(await evaluateToolCall(policy, { toolName: 'Read', input: { file_path: path.join(wt, '.env') }, subagentId: sub })).code, 'credential_path');
  assert.equal(denied(await evaluateToolCall(policy, { toolName: 'Agent', input: { description: 'g', prompt: 'again' }, subagentId: sub })).code, 'no_grandchildren');
  allowed(await evaluateToolCall(policy, { toolName: 'Grep', input: { pattern: 'BENIGN', path: 'clean' }, subagentId: sub }));
});

// ── Cause 2: uncapped PostToolUse redaction ─────────────────────────────────

test('F3 g6: output redaction has no prefix cap — a path with >= 64 dashes is withheld in content, count, -A and -n:false forms', async () => {
  const wt = await f3Worktree();
  const policy = readPolicy(wt);
  const grep = (content: string, mode = 'content'): unknown => ({ mode, numFiles: 1, filenames: [], content, numLines: content.split('\n').length });
  const dash200 = `${'c-'.repeat(200)}z`;
  const withheld: Array<[string, string, Record<string, unknown>, unknown]> = [
    ['66 dashes content', 'Grep', { pattern: 'S', output_mode: 'content' }, grep(`ok.txt:1:x\nsub/${DASHY}/.env:1:SECRET=SUB_DASH`)],
    ['200 dashes content', 'Grep', { pattern: 'S', output_mode: 'content' }, grep(`${dash200}/.env:1:SECRET=X`)],
    ['66 dashes count', 'Grep', { pattern: 'S', output_mode: 'count' }, grep(`sub/${DASHY}/.env:3`, 'count')],
    ['66 dashes -A context', 'Grep', { pattern: 'S', output_mode: 'content', '-A': 2 }, grep(`sub/${DASHY}/readme.txt:1:hi\nsub/${DASHY}/.env-2-SECRET=X`)],
    ['66 dashes -n false', 'Grep', { pattern: 'S', output_mode: 'content', '-n': false }, grep(`sub/${DASHY}/.env:SECRET=SUB_DASH`)],
    ['backslashes', 'Grep', { pattern: 'S', output_mode: 'content' }, grep(`sub\\${DASHY}\\.env:1:SECRET=SUB_DASH`)],
    ['absolute', 'Grep', { pattern: 'S', output_mode: 'content' }, grep(`${path.join(wt, 'sub', DASHY, '.env')}:1:SECRET=SUB_DASH`)],
    ['node_modules', 'Grep', { pattern: 'S', output_mode: 'content' }, grep(`node_modules/${NM_DASHY}/.env:1:SECRET=NM_DASH`)],
    ['.envrc', 'Grep', { pattern: 'S', output_mode: 'content' }, grep('envs/.envrc:1:SECRET=ENVRC')],
    ['.env-prod', 'Grep', { pattern: 'S', output_mode: 'content' }, grep('envs/.env-prod:1:SECRET=ENV_PROD')],
    ['deploy.key', 'Grep', { pattern: 'S', output_mode: 'content' }, grep('sub/cfg/deploy.key:1:SECRET=SUB_PEM')],
    ['files_with_matches', 'Grep', { pattern: 'S' }, { mode: 'files_with_matches', numFiles: 1, filenames: [`sub/${DASHY}/.env`] }],
    ['glob absolute', 'Glob', { pattern: '**/*' }, { durationMs: 1, numFiles: 1, filenames: [path.join(wt, 'sub', DASHY, '.env')], truncated: false }],
    ['glob junction', 'Glob', { pattern: 'j1/*' }, { durationMs: 1, numFiles: 1, filenames: [path.join(wt, 'j1', 'credentials')], truncated: false }],
    ['string response', 'Grep', { pattern: 'S' }, `sub/${DASHY}/.env:1:SECRET=SUB_DASH`],
    ['array response', 'Grep', { pattern: 'S' }, ['x']],
    ['number response', 'Glob', { pattern: '*' }, 42],
    ['filenames not an array', 'Glob', { pattern: '*' }, { durationMs: 1, numFiles: 1, filenames: 'x', truncated: false }],
    ['content not a string', 'Grep', { pattern: 'S', output_mode: 'content' }, { mode: 'content', numFiles: 0, filenames: [], content: ['x'] }],
  ];
  for (const [label, tool, input, res] of withheld) {
    const r = redactSearchOutput(policy, tool, input, res);
    assert.ok(r, `${label}: withheld`);
    assert.doesNotMatch(JSON.stringify(r.replacement), /SECRET|\.env|\.key|credentials|b-b-b/i, label);
    assert.equal(r.replacement['numFiles'], 0, label);
    assert.deepEqual(r.replacement['filenames'], [], label);
  }
  // Benign output — including long dashed paths — passes unchanged.
  for (const [label, tool, input, res] of [
    ['process.env in code', 'Grep', { pattern: 'env', path: 'clean', output_mode: 'content' }, grep('clean/a.ts:1:const x = process.env.FOO; // BENIGN')],
    ['66 dashes benign file', 'Grep', { pattern: 'hi', output_mode: 'content' }, grep(`sub/${DASHY}/readme.txt:1:hi BENIGN`)],
    ['66 dashes benign count', 'Grep', { pattern: 'hi', output_mode: 'count' }, grep(`sub/${DASHY}/readme.txt:1`, 'count')],
    ['markdown ruler', 'Grep', { pattern: '-', output_mode: 'content' }, grep(`notes.txt:2:|${'---|'.repeat(40)}`)],
    ['glob benign', 'Glob', { pattern: '**/*.ts', path: 'clean' }, { durationMs: 1, numFiles: 2, filenames: [path.join(wt, 'clean', 'a.ts'), path.join(wt, 'clean', 'deep', 'b.ts')], truncated: false }],
    ['empty', 'Grep', { pattern: 'x' }, grep('')],
    ['benign string', 'Grep', { pattern: 'x' }, 'No matches found'],
  ] as Array<[string, string, Record<string, unknown>, unknown]>) {
    assert.equal(redactSearchOutput(policy, tool, input, res), null, `${label}: benign`);
  }
});

test('F3: output that cannot be judged within bounds is withheld, never partially scanned', async () => {
  const wt = await f3Worktree();
  const policy = readPolicy(wt);
  const line = extras.lineCredentialRejection;
  assert.ok(typeof line === 'function', 'tool-policy.ts exports lineCredentialRejection (F3)');
  const maxBytes = extras.MAX_REDACTION_BYTES;
  const maxPairs = extras.MAX_BOUNDARY_PAIRS_PER_LINE;
  assert.ok(typeof maxBytes === 'number' && typeof maxPairs === 'number');
  // Every start (after each separator) x every end boundary is judged.
  assert.match(line(`sub/${DASHY}/.env:1:SECRET`, wt) ?? '', /\.env/);
  assert.match(line(`a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q/r/s/t/u/v/w/x/y/z/${'-'.repeat(70)}/.ssh/id_ed25519`, wt) ?? '', /\.ssh/);
  assert.equal(line(`sub/${DASHY}/readme.txt:1:hi`, wt), null);
  // A line with more boundary pairs than the cap is withheld unjudged.
  const pathological = `${'/-'.repeat(200)}`;
  assert.match(line(pathological, wt) ?? '', /boundary pairs|withheld/);
  const r = redactSearchOutput(policy, 'Grep', { pattern: 'x', output_mode: 'content' }, { mode: 'content', numFiles: 1, filenames: [], content: `ok.txt:1:x\n${pathological}` });
  assert.ok(r && /boundary pairs/.test(r.reason), JSON.stringify(r));
  // Oversized output is withheld unjudged.
  const big = redactSearchOutput(policy, 'Grep', { pattern: 'x', output_mode: 'content' }, { mode: 'content', numFiles: 1, filenames: [], content: 'ok.txt:1:x'.padEnd(maxBytes + 1, 'y') });
  assert.ok(big && /over \d+/.test(big.reason), JSON.stringify(big?.reason));
});

// ── SDK wiring ───────────────────────────────────────────────────────────────

test('F3: the SDK hooks deny a credential-tree Grep before execution and withhold a leaked output after, recording a denial', async () => {
  const wt = await f3Worktree();
  const policy = readPolicy(wt);
  const audit: string[] = [];
  const opts = buildClaudeSdkPermissionOptions(policy, { onDecision: (e) => audit.push(`${e.via}:${e.decision.allow ? 'allow' : e.decision.code}`) });
  const pre = opts.hooks.PreToolUse?.[0]?.hooks[0];
  const post = opts.hooks.PostToolUse?.[0]?.hooks[0];
  assert.ok(pre && post);
  const signal = new AbortController().signal;
  const denial = (await pre(
    { hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'SECRET', path: 'sub', output_mode: 'content' }, tool_use_id: 'g6', session_id: 's', transcript_path: 't', cwd: wt } as never,
    'g6',
    { signal },
  )) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string; updatedInput?: unknown } };
  assert.equal(denial.hookSpecificOutput?.permissionDecision, 'deny');
  assert.match(String(denial.hookSpecificOutput?.permissionDecisionReason), /narrow `path`/);
  assert.equal(denial.hookSpecificOutput?.updatedInput, undefined);
  const leaked = (await post(
    {
      hook_event_name: 'PostToolUse',
      tool_name: 'Grep',
      tool_input: { pattern: 'SUB_DASH', path: 'sub', output_mode: 'content' },
      tool_response: { mode: 'content', numFiles: 1, filenames: [], content: `sub\\${DASHY}\\.env:1:SECRET=SUB_DASH`, numLines: 1 },
      tool_use_id: 'g6b',
      session_id: 's',
      transcript_path: 't',
      cwd: wt,
    } as never,
    'g6b',
    { signal },
  )) as { hookSpecificOutput?: { updatedToolOutput?: Record<string, unknown> } };
  assert.doesNotMatch(JSON.stringify(leaked.hookSpecificOutput?.updatedToolOutput ?? {}), /SECRET|b-b-b/);
  assert.match(String(leaked.hookSpecificOutput?.updatedToolOutput?.['content']), /withheld/);
  assert.deepEqual(audit, ['PreToolUse:credential_path', 'PostToolUse:credential_path']);
});
