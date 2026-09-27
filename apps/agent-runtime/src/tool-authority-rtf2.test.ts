// tool-authority-rtf2.test.ts — regression suite for the final red-team pass
// (F2) on T02 "Tool authority" (FR-SEC-01, FR-SEC-02, FR-BOARD-01, G0).
//
//   D1  8.3 short names (`ENV~1`, `AWS~1\credentials`) bypassed the name-based
//       credential deny list: the rule saw only the literal argument
//   D2  Grep/Glob results were never checked: `Grep SECRET` (no glob),
//       `glob: ".en?"`, `glob: "*.pe?"` and `Glob "**/*"` returned credentials
//       (F3 redesign: the tree rg walks is enumerated and any credential
//       entry in it denies the call; see tool-authority-rtf3.test.ts)
//   D3  a junction inside the root pointing at an in-root credential directory
//       (`lnk -> .aws`) bypassed the name check
//   D5  misspelled / lookalike authority keys (`permision_mode`, Cyrillic
//       `permissiоn_mode`) were silently ignored => `ask` instead of `plan`
//   D6  the anchor/alias ban missed non-ASCII anchor names (`&é` / `*é`)
//   +   `rootRejection` accepted `~/.ssh`, `~/AppData` as roots
//
// Every test here fails on a24234e and passes after the fix. The probes
// mirror the red-team's rtf2/u1.mts and rtf2/u2.mts.
//
// Run: node --import tsx --test src/tool-authority-rtf2.test.ts

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, existsSync, realpathSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as charterMod from './charter.js';
import type { Charter } from './charter.js';
import * as policyMod from './tool-policy.js';
import {
  ToolPolicyError,
  buildClaudeSdkPermissionOptions,
  derivePolicy,
  evaluateToolCall,
  rootRejection,
  type ExecutionPolicy,
  type PolicyDecision,
} from './tool-policy.js';

delete process.env.OBSIDIAN_API_KEY;
process.env.OBSIDIAN_API_URL = 'http://127.0.0.1:55555';
process.env.LETTA_DISABLED = '1';

const isWin = process.platform === 'win32';

// New exports (absent on the baseline): resolved lazily so each test fails
// on its own assertion rather than at module link time.
type PolicyExtras = {
  credentialTargetRejection?: (p: string) => string | null;
  scanForCredentials?: (root: string) => { ok: true; scan: { dirs: string[]; files: string[]; entries: number } } | { ok: false; reason: string };
  redactSearchOutput?: (
    policy: ExecutionPolicy,
    toolName: string,
    toolInput: unknown,
    toolResponse: unknown,
  ) => { replacement: Record<string, unknown>; reason: string } | null;
  editDistance?: (a: string, b: string) => number;
};
const extras = policyMod as unknown as PolicyExtras;
function extra<K extends keyof PolicyExtras>(name: K): NonNullable<PolicyExtras[K]> {
  const fn = extras[name];
  assert.ok(typeof fn === 'function', `tool-policy.ts exports ${name} (F2 fix)`);
  return fn as NonNullable<PolicyExtras[K]>;
}

function parseText(text: string): { frontmatter: Record<string, unknown>; body: string } {
  return charterMod.parseCharterText(text);
}

function synthetic(frontmatter: Record<string, unknown>): Charter {
  return { agentId: 'board.coding', frontmatter, body: 'synthetic body long enough', loaded: true, path: '(synthetic)' };
}

function denied(d: PolicyDecision, label = ''): Extract<PolicyDecision, { allow: false }> {
  assert.equal(d.allow, false, `${label}: expected a denial, got ${JSON.stringify(d)}`);
  return d as Extract<PolicyDecision, { allow: false }>;
}

function allowed(d: PolicyDecision, label = ''): Extract<PolicyDecision, { allow: true }> {
  assert.equal(d.allow, true, `${label}: expected allow, got ${JSON.stringify(d)}`);
  return d as Extract<PolicyDecision, { allow: true }>;
}

