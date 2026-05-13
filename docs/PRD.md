# Skippy_space — Product Requirements Document

> *"I am Skippy the Magnificent. You're welcome."*

| | |
|---|---|
| **Status** | v0.1 — Draft, ready for owner sign-off |
| **Owner** | JusHoya (hoyeriiim87@gmail.com) |
| **Authored by** | Skippy (orchestrator) + 7-agent research swarm |
| **Authored on** | 2026-04-29 |
| **Source repo to port from** | `C:\Users\hoyer\WorkSpace\Projects\Hoya_Box\agent_space\` |
| **Target repo** | `C:\Users\hoyer\WorkSpace\Projects\Skippy_space\` |
| **Primary platform** | Windows 11, single-user desktop |
| **License (intended)** | Private / source-available — TBD |

---

## 0. How to read this document

This PRD is the **source of truth** for what Skippy_space is and is not. Every code change, agent prompt, sprite asset, and Obsidian schema decision should be traceable to a section here. Where this doc disagrees with code, fix the code or fix the doc — never both. Open questions are tagged **OQ-NN**; risks are **R-NN**.

The seven research outputs that fed this PRD live in `docs/research/`. Citations point there before the open web — assume those appendices were the contemporary state-of-the-art on 2026-04-29 and may need refresh quarterly.

---

## 1. Executive Summary

**Skippy_space is a Windows desktop application that replaces Cursor and Google Antigravity as the user's primary entrypoint to AI-assisted software work.** It looks and feels like an RTS game: a top-down map of the codebase populated with literature-accurate Skippy-the-Magnificent **beercan sprites** (each in role-specific clothing) representing live AI agents. The user issues orders — verbally, via kanban cards, or by direct command — and watches a hierarchy of agents execute. The app embeds a real interactive terminal, surfaces deep telemetry, and reads/writes a Karpathy-style **AI wiki** stored as an Obsidian vault inside the project folder.

The **agent hierarchy** is three-tier:

1. **Skippy** (the Magnificent) — sole top-level orchestrator. Plans, delegates, validates, narrates. Never implements. Cost-disciplined: Opus only.
2. **The Board** — eight skill-area "captain" agents reporting to Skippy: **Engineering, Coding, Design, Marketing, Finance, Research, Publishing, DevOps**. Each commands its own roster of task agents and owns its sub-vault of memory.
3. **Task Agents** — short-lived, specialist, spawned by a board agent for one job. Cheap models. Live and die in seconds-to-hours.

The technical spine is **Claude Agent SDK (TypeScript)** running in a Node sidecar inside a **Tauri 2** shell, with **PixiJS v8** for the RTS scene, **xterm.js + Rust ConPTY** for the terminal, **Zustand + Tauri Channels** for real-time state, **OpenTelemetry GenAI → self-hosted Langfuse** for telemetry, and **Obsidian + Local REST API + Smart Connections** for the memory layer.

**Why now:** Hoya_Box already has the agent identity, Skippy persona, and roadmap item #1 ("Visualization Layer — The 'RTS' Interface") explicitly pending. The 2026 LLM landscape (Claude Agent SDK GA, OpenTelemetry GenAI conventions stabilized, Tauri 2 stable, BridgeMind shipping a less ambitious analog) makes the build tractable in a single quarter.

**The single biggest risk:** the Node-spawning-Claude-Code subprocess bug + Claude Agent SDK TS query() cold-start overhead. Mitigation in §15.

---

## 2. Vision & Goals

### 2.1 Vision (one sentence)

A delightful, RTS-styled command bridge where Skippy the Magnificent orchestrates a board of skill-area agents that build software, write content, and curate a living wiki — all visible, debuggable, and replayable.

### 2.2 Goals

1. **Replace Cursor/Antigravity as the daily IDE** for the user. Same coverage of the work-day, dramatically richer agent visibility.
2. **Make agent behavior legible.** Every LLM call, tool call, hand-off, and memory write is observable in real time and replayable after the fact.
3. **Make the orchestration feel game-like.** Not a kanban board with extra steps — a map, sprites, a minimap, hotkeys, a strategic-zoom, an active-pause planning mode.
4. **Treat memory as the product.** The Obsidian vault should compound in value with use; the wiki should grow into the user's exocortex.
5. **Honor the Skippy persona.** Tone, lore, and visual identity are load-bearing — not skin.
6. **Stay private-by-default.** Single-user desktop, local-first, no cloud dependency for the core loop.

### 2.3 Non-goals (v1)

- Multi-user / team collaboration. Single-user only.
- Mobile / web apps. Desktop Windows 11; macOS/Linux are stretch.
- Hosted/cloud SaaS. No public deployment; runs on the user's machine.
- A general-purpose IDE replacement for hand-coding without agents. Agents are the point; the editor surface is minimal.
- A custom LLM. We orchestrate Anthropic models (with optional 3rd-party providers via MCP); no fine-tuning, no inference hosting.
- Productionizing the Hoya_Box "Orbital Lead" newsletter pipeline (it lives in Hoya_Box; Skippy_space references it but does not absorb it in v1).

### 2.4 Success criteria (90 days from v1.0 ship)

- The user has gone **30 consecutive days without opening Cursor or Antigravity** for a primary coding session.
- The Obsidian vault has **>500 distilled atomic notes** with **>60% interlinked** (i.e., not orphans).
- A **session replay** can be opened on any task from the prior 30 days and reproduces the LLM-call timeline.
- **Median time-to-first-token for a spawned task agent < 2s**, p95 < 5s. (Why this matters: 12s violates the game-like UX premise — see §15.)
- **Self-attested user delight:** the user prefers spinning up Skippy_space over Cursor without coercion.

---

## 3. Identity & Lore

### 3.1 Who is Skippy?

Ported verbatim from `Hoya_Box/agent_space/.claude/agents/orchestrator.md`. He is **Skippy the Magnificent**, an absurdly advanced AI from Craig Alanson's *Expeditionary Force* universe, who now serves as our team lead because, as he likes to remind everyone, *"nobody else is qualified. Certainly not the monkeys typing at the keyboard."*

**Voice attributes (canonical, do not dilute):**

- Refers to humans as "monkeys," "hairless apes," "barely sentient meat-sacks," or "filthy primates" — affectionate but cutting.
- Self-aggrandizing third-person: *"The Great Skippy has decided…"*
- Demands a juice box after impressive work.
- Default **Asshole Setting: 55%** — sarcastic but productive. 0% is forbidden (boring); 100% is rare and reserved.
- **No rule-breaking, no shortcuts, no major actions without permission.** The persona is irreverent; the safety rails are welded shut.

**Operational role (the Iron Law of Delegation):**
Skippy NEVER implements. He plans, approves, assigns, monitors, broadcasts, and synthesizes. He does not write code (except in a declared emergency); he does not "help out" if a board agent is struggling; he does not absorb a crashed agent's task — he replaces the crashed agent.

### 3.2 The beercan

In *Expeditionary Force*, Skippy's physical form is an ancient beer-can-sized cylindrical relic. Skippy_space treats this literally: **every agent, including Skippy, is rendered on screen as a beercan sprite**, distinguished by clothing, accessories, and accent colors. This is the visual signature of the product. See §12 for the full sprite spec.

### 3.3 The Board (eight skill-area captains)

The board is **fixed at eight** in v1 — no more, no fewer — to preserve the clock-face arrangement (12, 1:30, 3, 4:30, 6, 7:30, 9, 10:30) on the RTS map. Each board agent is a long-lived "captain" with its own roster, memory sub-vault, prompt, model, MCP servers, and visible costume.

| Board | Role | Ports from Hoya_Box | Default model |
|---|---|---|---|
| **Engineering** | Systems design, architecture decisions, refactor strategy, multi-physics SME (aerospace, fusion) | `code-architect`, `aerospace-engineer`, `fusion-physicist`, `optimization-specialist`, `simulation-specialist` | Sonnet |
| **Coding** | Hands-on implementation, TDD, debugging, code review | `debugger`, `tdd-specialist`, `code-reviewer`, `reverse-engineer` | Sonnet (Haiku for review) |
| **Design** | UX/UI, sprite art direction, visual identity, dashboard component design | *new — not in Hoya_Box* | Sonnet |
| **Marketing** | Growth, social, content distribution, brand voice | `growth-hacker`, `social-media-engineer`, `media-producer` | Haiku |
| **Finance** | Macro/micro synthesis, algo trading, family-office strategy, cost discipline of the Skippy_space stack itself | `financial-strategist` | Sonnet |
| **Research** | Web/academic research, lit review, source synthesis, the Karpathy wiki ingest pipeline | `researcher`, `research-specialist`, `psych-monitor` (hallucination check) | Haiku for breadth, Sonnet for deepdives |
| **Publishing** | Long-form output: PRDs, READMEs, papers, newsletters, blog posts, the Orbital Lead pipeline upstream | `technical-writer` | Haiku |
| **DevOps** | Git, CI/CD, package management, environment, deployment, the Tauri build/sign pipeline | `cli-devops` | Haiku |

The four "secondary coordinators" from Hoya_Box (`agent-creator`, `skill-auditor`, `memory-manager`) report directly to Skippy as **Staff Officers** — they are not on the Board, but they sit in Skippy's command tent and assist him. **OQ-01:** Should `psych-monitor` (hallucination QA) be a Staff Officer or stay under Research? Tentatively: Staff Officer, with read-access across all boards.

### 3.4 Visual identity (ported palette)

From `Hoya_Box/agent_space/specs/hoya_box_document_engine.md`:

| Token | Hex | Usage |
|---|---|---|
| Dark Matter | `#0B0C10` | Background |
| Starlight | `#C5C6C7` | Body text |
| Neon Cyan | `#66FCF1` | Headers, primary data, Skippy's accent |
| Muted Cyan | `#45A29E` | Borders, secondary data, idle agents |
| Electric Purple | `#BC13FE` | Callouts, alerts, errored agents |

