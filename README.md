# Skippy_space

> *"I am Skippy the Magnificent. You're welcome."*

Skippy_space is a Windows desktop AI workbench with Skippy as orchestrator, eight board captains, an RTS view of agent work, a terminal and an Obsidian-backed wiki.

The revival direction is a conversation-centered workspace with integrated changes, wiki and RTS views, persistent execution, and balanced local/cloud model routing.

## Status

**Implemented prototype; revival specification prepared 2026-09-25.** The repository contains Tauri, React/Pixi, a Node runtime, memory jobs and telemetry. It is beyond Phase 0, but execution, permissions, persistence, costs and packaging need repairs and validation.

The assessment found simulated/failed delegation paths that can report success, permission bypass in SDK execution, unsafe vault paths and loss of ingestion originals. These are the first implementation priorities. No runtime fixes, model downloads or cluster changes are included in this assessment branch.

## Start here

| Document | Purpose |
|---|---|
| [PRD v0.2](docs/PRD.md) | Current requirements, architecture, acceptance gates and delivery sequence |
| [Project assessment](docs/ASSESSMENT-2026-09-25.md) | Source-backed findings, reusable foundations and validation limits |
| [Models and cluster plan](docs/MODEL-AND-CLUSTER-PLAN.md) | Download shortlist, placement, task assignments and Pleiades coexistence |
| [Research](docs/research/08-revival-research-2026-09-25.md) | Primary sources for accounts, routing, local serving and Jev |
| [Claude Opus handoff](docs/CLAUDE-OPUS-HANDOFF.md) | Ordered tickets, checks and a kickoff prompt |
| [Original PRD](docs/archive/PRD-v0.1-2026-04-29.md) | Preserved historical specification |

The proposal preserves Alcyone's documented 9B/Hermes service, qualifies a larger local candidate and an Atlas 5070 Ti worker, and keeps personal Codex/Claude Code sessions distinct from separately billed APIs. Jev begins in shadow mode as an optional decision adviser.

## Repository map

| Path | Contents |
|---|---|
| `apps/shell/` | Tauri 2 shell, Rust commands, PTY and sidecar management |
| `apps/ui/` | React 19, PixiJS scene, HUD and stores |
| `apps/agent-runtime/` | TypeScript orchestration, model calls, MCP and memory jobs |
| `packages/` | Shared contracts, memory, OTel and sprite assets |
| `vault/` | Markdown/Obsidian knowledge and decisions |
| `agent_space/` | Charters, skills and commands derived from Hoya_Box |
| `infra/` | Existing telemetry/memory compose files; assess before booting |
| `docs/research/` | Historical research 01-07 and the revival appendix |

## Development and validation

Read [CLAUDE.md](CLAUDE.md) before editing. Manifests require Node 22 or later and pin pnpm 9.15.0; native development also needs Rust/Tauri Windows prerequisites.

See the [handoff](docs/CLAUDE-OPUS-HANDOFF.md) for baseline commands and [Playwright guide](docs/PLAYWRIGHT.md) for browser checks. The assessment environment lacked Node, pnpm and Cargo, so application tests/builds and installer validation were not run. Static document checks do not establish runtime readiness.

Existing infrastructure instructions remain in [infra/README.md](infra/README.md), but the assessment found a Langfuse/OTLP version mismatch. Core work should not depend on starting that stack before it is corrected.

## Identity

Skippy plans, delegates, monitors and synthesizes. Engineering, Coding, Design, Marketing, Finance, Research, Publishing and DevOps own the work. Layered beercan sprites and Skippy's voice remain product features; model/provider choices are independent of those identities.
