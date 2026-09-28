// executor-env.ts — the explicit, minimal environment and the ephemeral,
// private per-execution directories handed to the Claude Code CLI that backs
// the Claude Agent SDK executor (FR-SEC-01, OQ-18, OQ-22, M0-G06).
//
// WHY: SDK `Options.env` REPLACES the CLI's environment (sdk.d.ts: "it is not
// merged with `process.env`"; sdk.mjs 0.3.162 builds the child env as
// `options.env ? {...options.env} : {...process.env}`), and with no `env` the
// CLI inherits the sidecar's whole ambient environment. Verified against the
// CLI 2.1.162 bundled in the native binary, that environment can change tool
// behaviour and authority underneath the policy gate. The concrete case
// (M0-G06): the CLI picks its rg in `SX8`:
//
//     if (isFalsy(USE_BUILTIN_RIPGREP) && which('rg')) -> system rg, args []
//     else if (native build)                         -> embedded rg, ['--no-config']
//
// (`isFalsy` = `"0"|"false"|"no"|"off"`, case-insensitive). A system rg reads
// `RIPGREP_CONFIG_PATH`, so a user config holding `--follow` makes Grep/Glob
// descend junctions/symlinks the OQ-18 tree gate deliberately does not
// enumerate, and search content outside the roots. The SDK always spawns the
// native binary (no `pathToClaudeCodeExecutable` is ever passed), so with
// `USE_BUILTIN_RIPGREP` forced to a non-falsy value the embedded rg with
// `--no-config` is chosen deterministically.
//
// THE CONFIG DIRECTORY IS ALSO AN ENVIRONMENT (D1 of the M0-G06 re-audit).
// The CLI reads configuration, policy and env from files under
// `CLAUDE_CONFIG_DIR` (`s6()` = `CLAUDE_CONFIG_DIR ?? ~/.claude`) whatever
// `settingSources` says:
//   - global config `<cfg>/.config.json` (else `<cfg>/.claude.json`, `nV()`):
//     `IxH()` does `Object.assign(process.env, I78(C8().env, "globalConfig"))`
//     unconditionally, so an `env` block there re-injects every variable the
//     allowlist below dropped (`USE_BUILTIN_RIPGREP=0`, `RIPGREP_CONFIG_PATH`,
//     `ANTHROPIC_BASE_URL`, …);
//   - `<cfg>/remote-settings.json`: the cached remote managed settings, loaded
//     as `policySettings` (`bOH()`/`gL1()`) whenever `Ds()` is true — first-
//     party, an API key present, and `ANTHROPIC_BASE_URL` unset or
//     api.anthropic.com (`q5()`); policy settings carry `env`, `hooks`,
//     `permissions`, `disableAllHooks` (which switches the PreToolUse gate off)
//     and `allowManagedHooksOnly`;
//   - `<cfg>/settings.json` (userSettings; excluded by `settingSources: []`),
//     `<cfg>/agents`, `<cfg>/skills`, `<cfg>/commands`, `<cfg>/plugins`,
//     `<cfg>/CLAUDE.md`, `<cfg>/rules`, `<cfg>/keybindings.json`,
//     `<cfg>/.credentials.json`; and it WRITES `<cfg>/projects/<slug>/*.jsonl`
//     transcripts, `sessions`, `todos`, `shell-snapshots`, `debug`,
//     `history.jsonl`, `file-history`, `statsig`, `cache`, `.claude.json`.
// A persistent, shared config directory is therefore agent-reachable state:
// a board that can write into it (or into a root that contains it) changes
// the next run's tool behaviour and authority; transcripts in it are
// readable by a later board. So the directory is EPHEMERAL, PRIVATE and
// VALIDATED, by construction:
//   - `createExecutorConfigDir()` makes a fresh, random, empty directory per
//     execution (`mkdtemp`, mode 0700 where the OS honours it) under the
//     runtime-owned base `executorConfigBase()`; nothing is pre-seeded (the
//     CLI needs nothing to start and writes its own `.claude.json`), so none
//     of the files above exists when the CLI starts;
//   - the base is never inside a tool root: `rootRejection` (tool-policy.ts)
//     refuses any root that is, contains or is inside it, and the path guard
//     refuses any read/write/search target inside it (defense in depth);
//   - `removeExecutorConfigDir()` deletes the directory after the run, on
//     every path (success, error, cancel), and a directory is never reused;
//   - the location is not taken from the environment: the former
//     `SKIPPY_CLAUDE_CONFIG_DIR` override is gone, and the test-only
//     `executorEnvOverrides` seam cannot set `CLAUDE_CONFIG_DIR` (it is
//     forced after the overrides).
// Remote managed settings fetched during a run (`/api/claude_code/settings`
// with the operator's key) are the operator's own org policy and stay in
// scope of OQ-22's "managed settings still apply"; they cannot be planted
// because the cache file starts absent and dies with the directory. The CLI
// has no dedicated switch for that fetch (`K4H()` is a stub; only
// `CLAUDE_CODE_ENTRYPOINT=local-agent` disables it, and that entrypoint also
// changes subprocess env scrubbing, MCP env allowlisting and trust branches,
// so it is not used).
//
// THE RUN SUPPORT DIRECTORY (per execution, beside the config directory).
// `<cfg>.support/` is created and destroyed with the config directory and
// holds the other per-run state the executor needs to exist on disk:
//   - `no-root-cwd/`  — the working directory of a board with NO filesystem
//     roots (`noRootWorkingDirectory`). Formerly a single persistent
//     `<tmp>/skippy-agent-runtime/no-root` shared by every no-root board and
//     selectable through `SKIPPY_NO_ROOT_CWD`; anything one run left there
//     (a `.git`, see below) was the next run's startup context. Now fresh
//     and empty per run, inside the executor state base (so `rootRejection`
//     refuses it as a root and every tool path in it is denied), and gone
//     afterwards.
//   - `git/config`    — an EMPTY file that is the executor's global git config.
//   - `git/hooks/`    — an EMPTY directory that is the executor's hooks path.
//
// GIT IS ALSO AN ENVIRONMENT (D-A of the M1 pre-flight). At startup the CLI
// runs, in its cwd, `git --no-optional-locks status --short`, `git log
// --oneline -n 5`, `git config user.name` and `git rev-parse` (system
// context `QD` -> `Dkq`; `wD()` = "is cwd inside a repo"), through execa
// with the CLI's own environment. Git reads the REPO configuration of that
// worktree — `<wt>/.git/config` (or the gitdir a `<wt>/.git` FILE points to,
// plus `commondir/config` for a linked worktree), every `include.path` /
// `includeIf` it names, `<wt>/.gitattributes` and `<wt>/.git/info/attributes`
// — and several keys there run code during a read-only `git status`
// (verified empirically, git 2.45):
//   core.fsmonitor=<script>   runs the script on every status (also via an
//                             include, a gitdir file, or the global config);
//   filter.<x>.clean/process  run when status re-hashes a racily-clean or
//                             same-size-modified file carrying `filter=<x>`;
//   core.hooksPath / hooks    NOT run by status/log/rev-parse (post-index-
//                             change needs an index write; not observed);
//   core.pager, core.editor   never consulted (no TTY, no editing commands);
//   credential.helper, core.sshCommand, url.*.insteadOf, protocol.*
//                             network commands only, never spawned here.
// A board that could write `<wt>/.git/config` (allowed before this change:
// `.git` is not a credential name) planted `core.fsmonitor` and the NEXT run
// — a read-only board with zero tool calls — executed it. Two independent
// layers now close that, and each is tested on its own:
//   1. tool-policy.ts: git metadata is never board-writable
//      (`gitMetadataRejection`: any `.git` segment at any depth, a gitdir a
//      `.git` file/link points to and its commondir, `.gitattributes`,
//      `.gitmodules`, `.gitconfig`; literal and real path). So no driver,
//      hook, include, fsmonitor or attribute assignment can be introduced.
//   2. this file: the executor's git is neutralised whatever the repo says:
//      `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1` (verified in cli.js: `iJ8()`
//      false => `QD` skips `Dkq`, the startup status/log/config calls, and
//      the git section of the system prompt), `GIT_CONFIG_NOSYSTEM=1`,
//      `GIT_CONFIG_GLOBAL=<support>/git/config` (empty: the user's global
//      config is ambient and not consulted), `GIT_TERMINAL_PROMPT=0`, and
//      `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` overrides,
//      which git applies with command-line precedence over every file and
//      include (`EXECUTOR_GIT_CONFIG_OVERRIDES`): `core.fsmonitor=false`,
//      `core.hooksPath=<support>/git/hooks` (empty), `core.untrackedCache=false`,
//      `core.pager=cat`, `safe.bareRepository=explicit` (D-A1: an implicit
//      bare layout — HEAD + objects/ + refs/ in an ordinary directory — is
//      never discovered, so its `config` is never loaded; the command scope
//      is protected configuration, so git honours it from the env; verified
//      on git 2.45, normal repos / linked worktrees unaffected). With git
//      instructions disabled the only git the CLI 2.1.162 still spawns is
//      `git config --get remote.origin.url` (M1 pre-flight trace), which
//      reads config and runs nothing. Filter drivers cannot be pinned generically (their
//      names are arbitrary); a driver a USER configured in their own repo is
//      that user's own command (looked up on the sidecar's PATH, never a
//      board-writable file) and the startup status that would trigger it is
//      off. The overrides also reach any git an owner-approved Bash command
//      runs (the CLI's Bash env is built from its own process env), which is
//      intended: repo hooks and fsmonitor are board-adjacent code. Cost: the
//      user's global identity/credential helpers are not seen by executor-
//      spawned git; no approval channel exists yet (OQ-14), so nothing is
//      broken today — revisit with FR-SEC-03.
//
// SWEEPS. `sweepExecutorState()` (on runtime start and before every run)
// removes `run-*` directories under the base older than one hour whose
// owner process (`<support>/pid`) is no longer alive (a crashed sidecar's
// leftovers) and the legacy persistent `<tmp>/skippy-agent-runtime/
// claude-config` and `…/no-root` directories. Only exact runtime-owned
// names, `lstat`ed real directories (a junction or symlink is skipped,
// never followed or unlinked).
//
// MODEL: allowlist, never denylist. Only the variables below are copied from
// the source environment; everything else (every `CLAUDE_CODE_*` toggle,
// `CLAUDE_CONFIG_DIR`, `RIPGREP_CONFIG_PATH`, `SHELL`, proxy / CA variables,
// `NODE_*`, `GIT_*`, cloud-provider credentials, `EMBEDDED_SEARCH_TOOLS`,
// `ANTHROPIC_*` model/header overrides, …) is dropped. A few values are then
// FORCED (they override any source value, and a forced key is never copied).
//
// Copied when present (why each is required to run):
//   PATH                         — locating `git` (the CLI's startup git
//                                  status) and Git Bash; rg is NOT looked up
//                                  (embedded rg is forced).
//   HOME, USERPROFILE,           — `os.homedir()` (the CLI refuses to rg-walk
//   HOMEDRIVE, HOMEPATH            the home directory).
//   TEMP, TMP, TMPDIR            — the CLI's temp files (spilled tool output).
//   APPDATA, LOCALAPPDATA        — Windows per-user app dirs used by git/Bun.
//   SystemRoot, SystemDrive,     — Windows system variables every Windows
//   windir, ComSpec, PATHEXT,      process (git, Bun's `which`, CreateProcess)
//   ProgramData, ProgramFiles,     expects; machine-set, not user tool config.
//   ProgramFiles(x86), ProgramW6432
//   ANTHROPIC_API_KEY            — the executor's credential (the execution
//                                  gate requires it; no other auth is used).
//   ANTHROPIC_BASE_URL           — the operator's Messages API endpoint
//                                  (gateway; the live CLI mock tests). It
//                                  moves where requests go, not what tools may
//                                  do.
//   CLAUDE_CODE_GIT_BASH_PATH    — Windows only: the CLI finds Git Bash in the
//                                  standard install paths or next to `git` on
//                                  PATH; this names one installed elsewhere.
//                                  It only selects the Bash tool's shell, and
//                                  the Bash tool is policy-gated (exec is
//                                  approval-required, OQ-14).
// Forced:
//   USE_BUILTIN_RIPGREP=1        — embedded rg with `--no-config` (above).
//   CLAUDE_CONFIG_DIR=<run dir>  — the fresh per-execution directory (above);
//                                  forced AFTER the test-only overrides.
//   CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
//                                — only the Messages API is needed; no
//                                  telemetry, error reporting or autoupdate
//                                  egress (the adapter claims no egress
//                                  control, so it keeps egress minimal). This
//                                  is also the configuration every live CLI
//                                  test has been verified under.
//   CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1, GIT_CONFIG_NOSYSTEM=1,
//   GIT_CONFIG_GLOBAL, GIT_TERMINAL_PROMPT=0, GIT_CONFIG_COUNT/KEY_n/VALUE_n
//                                — the git neutralisation (above). Set before
//                                  the test-only overrides so a sensitivity
//                                  control can prove the hostile scenario is
//                                  real; production never passes overrides.
//
// Re-audit on every SDK/CLI bump (the `SX8` selection, the env list the CLI
// reads, the files it reads under `CLAUDE_CONFIG_DIR`, `Ds()`/`q5()`, the
// `iJ8()` gate of the startup git context and the git subcommands the CLI
// spawns, and the SDK's env semantics). Proxy / CA variables are deliberately
// not forwarded (OQ-22).