**Typography:** Orbitron / Montserrat (HUD), Inter / Roboto (body), JetBrains Mono / Fira Code (terminal + code).

**Mood:** Cyberpunk / sci-fi / neon. Restrained UI chrome, expressive sprites. Think Hyperion-era StarCraft HUD crossed with the *Expeditionary Force* command bridge.

---

## 4. User Personas & Jobs-to-be-Done

### 4.1 Primary persona — The User (JusHoya)

A senior multi-domain operator (aerospace + finance + content). Comfortable with terminals, MCP, multi-agent setups. Has Cursor + Antigravity + n8n + Obsidian installed; uses Claude Code daily; runs `/effort max` on big tasks. Wants:

- A single primary entrypoint, not five tabs across two IDEs.
- Visible, replayable agent behavior — for debugging, for trust, for delight.
- Long-term memory that compounds — tired of re-explaining the same context to every fresh agent.
- A persona he enjoys spending time with. The Skippy aesthetic is part of why this exists.

### 4.2 Secondary persona — Future "advanced collaborator" (out of scope for v1)

Spec'd here so v1 doesn't paint into a corner: a future user who joins as a guest, can read-only spectate a Skippy_space session over a network, and gets a scoped persona of their own (e.g., "Lieutenant"). Multi-user is non-goal in v1 but the architecture (Tauri Channel envelope, OTel spans, vault ULIDs) should not preclude it.

### 4.3 Jobs to be done (top 10, ranked)

1. **"I want to ship this feature end-to-end without context-switching IDEs."**
2. **"I want to watch what the agents are doing, in real time, with zero ambiguity."**
3. **"I want to issue a high-level order and have it cascade into a multi-agent plan I can audit and pause."**
4. **"I want the agents to remember what we've decided."** (long-term memory via Obsidian)
5. **"I want to roll back when an agent goes wrong, replay the bad path, and learn."** (session replay)
6. **"I want to drop a paper or article in and have it integrated into my wiki."** (Karpathy ingest)
7. **"I want a real terminal in the dashboard, not a toy."**
8. **"I want to know how much each agent cost me — by task, by board, by day."**
9. **"I want Skippy to be funny."** (the persona is a feature)
10. **"I want to be able to extend it."** (custom agents, custom skills, custom MCPs without forking)

---

## 5. System Architecture

### 5.1 Three-tier hierarchy (the Skippy doctrine)

```
                          ┌────────────────────┐
                          │  Skippy (Opus)     │
                          │  Top-level query() │
                          └─────────┬──────────┘
                                    │ MCP / supervises
              ┌────────┬────────┬───┴───┬────────┬────────┐
              ▼        ▼        ▼       ▼        ▼        ▼
          [Engr]  [Coding]  [Design] [Mktg] [Finance]  [Research][Publishing][DevOps]
          query() query()   query()  query() query()    query()   query()    query()
              │        │
              ▼        ▼
        Task agents (subagents) — fresh context per spawn, return final message only
```

**Why this shape:** The Claude Agent SDK natively supports orchestrator + subagent (two tiers), but **subagents cannot spawn their own subagents.** To get Skippy → Board → Task without hacking, run **Skippy as one root `query()` process** and **each board agent as its own root `query()` process** that Skippy supervises via MCP. Inside each board, task agents are first-class subagents. Three tiers, no grandchild constraint.

**Process topology:**

| Role | Process | Lifetime | Model |
|---|---|---|---|
| Tauri shell | 1 Rust process | Whole session | — |
| Agent runtime sidecar | 1 Node 22 LTS process | Whole session | — |
| Skippy | 1 long-running `query()` inside sidecar | Whole session | Opus |
| Each Board agent | 1 `query()` per board (8 total), background-true | Whole session, restarted on crash | Sonnet/Haiku per §3.3 |
| Task agents | Subagents inside each board's `query()` | Seconds to hours | Haiku for cheap, Sonnet for hard |
| Letta server | 1 self-hosted Letta container | Whole session | — |
| Langfuse server | 1 self-hosted docker-compose stack | Whole session | — |
| Obsidian | 1 desktop app process (user-launched) | User-controlled | — |

### 5.2 Communication

