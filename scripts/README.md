# scripts/

Repo-level utilities. None of these are deployed; they are dev/ops helpers.

## `git-autocommit.mjs`

Auto-commits **only** the `vault/` subtree so the Obsidian wiki has a
recoverable history (PRD §5.3, §8.6 — git is the safety net).

```powershell
# Once (used by the `pnpm autocommit` script at repo root).
node scripts/git-autocommit.mjs --once

# Daemonized — commit every 300s (default), or pass --interval=NN for seconds.
node scripts/git-autocommit.mjs --interval=300
```

Idempotent: when `git status --porcelain vault/` is empty, the script exits
quietly without producing an empty commit. The commit message is
`chore(vault): auto-commit <iso-timestamp>`.

## `dev.ps1`

One-shot launcher. From a fresh checkout:

```powershell
./scripts/dev.ps1 -Install   # runs pnpm install, then builds the runtime and starts the Tauri shell
./scripts/dev.ps1            # skips install if node_modules exists
```

The script intentionally builds `@skippy/agent-runtime` ahead of starting
`@skippy/shell` because the shell spawns the runtime as a sidecar at boot.