import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Copied from the source environment when present. Matched
 * case-insensitively on Windows (whose environment is case-insensitive) and
 * emitted under this canonical spelling. */
export const EXECUTOR_ENV_ALLOWLIST: readonly string[] = Object.freeze([
  'PATH',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'TEMP',
  'TMP',
  'TMPDIR',
  'APPDATA',
  'LOCALAPPDATA',
  'SystemRoot',
  'SystemDrive',
  'windir',
  'ComSpec',
  'PATHEXT',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_GIT_BASH_PATH',
]);

/** The value the CLI treats as "use the embedded rg" (anything not falsy). */
export const FORCED_BUILTIN_RIPGREP = '1';

/** Prefix of every per-execution config directory under the base. */
export const EXECUTOR_CONFIG_DIR_PREFIX = 'run-';

/** Suffix of the per-execution support directory (`<cfg>.support`). */
export const EXECUTOR_SUPPORT_DIR_SUFFIX = '.support';

/** Per-run directories under the base older than this are swept as the
 * leftovers of a crashed sidecar. */
export const EXECUTOR_STALE_RUN_MS = 60 * 60 * 1000;

/**
 * Git configuration keys forced on every git the executor (or anything it
 * spawns) runs, with command-line precedence over every config file and
 * include (`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`).
 * `hooksPath` is resolved against the run's support directory.
 */