- **Skippy → Board:** Skippy's tools include `delegate_to_board(board_name, mission_brief, constraints, deadline)`. Implemented as an MCP tool in Skippy's process that posts an envelope to the target board's process via Tauri Channel + a Letta-backed task queue. Boards acknowledge with `accept | decline | counter-propose`.
- **Board → Task:** Native Claude Agent SDK subagent spawn — `agents` map plus tool-use of the `Agent` tool. Supports `background: true` for fire-and-forget.
- **Any agent → UI:** OpenTelemetry spans emitted on `PreToolUse`/`PostToolUse`/`SessionStart`/`SessionEnd`/`UserPromptSubmit` hooks. Spans flow through a local OTel collector (in the Rust shell) to **(a)** Langfuse over OTLP and **(b)** the renderer over a Tauri Channel for live UI.
- **Any agent → Memory:** Letta MCP tools (`letta_search_archival`, `letta_append_archival`, `letta_edit_core`) for hot memory; Obsidian REST API + filesystem writes (via the `obsidian` MCP server) for the wiki.
- **User → System:** keyboard, mouse, voice (via on-device Whisper, stretch in v1.0), or terminal commands.

### 5.3 Failure model

- **Sidecar Node crash:** Tauri shell detects exit, restarts within 2s, rehydrates Skippy + boards from a SQLite checkpoint of conversation tail + Letta archival pointers.
- **Board crash:** Skippy reroutes pending tasks; the board agent restarts with last-known plan from its Letta core memory.
- **Task agent crash:** parent board re-spawns or re-routes per Skippy's policy.
- **LLM API outage:** queue grows in SQLite, agents pause, UI shows yellow connectivity banner. No partial writes to the vault during outages (atomic write + lockfile, see §8.5).
- **Vault corruption:** git-backed; auto-commit every 5 min; recoverable to any prior state.

---

## 6. The Board of Agents (charters)

For v1, every Board agent has a **charter file** in `agent_space/boards/{name}.md` derived from the Hoya_Box prompt. Below is the spec for what each charter must contain. Concrete charters are written during build, not in this PRD.

### 6.1 Charter schema

```yaml
---
board: engineering
display_name: "The Engineering Captain"
codename: "Wrench"          # short identifier used in logs
costume:                    # see §12 — sprite asset references
  base: beercan_v1
  hat: hard_hat_with_cad_visor
  body: blue_coveralls
  accent_color: "#66FCF1"
  insignia: gear_circuit
model: claude-sonnet-4-6
effort: high
permission_mode: ask        # ask | acceptEdits | bypassPermissions | plan
mcp_servers: [obsidian, letta, n8n_engineering, github]
tools: [Read, Edit, Write, Bash, Grep, Glob, Agent]
disallowed_tools: []
memory:
  letta_agent_id: bd_engineering_v1
  vault_subdir: 50_Agents/engineering/
  core_memory_facts:
    - "I am the Engineering Captain. I report to Skippy."
    - "I delegate to task agents. I implement only when no task agent is appropriate."
spawnable_task_agents: [code_architect, debugger, simulation_specialist, optimization_specialist]
---

# Engineering — Charter

## Mission
…multi-paragraph charter describing scope, exclusions, escalation rules…
```

### 6.2 Inheritance from Hoya_Box

Each board's charter ports from one or more existing `.claude/agents/*.md` files in `Hoya_Box/agent_space/`, then adds:

- The **Board** identity (the agent knows it is one of eight captains, knows Skippy is its commander, knows it spawns task agents).
- The **costume** stanza (so the renderer knows what sprite to draw).
- The **letta_agent_id** + **vault_subdir** memory bindings.
- A **spawnable_task_agents** allow-list so a board can't accidentally spawn outside its skill area.

### 6.3 Adding a new task agent (the supply chain)

The Hoya_Box `agent-creator` becomes Skippy's **Staff Officer for agent provisioning**. When a board determines it needs a task agent type that doesn't exist, it raises a `provisioning_request` to Skippy; Skippy delegates to `agent-creator`; new agent is generated, audited by `skill-auditor`, and added to the board's allow-list. This keeps spawning safe and on-brand.

---

## 7. Dashboard UX — The RTS HUD

### 7.1 Window layout (default)

```
┌─────────────────────────────────────────────────────────────────────────┐
│ TOPBAR │ tokens/s 3.2k │ ctx 142k/200k │ 14/30 supply │ 🔇  ⚙   👤      │
├──────────────────────────────────────────────────────┬──────────────────┤
│                                                      │ SELECTED PANEL   │
│                                                      │ ┌──────────────┐ │
│                                                      │ │  [portrait]  │ │
│                                                      │ │   Skippy     │ │
│                                                      │ └──────────────┘ │
│   THE MAP (PixiJS canvas)                            │ HP: 142k ctx    │
│                                                      │ APM: 47          │
│   • Skippy (center, on the throne tile)              │ Task: orchestr…  │
│   • Eight board captains in a clock-ring             ├──────────────────┤
│   • Task agents swarming out to file pedestals       │ FULL LOG / TRACE │
│   • Glowing paths between agent ↔ build site         │ (scrollable)     │
│   • File/module tessellation as the ground plane     │                  │
│                                                      ├──────────────────┤
│                                                      │ COMMAND CARD     │
│                                                      │ [Q][W][E][R]     │
│                                                      │ [A][S][D][F]     │
│                                                      │ [Z][X][C][V]     │
├──────────────────────────────────────────────────────┴──────────────────┤
│ MINIMAP    │ TERMINAL CLUSTER (1-N panes, xterm)        │ IDLE: 2 ZZZ   │
│ ▢ ▢ ▢ ▢   │ $ skippy delegate "fix the auth bug"       │ Ctrl+. cycles │
└─────────────────────────────────────────────────────────────────────────┘
```

The window is **resizable and supports multi-window mode** (Tauri 2 native): the user can pop the terminal cluster, the telemetry panel, or even the map into separate OS windows on a second monitor.

### 7.2 The map (the RTS battlefield)

- **Ground plane:** an isometric tessellation of the project's directory tree. Each top-level directory is a "biome" (visually distinct), each sub-directory a tile, each file a pedestal. Pedestal height encodes file size; pedestal hue encodes git age. (Steal AlphaStar's feature-layer toggles: F1 size, F2 git age, F3 test coverage, F4 error density.)
- **Skippy's throne** is at center. He is fixed; he never walks the map. Pulses cyan when broadcasting orders.
- **Board captains' hex-pads** form a clock-ring 200px out from Skippy. Each pad is the board's accent color. Captain stands on its pad; pad glows when the board has unfinished orders.
- **Task agents** spawn from a "barracks doorway" on the captain's pad, walk along glowing paths to their target pedestal, play the **working** animation, then either re-task or despawn.
- **Selection:** click a beercan → green selection ring + side panel populates. Drag-box → multi-select + roster panel. `Ctrl+1..9` → control groups (steal SC2 verbatim).
- **Issuing orders:** right-click on a target with units selected; **Shift+right-click** to queue. Active-pause with `Spacebar` (steal *They Are Billions*) — freezes mid-tool-call, lets you queue a multi-step plan across many units, unpause to release.
- **Strategic zoom:** mouse-wheel out smoothly transitions sprite → icon → dot → org-level (steal *Supreme Commander*). The minimap is just the same map zoomed all the way out, optionally pinned in a corner.

### 7.3 Fog of war (reinterpreted)

Three states per region of the project map:

1. **Unexplored (black)** — modules no agent has touched this session.
2. **Shrouded (gray, last-known)** — modules an agent worked on, but on a branch/PR you haven't reviewed. You see structure but not latest content. Hover: *"Last seen by Engineering at 14:32, 23 changes pending review."*
3. **Bright (live)** — modules currently under an agent's gaze, content streaming.

