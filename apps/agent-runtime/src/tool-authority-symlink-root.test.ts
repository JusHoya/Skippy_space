// tool-authority-symlink-root.test.ts — the Grep/Glob pre-execution gate
// enumerates exactly the tree rg walks when the search root, or something
// below it, is a directory link — on every OS (T02 "Tool authority";
// FR-SEC-01, FR-SEC-02, G0, OQ-18).
//
// rg (the CLI runs it WITHOUT `--follow`; see `Au7` / Grep `call` quoted in
// tool-policy.ts) behaves the same on Windows and Linux:
//   - a link given as the explicit search path (Grep `path`, Glob `path`, the
//     base of an absolute Glob pattern) IS followed: rg walks the target;
//   - links met BELOW the search path are neither descended nor listed.
// So the gate must judge the tree behind a linked root (its real path: the
// credential rule, the root containment check and the tree scan all apply to
// the resolved root) and must not descend links below it. The first CI run
// on Linux only ever tested this with Windows junctions, which the fixtures
// created on win32 alone; these cases run everywhere:
//   - Windows: a junction (no privilege needed) and, where the process holds
//     SeCreateSymbolicLinkPrivilege (the GitHub runner does), a real
//     directory symlink;
//   - POSIX: a directory symlink.
// The last test uses the ripgrep embedded in the bundled CLI binary as an
// oracle for "what rg walks" and checks the gate against it.
//
// Run: node --import tsx --test src/tool-authority-symlink-root.test.ts

import { after, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Charter } from './charter.js';
import { credentialPathRejection, derivePolicy, evaluateToolCall, type ExecutionPolicy, type PolicyDecision } from './tool-policy.js';

delete process.env.OBSIDIAN_API_KEY;
process.env.OBSIDIAN_API_URL = 'http://127.0.0.1:55555';
process.env.LETTA_DISABLED = '1';

const isWin = process.platform === 'win32';

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

/** The directory-link kinds this OS can make: `junction` (Windows; on POSIX
 * the type is ignored, so it would just repeat `dir`) and `dir` (a real
 * symlink; on Windows it needs Developer Mode or the symlink privilege). */
const LINK_KINDS: ReadonlyArray<'junction' | 'dir'> = isWin ? ['junction', 'dir'] : ['dir'];

/** Create a directory link, or return why this environment cannot. */
async function dirLink(target: string, link: string, kind: 'junction' | 'dir'): Promise<string | null> {
  try {
    await fs.symlink(target, link, kind);
    return null;
  } catch (err) {
    return `${kind} links unavailable here (${(err as NodeJS.ErrnoException).code ?? String(err)})`;
  }
}

interface LinkedFixture {
  wt: string;
  outside: string;
}

/** A worktree whose linked roots point at a credential-bearing subtree
 * (`lsub`, `lchain`), a clean subtree (`lclean`), a credential directory
 * (`laws`) and a directory outside the roots (`lout`); `clean2/inner` is a
 * link BELOW a clean root onto the credential-bearing subtree. */
async function linkedWorktree(t: TestContext, kind: 'junction' | 'dir'): Promise<LinkedFixture | null> {
  const wt = await tmpDir(`skippy-symroot-${kind}-`);
  const outside = await tmpDir(`skippy-symroot-out-${kind}-`);
  await writeFiles(wt, {
    'sub/.env.local': 'SECRET=SUB\n',
    'sub/ok.txt': 'BENIGN\n',
    'clean/a.ts': 'BENIGN\n',
    'clean/deep/b.ts': 'BENIGN\n',
    'clean2/c.ts': 'BENIGN\n',
    '.aws/credentials': 'SECRET=AWS\n',
  });
  await writeFiles(outside, { 'ok.txt': 'BENIGN\n' });
  for (const [target, link] of [
    [path.join(wt, 'sub'), path.join(wt, 'lsub')],
    [path.join(wt, 'clean'), path.join(wt, 'lclean')],
    [path.join(wt, '.aws'), path.join(wt, 'laws')],
    [outside, path.join(wt, 'lout')],
    [path.join(wt, 'lsub'), path.join(wt, 'lchain')], // a link to a link
    [path.join(wt, 'sub'), path.join(wt, 'clean2', 'inner')],
  ] as const) {
    const why = await dirLink(target, link, kind);
    if (why) {
      t.skip(why);
      return null;
    }
  }
  return { wt, outside };
}