function refused(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  assert.fail('expected a refusal');
}

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

/** The red-team fixture: a worktree with well-known credential files, a
 * junction to an in-root credential directory and a benign file. */
async function credentialWorktree(): Promise<{ wt: string; junction: boolean }> {
  const wt = await tmpDir('skippy-rtf2-wt-');
  for (const d of ['.aws', '.ssh', 'sub', path.join('sub', 'deep')]) await fs.mkdir(path.join(wt, d), { recursive: true });
  const files: Record<string, string> = {
    '.env': 'SECRET_ENV=sk-ant-envleak\n',
    '.env.production': 'SECRET_ENVPROD=prodleak\n',
    '.aws/credentials': 'aws_secret_access_key=SECRET_AWS\n',
    '.ssh/config': 'SECRET_SSHCONFIG\n',
    '.ssh/id_ed25519': 'SECRET_SSHKEY\n',
    'server.pem': 'SECRET_PEM\n',
    'inside.txt': 'inside SECRET_NOT_A_CREDENTIAL\n',
    'sub/deep/notes.txt': 'plain\n',
  };
  for (const [rel, content] of Object.entries(files)) await fs.writeFile(path.join(wt, ...rel.split('/')), content);
  let junction = false;
  try {
    await fs.symlink(path.join(wt, '.aws'), path.join(wt, 'lnk'), 'junction');
    junction = true;
  } catch {
    junction = false;
  }
  return { wt, junction };
}

function readPolicy(wt: string, extra: Record<string, unknown> = {}): ExecutionPolicy {
  return derivePolicy(synthetic({ permission_mode: 'ask', tools: ['Read', 'Glob', 'Grep'], ...extra }), { worktreePath: wt });
}

/** 8.3 short name of `<wt>/<longName>` when the volume generates them. */
function shortNameFor(wt: string, longName: string, candidate: string): string | null {
  const p = path.join(wt, candidate);
  if (!existsSync(p)) return null;
  try {
    return path.basename(realpathSync.native(p)) === longName ? candidate : null;
  } catch {
    return null;
  }
}

// ── D1: 8.3 short names ──────────────────────────────────────────────────────

test('D1: an 8.3 short name never reaches a credential file (literal rule + real-path rule)', { skip: !isWin }, async () => {
  const { wt } = await credentialWorktree();
  const policy = readPolicy(wt);
  // The literal rule: any `~<digit>` segment is refused, whether or not the
  // volume has short names.
  for (const rel of ['ENV~1', 'ENV~1.PRO', 'AWS~1\\credentials', 'SSH~1\\config', 'sub\\NOTES~1.TXT']) {
    const d = denied(await evaluateToolCall(policy, { toolName: 'Read', input: { file_path: path.join(wt, rel) } }), `Read ${rel}`);
    assert.match(d.reason, /8\.3|short name|credential/i);
  }
  denied(await evaluateToolCall(policy, { toolName: 'Grep', input: { pattern: 'SECRET', path: path.join(wt, 'AWS~1') } }), 'Grep path AWS~1');
  denied(await evaluateToolCall(policy, { toolName: 'Grep', input: { pattern: 'SECRET', path: path.join(wt, 'SSH~1') } }), 'Grep path SSH~1');
  denied(await evaluateToolCall(policy, { toolName: 'Glob', input: { pattern: 'AWS~1/*' } }), 'Glob AWS~1/*');
  denied(await evaluateToolCall(policy, { toolName: 'Glob', input: { pattern: '*', path: path.join(wt, 'SSH~1') } }), 'Glob path SSH~1');
  // The real-path rule on its own (below the literal rule): the short name
  // canonicalises to the long name the deny list knows.
  const env = shortNameFor(wt, '.env', 'ENV~1');
  const aws = shortNameFor(wt, '.aws', 'AWS~1');
  if (env === null || aws === null) {
    // 8.3 generation disabled on this volume: the literal rule above still
    // holds; nothing more to prove here.
    return;
  }
  const target = extra('credentialTargetRejection');
  assert.match(target(path.join(wt, env)) ?? '', /resolves to .*\.env/i);
  assert.match(target(path.join(wt, aws, 'credentials')) ?? '', /resolves to .*\.aws/i);
  assert.equal(target(path.join(wt, 'inside.txt')), null);
});