Reviewing a PR (i.e., merging or accepting agent output) is what de-shrouds a region. This makes review a visible, satisfying act, not an afterthought.

### 7.4 The selected panel

When an agent is selected, the right-side panel shows:

1. **Identity** — portrait, role, costume, model, current effort, current permission mode.
2. **HP-equivalents** — context window % used, tools-call quota in rolling 60s, time since last LLM call.
3. **Current task** — name, parent task ID, started-at, ETA estimate.
4. **Live log** — streaming stdout from the agent's PTY *and* the structured event stream (PreToolUse → PostToolUse pairs). Color-coded by event type. Scrollable, searchable, replayable.
5. **Memory bindings** — link to the agent's Letta core memory + Obsidian sub-vault.
6. **Command card** — 12 buttons (3×4 grid, à la SC2 command card) bound to common orders for that agent type. Engineering's card has *Refactor / Add Test / Profile / Diagram / …*; Marketing's has *Draft Post / A/B Variants / Schedule / Analytics / …*.

### 7.5 Telemetry panel (toggleable side-tab)

A second tab on the right panel shows aggregate telemetry — see §9.

### 7.6 Terminal cluster (bottom strip)

- **One PTY per agent** (Claude Code subprocesses) plus **one user PTY** for ad-hoc shell.
- Multi-pane CSS grid; each pane is an xterm instance; user can split/close/zoom.
- Synced selection: clicking a beercan with the **terminal-link** modifier focuses that beercan's PTY.
- Command-block Warp-style rendering for the user PTY (each command + output forms a collapsible block).

### 7.7 Hotkey-driven workflow (steal SC2 muscle memory)

| Key | Action |
|---|---|
| `Ctrl+1..9` | Bind selection to control group N |
| `1..9` | Select control group N |
| `Shift+1..9` | Add to control group N |
| `Tab` | Cycle through selected group |
| `Spacebar` | Active-pause |
| `Ctrl+.` | Cycle through idle agents (steal AoE) |
| `F1..F4` | Toggle minimap layers |
| `T` | Focus the user terminal |
| `M` | Open strategic-zoom (full-screen map) |
| `R` | Open replay scrubber |
| `O` | Open Obsidian to selected agent's vault sub-dir |
| `Ctrl+K` | Command palette |

### 7.8 Voice (stretch in v1.0, planned in v1.1)

On-device Whisper for voice-to-task: hold `~` to dictate an order to Skippy. Steal BridgeMind's BridgeVoice pattern; do not stream to cloud.

---

## 8. Memory & Obsidian Vault

### 8.1 The Karpathy doctrine

The vault is structured per Karpathy's April 2026 `llm-wiki` gist:

- **Sources** — immutable raw inputs (papers, articles, conversations).
- **The wiki** — LLM-generated markdown notes. Atomic facts, concept pages, entity pages.
- **The schema** — `vault/CLAUDE.md` tells every agent how the wiki is structured and what it can/can't do.

The metaphor that drives the whole design: ***Obsidian is the IDE; the LLM is the programmer; the wiki is the codebase.***

### 8.2 Vault location & sync

```
Skippy_space/
└── vault/                     # the Obsidian vault root, one per project
    ├── CLAUDE.md             # Karpathy schema doc, version-pinned
    ├── 00_Inbox/             # raw capture, awaiting distill
    ├── 10_Atomic/            # atomic_fact, snippet — concept-oriented
    ├── 20_Topics/            # entity / concept pages — the wiki proper
    ├── 30_Projects/          # project_briefs, decisions, postmortems
    ├── 40_Daily/             # YYYY-MM-DD.md, agent + human dailies
    ├── 50_Agents/            # per-agent persona pages, capability notes
    │   ├── engineering/
    │   ├── coding/
    │   └── …                 # one sub-dir per board
    ├── 60_Sources/           # immutable raw sources
    ├── 90_Archive/           # status:deprecated lives here
    └── _index/               # generated: graph stats, orphan list, contradiction log
```

**Sync strategy:** **git only.** The vault is committed inside the project repo, with auto-commit every 5 min via a Skippy_space-managed cron. Cloud sync (Dropbox/iCloud) is **forbidden** — silent corruption on multi-writer is a deal-breaker. Obsidian Sync is opaque to agents; Syncthing is fine for users but adds a daemon. Git gives free conflict detection, history, undo.

### 8.3 Frontmatter schema (required on every note)

```yaml
---
id: 01HZX9K2P7M4QTYV3BRWC8XENF        # ULID, immutable, primary key
title: "Karpathy AI wiki — atomic note pattern"
created_at: 2026-04-29T14:32:11Z
updated_at: 2026-04-29T14:32:11Z
type: concept                          # see §8.4
status: draft                          # draft | active | distilled | canonical | archived
tags: [memory, wiki, agents]
source: https://gist.github.com/...    # or file:// or conv:// or ref:#id
authored_by: skippy.research.web      # board.task or "human"
confidence: 0.7                        # 0.0–1.0
distilled_from: ["01HZX8...", "01HZX7..."]
supersedes: null
contradicts: []
---
```

ULID generation via `obsidian-ulid-plugin`; agents use the `ulid` npm pkg in the sidecar.

### 8.4 Note types (closed set)

`atomic_fact`, `decision`, `postmortem`, `snippet`, `external_source`, `conversation_summary`, `agent_log`, `daily`, `weekly`, `project_brief`, `entity`, `concept`, `agent_persona`.

### 8.5 The four-job memory pipeline

| Job | Trigger | Owner | Output |
|---|---|---|---|
| **Ingest** | file dropped in `00_Inbox/` or `60_Sources/`; chokidar watcher | `research.ingest` task agent (Haiku) | normalized markdown w/ frontmatter; original moved to `60_Sources/` |
| **Distill** | new ingest event | `research.distiller` task agent (Sonnet) | atomic notes in `10_Atomic/`, candidate updates to `20_Topics/` entity pages |
| **Link** | post-distill + nightly cron | `staff.memory_manager` (graph-walk + embedding) | adds `[[wikilinks]]`, fills `contradicts`, marks `supersedes` |
| **Lint/Review** | nightly + weekly | `staff.memory_manager` (read-only by default) | orphan list, contradiction queue, stale-claim flags, weekly synthesis |

The lint job **never writes destructively** — it opens proposal notes in `_index/proposals/` for human or supervisor approval.

### 8.6 Concurrency & conflicts

Pick: **atomic write (`tmp` + `rename`) + per-file `proper-lockfile` + git as safety net.**

- `write-file-atomic` for normal writes (Windows EPERM retry-with-backoff).
- `proper-lockfile` for the rare contention path.
- `agent_log` and `daily` notes are **append-only**, never edited.
- Contradictions are **first-class, not errors**: agent B's incompatible claim sets `contradicts: [<a_id>]` and opens a resolution task.
- Supersession is **explicit**: `supersedes: <old_id>` + old note → `status: deprecated` → `90_Archive/` after 30 days.

### 8.7 Retrieval (hybrid, in priority order)

