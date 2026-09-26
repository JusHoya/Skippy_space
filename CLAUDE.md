# CLAUDE.md — Skippy_space project conventions

You are working inside **Skippy_space**, a desktop AI-orchestration dashboard. Read this file in full before editing anything.

## Source of truth

`docs/PRD.md` v0.2 (2026-09-25) is authoritative for the revival. The original is archived at `docs/archive/PRD-v0.1-2026-04-29.md`; where they conflict, v0.2 wins. Read `docs/CLAUDE-OPUS-HANDOFF.md` for implementation order and `docs/ASSESSMENT-2026-09-25.md` for the unverified baseline. Trace changes to requirement IDs and record material gaps as `OQ-NN` questions with nonblocking defaults.

## Identity

This project ports the agent identity and Skippy persona from `C:\Users\hoyer\WorkSpace\Projects\Hoya_Box\agent_space\`. The persona is **load-bearing**, not decoration:

- **Skippy the Magnificent** — top-level orchestrator. Self-aggrandizing, irreverent, rule-abiding. Refers to humans as "monkeys." Default Asshole Setting: 55%.
- **The Iron Law of Delegation** — Skippy never implements. He plans, approves, assigns, monitors, broadcasts, synthesizes.
- **Eight Boards** — Engineering, Coding, Design, Marketing, Finance, Research, Publishing, DevOps. Each is a captain commanding task agents.
- **Beercan sprites** — every agent is rendered as a literature-accurate Skippy-style beer-can-shaped canister with role-specific clothing.

## Layout you will encounter

```
docs/             — PRD, architecture, roadmap, research appendices
vault/            — Obsidian vault (Karpathy AI wiki). Treat as a database.
agent_space/      — Skippy + Board charters + skills + commands. Ported from Hoya_Box.
apps/             — shell (Tauri Rust), ui (React + PixiJS), agent-runtime (Node sidecar)
packages/         — shared, memory, otel, sprite-kit
infra/            — docker-compose for Langfuse, Letta, n8n
```

## Conventions

1. **Preserve the desktop stack.** Tauri 2 + Vite + React 19 + PixiJS v8 + xterm + Rust portable-pty + Tauri Channels + Zustand. PRD v0.2 authorizes a durable TypeScript harness, local/Codex/Claude executor adapters and model routing. OTel export, Langfuse, Letta and Obsidian REST are optional integrations; Markdown remains the knowledge source of truth.
2. **TypeScript end-to-end.** Don't introduce Python unless wrapping a Python-only library, in which case isolate it behind an MCP server.
3. **Per-frame data does not go through Zustand.** Sprite positions and animation phases live in a transient ref-store that the Pixi tick loop reads directly. Zustand only for state with UI-visible discrete changes.
4. **Execution is durably observable.** Persist task/run/attempt events locally and correlate OTel spans. Optional exporter failure cannot stop work. Stream normalized events through Tauri Channels; never turn a stub or provider error into success.
5. **Vault writes are atomic, locked and contained.** Use `write-file-atomic` + `proper-lockfile` around the full read-modify-write; validate real path containment and expected content hashes. Preserve originals and stable note IDs. Append-only for `agent_log` and daily notes. Wikilinks inside vault notes (`[[note]]`); normal Markdown links are appropriate in project documentation.
6. **Costumes are layered sprites**, not single PNGs. Hat + body + accessory + insignia + accent_color, composited at runtime.
7. **No grandchildren agents.** Skippy -> Board -> Task is the ownership limit. Use separately supervised executions when a provider's native nesting cannot represent it. Task agents escalate to their board; eight logical boards do not require eight resident models.
8. **Every Board agent has a charter** in `agent_space/boards/{name}.md` with the YAML schema in PRD §6.1.

## Hoya_Box sync ritual

This project's identity, agents, and skills derive from `Hoya_Box/agent_space/`. When you change a Skippy-related prompt or charter, **also propose a corresponding edit to Hoya_Box** so they don't drift. Hoya_Box is upstream.

## Don't

- Don't add an agent that doesn't fit on one of the eight Boards (or the Staff Officer slate). The 8-board count is fixed in v1 to preserve the clock-ring map.
- Don't add a feature without tracing it back to a PRD section.
- Don't write to the vault without frontmatter (`id`, `created_at`, `type`, `authored_by`, etc.). The frontmatter schema is PRD §8.3.
- Don't strip Skippy's voice from generated text where Skippy is the speaker. Test transcripts should pass `grep` for "monkey" / "magnificent" / etc.
- Don't introduce cloud sync to the vault (Dropbox, iCloud, Obsidian Sync). Git only; see PRD section 8.4. Preserve unrelated staged user changes.
- Don't bundle Obsidian or Node into the installer; require users to install them and document via `winget`.

## When in doubt

Read the matching section of `docs/PRD.md`, then the current research appendix. Record remaining uncertainty in PRD section 14 with an explicit default and resolve it at the affected integration boundary. Do not re-ask settled preferences or treat historical phase labels as verified completion.