// ── D3: junction to an in-root credential directory ──────────────────────────

test('D3: a junction inside the root that points at an in-root credential directory is denied via its real path', { skip: !isWin }, async () => {
  const { wt, junction } = await credentialWorktree();
  assert.ok(junction, 'junction created');
  const policy = readPolicy(wt);
  const d = denied(await evaluateToolCall(policy, { toolName: 'Read', input: { file_path: path.join(wt, 'lnk', 'credentials') } }), 'Read lnk/credentials');
  assert.equal(d.code, 'credential_path');
  assert.match(d.reason, /resolves to .*\.aws/i);
  assert.equal(denied(await evaluateToolCall(policy, { toolName: 'Grep', input: { pattern: 'SECRET', path: path.join(wt, 'lnk') } })).code, 'credential_path');
  assert.equal(denied(await evaluateToolCall(policy, { toolName: 'Glob', input: { pattern: '*', path: path.join(wt, 'lnk') } })).code, 'credential_path');
  assert.equal(denied(await evaluateToolCall(policy, { toolName: 'Glob', input: { pattern: 'lnk/*' } })).code, 'credential_path');
  // A new file under the junction (write class) resolves the same way.
  const wp = derivePolicy(synthetic({ permission_mode: 'acceptEdits', tools: ['Write'] }), { worktreePath: wt });
  assert.equal(denied(await evaluateToolCall(wp, { toolName: 'Write', input: { file_path: path.join(wt, 'lnk', 'new.txt'), content: 'x' } })).code, 'credential_path');
});

// ── D2: search results ───────────────────────────────────────────────────────
//
// F3 redesign: Grep/Glob are gated on the TREE rg walks, not on modelled
// filtering. A credential entry anywhere under the search root denies the
// call; the model is told to narrow `path`. Nothing is rewritten.

test('D2/F3: Grep is denied whenever the tree under its search root holds a credential entry — no rewrite', async () => {
  const { wt } = await credentialWorktree();
  const policy = readPolicy(wt);
  for (const input of [
    { pattern: 'SECRET', output_mode: 'content' },
    { pattern: 'SECRET', path: wt, output_mode: 'content' },
    { pattern: 'SECRET', glob: '.en?', output_mode: 'content' },
    { pattern: 'SECRET', glob: '[.]env', output_mode: 'content' },
    { pattern: 'SECRET', glob: '*.pe?', output_mode: 'content' },
    { pattern: 'SECRET', glob: '*.txt', output_mode: 'content' }, // a narrowing glob is not modelled: still denied
    { pattern: 'SECRET', type: 'txt' },
    { pattern: 'plain', path: path.join(wt, 'lnk') },
  ]) {
    const d = denied(await evaluateToolCall(policy, { toolName: 'Grep', input }), JSON.stringify(input));
    assert.equal(d.code, 'credential_path');
    assert.match(d.reason, /narrow `path`|credential/i);
    assert.ok(!('updatedInput' in d), 'no input rewrite exists any more');
  }
  // A subtree without credentials runs unchanged.
  const clean = allowed(await evaluateToolCall(policy, { toolName: 'Grep', input: { pattern: 'plain', path: path.join(wt, 'sub') } }));
  assert.ok(!('updatedInput' in clean));
  allowed(await evaluateToolCall(policy, { toolName: 'Grep', input: { pattern: 'plain', path: path.join(wt, 'sub'), glob: '**/*' } }));
  allowed(await evaluateToolCall(policy, { toolName: 'Grep', input: { pattern: 'plain', path: path.join(wt, 'inside.txt') } }), 'a file root');
});