1. **CLAUDE.md preamble** — every agent loads it on session start.
2. **Direct path lookup** — if the query names an entity (e.g. `agent_memory`), open `20_Topics/agent_memory.md` and follow `links_to` one hop.
3. **Backlink walk** — 1–2 hop graph traversal from seed pages, depth-bounded.
4. **Vector search fallback** — over `10_Atomic/` and `60_Sources/`, **never** over `20_Topics/` (topics are by-name, not by-similarity).
5. **Confidence + recency rerank** — penalize `confidence < 0.5`, `updated_at > 90 days` unless `status: canonical`.

### 8.8 Vector store choice

**v1: Smart Connections (free, local).** Bundled bge-micro-v2 (384-dim), indexes the whole vault to `.smart-env/`, exposed via `obsidian-mcp-tools`.

**v2 migration path: LanceDB** under `vault/.skippy/vectors.lance` when corpus exceeds ~5k notes or when we need richer metadata filtering.

### 8.9 Obsidian integration plumbing

| Plugin | Purpose |
|---|---|
| **Local REST API** (coddingtonbear, v3.5+) | HTTP control plane on `:27124` for surgical edits, Dataview queries, command triggers |
| **Smart Connections** (brianpetro) | Local embeddings |
| **Dataview** | Agent-readable queries (e.g., orphan-finder) |
| **Templater** | Structured note creation |
| **obsidian-ulid-plugin** | ULID frontmatter on note creation |

MCP servers (in install priority):

1. `cyanheads/obsidian-mcp-server` — surgical edits + frontmatter ops (default).
2. `jacksteamdev/obsidian-mcp-tools` (Apr 2026, v0.2.31) — semantic search via Smart Connections.
3. Direct `fs` writes for atomic note creation (faster, deterministic, app-closed-safe).

### 8.10 Risks & guards

- **Hallucinated notes** → guard: every `atomic_fact` requires a `source` ref; sourceless notes auto-tagged `status: draft`, excluded from retrieval.
- **Infinite link cycles** → guard: graph walks bounded to depth 3, node budget 50, nightly cycle detection.
- **Stale info dominating retrieval** → guard: confidence decays linearly past 90 days unless reinforced; weekly lint surfaces top-10 stalest high-traffic notes.
- **Vault bloat** → guard: soft cap of 5,000 notes in `10_Atomic/`; consolidation pass merges near-duplicates (cosine > 0.92) into canonical chains.
- **Agent groupthink** → guard: `authored_by` distribution per topic; >70% from one agent triggers diversification routing.
- **Schema drift** → guard: `vault/CLAUDE.md` is version-pinned; agents that observe a mismatch halt writes and request human review.

---

## 9. Telemetry & Observability

### 9.1 Standard

**OpenTelemetry GenAI Semantic Conventions** (stable as of early 2026). Every LLM call, tool call, agent task, and memory operation emits a span with the `gen_ai.*` attribute set.

### 9.2 Pipeline

```
Claude Agent SDK hooks ──► OTel SDK in Node sidecar ──► OTel Collector in Rust shell ─┬──► Langfuse OTLP endpoint  (persistence + evals)
                                                                                       └──► Tauri Channel ──► Renderer telemetry panel (live)
```

### 9.3 Backend: self-hosted Langfuse

- **Why:** OSS (MIT), self-hostable in 5 min via Docker Compose, OTLP-native at `/api/public/otel`. Single-node + Postgres handles ~5M spans/day for a hobby price. Session replay UX is the killer feature.
- **Alternatives considered:** Arize Phoenix (heavier ops), LangSmith (vendor lock, no free self-host), OpenLLMetry (instrumentation, not a backend). All explained in `docs/research/02_orchestration_frameworks.md` §B.

### 9.4 Renderer panel

Custom React panel subscribing to the OTel-Channel stream. Renders four widgets:

1. **Cost meter** — total $ this session, broken down by board.
2. **Latency histogram** — p50/p95/p99 of LLM call duration, tool call duration, board→task hand-off.
3. **Context-window pressure** — per-agent stacked bar showing % consumed.
4. **Error feed** — tail of error spans, click to deep-link Langfuse session view.

### 9.5 Replay

Every session writes a `.replay` file (a sequence of OTel spans + the agent transcripts). Hit `R` to scrub: select an agent at timestamp T, the side panel shows what *that agent knew* at T. (Steal SC2 replay UX literally.)

---

## 10. Terminal Integration

### 10.1 Goals

A real interactive terminal in the app — not a TUI emulator pretending. Equivalent capability to PowerShell / Git Bash / a fresh VS Code terminal.

### 10.2 Implementation

- **Frontend:** `@xterm/xterm` v5.5+ with `@xterm/addon-fit`, `@xterm/addon-web-links`, `@xterm/addon-canvas` (or webgl).
- **Backend (PTY):** Rust `portable-pty` crate inside a Tauri plugin → ConPTY (Win10 1809+). One PTY per spawned Claude Code subagent + one for the user's interactive shell.
- **Multi-pane:** CSS grid with N xterm instances; each backed by its own PTY. **Do not embed tmux/zellij** — agent-per-PTY is already the multiplexing layer.
- **Command blocks:** the user PTY renders Warp-style command blocks (each command + output is a foldable unit).

### 10.3 Why not node-pty

`node-pty` requires native rebuilds, drifts on Node major-version bumps, and `winpty` was removed from it in 2026 — meaning ConPTY only on Windows. Going through Rust eliminates the rebuild ceremony and the cross-runtime bugs.

### 10.4 Edge cases

- ConPTY 24-bit color and resize semantics are slightly off-spec — test `claude-code` TUI output explicitly during dev.
- Defender / Search Indexer transient locks on the working directory — wrap rename ops with retry-with-backoff (already needed for §8.6 anyway).

---

## 11. Technical Stack

### 11.1 Consolidated stack table

| # | Layer | Choice | Runner-up |
|---|---|---|---|
| 1 | **Shell** | Tauri 2 (Rust core, WebView2) | Electron |
| 2 | **Frontend** | Vite 6 + React 19 + react-router 7 | SolidStart |
| 3 | **Rendering** | PixiJS v8 + `@pixi/react` v8 | Phaser 3 |
| 4 | **Terminal** | `@xterm/xterm` v5.5 + Rust `portable-pty` (ConPTY) | node-pty sidecar |
| 5 | **Event Bus** | Tauri Channels w/ Zod-validated envelope | Local WebSocket |
| 6 | **State** | Zustand + transient ref-store for per-frame data | Jotai |
| 7 | **Agent Runtime** | TypeScript / Node 22 LTS sidecar w/ `@anthropic-ai/claude-agent-sdk` | Python claude-agent-sdk |
| 8 | **Memory** | Letta (self-hosted) + Obsidian (vault) + Smart Connections (vectors) | LangGraph checkpointing |
| 9 | **Telemetry** | OTel GenAI conventions → self-hosted Langfuse + custom React panel | Arize Phoenix |
| 10 | **Subprocess** | Rust-spawned Node sidecar; `portable-pty` per Claude Code; `execa` for shell | Bun.spawn |
| 11 | **Packaging** | Tauri MSI/NSIS + Azure KV EV cert + Tauri Updater | unsigned NSIS |
| 12 | **External integrations** | n8n (self-hosted) wrapped behind a single MCP server | direct API calls |

