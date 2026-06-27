# Skippy_space — Changelog

> Reverse-chronological record of shipped work, reconstructed from git history.
> This is the operational substrate the **Hoya_Box sync ritual** logs into (PRD
> R-11 / `agent_space/CLAUDE.md`): when a Skippy charter/prompt is ported from
> Hoya_Box, record the sync here under the upcoming version. Phases map to the
> roadmap in `docs/PRD.md` §14.

Dates and commit hashes are drawn from the repo's own history; treat them as
authoritative for *when* something shipped.

---

## [Unreleased] — Phase 4 polish (2026-06-26)

"Polish + Ship" (PRD §14.5), buildable subset. Ship infrastructure (EV
code-signing, auto-updater endpoint, v1.0 release) is deferred — it needs a real
Azure Key Vault cert + hosted update endpoint that can't be provisioned
headlessly — and stays TODO in §14.5. Landed via an orchestrated agent team
(sprites / UI / Letta in parallel, then integration + gate). New gate:
`pnpm validate:phase4` (26/26 green); `validate:phase3.5` re-run proves zero
regression.

- **Sprite v1 — generative polish** (`packages/sprite-kit`): metal/3D beercan
  body (`paintBrushedMetal`, rim/lip, LED + antenna glow halos), per-board
  costume distinction, and a richer animation FSM (`tick.ts`). 100% procedural
  PixiJS `Graphics` — no binary atlas (resolves the OQ-02 contradiction in favor
  of "generative throughout"). The gallery (`?gallery`) gained an
  animation-state showcase row.
- **Onboarding flow** (`apps/ui/src/hud/Onboarding.tsx`): a first-run
  Skippy-voiced overlay (intro → scanned-CLAUDE.md summary → one-click sample
  mission), gated on a `localStorage` flag, re-openable from the TopBar ★.
- **In-app docs on F1** (`apps/ui/src/hud/DocsPanel.tsx`): searchable help
  overlay. F1 was a minimap-layer toggle (`size`); it's reassigned to docs and
  the `size` layer re-homed to **Shift+F1** (F2–F4 unchanged).
- **Letta carryover resolved — OQ-D4-01..04.** The REST client
  (`packages/memory/src/letta-client.ts`) is hardened to the verified current
  Letta v1 contract (`archival-memory` insert/search, `core-memory/blocks` edit)
  with graceful legacy fallbacks; added `listAgents`/`createAgent`. New
  `letta-bootstrap` job (`pnpm letta:bootstrap`) idempotently provisions per-board
  agents from the charters, and `pnpm validate:letta` (`scripts/letta-verify.mjs`)
  live-checks the contract — both skip cleanly (exit 0) when Letta is down.
- **Visual-test hardening** (`tests/visual/gallery.spec.ts`): the gallery spec
  now gates on a deterministic `data-painted` readiness flag and drops the
  full-roster pixel baseline (two large-glow procedural cans render with GPU
  sub-pixel non-determinism — a ~12% two-tile noise floor that exceeds the signal
  of a real regression). Per-tile pixel coverage stays via `skippy-speaking.png`;
  Playwright runs under `reducedMotion` so the gallery freezes to a fixed frame.
- **Docs:** PRD §14.5 split into landed-polish vs deferred-ship; OQ-02 +
  OQ-D4-01..04 marked resolved; `scripts/README.md` documents the new Letta
  scripts.

---

## [Unreleased] — Review remediation (2026-06-10 → 2026-06-11)

A multi-agent comprehensive review (`docs/REVIEW-2026-06-10.md`: 1 critical, 17
high, ~70 medium, 16 low) was triaged and remediated in waves.

- **CRITICAL — unbreak dead-on-arrival sidecar** (`7238bdf`). `@skippy/memory`
  was an external bare import in the built `dist/index.js`, so the spawned
  sidecar threw `ERR_MODULE_NOT_FOUND` at load and restart-looped. Bundled it
  via `noExternal`, and added a no-API-key **boot smoke** gate
  (`pnpm validate:boot`) that spawns `node dist/index.js` and asserts the
  `board_spawned` envelopes arrive — the regression guard.
- **All 17 HIGH findings resolved** (`cd37960`): SDK-board security
  (path-containment on `obsidian_write_note`, charter-driven permissions instead
  of a hardcoded `bypassPermissions`, append-only guards, real `authored_by`
  provenance), the wire contract (the 5 Phase 3 envelope variants mirrored into
  the Rust enum), memory-pipeline correctness, and UI fixes.
- **Medium / low waves** (`6ee2979`, `7f86451`): runtime + memory correctness,
  Rust PTY lifecycle + UTF-8 buffering, UI math (zoom / DPR), shell resilience,
  and security hardening.
- **Made validation real** (`dbe068e`): a runnable `lint` script over the flat
  ESLint config, a UI test harness, and a CI workflow
  (`.github/workflows/ci.yml`) that actually runs lint + typecheck + tests +
  boot smoke on push.
- **Docs reconciliation** (this change): added the Phase 3.5 roadmap section
  (§14.45), reconciled the §8.3 `status` enum to the implemented six-value
  `NOTE_STATUSES`, registered the previously-phantom Open Questions (OQ-18,
  OQ-D4-01..04) in §16, created this `docs/changelog.md` and
  `docs/architecture.md` (promised by §11.3), and corrected the
  `psych-monitor` charter's overclaim about `disallowed_tools` enforcement.