export const EXECUTOR_GIT_CONFIG_OVERRIDES: ReadonlyArray<readonly [key: string, value: string | 'hooksPath']> =
  Object.freeze([
    ['core.fsmonitor', 'false'],
    ['core.hooksPath', 'hooksPath'],
    ['core.untrackedCache', 'false'],
    ['core.pager', 'cat'],
    // D-A1: an implicit bare repository (a directory holding HEAD + objects/
    // + refs/, e.g. one a board assembled from ordinary files) is never
    // discovered; only `--git-dir`/`GIT_DIR` could select one. Honoured from
    // the command scope (GIT_CONFIG_COUNT is command scope, which git treats
    // as protected configuration). Normal repos, linked worktrees and
    // submodule gitdirs are unaffected (verified, git 2.45).
    ['safe.bareRepository', 'explicit'],
  ] as const);

/**
 * The runtime-owned base under which every per-execution CLI config directory
 * is created: `<tmp>/skippy-agent-runtime/executor-config`. It is a fixed
 * location derived from the platform temp directory, never from a
 * `SKIPPY_*` variable, and it is excluded from tool roots and tool paths by
 * tool-policy.ts. Resolved to its real long path when it exists (the CLI
 * matches config paths textually, and the SDK warns that `CLAUDE_CONFIG_DIR`
 * must match "same path, same separators").
 */