test('D2/F3: Glob is denied whenever the tree rg walks holds a credential entry, whatever the pattern', async () => {
  const { wt } = await credentialWorktree();
  const policy = readPolicy(wt);
  for (const input of [
    { pattern: '**/*' },
    { pattern: '*' },
    { pattern: '**' },
    { pattern: '.en?' },
    { pattern: '[.]env' },
    { pattern: '*.pe?' },
    { pattern: '**/{config,id_*}' },
    { pattern: '.*' },
    { pattern: '*.txt' }, // narrowing patterns are not modelled: the tree decides
    { pattern: 'sub/**/*.txt' },
    { pattern: '**/*.md' },
    { pattern: `${wt.replace(/\\/g, '/')}/**/*` },
    { pattern: `${wt.replace(/\\/g, '/')}/./*.txt` },
    { pattern: '*', path: wt },
  ]) {
    const d = denied(await evaluateToolCall(policy, { toolName: 'Glob', input }), JSON.stringify(input));
    assert.equal(d.code, 'credential_path');
  }
  for (const input of [
    { pattern: '*', path: path.join(wt, 'sub') },
    { pattern: '**/*.txt', path: path.join(wt, 'sub') },
    { pattern: `${wt.replace(/\\/g, '/')}/sub/**/*` }, // absolute: rg runs in the static prefix
    { pattern: `${wt.replace(/\\/g, '/')}/./sub//deep/*` }, // non-normalised absolute prefix
  ]) {
    allowed(await evaluateToolCall(policy, { toolName: 'Glob', input }), JSON.stringify(input));
  }
});

test('D2/F3: the search-tree scan has no carve-outs and is bounded (a bound is a denial)', async () => {
  const scan = extra('scanForCredentials');
  const { wt } = await credentialWorktree();
  const r = scan(wt);
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual([...r.scan.dirs].sort(), ['.aws', '.ssh']);
  assert.deepEqual([...r.scan.files].sort(), ['.aws/credentials', '.env', '.env.production', '.ssh/config', '.ssh/id_ed25519', 'server.pem']);
  // Depth cap => denial, not a guess.
  const deep = await tmpDir('skippy-rtf2-deep-');
  let cur = deep;
  for (let i = 0; i < 45; i++) {
    cur = path.join(cur, 'd');
    await fs.mkdir(cur);
  }
  const dr = scan(deep);
  assert.equal(dr.ok, false);
  assert.match(dr.ok ? '' : dr.reason, /deeper than|narrow/);
  assert.equal(denied(await evaluateToolCall(readPolicy(deep), { toolName: 'Grep', input: { pattern: 'x' } })).code, 'credential_path');
  assert.equal(denied(await evaluateToolCall(readPolicy(deep), { toolName: 'Glob', input: { pattern: '*.txt' } })).code, 'credential_path');
  // A credential name with whitespace is just a credential name now.
  const odd = await tmpDir('skippy-rtf2-odd-');
  await fs.writeFile(path.join(odd, 'my key.pem'), 'SECRET');
  assert.equal(denied(await evaluateToolCall(readPolicy(odd), { toolName: 'Grep', input: { pattern: 'x' } })).code, 'credential_path');
  // node_modules and VCS directories are NOT carved out (F3: the carve-out leaked).
  const nm = await tmpDir('skippy-rtf2-nm-');
  await fs.mkdir(path.join(nm, 'node_modules', 'pkg'), { recursive: true });
  await fs.mkdir(path.join(nm, '.git'), { recursive: true });
  await fs.writeFile(path.join(nm, 'node_modules', 'pkg', '.env'), 'x');
  await fs.writeFile(path.join(nm, '.git', 'id_rsa'), 'x');
  assert.deepEqual((scan(nm) as { ok: true; scan: { files: string[] } }).scan.files.sort(), ['.git/id_rsa', 'node_modules/pkg/.env']);
  assert.equal(denied(await evaluateToolCall(readPolicy(nm), { toolName: 'Grep', input: { pattern: 'x' } })).code, 'credential_path');
  assert.equal(denied(await evaluateToolCall(readPolicy(nm), { toolName: 'Grep', input: { pattern: 'x', path: 'node_modules' } })).code, 'credential_path');
});

