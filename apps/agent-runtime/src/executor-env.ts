// executor-env.ts — the explicit, minimal environment handed to the Claude
// Code CLI that backs the Claude Agent SDK executor (FR-SEC-01, OQ-18,
// M0-G06).
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
//   CLAUDE_CONFIG_DIR=<runtime>  — a runtime-owned directory (default
//                                  `<tmp>/skippy-agent-runtime/claude-config`,
//                                  `SKIPPY_CLAUDE_CONFIG_DIR` overrides with an
//                                  absolute path), so the user's `~/.claude`
//                                  (settings, `.claude.json` project state,
//                                  OAuth credentials, agents, plugins) can
//                                  never reach the executor, whatever
//                                  `settingSources` covers.
//   CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
//                                — only the Messages API is needed; no
//                                  telemetry, error reporting or autoupdate
//                                  egress (the adapter claims no egress
//                                  control, so it keeps egress minimal). This
//                                  is also the configuration every live CLI
//                                  test has been verified under.
//
// Re-audit on every SDK/CLI bump (the `SX8` selection, the env list the CLI
// reads, and the SDK's env semantics). Proxy / CA variables are deliberately
// not forwarded (OQ-22).

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

/** Runtime-owned Claude Code config directory for the executor. */
export function claudeExecutorConfigDir(source: NodeJS.ProcessEnv = process.env): string {
  const override = source.SKIPPY_CLAUDE_CONFIG_DIR;
  if (override && path.isAbsolute(override)) return path.resolve(override);
  return path.join(os.tmpdir(), 'skippy-agent-runtime', 'claude-config');
}

/**
 * Build the complete environment for the executor's CLI process from
 * `source` (the sidecar's environment): the allowlisted variables, then the
 * forced values. `overrides` is a test-only seam (code-level injection through
 * `ExecuteBoardMissionDeps`, never read from the environment); it is applied
 * last and may reintroduce anything, which is why production never passes it.
 */
export function buildClaudeExecutorEnv(
  source: NodeJS.ProcessEnv = process.env,
  overrides?: Readonly<Record<string, string>>,
  platform: NodeJS.Platform = process.platform,
): ClaudeExecutorEnv {
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
  const env: ClaudeExecutorEnv = {
    ...copied,
    USE_BUILTIN_RIPGREP: FORCED_BUILTIN_RIPGREP,
    CLAUDE_CONFIG_DIR: claudeExecutorConfigDir(source),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
  if (overrides) Object.assign(env, overrides);
  return env;
}

export type ClaudeExecutorEnv = Record<string, string> & { CLAUDE_CONFIG_DIR: string };