---

## Phase 3.5 — Obsidian + Letta tools (2026-06-03)

PRD §14.45. Gave the gated SDK Boards real, in-process memory tools, all behind
`PHASE3_AGENTS_ENABLED`.

- **Obsidian D1** (`7b17b70`): in-process Obsidian MCP server with
  `obsidian_read_note`, `obsidian_search`, `obsidian_patch_frontmatter`,
  `obsidian_append_block`, `obsidian_write_note`, backed by the WS2
  `ObsidianRestClient` with an atomic-fs fallback.
- **Letta D4** (`f930302`, `7b17b70`): graceful Letta client +
  `letta_search_archival`, `letta_append_archival`, `letta_edit_core` bound
  per-board to `memory.letta_agent_id`, with an **archival → vault mirror**
  (`50_Agents/<board>/agent_log.md`) so the durable record survives Letta being
  down. Every tool degrades to an `isError` result when its service is offline.
- Scoped `zod@4` to `apps/agent-runtime` only (the SDK's `tool()` requires
  v4); `@skippy/shared` + `@skippy/memory` stay on zod@3.

**Exit gate:** `pnpm validate:phase3.5` (20/20). Raised OQ-D4-01..04
(provisional Letta REST surface + missing bootstrap job).

---

## Phase 3 — Memory deepens (2026-06-03)

PRD §14.4 — "the Karpathy wiki is alive." Branch `session/phase3-memory`.
Exit gate `pnpm validate:phase3` (48/48 after remediation; 38/38 at first ship).

- **Memory core + four task charters** (`02e63fe`): vault writer +
  ingest/distill/link/lint charters.
- **Graceful Obsidian REST client + embeddings + vector store** (`90ba0c3`):
  bge-micro embeddings, Smart Connections vector path.
- **Telemetry data path** (`5762c83`, `bdcb742`): tokens, cost, context-window
  pressure, error feed; live TopBar tok/s + context readout.
- **Session replay** (`a814e06`): JSONL writer + scrubber + Tauri commands
  (PRD §9.5).
- **Claude Agent SDK adopted for Board execution, gated** (`a21fa94`).
- **Four-job memory pipeline + runtime wiring** (`330a5ea`).
- Fixed an envelope↔phase3 import cycle that crashed runtime boot (`f568417`).

---

## Phase 3-prep (2026-05-15)

`4c3949a`. Skippy streaming-hang fix, `claude-code` PTY spawn, TUI navigator,
model picker, Playwright MCP. Boot-time updater plugin disabled until Phase 4.
Merged to `main`.

---

## Phase 2 — RTS UX (2026-05-15)

PRD §14.3. Branch `session/phase2-rts-ux`. Exit gate `pnpm validate:phase2`
(83/83).

- `3345e34`: file-pedestals, walkers, camera, selection model (single /
  drag-box / control groups / Tab cycle), hotkeys, strategic zoom, active-pause,
  fog-of-war reinterpretation, minimap + layer toggles, per-board command cards.

---

## Phase 1 — The Board (2026-05-14)

PRD §14.2. Exit gate `pnpm validate:phase1` (44/44). All eight Boards alive with
`delegate_to_board` round-trips.

- Ported canonical Skippy + 8 Board + 4 Staff Officer charters (`28b377f`).
- Board + delegation envelopes, `BOARD_META`, `BoardIdSchema` (`16a0459`).
- Clock-ring of 8 captains, selection model, delegation router (`421f53d`).
- Per-board persona pages + daily auto-note generator (`13523d3`).
- `BoardSupervisor` + 8 `query()` boards + `delegate_to_board` MCP (`0e728eb`).
- Langfuse + Letta + OTel collector stacks + phase1 boot scripts (`8d5ba2a`).
- Phase 1 exit-gate validator + refreshed visual baselines (`ee9b814`,
  `e0abe48`).

---

## Phase 0 — Scaffold (2026-05-13)

PRD §14.1. Exit gate `pnpm validate:phase0`. Full build chain + a live Skippy
round-trip green.

- Tauri shell + UI + Skippy sidecar + sprite-kit + shared scaffold (`b2f8ad6`).
- `.env.example` for `ANTHROPIC_API_KEY` + telemetry vars (`81ebd73`).
- Procedural costumes for all 8 boards + Skippy gallery view (`95ecd53`).
- Playwright visual harness + gallery/HUD render fixes (`01ed327`).
- Placeholder icons to unblock `cargo check` (`ab40235`).
- Phase 0 exit-gate validator (`44a1731`); pnpm resolution + Playwright
  timeouts + Tauri `frontendDist` (`961dd38`).

---

## Hoya_Box sync log

Record each port from `Hoya_Box/agent_space/` here (R-11). Format:
`YYYY-MM-DD — <charter/prompt> — <direction> — <commit>`.

- 2026-05-14 — Skippy + 8 Boards + 4 Staff Officers — initial port from
  Hoya_Box → Skippy_space (`28b377f`). Design board is new (no Hoya_Box
  ancestor); Research adds `ingest` + `distiller` task-agent placeholders.
- _(append future syncs above this line)_