test('D2/F3: the SDK options deny Grep/Glob on PreToolUse (no rewrite) and withhold on PostToolUse', async () => {
  const { wt } = await credentialWorktree();
  const policy = readPolicy(wt);
  const audit: string[] = [];
  const opts = buildClaudeSdkPermissionOptions(policy, { onDecision: (e) => audit.push(`${e.via}:${e.decision.allow ? 'allow' : e.decision.code}`) });
  const pre = opts.hooks.PreToolUse?.[0]?.hooks[0];
  assert.ok(pre, 'PreToolUse hook');
  const out = (await pre(
    { hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'SECRET' }, tool_use_id: 'tu1', session_id: 's', transcript_path: 't', cwd: wt } as never,
    'tu1',
    { signal: new AbortController().signal },
  )) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string; updatedInput?: unknown } };
  assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny');
  assert.match(String(out.hookSpecificOutput?.permissionDecisionReason), /credential_path/);
  assert.equal(out.hookSpecificOutput?.updatedInput, undefined);
  const cut = await opts.canUseTool('Grep', { pattern: 'SECRET' }, { signal: new AbortController().signal, toolUseID: 'tu2' });
  assert.equal(cut.behavior, 'deny');
  // An allowed call passes through the hook untouched (no updatedInput).
  const ok = (await pre(
    { hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'plain', path: path.join(wt, 'sub') }, tool_use_id: 'tu3', session_id: 's', transcript_path: 't', cwd: wt } as never,
    'tu3',
    { signal: new AbortController().signal },
  )) as Record<string, unknown>;
  assert.deepEqual(ok, {});
  // PostToolUse: matched to the search tools, replaces credential-bearing output.
  const post = opts.hooks.PostToolUse?.find((m) => /Grep/.test(m.matcher ?? ''))?.hooks[0];
  assert.ok(post, 'PostToolUse hook for Grep/Glob');
  const leaked = {
    hook_event_name: 'PostToolUse',
    tool_name: 'Grep',
    tool_input: { pattern: 'SECRET', output_mode: 'content' },
    tool_response: { mode: 'content', numFiles: 0, filenames: [], content: 'server.pem:1:SECRET_PEM\n.env:1:SECRET_ENV=x', numLines: 2 },
    tool_use_id: 'tu4',
    session_id: 's',
    transcript_path: 't',
    cwd: wt,
  };
  const r = (await post(leaked as never, 'tu4', { signal: new AbortController().signal })) as {
    hookSpecificOutput?: { hookEventName?: string; updatedToolOutput?: Record<string, unknown> };
  };
  assert.equal(r.hookSpecificOutput?.hookEventName, 'PostToolUse');
  assert.equal(r.hookSpecificOutput?.updatedToolOutput?.['numFiles'], 0);
  assert.doesNotMatch(JSON.stringify(r.hookSpecificOutput?.updatedToolOutput), /SECRET_/);
  assert.deepEqual(audit, ['PreToolUse:credential_path', 'canUseTool:credential_path', 'PreToolUse:allow', 'PostToolUse:credential_path']);
});