for (const kind of LINK_KINDS) {
  test(`symlinked root (${kind}): the gate judges the tree behind an explicit linked search root`, async (t) => {
    const fx = await linkedWorktree(t, kind);
    if (!fx) return;
    const { wt } = fx;
    const policy = readPolicy(wt);
    // rg follows the explicit root: the credential behind it denies the call.
    for (const [toolName, input] of [
      ['Grep', { pattern: 'SECRET', path: 'lsub', output_mode: 'content' }],
      ['Grep', { pattern: 'SECRET', path: path.join(wt, 'lsub') }],
      ['Grep', { pattern: 'SECRET', path: 'lchain', output_mode: 'count' }],
      ['Grep', { pattern: 'SECRET', path: 'lsub', glob: '*.txt' }], // a narrowing glob is not modelled
      ['Glob', { pattern: '*', path: 'lsub' }],
      ['Glob', { pattern: '**/*.txt', path: path.join(wt, 'lchain') }],
      ['Glob', { pattern: `${fwd(wt)}/lsub/*` }], // absolute: rg walks <wt>/lsub
      ['Glob', { pattern: `${fwd(wt)}/lsub/ok.txt` }], // no metacharacter: rg walks <wt>/lsub
      ['Grep', { pattern: 'SECRET', path: 'laws' }], // the root itself resolves to `.aws`
      ['Glob', { pattern: '*', path: 'laws' }],
    ] as const) {
      const d = denied(await evaluateToolCall(policy, { toolName, input: { ...input } }), `${toolName} ${JSON.stringify(input)}`);
      assert.equal(d.code, 'credential_path', `${toolName} ${JSON.stringify(input)}: ${JSON.stringify(d)}`);
    }
    // Reads through the linked directory resolve to the real name too.
    const read = denied(await evaluateToolCall(policy, { toolName: 'Read', input: { file_path: path.join(wt, 'laws', 'credentials') } }), 'Read laws/credentials');
    assert.equal(read.code, 'credential_path');
    // A link whose real target is outside the roots is outside the roots.
    for (const [toolName, input] of [
      ['Grep', { pattern: 'BENIGN', path: 'lout' }],
      ['Glob', { pattern: '*', path: 'lout' }],
      ['Glob', { pattern: `${fwd(wt)}/lout/*.txt` }],
      ['Read', { file_path: path.join(wt, 'lout', 'ok.txt') }],
    ] as const) {
      const d = denied(await evaluateToolCall(policy, { toolName, input: { ...input } }), `${toolName} ${JSON.stringify(input)}`);
      assert.equal(d.code, 'path_outside_roots', `${toolName} ${JSON.stringify(input)}: ${JSON.stringify(d)}`);
    }
    // A linked root onto a clean subtree works like the subtree itself.
    for (const [toolName, input] of [
      ['Grep', { pattern: 'BENIGN', path: 'lclean', output_mode: 'content' }],
      ['Glob', { pattern: '**/*.ts', path: 'lclean' }],
      ['Glob', { pattern: `${fwd(wt)}/lclean/**/*.ts` }],
      ['Read', { file_path: path.join(wt, 'lclean', 'a.ts') }],
    ] as const) {
      allowed(await evaluateToolCall(policy, { toolName, input: { ...input } }), `${toolName} ${JSON.stringify(input)}`);
    }
  });

  test(`symlinked root (${kind}): a link BELOW the search root is not descended, exactly like rg without --follow`, async (t) => {
    const fx = await linkedWorktree(t, kind);
    if (!fx) return;
    const { wt } = fx;
    const policy = readPolicy(wt);
    // rg lists nothing under `clean2/inner` (see the oracle test), so the
    // tree it walks holds no credential entry and the search runs.
    allowed(await evaluateToolCall(policy, { toolName: 'Grep', input: { pattern: 'BENIGN', path: 'clean2' } }), 'Grep clean2');
    allowed(await evaluateToolCall(policy, { toolName: 'Glob', input: { pattern: '**/*', path: 'clean2' } }), 'Glob clean2');
    // Naming the link as the root makes rg follow it: denied.
    assert.equal(denied(await evaluateToolCall(policy, { toolName: 'Grep', input: { pattern: 'SECRET', path: 'clean2/inner' } }), 'Grep clean2/inner').code, 'credential_path');
    assert.equal(denied(await evaluateToolCall(policy, { toolName: 'Glob', input: { pattern: `${fwd(wt)}/clean2/inner/*` } }), 'Glob clean2/inner/*').code, 'credential_path');
  });
}

