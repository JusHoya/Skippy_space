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
- `PHASE3_AGENTS_ENABLED` unset — Board Captains run as the Phase-1 keyword
  stub. Set it to `1` (with `ANTHROPIC_API_KEY`) to route accepted delegations
  through a real Claude Agent SDK `query()` using the board's charter as the
  system prompt (`sdk-board.ts`); any SDK failure falls back to the stub. The
  Obsidian/Letta MCP *tools* are NOT wired into that path yet — `tool()` needs
  the SDK's bundled zod v4 and this repo is on zod v3 (a workspace-wide upgrade
  is a separate, gated task). Live board execution is validated manually, not
  in this gate.
- `SKIPPY_REPLAY=0` / `SKIPPY_MEMORY_JOBS=0` — disable the replay writer / the
  memory watcher+cron respectively.

### Manual real-LLM checklist (NOT in the automated gate)

To validate the production path end-to-end: set `ANTHROPIC_API_KEY` and
`SKIPPY_DISTILL_MODE=llm`, start Obsidian with the Local REST API + Smart
Connections plugins, then drop a real `paper.pdf`/`.md` into `vault/00_Inbox/`
and confirm a richly-linked atomic-note set appears within 5 minutes.

## `phase3p5-validate.mjs` — Obsidian MCP (D1) + Letta (D4)

`pnpm validate:phase3.5` is headless: it proves the Obsidian + Letta MCP tools
build, degrade to `isError` when their service is offline, and that
`letta_append_archival` still mirrors to `vault/50_Agents/<board>/agent_log.md`
even with Letta down. It also re-runs `pnpm validate:phase3` to prove the gated
SDK board path (off by default) caused no regression. The SDK MCP tool schemas
use a **zod@4 scoped to `apps/agent-runtime` only** (the SDK's `tool()` requires
zod v4); `@skippy/shared` + `@skippy/memory` stay on zod@3.

### Manual live-validation checklist (NOT in the headless gate)

1. `docker compose -f infra/letta/docker-compose.yml up -d`; confirm Letta on
   `http://localhost:8283`. Pre-create each board agent (e.g. `bd_research_v1`)
   — there is no bootstrap job yet (OQ-D4-04).
2. Start Obsidian on `vault/` with the Local REST API plugin; set
   `OBSIDIAN_API_KEY` (+ `OBSIDIAN_API_URL` if non-default).
3. Run a board mission with `PHASE3_AGENTS_ENABLED=1` + `ANTHROPIC_API_KEY`;
   confirm `obsidian_*` / `letta_*` tool calls in the OTel/Langfuse spans.
4. Trigger `letta_append_archival`; confirm it round-trips via
   `letta_search_archival` AND that `agent_log.md` mirrored the write.
5. `docker stop` Letta and re-run: `letta_*` tools return `isError` but
   `agent_log.md` STILL grows (the mirror fallback). Close Obsidian and confirm
   `obsidian_*` degrades while atomic fs writes keep working.

Letta REST endpoint paths (insert/search/core-memory) are provisional — verify
against the pinned Letta image during this pass (OQ-D4-01/02/03).