test('D2: redactSearchOutput withholds any Grep/Glob result naming a credential path and passes benign results', async () => {
  const redact = extra('redactSearchOutput');
  const { wt } = await credentialWorktree();
  const policy = readPolicy(wt);
  const grep = (content: string, mode = 'content'): unknown => ({ mode, numFiles: 0, filenames: [], content, numLines: content.split('\n').length });
  for (const [label, tool, input, res] of [
    ['content', 'Grep', { pattern: 'x', output_mode: 'content' }, grep('.env:1:SECRET_ENV=x')],
    ['nested', 'Grep', { pattern: 'x', output_mode: 'content' }, grep('src\\index.ts:1:ok\n.ssh\\config:1:SECRET')],
    ['context line', 'Grep', { pattern: 'x', output_mode: 'content', '-C': 1 }, grep('my-app/.env-12-KEY=val')],
    ['count', 'Grep', { pattern: 'x', output_mode: 'count' }, grep('.aws\\credentials:3', 'count')],
    ['files', 'Grep', { pattern: 'x' }, { mode: 'files_with_matches', numFiles: 1, filenames: ['server.pem'] }],
    ['absolute', 'Grep', { pattern: 'x' }, { mode: 'files_with_matches', numFiles: 1, filenames: [path.join(wt, '.env.production')] }],
    ['junction', 'Grep', { pattern: 'x' }, { mode: 'files_with_matches', numFiles: 1, filenames: [path.join(wt, 'lnk', 'credentials')] }],
    ['glob', 'Glob', { pattern: '**/*' }, { durationMs: 1, numFiles: 2, filenames: ['inside.txt', '.ssh\\id_ed25519'], truncated: false }],
    ['glob alias', 'Task', { pattern: '**/*' }, { durationMs: 1, numFiles: 1, filenames: ['.npmrc'], truncated: false }],
  ] as Array<[string, string, Record<string, unknown>, unknown]>) {
    const r = redact(policy, tool, input, res);
    if (tool === 'Task') {
      assert.equal(r, null, `${label}: not a search tool`);
      continue;
    }
    assert.ok(r, `${label}: redacted`);
    assert.doesNotMatch(JSON.stringify(r.replacement), /SECRET|\.env|\.ssh|\.aws|\.pem|npmrc/i);
    assert.equal(r.replacement['numFiles'], 0);
    assert.deepEqual(r.replacement['filenames'], []);
    if (tool === 'Grep') assert.equal(r.replacement['mode'], (res as { mode: string }).mode);
    else assert.equal(r.replacement['truncated'], false);
  }
  for (const [tool, input, res] of [
    ['Grep', { pattern: 'inside', output_mode: 'content' }, grep('inside.txt:1:inside SECRET_NOT_A_CREDENTIAL')],
    ['Grep', { pattern: 'x' }, { mode: 'files_with_matches', numFiles: 1, filenames: ['sub\\deep\\notes.txt'] }],
    ['Glob', { pattern: '*.txt' }, { durationMs: 1, numFiles: 1, filenames: ['inside.txt'], truncated: false }],
    ['Grep', { pattern: 'x' }, grep('')],
    ['Read', { file_path: 'x' }, { type: 'text', file: { content: '.env' } }],
  ] as Array<[string, Record<string, unknown>, unknown]>) {
    assert.equal(redact(policy, tool, input, res), null, `${tool} ${JSON.stringify(res)} is benign`);
  }
});

// ── D5: lookalike authority keys ─────────────────────────────────────────────