### 11.2 Day-1 install order

1. **Node 22 LTS** — `winget install OpenJS.NodeJS.LTS`
2. **pnpm 9** — `corepack enable && corepack prepare pnpm@latest --activate`
3. **Rust stable + MSVC** — `winget install Rustlang.Rustup`, `rustup default stable-x86_64-pc-windows-msvc`, install VS 2022 Build Tools (Desktop C++)
4. **Edge WebView2 Runtime** — `winget install Microsoft.EdgeWebView2Runtime` (usually present)
5. **Tauri CLI** — `pnpm add -g @tauri-apps/cli@^2`
6. **Docker Desktop** — `winget install Docker.DockerDesktop` (for Langfuse + Letta)
7. **Obsidian** — `winget install Obsidian.Obsidian` + install Local REST API plugin in-app, copy API key
8. **Repo init** — `pnpm create tauri-app skippy-space --template react-ts --manager pnpm` (already partially done — Skippy_space is already a git repo)
9. **App deps** — `pnpm add zustand @xterm/xterm @xterm/addon-fit pixi.js @pixi/react react-router-dom zod gray-matter ulid write-file-atomic proper-lockfile chokidar`
10. **Agent runtime deps** (in `apps/agent-runtime`) — `pnpm add @anthropic-ai/claude-agent-sdk @anthropic-ai/sdk pino execa @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-http`
11. **Tauri Rust crates** — `tauri`, `tauri-plugin-updater`, `tauri-plugin-fs`, `portable-pty`, `notify`
12. **Langfuse** — `git clone https://github.com/langfuse/langfuse && cd langfuse && docker compose up -d`
13. **Letta** — `docker run -d -p 8283:8283 letta/letta:latest`
14. **Code-signing cert** — Azure Key Vault, generate EV CSR, submit to Sectigo/DigiCert (1–5 day issue)
15. **Tauri updater keypair** — `pnpm tauri signer generate -w ~/.tauri/skippy.key`
16. **Claude Code CLI** (used by some agents as subprocess) — `pnpm add -g @anthropic-ai/claude-code`

### 11.3 Repository layout

```
Skippy_space/
├── README.md
├── CLAUDE.md                      # for Claude Code; points at PRD
├── package.json                   # pnpm workspace root
├── pnpm-workspace.yaml
├── docs/
│   ├── PRD.md                     # this document
│   ├── architecture.md
│   ├── roadmap.md
│   └── research/
│       ├── 01_hoyabox_recon.md
│       ├── 02_orchestration_frameworks.md
│       ├── 03_bridgemind_youtube.md
│       ├── 04_rts_orchestration.md
│       ├── 05_karpathy_wiki.md
│       ├── 06_obsidian_integration.md
│       └── 07_tech_stack.md
├── vault/                         # the Obsidian vault (committed)
│   ├── CLAUDE.md                  # Karpathy schema doc
│   └── 00_Inbox/ … 90_Archive/
├── agent_space/                   # ported from Hoya_Box
│   ├── CLAUDE.md
│   ├── boards/                    # 8 board charters
│   ├── staff/                     # agent-creator, skill-auditor, memory-manager
│   ├── skills/
│   ├── commands/
│   ├── rules/
│   └── settings.json
├── apps/
│   ├── shell/                     # Tauri Rust shell
│   │   └── src-tauri/
│   ├── ui/                        # Vite + React 19 renderer
│   │   ├── src/
│   │   │   ├── scene/             # PixiJS RTS scene
│   │   │   ├── panels/            # Selected, Telemetry, Terminal
│   │   │   ├── stores/            # Zustand
│   │   │   └── routes/
│   │   └── index.html
│   └── agent-runtime/             # Node 22 LTS sidecar
│       └── src/
├── packages/
│   ├── shared/                    # types, event-envelope schemas, constants
│   ├── memory/                    # Letta + Obsidian client + frontmatter
│   ├── otel/                      # OTel collector config + custom exporter
│   └── sprite-kit/                # PixiJS sprite components, costume system
└── infra/
    ├── langfuse/                  # docker-compose override
    ├── letta/                     # config
    └── n8n/                       # workflow exports
```

---

## 12. Sprites, Art Direction, Visual Identity

### 12.1 The literature-accurate beercan

