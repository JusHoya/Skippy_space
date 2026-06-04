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

## `phase{0,1,2,3}-validate.mjs`

Exit-gate validators, one per roadmap phase (PRD §14). Each runs the prior
phases' staples (typecheck, sidecar build, `cargo check`) plus that phase's
own file-presence + behavior checks, and exits non-zero on any failure.

```powershell
pnpm validate:phase3
```

### Phase 3 — deterministic + headless by design

`validate:phase3` runs with **no live LLM, Obsidian, or Docker**. Its decisive
check is the `@skippy/memory` test suite, whose `pipeline.e2e.test.ts` drops a
fixture paper into a tmp-vault `00_Inbox/` and asserts ≥8 valid §8.3 atomic
notes (with `distilled_from` backlinks) + ≥1 `[[wikilink]]` in `20_Topics/` —
the Phase 3 exit criterion — using the **mock distiller**. Relevant env:

- `SKIPPY_DISTILL_MODE=mock` (gate default) — deterministic sentence-splitter
  distiller; `=llm` swaps in the real model path (identical plumbing).
- `LETTA_DISABLED=1` — Letta (D4) is deferred to Phase 3.5; clients no-op.
- `OBSIDIAN_API_KEY` unset — the REST client reports unavailable and the
  pipeline writes to the filesystem only (the source of truth, PRD §8.9).

### Manual real-LLM checklist (NOT in the automated gate)

To validate the production path end-to-end: set `ANTHROPIC_API_KEY` and
`SKIPPY_DISTILL_MODE=llm`, start Obsidian with the Local REST API + Smart
Connections plugins, then drop a real `paper.pdf`/`.md` into `vault/00_Inbox/`
and confirm a richly-linked atomic-note set appears within 5 minutes.