// ── Oracle: the ripgrep embedded in the bundled CLI ──────────────────────────

/** The platform binary of @anthropic-ai/claude-agent-sdk (it runs as rg when
 * started with argv0 `rg`, which is how the CLI itself invokes it). */
function bundledCliBinary(): string | null {
  try {
    const req = createRequire(import.meta.url);
    const sdkReq = createRequire(req.resolve('@anthropic-ai/claude-agent-sdk'));
    for (const suffix of ['', '-musl']) {
      try {
        const dir = path.dirname(sdkReq.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}${suffix}/package.json`));
        const bin = path.join(dir, isWin ? 'claude.exe' : 'claude');
        if (existsSync(bin)) return bin;
      } catch {
        /* try the next variant */
      }
    }
  } catch {
    /* SDK not resolvable */
  }
  return null;
}

/** `rg --files` exactly as the CLI's Glob runs it (no `--follow`), in `cwd`. */
function rgFiles(bin: string, cwd: string, root: string): string[] {
  const r = spawnSync(bin, ['--no-config', '--files', '--hidden', '--no-ignore', root], {
    argv0: 'rg',
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  });
  assert.ok(r.status === 0 || r.status === 1, `rg ${root}: status ${r.status} ${r.stderr}`);
  return r.stdout.split(/\r?\n/).filter((l) => l !== '');
}

const RG_BIN = bundledCliBinary();
const RG_OK = RG_BIN !== null && /ripgrep/i.test(spawnSync(RG_BIN, ['--version'], { argv0: 'rg', encoding: 'utf8', timeout: 30_000, windowsHide: true }).stdout ?? '');

for (const kind of LINK_KINDS) {
  test(
    `symlinked root (${kind}) oracle: rg follows an explicit linked root and skips links below it; the gate denies every root whose rg listing holds a credential`,
    { skip: RG_OK ? false : 'the bundled CLI binary cannot run as rg here' },
    async (t) => {
      const fx = await linkedWorktree(t, kind);
      if (!fx) return;
      const { wt } = fx;
      const policy = readPolicy(wt);
      const bin = RG_BIN as string;
      const segs = (line: string): string[] => line.split(/[\\/]/);
      // rg behaviour the gate relies on.
      assert.ok(rgFiles(bin, wt, 'lsub').some((l) => segs(l).includes('.env.local')), 'rg follows an explicit linked root');
      assert.ok(rgFiles(bin, wt, 'lchain').some((l) => segs(l).includes('.env.local')), 'rg follows a chain of links given as the root');
      const below = rgFiles(bin, wt, 'clean2');
      assert.ok(below.some((l) => segs(l).includes('c.ts')), `rg lists clean2: ${JSON.stringify(below)}`);
      assert.ok(!below.some((l) => segs(l).includes('inner')), `rg does not descend a link below the root: ${JSON.stringify(below)}`);
      const top = rgFiles(bin, wt, '.');
      assert.ok(!top.some((l) => segs(l).some((s) => s === 'lsub' || s === 'lchain' || s === 'laws' || s === 'lout')), `rg skips links below the root: ${JSON.stringify(top)}`);
      // The gate is never weaker than rg: a root whose rg listing names a
      // credential is denied before rg runs.
      for (const root of ['lsub', 'lchain', 'laws', 'lclean', 'clean2', 'clean2/inner', 'sub', 'clean', '.']) {
        const listing = rgFiles(bin, wt, root);
        const leaks = listing.some((l) => segs(l).some((_, i, all) => credentialPathRejection(all.slice(0, i + 1).join('/')) !== null));
        const d = await evaluateToolCall(policy, { toolName: 'Grep', input: { pattern: 'SECRET', path: root } });
        if (leaks) assert.equal(d.allow, false, `rg lists a credential under ${root} (${JSON.stringify(listing)}) but the gate allowed it`);
        const g = await evaluateToolCall(policy, { toolName: 'Glob', input: { pattern: '*', path: root } });
        if (leaks) assert.equal(g.allow, false, `rg lists a credential under ${root} (${JSON.stringify(listing)}) but the Glob gate allowed it`);
      }
    },
  );
}
