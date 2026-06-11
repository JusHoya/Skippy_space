# Skippy_space — Architecture Overview

> Companion to `docs/PRD.md` (the source of truth). The PRD says *what* and
> *why*; this file is a concise, factual map of *how the code is laid out today*.
> When the two disagree, the PRD wins for intent and the code wins for what
> actually ships — reconcile, never both.

Last reconciled against the tree: 2026-06-11 (post review-remediation, branch
`session/phase3p5-d1-letta`).

---

## 1. The shape: three processes, one wire format

Skippy_space is a Tauri 2 desktop app with three cooperating processes:

```
┌─────────────────────────────────────────────────────────────┐
│ Tauri shell  (apps/shell/src-tauri, Rust)                    │
│  • owns the OS window, the webview, the PTYs, the vault git  │
│  • spawns the Node sidecar as a child process                │
│  • relays the sidecar's stdout envelopes to the renderer     │
│    over Tauri Channels                                        │
└───────────────┬──────────────────────────┬──────────────────┘
                │ Tauri Channel            │ stdin/stdout (JSONL)
                ▼                          ▼
┌───────────────────────────┐   ┌──────────────────────────────┐
│ Renderer (apps/ui, React) │   │ Sidecar (apps/agent-runtime,  │
│  • PixiJS RTS scene       │   │   Node 22, TypeScript)        │
│  • Zustand UI stores      │   │  • Skippy orchestrator        │
│  • xterm terminal panes   │   │  • 8 Board query() processes  │
│  • telemetry / replay HUD │   │  • memory jobs + MCP tools    │
└───────────────────────────┘   └──────────────────────────────┘
```

The **single wire format** between all three is the line-delimited JSON
**envelope**. The sidecar prints one envelope per line on stdout; the Rust shell
deserializes each line (`apps/shell/src-tauri/src/envelope.rs`,
`sidecar.rs`) and forwards it over a Tauri Channel; the renderer revalidates with
zod and routes it (`apps/ui/src/lib/channel.ts`). The canonical envelope schemas
live in `packages/shared/src/envelope.ts` (+ `phase2.ts` / `phase3.ts` /
`phase3prep.ts` for the per-phase additions). Keeping the Rust enum and the TS
zod schema in lockstep is a hand-maintained cross-language contract.

---

## 2. Monorepo layout (pnpm workspace)

```
Skippy_space/
├── apps/
│   ├── shell/         @skippy/shell      — Tauri 2 Rust host
│   │   └── src-tauri/src/
│   │       ├── main.rs / lib.rs          — app entry, command registration
│   │       ├── sidecar.rs                — spawn + supervise the Node sidecar
│   │       ├── envelope.rs               — Rust mirror of the wire envelopes
│   │       ├── channel.rs                — Tauri Channel event bus
│   │       ├── pty.rs                    — portable-pty terminal backends
│   │       ├── project_tree.rs           — file tree → pedestal map source
│   │       ├── git_autocommit.rs         — vault/ auto-commit (pathspec'd)
│   │       ├── replay.rs                 — replay-session commands
│   │       └── cmd_set_model.rs          — model-picker command
│   ├── ui/            @skippy/ui         — Vite + React 19 + PixiJS v8 renderer
│   │   └── src/
│   │       ├── scene/                    — PixiJS RTS scene (SceneRoot, walkers)
│   │       ├── stores/                   — Zustand (discrete UI state only)
│   │       ├── hud/                      — TopBar, TerminalPane, Hotkeys, panels
│   │       └── lib/channel.ts            — Channel subscription + envelope routing
│   └── agent-runtime/ @skippy/agent-runtime — Node 22 sidecar (the brains)
│       └── src/
│           ├── index.ts                  — sidecar entry / stdin loop
│           ├── supervisor.ts             — BoardSupervisor (8 boards)
│           ├── skippy.ts / claude.ts     — Skippy orchestrator + streaming
│           ├── board.ts                  — per-Board execution + delegation
│           ├── sdk-board.ts              — gated Claude Agent SDK board path
│           ├── charter.ts                — charter loader + charterPermissions()
│           ├── mcp-registry.ts           — buildMcpServers() per charter
│           ├── mcp-handlers.ts           — obsidian_* / letta_* tool handlers
│           ├── mcp-delegate.ts           — delegate_to_board MCP server
│           ├── memory-jobs.ts            — wires the four memory jobs
│           ├── modelRegistry.ts          — per-board model resolution
│           ├── replay-writer.ts          — session-replay JSONL writer
│           ├── otel.ts                   — OTel span emission
│           └── warmpool.ts               — (stub) SDK warm-pool placeholder
├── packages/
│   ├── shared/        @skippy/shared     — envelope schemas, BOARD_META, ids,
│   │                                       pricing, model-limits, palette, states
│   ├── memory/        @skippy/memory     — vault writer + Obsidian/Letta clients
│   │   └── src/
│   │       ├── frontmatter.ts            — §8.3 schema + NOTE_STATUSES validator
│   │       ├── atomic.ts                 — atomic + locked vault writes
│   │       ├── daily.ts                  — daily auto-note generator
│   │       ├── vault-watcher.ts          — chokidar inbox watcher
│   │       ├── obsidian-rest.ts          — Local REST API client (graceful)
│   │       ├── letta-client.ts           — Letta client (graceful)
│   │       ├── embeddings.ts / vector-store.ts — bge-micro + SC vector path
│   │       └── jobs/                      — ingest, distill, link, lint, archival-mirror
│   ├── otel/          @skippy/otel       — OTel collector config + exporter glue
│   └── sprite-kit/    @skippy/sprite-kit — PixiJS costume system (BOARD_COSTUMES)
├── agent_space/                          — agent identity layer (charters)
│   ├── skippy.md                          — Skippy orchestrator charter
│   ├── boards/*.md                        — 8 Board captain charters
│   └── staff/*.md                         — 4 Staff Officer charters
├── vault/                                 — Obsidian vault (Karpathy wiki, git-only)
├── infra/                                 — docker-compose: langfuse, letta, otel-collector, n8n
├── scripts/                               — phase{0,1,2,3,3.5} validators + boot-smoke + autocommit
└── docs/                                  — PRD.md, architecture.md, changelog.md, roadmap.md, research/
```