export function executorConfigBase(tmp: string = os.tmpdir()): string {
  return realpathOrSelf(path.join(path.resolve(tmp), 'skippy-agent-runtime', 'executor-config'));
}

/** The legacy persistent directories earlier designs used under the runtime
 * temp directory; swept whenever seen (never consulted any more). */
export function legacyExecutorDirs(tmp: string = os.tmpdir()): string[] {
  const base = path.join(path.resolve(tmp), 'skippy-agent-runtime');
  return [path.join(base, 'claude-config'), path.join(base, 'no-root')];
}

/** fs options as a null-prototype record (M1 pre-flight D-B2): Node reads
 * option fields (`recursive`, `mode`, `flag`, `signal`, …) through the
 * prototype chain, so a polluted `Object.prototype` must not reach the
 * per-run directory's creation, permissions or removal. */
function fsOptions<T extends object>(o: T): T {
  return Object.assign(Object.create(null) as T, o);
}

function realpathOrSelf(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** True when `dir` is a per-execution config directory: a direct child of the
 * base whose name carries the prefix and is not a support directory
 * (compared on the real long path). */
export function isExecutorConfigDir(dir: string, base: string = executorConfigBase()): boolean {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) return false;
  const abs = realpathOrSelf(path.resolve(dir));
  const parent = path.dirname(abs);
  const name = path.basename(abs);
  return (
    samePath(parent, realpathOrSelf(base)) &&
    name.startsWith(EXECUTOR_CONFIG_DIR_PREFIX) &&
    !name.endsWith(EXECUTOR_SUPPORT_DIR_SUFFIX)
  );
}