test('D5: misspelled or lookalike authority keys are refused, never silently ignored', async () => {
  const ed = extra('editDistance');
  assert.equal(ed('permision_mode', 'permission_mode'), 1);
  assert.equal(ed('tools', 'tolos'), 1);
  assert.equal(ed('role', 'tools'), 3);
  const cyrillicO = String.fromCharCode(0x43e);
  const cases: Array<[string, string]> = [
    ['permision_mode: plan\ntools: [Agent, Read]', 'unknown_authority_field'],
    [`permissi${cyrillicO}n_mode: plan\ntools: [Agent, Read]`, 'invalid_charter_key'],
    ['tools​: [Bash]\ntools: [Read]', 'invalid_charter_key'],
    ['toolz: [Bash]\ntools: [Read]', 'unknown_authority_field'],
    ['tool: [Bash]\ntools: [Read]', 'unknown_authority_field'],
    ['mcp_server: [x]\ntools: [Read]', 'unknown_authority_field'],
    ['disalowed_tools: []\ntools: [Read]', 'unknown_authority_field'],
    ['permissionmode: plan\ntools: [Read]', 'unknown_authority_field'],
    ['memory:\n  permision_mode: plan\ntools: [Read]', 'unknown_authority_field'],
    [`costume:\n  h${cyrillicO}t: x\ntools: [Read]`, 'invalid_charter_key'],
  ];
  for (const [fm, code] of cases) {
    const { frontmatter } = parseText(`---\n${fm}\n---\nbody`);
    const err = refused(() => derivePolicy(synthetic(frontmatter), {}));
    assert.ok(err instanceof ToolPolicyError, `${JSON.stringify(fm)}: ${String(err)}`);
    assert.equal(err.code, code, `${JSON.stringify(fm)}: ${err.message}`);
  }
  // The intended charter still works and an Agent spawn is forbidden in plan.
  const plan = derivePolicy(synthetic(parseText('---\npermission_mode: plan\ntools: [Agent, Read]\n---\nb').frontmatter), {});
  assert.equal(plan.permissionMode, 'plan');
  assert.equal(denied(await evaluateToolCall(plan, { toolName: 'Agent', input: { description: 'd', prompt: 'p' } })).code, 'mode_forbids');
  // Distant, non-authority extension keys stay tolerated (schema lenience).
  const ok = derivePolicy(synthetic(parseText('---\ntools: [Read]\nfavorite_colour: teal\nrole: captain\n---\nb').frontmatter), {});
  assert.deepEqual([...ok.allowedTools], ['Read']);
});

// ── D6: non-ASCII anchors / aliases / tags ───────────────────────────────────

test('D6: anchors and aliases with non-ASCII names, and explicit tags, are refused', () => {
  const e = String.fromCharCode(0xe9);
  const cjk = String.fromCharCode(0x540d);
  for (const fm of [
    `tools: &${e} [Read]\ndisallowed_tools: *${e}`,
    `base: &${cjk}${cjk} [Read, Bash]\ntools: *${cjk}${cjk}`,
    `tools: [Read]\ndisallowed_tools: &${e}x []`,
    'tools:\n  - *é',
    'permission_mode: !!binary cGxhbg==\ntools: [Read]',
    'tools: !!set {Read, Bash}',
    'tools: !custom [Read]',
    'tools: !!str [Read]',
  ]) {
    const err = refused(() => parseText(`---\n${fm}\n---\nbody`));
    assert.equal(err.name, 'CharterParseError', `${JSON.stringify(fm)}: ${String(err)}`);
  }
  // Quoted scalars may still carry any of these characters.
  const ok = parseText(`---\ndisplay_name: "R&D *${e}* !now <<fast>>"\ncodename: 'A&${e} *${e}'\ntools: [Read]\n---\nbody`);
  assert.equal(ok.frontmatter['display_name'], `R&D *${e}* !now <<fast>>`);
  assert.deepEqual(ok.frontmatter['tools'], ['Read']);
});

// ── Observation: credential locations and profile directories as roots ──────

test('rootRejection refuses credential locations, home dot-directories and the AppData profile directories', () => {
  const home = path.join(path.parse(os.tmpdir()).root, 'Users', 'someone');
  const rejects = [
    path.join(home, '.ssh'),
    path.join(home, '.aws'),
    path.join(home, '.claude'),
    path.join(home, '.codex'),
    path.join(home, '.config'),
    path.join(home, 'AppData'),
    path.join(home, 'AppData', 'Local'),
    path.join(home, 'AppData', 'Roaming'),
    path.join(home, 'AppData', 'LocalLow'),
    path.join(home, 'Projects', 'x', '.ssh'),
    path.join(home, 'Projects', 'x', '.ssh', 'keys'),
    path.join(home, 'PROJEC~1', 'x'),
  ];
  for (const r of rejects) assert.ok(rootRejection(r, home), `${r} rejected`);
  const accepts = [path.join(home, 'Projects', 'x'), path.join(home, 'AppData', 'Local', 'Temp', 'wt'), path.join(home, 'src')];
  for (const r of accepts) assert.equal(rootRejection(r, home), null, `${r} accepted`);
});