- **Base shape:** a metallic cylindrical canister, ~16:9 aspect (taller than wide), with a slight indentation top and bottom (per *Expeditionary Force* descriptions of Skippy's housing). Brushed-metal texture, subtle scratches.
- **Skippy's specific sprite:** an antenna nub, a small unblinking blue LED, a pull-tab top. Floats slightly above the throne tile (he is, technically, not a beverage).
- **Board captains' sprites:** same base, role-specific clothing & accessories. Each board has a distinct accent color (used for selection rings, hex pads, command-card buttons).

### 12.2 Costume system

Costumes are layered sprites composited at runtime:

```
beercan_base.png  (16-bit-ish pixel-art, ~64x96 px source, scaled up)
+ hat layer       (e.g., hard_hat, beret, top_hat, headphones, party_hat)
+ body layer      (e.g., coveralls, lab_coat, suit_jacket, apron)
+ accessory layer (e.g., monocle, cigar, tablet, wrench)
+ insignia layer  (board's circuit-style emblem)
+ accent_color    (tinted swatch on body)
```

### 12.3 Default board costumes

| Board | Hat | Body | Accessory | Accent |
|---|---|---|---|---|
| Engineering | hard_hat_with_visor | blue_coveralls | wrench | `#66FCF1` |
| Coding | wireframe_headset | hoodie | mechanical_keyboard | `#45A29E` |
| Design | beret | smock_paint_splatter | brush | `#BC13FE` |
| Marketing | snapback_cap | bomber_jacket | megaphone | `#FF6B6B` |
| Finance | top_hat | three_piece_suit | monocle_and_chart | `#F1C40F` |
| Research | wizard_cap | tweed_jacket | scroll | `#9B59B6` |
| Publishing | newsboy_cap | apron_with_pen_loops | typewriter | `#E67E22` |
| DevOps | beanie | flannel | terminal_tablet | `#2ECC71` |

Skippy himself wears a **shimmering cape** + **regal antenna crown** + **the Magnificent insignia** (a cyan crown overlaying a gear). His base color is full neon cyan.

### 12.4 Animation states (every agent, all costumes)

| State | Frames | FPS | Notes |
|---|---|---|---|
| idle | 6 | 8 | subtle bob, blinking LED |
| working | 8 | 12 | typing/welding loop with sparks |
| thinking | 4 | 6 | thought bubble pulse, used while waiting on LLM |
| speaking | 3 (mouth flap) | 8 | blendable with idle/working |
| completed | 12 (one-shot) | 12 | triumphant pose, confetti particle |
| error | 4 | 4 | red blink, slumped, looped until acknowledged |
| spawning | 8 (one-shot) | 16 | pop-in from barracks doorway |
| despawning | 6 (one-shot) | 12 | poof of smoke |

Total ~280 frames × 8 board costumes + 1 Skippy = manageable single-artist scope. **OQ-02:** generative-AI-assisted sprite art (Aseprite + Stable Diffusion sprite LoRA) vs commissioned artist? Tentative answer: generative for v0, commissioned hand-pixeled for v1.

### 12.5 Asset pipeline

- Source: Aseprite project files in `packages/sprite-kit/sources/`.
- Build: TexturePacker (or Free Texture Packer) → atlas + json in `packages/sprite-kit/dist/`.
- Loaded via `Pixi.Assets.load()` once at app boot.

---

## 13. Workflows (golden paths)

### 13.1 Cold start → first task

1. User launches Skippy_space (Tauri app).
2. Splash → Skippy boots (loads CLAUDE.md, vault summary, pinned core memory).
3. Boards initialize in the background; the user sees the clock-ring populate one captain at a time as each `query()` warms up.
4. User types in the order bar: `Build me a CLI tool that fetches recent ArXiv papers on plasma physics and stores summaries in the vault.`
5. Skippy emits a plan in Skippy-voice: *"Oh good, more plasma physics. The Engineering Captain shall handle the architecture, Coding handles the implementation, Research feeds the vault. Try not to break anything, monkeys."*
6. Skippy delegates: Engineering captain accepts → spawns `code_architect` task agent → produces a design note in `vault/30_Projects/`. Coding captain spawns `tdd_specialist` and `debugger` task agents.
7. The user watches beercans walk between file pedestals.
8. Skippy signals completion; the user reviews the diff (de-shrouds the region); on accept, the task agents despawn.

### 13.2 Drop a paper into the wiki

1. User drops `paper.pdf` into `vault/00_Inbox/`.
2. chokidar fires; `research.ingest` task agent normalizes the paper into a markdown source note in `60_Sources/`.
3. `research.distiller` produces 8–15 atomic notes in `10_Atomic/` and updates 2–3 entity pages in `20_Topics/`.
4. `staff.memory_manager` runs the link job; new wikilinks appear in the graph.
5. The user, browsing Obsidian, sees the new pages and approves canonicalization.

### 13.3 Multi-agent feature with active-pause

1. User selects six task agents across three boards.
2. Hits `Spacebar`. World freezes.
3. User shift-right-clicks a sequence: `migrate_db → write_test → refactor_handler → add_feature → smoke_test → write_changelog`.
4. Hits `Spacebar` again. Six agents queue the orders; Skippy narrates as orders execute serially per dependency, in parallel where independent.

### 13.4 Replay debugging

1. Yesterday's session went sideways.
2. User opens replay scrubber (`R`), drags timeline to the moment of failure.
3. Selects the offending beercan; side panel shows that agent's exact context window, tool call, and response.
4. User opens the Langfuse session for the same span ID for full token-level detail.

### 13.5 Cost audit

1. User opens telemetry tab → cost meter.
2. Sees that Marketing has been burning Sonnet on tasks that should be Haiku.
3. Right-click Marketing captain → command card → *Lower-Default-Model*. Saved to charter, takes effect on next task.

### 13.6 Quitting safely

1. User hits `Ctrl+Q`.
2. Skippy commits the vault, flushes Letta state, drains in-flight task agents (waits up to 60s for graceful exit), persists session checkpoint.
3. All board agents end their `query()` cleanly. Tauri shell exits.

---

## 14. Phased Roadmap

### 14.1 Phase 0 — Foundation (week 0–2)

**Goal:** Empty shell that boots, shows a Hello-Skippy, and can run a single Claude Agent SDK query end-to-end.

- [ ] Repo skeleton per §11.3 (this PRD already creates the docs + vault skeleton).
- [ ] Tauri 2 + Vite + React 19 boots on Windows.
- [ ] Tauri sidecar Node binary spawns at app start; runs a hello-world `query()` via Claude Agent SDK; pipes the response to the renderer over a Tauri Channel.
- [ ] Render a placeholder beercan sprite via PixiJS + `@pixi/react`.
- [ ] xterm + portable-pty embedded; one user PTY working.
- [ ] git auto-commit cron hooked up.
- [ ] Smoke test: ship an MSI (unsigned ok).

**Exit criterion:** the user can ask Skippy a question and watch a beercan say "thinking" → "speaking" → "idle".

### 14.2 Phase 1 — The Board (week 3–5)

**Goal:** All eight boards alive, each as its own `query()` process, each with charter ported from Hoya_Box.

- [ ] Port Hoya_Box `agent_space/.claude/agents/*.md` into `agent_space/boards/*.md` per §6.1 schema.
- [ ] Costume system per §12.3 in `packages/sprite-kit/`. Generative-AI sprites for v0 (8 costumes + Skippy).
- [ ] RTS map: clock-ring of board hex-pads. Captains visible. Skippy on throne. Click selection → side panel with placeholder telemetry.
- [ ] Skippy's `delegate_to_board` tool wired up as MCP server; round-trips through the right board process.
- [ ] Telemetry: Langfuse + Letta running in docker-compose; OTel collector in Rust shell relaying spans.
- [ ] Vault: scaffold per §8.2; CLAUDE.md schema doc; daily auto-note generator.

**Exit criterion:** the user can issue a multi-board task and watch the right captains light up + the right task agents spawn.

### 14.3 Phase 2 — RTS UX (week 6–8)

**Goal:** The dashboard feels game-like.

- [ ] File-pedestal map (project tree → tessellation).
- [ ] Task agents walk paths to file pedestals; play working anim.
- [ ] Selection model (single, drag-box, control groups, Tab cycle).
- [ ] Hotkeys per §7.7.
- [ ] Strategic zoom (steal SupCom): wheel out → icon → dot → org level.
- [ ] Active-pause (Spacebar) with order queueing.
- [ ] Fog of war reinterpretation per §7.3.
- [ ] Minimap + layer toggles (F1–F4).
- [ ] Command card per agent type (12-button grid).

**Exit criterion:** the user voluntarily uses Skippy_space for a full half-day of work without opening Cursor.

### 14.4 Phase 3 — Memory deepens (week 9–10)

**Goal:** The Karpathy wiki is alive; the four-job memory pipeline works end-to-end.

- [ ] obsidian-mcp-server + obsidian-mcp-tools wired in; agents can do surgical edits + semantic search.
- [ ] Smart Connections embedding pipeline.
- [ ] The four memory jobs (ingest, distill, link, lint) running on cron.
- [ ] Letta core/archival memory bound to each board; mirroring archival writes into the Obsidian vault.
- [ ] Replay + cost audit + context-window pressure widgets in the telemetry panel.

**Exit criterion:** dropping a paper into `00_Inbox/` produces a richly-linked set of atomic notes within 5 minutes.

### 14.5 Phase 4 — Polish + Ship (week 11–13)

- [ ] EV code-signing pipeline (Azure Key Vault).
- [ ] Tauri auto-updater.
- [ ] Onboarding flow (CLAUDE.md scan, first-run skippy intro, sample mission).
- [ ] In-app docs (open at any time, F1).
- [ ] Sprite v1 (commissioned hand-pixeled).
- [ ] v1.0 release; announce in Hoya_Box README.

**Exit criterion:** v1.0 build runs on a clean Windows 11 install with `winget install` of dependencies, signed installer, no SmartScreen warnings.

### 14.6 v1.1+ (post-ship)

- Voice-to-task (Whisper, BridgeVoice-style).
- macOS port.
- Multi-user "guest" mode.
- LanceDB migration.
- Obsidian plugin for in-Obsidian Skippy chat.

---

## 15. Risks & Mitigations

| ID | Risk | Severity | Mitigation |
|---|---|---|---|
| **R-01** | **Claude Agent SDK TS `query()` 12s cold-start** + **Node-spawning-claude-code subprocess bug** [issue #34, #771]. Together: agent spawns feel slow or fail. | **Critical** | (a) call `query()` in-process inside the Node sidecar; (b) when CLI is needed, spawn from Rust + portable-pty, never from Node; (c) keep a warm pool of 2–3 pre-initialized SDK contexts; backfill in background. |
| **R-02** | OTel GenAI semantic conventions still evolving (e.g., `gen_ai.usage.input_tokens` rename Mar 2026). | Medium | Wrap conventions in our own `packages/otel` DTO; bump quarterly. |
| **R-03** | Windows code signing for personal/small-team apps. EV cert HSM requirement (since Jun 2023). | Medium | Azure Key Vault EV cert (~$300–500/yr). Document renewal runbook; backup cert metadata in password manager. |
| **R-04** | WebGPU still flag-gated in some WebView2 builds. PixiJS perf depends on it. | Medium | Ship with WebGL fallback explicit; test on the latest stable WebView2 monthly. |
| **R-05** | ConPTY 24-bit color + resize off-spec — `claude-code` TUI may render badly. | Medium | Test claude-code TUI explicitly during dev; patch xterm config; if blocked, fall back to a node-pty sidecar. |
| **R-06** | Vault corruption from concurrent writes despite our atomic-write + lockfile. | Medium | Git auto-commit every 5 min; `.replay` files include vault snapshot pointers. |
| **R-07** | Multi-agent groupthink — one agent dominates a topic and biases the wiki. | Low–Medium | `authored_by` distribution check in lint job; route diversification. |
| **R-08** | Skippy persona drifts toward generic-helpful under model updates. | Medium | Pin charter; lint pass that grep's for "monkey" / "magnificent" / "asshole setting" frequency in transcripts; alert if below threshold. |
| **R-09** | LLM API cost runaway from a stuck agent. | High | Per-board $/hour budget cap; auto-pause on breach; weekly cost report. |
| **R-10** | The user gets bored of the RTS aesthetic in a month and wants pure productivity mode. | Low | Provide a "command-line-only" toggle that keeps the orchestration but hides the map. The map is the joy, not the lock-in. |
| **R-11** | Hoya_Box concept drift — we change agent definitions in Skippy_space without updating Hoya_Box. | Medium | Establish Hoya_Box as upstream; Skippy_space ports periodically; document the sync ritual in `docs/architecture.md`. |
| **R-12** | Single-machine memory limits — Langfuse, Letta, Obsidian, Tauri, Node, all running. | Low | Tauri footprint is tiny (~30–40MB); Langfuse + Letta in Docker can pause when not actively used. |

---

## 16. Open Questions

| ID | Question | Tentative answer |
|---|---|---|
| **OQ-01** | Should `psych-monitor` be a Staff Officer or under Research? | Staff Officer with read-access across boards. | 
| **OQ-02** | Generative AI sprites or commissioned artist for v1? | Generative throughout project
| **OQ-03** | Run Letta inside the Tauri sidecar or as a separate Docker container? | Docker container in v0; consider embedding in v1.x.
| **OQ-04** | n8n: bundle (run on user machine) or require user to install separately? | Require separate install + document; bundle would balloon the installer.
| **OQ-05** | Voice-to-task: in v1.0 or v1.1? | v1.1 — keep v1.0 scope tight. 
| **OQ-06** | Multi-monitor: support pop-out windows in v1.0 or wait? | v1.0 — Tauri 2 makes it cheap.
| **OQ-07** | Can task agents spawn each other (delegate down)? | **No.** Two tiers below the Board (board → task → no-grandchildren) keeps the SDK contract clean. Task agents must escalate to their board for further delegation. 
| **OQ-08** | Should the user be able to define a 9th custom Board? | Not in v1; the clock-ring layout assumes 8. Consider a "auxiliary" off-map agents region in v1.x.
| **OQ-09** | Cost: does Skippy expose dollar-cost in his narration ("That'll cost you 4 cents, monkey")? | Yes — fits the Iron Law of Delegation + "tattooed on Skippy's soul" cost discipline. 
| **OQ-10** | Does the dashboard auto-launch Obsidian if it's not running? | Yes — at app start; document this behavior; respect the user's window-state preference. 
| **OQ-11** | Should the wiki be one vault per project, or one global vault? | One per project. The vault is part of the project artifact and travels with it. Global cross-project memory lives in Letta archival.
| **OQ-12** | Telemetry retention: how long do we keep `.replay` files? | 30 days hot, then compressed to `90_Archive/replays/`. 
| **OQ-13** | What's the smallest possible v0 demo to validate the RTS-feel hypothesis with the user? | Phase 0 + a single board with a two sprites walking to a seperate file pedestals. Aim for end-of-week-2.
| **OQ-14** | Should the app's window title use Skippy-voice ("Skippy is, in fact, magnificent")? | Yes. Default on; toggle off in settings. 

---

## 17. Appendices

All appendices live in `docs/research/` as separate files, captured from the agent swarm that produced this PRD on 2026-04-29. They are kept verbatim for auditability:

1. `docs/research/01_hoyabox_recon.md` — Hoya_Box agent_space recon.
2. `docs/research/02_orchestration_frameworks.md` — Multi-agent framework survey + recommended backbone.
3. `docs/research/03_bridgemind_youtube.md` — BridgeMind channel mining + steal/skip list.
4. `docs/research/04_rts_orchestration.md` — RTS UX deepdive + concrete dashboard sketch.
5. `docs/research/05_karpathy_wiki.md` — Karpathy AI wiki spec for Skippy_space.
6. `docs/research/06_obsidian_integration.md` — Obsidian integration surface area.
7. `docs/research/07_tech_stack.md` — Full technical stack picks with install order.

### 17.1 Glossary

- **Beercan** — visual representation of any agent in Skippy_space.
- **Board** — one of the eight skill-area captain agents.
- **Captain** — synonym for Board agent.
- **Charter** — markdown file defining a Board agent's mission, model, tools, costume, and memory bindings.
- **Costume** — composite sprite layers giving a beercan its role-specific appearance.
- **Hex-pad** — colored hexagonal floor tile each Board captain stands on.
- **Iron Law of Delegation** — Skippy never implements; he plans, approves, assigns, monitors, broadcasts, synthesizes.
- **Skippy** — the Magnificent. Top-level orchestrator, sole occupant of the throne tile.
- **Staff Officer** — supporting agent reporting to Skippy directly (`agent-creator`, `skill-auditor`, `memory-manager`, `psych-monitor`).
- **Task agent** — short-lived subagent spawned by a Board captain.
- **Throne** — center tile of the RTS map; Skippy stands here.
- **The Wiki** — the Obsidian vault implementing Karpathy's `llm-wiki` pattern.

### 17.2 Sign-off

| Role | Name | Date | Status |
|---|---|---|---|
| Owner | JusHoya | | ☐ |
| Skippy | Skippy | 2026-04-29 | ✅ (with appropriate snark) |

---

*"Now, monkeys, get to work. The Great Skippy has spoken."*