/** The per-run support directory beside a config directory. */
export function executorSupportDir(configDir: string): string {
  return `${configDir}${EXECUTOR_SUPPORT_DIR_SUFFIX}`;
}

/** The empty, per-run working directory of a board with no filesystem roots. */
export function noRootWorkingDirectory(configDir: string): string {
  return path.join(executorSupportDir(configDir), 'no-root-cwd');
}

/** The empty per-run global git config file and hooks directory. */
export function executorGitPaths(configDir: string): { config: string; hooks: string } {
  const git = path.join(executorSupportDir(configDir), 'git');
  return { config: path.join(git, 'config'), hooks: path.join(git, 'hooks') };
}

/** Config directories created by this process and not yet removed (never
 * swept while listed, however long the run takes). */
const activeRuns = new Set<string>();

function runKey(configDir: string): string {
  const abs = realpathOrSelf(path.resolve(configDir));
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

/** `<support>/pid`: the process that owns a run. Another sidecar process
 * (or a test runner) sweeping the base skips a run whose owner is alive,
 * however old the directory looks. */
function runPidFile(configDir: string): string {
  return path.join(executorSupportDir(configDir), 'pid');
}

/** True when the process recorded as the run's owner is still alive. A
 * missing or malformed pid file means "no live owner". */
function runOwnerAlive(configDir: string): boolean {
  let pid: number;
  try {
    const st = lstatSync(runPidFile(configDir));
    if (!st.isFile()) return false;
    pid = Number.parseInt(readFileSync(runPidFile(configDir), 'utf8').trim(), 10);
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Create a fresh, empty, randomly named config directory for ONE execution,
 * plus its support directory (`<cfg>.support/no-root-cwd`, `git/config`
 * (empty file), `git/hooks` (empty dir)). The base is created with mode 0700
 * (honoured on POSIX; on Windows the per-user temp directory already carries
 * user-only ACLs) and the run directory by `mkdtemp` (0700 on POSIX).
 * Returns the real long path of the config directory.
 */
export function createExecutorConfigDir(base: string = executorConfigBase()): string {
  mkdirSync(base, fsOptions({ recursive: true, mode: 0o700 }));
  const dir = realpathOrSelf(mkdtempSync(path.join(base, EXECUTOR_CONFIG_DIR_PREFIX)));
  const git = executorGitPaths(dir);
  mkdirSync(noRootWorkingDirectory(dir), fsOptions({ recursive: true, mode: 0o700 }));
  mkdirSync(git.hooks, fsOptions({ recursive: true, mode: 0o700 }));
  writeFileSync(git.config, '', fsOptions({ mode: 0o600 }));
  writeFileSync(runPidFile(dir), `${process.pid}\n`, fsOptions({ mode: 0o600 }));
  activeRuns.add(runKey(dir));
  return dir;
}

/**
 * Delete a per-execution config directory and its support directory.
 * Refuses (returns false, deletes nothing) unless `dir` is a run directory
 * under the base — this function must never be pointed at anything else. The
 * CLI child can still hold a transcript open for a moment after the stream
 * ends (Windows), so removal is retried for up to ~`maxWaitMs`. Returns true
 * once both directories are gone.
 */
export async function removeExecutorConfigDir(
  dir: string,
  base: string = executorConfigBase(),
  maxWaitMs = 5_000,
): Promise<boolean> {
  if (!isExecutorConfigDir(dir, base)) return false;
  activeRuns.delete(runKey(dir));
  const targets = [dir, executorSupportDir(dir)];
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    for (const t of targets) {
      try {
        rmSync(t, fsOptions({ recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
      } catch {
        /* retried below */
      }
    }
    if (targets.every((t) => !existsDir(t))) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
}

function existsDir(p: string): boolean {
  try {
    realpathSync.native(p);
    return true;
  } catch {
    return false;
  }
}

export interface ExecutorSweepResult {
  /** Directories removed (real directories only). */
  removed: string[];
  /** Entries left alone: active runs, fresh runs, reparse points, foreign names. */
  skipped: string[];
}

/**
 * Remove the leftovers of crashed or interrupted runs and the legacy
 * persistent directories. Under the base, only direct children named
 * `run-*` (config and support directories) that `lstat` as a REAL directory
 * (a junction/symlink named like a run is skipped, never followed or
 * unlinked), are older than `maxAgeMs` and are not a run of this process are
 * removed. The legacy directories are removed whatever their age when they
 * are real directories. Never throws.
 */
export function sweepExecutorState(opts: {
  base?: string;
  tmp?: string;
  now?: number;
  maxAgeMs?: number;
} = {}): ExecutorSweepResult {
  // Own-property option reads (D-B2): an inherited `base` must never point
  // the sweep at another directory.
  const ownOpt = (k: 'base' | 'tmp' | 'now' | 'maxAgeMs'): unknown => (Object.hasOwn(opts, k) ? opts[k] : undefined);
  const baseOpt = ownOpt('base');
  const nowOpt = ownOpt('now');
  const ageOpt = ownOpt('maxAgeMs');
  const tmpOpt = ownOpt('tmp');
  const base = typeof baseOpt === 'string' ? baseOpt : executorConfigBase();
  const now = typeof nowOpt === 'number' ? nowOpt : Date.now();
  const maxAgeMs = typeof ageOpt === 'number' ? ageOpt : EXECUTOR_STALE_RUN_MS;
  const result: ExecutorSweepResult = { removed: [], skipped: [] };
  const removeRealDir = (p: string, minAge: number): void => {
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(p);
    } catch {
      return; // absent
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      result.skipped.push(p);
      return;
    }
    if (minAge > 0 && now - st.mtimeMs < minAge) {
      result.skipped.push(p);
      return;
    }
    try {
      rmSync(p, fsOptions({ recursive: true, force: true, maxRetries: 2, retryDelay: 50 }));
      result.removed.push(p);
    } catch {
      result.skipped.push(p);
    }
  };
  let children: string[] = [];
  try {
    children = readdirSync(base);
  } catch {
    children = [];
  }
  for (const name of children) {
    if (!name.startsWith(EXECUTOR_CONFIG_DIR_PREFIX)) continue;
    const full = path.join(base, name);
    const cfg = name.endsWith(EXECUTOR_SUPPORT_DIR_SUFFIX) ? full.slice(0, -EXECUTOR_SUPPORT_DIR_SUFFIX.length) : full;
    // A run of this process, or of any live process (the `pid` file in the
    // run's support directory), is never swept, however old it looks.
    if (activeRuns.has(runKey(cfg)) || runOwnerAlive(cfg)) {
      result.skipped.push(full);
      continue;
    }
    removeRealDir(full, maxAgeMs);
  }
  for (const legacy of legacyExecutorDirs(typeof tmpOpt === 'string' ? tmpOpt : undefined)) removeRealDir(legacy, 0);
  return result;
}

/**
 * Build the complete environment for the executor's CLI process from
 * `source` (the sidecar's environment): the allowlisted variables, then the
 * forced values. `configDir` MUST be a per-execution directory from
 * `createExecutorConfigDir()` with its support directory present (anything
 * else throws). `overrides` is a test-only seam (code-level injection through
 * `ExecuteBoardMissionDeps`, never read from the environment); it is applied
 * after the allowlist and the forced values and may reintroduce anything
 * EXCEPT `CLAUDE_CONFIG_DIR`, which is forced last so no seam can point the
 * executor at a persistent or shared directory.
 */
export function buildClaudeExecutorEnv(
  source: NodeJS.ProcessEnv,
  configDir: string,
  overrides?: Readonly<Record<string, string>>,
  platform: NodeJS.Platform = process.platform,
): ClaudeExecutorEnv {
  if (!isExecutorConfigDir(configDir)) {
    throw new Error(`executor config dir ${JSON.stringify(configDir)} is not a per-execution directory under ${executorConfigBase()}`);
  }
  const git = executorGitPaths(configDir);
  if (!existsDir(git.hooks) || !isRegularFile(git.config) || !existsDir(noRootWorkingDirectory(configDir))) {
    throw new Error(`executor support directory ${JSON.stringify(executorSupportDir(configDir))} is incomplete`);
  }
  const fold = (k: string): string => (platform === 'win32' ? k.toUpperCase() : k);
  const byKey = new Map<string, string>();
  for (const [k, v] of Object.entries(source)) {
    if (typeof v === 'string') byKey.set(fold(k), v);
  }
  const copied: Record<string, string> = {};
  for (const name of EXECUTOR_ENV_ALLOWLIST) {
    const v = byKey.get(fold(name));
    if (v !== undefined) copied[name] = v;
  }
  const env: Record<string, string> = {
    ...copied,
    USE_BUILTIN_RIPGREP: FORCED_BUILTIN_RIPGREP,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ...gitNeutralisationEnv(configDir),
  };
  if (overrides) {
    for (const [k, v] of Object.entries(overrides)) {
      // Case-insensitive on every OS: no spelling of CLAUDE_CONFIG_DIR may be
      // supplied, even where env names are case-sensitive (POSIX).
      if (k.toUpperCase() === 'CLAUDE_CONFIG_DIR') continue;
      env[k] = v;
    }
  }
  env['CLAUDE_CONFIG_DIR'] = configDir;
  return env as ClaudeExecutorEnv;
}

/** The git-neutralising variables for a run (see the header). */
export function gitNeutralisationEnv(configDir: string): Record<string, string> {
  const git = executorGitPaths(configDir);
  const env: Record<string, string> = {
    CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: git.config,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: String(EXECUTOR_GIT_CONFIG_OVERRIDES.length),
  };
  EXECUTOR_GIT_CONFIG_OVERRIDES.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value === 'hooksPath' ? git.hooks : value;
  });
  return env;
}

function isRegularFile(p: string): boolean {
  try {
    return lstatSync(p).isFile();
  } catch {
    return false;
  }
}

export type ClaudeExecutorEnv = Record<string, string> & { CLAUDE_CONFIG_DIR: string };