---

## 3. Data flow, end to end

1. **User issues an order** in the renderer (chat to Skippy, or a board command
   card). The renderer sends it to the sidecar via the shell.
2. **Skippy plans** (`skippy.ts` / `claude.ts`) and, per the Iron Law of
   Delegation, calls `delegate_to_board` (`mcp-delegate.ts`) rather than
   implementing.
3. **A Board executes** (`board.ts`). With the `PHASE3_AGENTS_ENABLED` gate
   **off** (the default) the board uses a stub path; with it **on**, the board
   runs through the Claude Agent SDK (`sdk-board.ts`) with charter-driven
   permissions and the in-process `obsidian_*` / `letta_*` MCP tools
   (`mcp-registry.ts` + `mcp-handlers.ts`).
4. **Everything emits envelopes** — lifecycle (`board_spawned`,
   `delegation_complete`), telemetry (`telemetry_span`, `context_window`,
   `error_span`), memory (`memory_job`), and replay (`replay_session`) — onto
   stdout.
5. **The shell forwards** each envelope to the renderer over a Tauri Channel;
   the renderer's zod revalidates and routes them to the PixiJS scene (sprite
   states, walkers) and the HUD (cost meter, tok/s, context bar, error feed,
   replay id).
6. **Memory jobs** (`memory-jobs.ts` → `packages/memory/src/jobs/*`) run the
   four-job pipeline (ingest → distill → link → lint, PRD §8.5) over the vault,
   writing atomic + locked, wikilink-only, §8.3-frontmatter notes.

---

## 4. Key invariants (and where they live)

- **No per-frame data through Zustand.** Sprite positions / animation phases
  live in a transient ref-store the Pixi tick loop reads directly
  (`apps/ui/src/scene/`). Zustand holds only discrete, UI-visible state.
- **Vault writes are atomic + locked, wikilinks only, §8.3 frontmatter.**
  Enforced in `packages/memory/src/atomic.ts` + `frontmatter.ts`; `agent_log`
  and daily notes are append-only.
- **The 8-board count is fixed in v1** to preserve the clock-ring map. Board
  identity is hand-synced between `packages/shared/src/boards.ts` (`BOARD_META`),
  the charters in `agent_space/boards/`, and `packages/sprite-kit` costumes.
- **No grandchildren agents.** Skippy → Board → Task is the maximum depth
  (PRD §3.3 / OQ-07).
- **Charter-driven permissions on the gated SDK path.**
  `charter.ts` `charterPermissions()` parses `permission_mode` / `tools` /
  `disallowed_tools`; `sdk-board.ts` maps them onto the SDK `query()` options.
  `bypassPermissions` is reachable only via an explicit `SKIPPY_BYPASS_PERMISSIONS`
  opt-in. (Staff Officers are loadable/referenceable but not yet invocable — see
  `agent_space/staff/psych-monitor.md` for the precise enforcement state.)
- **All agent communication is OTel-traced** (`otel.ts`); the renderer
  subscribes via Tauri Channels.

---

## 5. Tooling: gates, lint, CI

- **Phase gates** live in `scripts/` (`pnpm validate:phase{0,1,2,3,3.5}`) plus a
  no-API-key **boot smoke** (`pnpm validate:boot`) that builds the sidecar,
  spawns `node dist/index.js`, and asserts the `board_spawned` envelopes arrive —
  the regression guard for the dead-on-arrival sidecar fixed during review
  remediation.
- **Lint:** `pnpm lint` runs ESLint over a maintained flat config.
- **Tests:** per-package `*.test.ts` run via each package's `tsx`-backed
  `test` script; `pnpm test` runs them recursively.
- **CI** (`.github/workflows/ci.yml`) runs lint, typecheck, tests, and the boot
  smoke on push.

---

## 6. The Hoya_Box sync ritual (R-11 substrate)

The agent identity layer (`agent_space/`) **ports from**
`C:\Users\hoyer\WorkSpace\Projects\Hoya_Box\agent_space\`, which is upstream.
When a Skippy-related charter/prompt changes here, propose the corresponding
edit in Hoya_Box so the two repos don't drift (PRD R-11). The ritual: weekly
diff, manual merge, **log the sync in `docs/changelog.md`** under the upcoming
version. This file and the changelog are the operational substrate that R-11's
mitigation references.

---

## 7. Phase history

See `docs/changelog.md` for the per-phase summary (Phase 0 → 3.5 + the
2026-06 review-remediation effort) and `docs/PRD.md` §14 for the forward
roadmap.
