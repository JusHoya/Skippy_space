// executor-env.ts — the explicit, minimal environment and the ephemeral,
// private configuration directory handed to the Claude Code CLI that backs
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
//   HOMEDRIVE, HOMEPATH            the home directory; git's global config).
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
//
// Re-audit on every SDK/CLI bump (the `SX8` selection, the env list the CLI
// reads, the files it reads under `CLAUDE_CONFIG_DIR`, `Ds()`/`q5()` and the
// SDK's env semantics). Proxy / CA variables are deliberately not forwarded
// (OQ-22).

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
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

function realpathOrSelf(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

/** True when `dir` is a per-execution config directory: a direct child of the
 * base whose name carries the prefix (compared on the real long path). */
export function isExecutorConfigDir(dir: string, base: string = executorConfigBase()): boolean {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) return false;
  const abs = realpathOrSelf(path.resolve(dir));
  const parent = path.dirname(abs);
  const same = (a: string, b: string): boolean =>
    process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  return same(parent, realpathOrSelf(base)) && path.basename(abs).startsWith(EXECUTOR_CONFIG_DIR_PREFIX);
}

/**
 * Create a fresh, empty, randomly named config directory for ONE execution.
 * The base is created with mode 0700 (honoured on POSIX; on Windows the
 * per-user temp directory already carries user-only ACLs) and the run
 * directory by `mkdtemp` (0700 on POSIX). Returns the real long path.
 */
export function createExecutorConfigDir(base: string = executorConfigBase()): string {
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(path.join(base, EXECUTOR_CONFIG_DIR_PREFIX));
  return realpathOrSelf(dir);
}

/**
 * Delete a per-execution config directory. Refuses (returns false, deletes
 * nothing) unless `dir` is a run directory under the base — this function
 * must never be pointed at anything else. The CLI child can still hold a
 * transcript open for a moment after the stream ends (Windows), so removal
 * is retried for up to ~`maxWaitMs`. Returns true once the directory is gone.
 */
export async function removeExecutorConfigDir(
  dir: string,
  base: string = executorConfigBase(),
  maxWaitMs = 5_000,
): Promise<boolean> {
  if (!isExecutorConfigDir(dir, base)) return false;
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      /* retried below */
    }
    if (!existsDir(dir)) return true;
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

/**
 * Build the complete environment for the executor's CLI process from
 * `source` (the sidecar's environment): the allowlisted variables, then the
 * forced values. `configDir` MUST be a per-execution directory from
 * `createExecutorConfigDir()` (anything else throws). `overrides` is a
 * test-only seam (code-level injection through `ExecuteBoardMissionDeps`,
 * never read from the environment); it is applied after the allowlist and
 * may reintroduce anything EXCEPT `CLAUDE_CONFIG_DIR`, which is forced last
 * so no seam can point the executor at a persistent or shared directory.
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
  };
  if (overrides) {
    for (const [k, v] of Object.entries(overrides)) {
      if (fold(k) === fold('CLAUDE_CONFIG_DIR')) continue;
      env[k] = v;
    }
  }
  env['CLAUDE_CONFIG_DIR'] = configDir;
  return env as ClaudeExecutorEnv;
}

export type ClaudeExecutorEnv = Record<string, string> & { CLAUDE_CONFIG_DIR: string };
