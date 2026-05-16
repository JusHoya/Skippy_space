# agent_space/CLAUDE.md — Skippy + Board charter conventions

This folder is the **agent identity layer** of Skippy_space. Every prompt, charter,
skill, and command that defines *how the agents think and speak* lives here. The
runtime sidecar (`apps/agent-runtime/`) loads these files at session start; the
Tauri shell never reads them directly.

> **Source of truth:** `C:\Users\hoyer\WorkSpace\Projects\Skippy_space\docs\PRD.md`
> — read §3 (Identity & Lore) and §6 (Board of Agents) before editing anything in
> here. If your edit disagrees with the PRD, fix the code *or* fix the PRD —
> never both, never silently.

## Layout

```
agent_space/
├── CLAUDE.md             # this file
├── skippy.md             # Skippy the Magnificent — top-level orchestrator charter
├── boards/               # 8 Board captain charters (one per skill area)
│   ├── engineering.md
│   ├── coding.md
│   ├── design.md
│   ├── marketing.md
│   ├── finance.md
│   ├── research.md
│   ├── publishing.md
│   └── devops.md
├── staff/                # Staff Officers reporting directly to Skippy
│   ├── agent-creator.md
│   ├── skill-auditor.md
│   ├── memory-manager.md
│   └── psych-monitor.md
├── tasks/                # (future) Task agent templates spawnable by Boards
├── skills/               # (future) Atomic skills inheritable by agents
├── commands/             # (future) Slash commands
├── rules/                # (future) Constitutional guidelines (ports from Hoya_Box rules.md)
└── mcp-configs/          # (future) MCP server configs
```

In Phase 1 only the top three layers are populated (`skippy.md`, `boards/`,
`staff/`). The lower layers are scaffolded into existence as later phases need
them (PRD §14.3+).

## Hierarchy at a glance

```
                       Skippy (skippy.md, model: opus)
                        │
        ┌───────────────┼───────────────┐
        │               │               │
   Staff Officers   8 Board Captains   (escalations, direct user orders)
   (staff/*.md)     (boards/*.md)
                        │
                        ▼
                  Task agents (spawned by a Board, defined later in tasks/)
```

**No grandchildren.** A task agent that needs to delegate must escalate to its
Board. This is PRD §3.3 + OQ-07, and it's a hard rule baked into the Claude
Agent SDK contract.

## Charter schema (PRD §6.1)

Every Board charter and Skippy himself use the same YAML frontmatter shape,
adapted from PRD §6.1:

```yaml
---
board: engineering              # or `agent: skippy` for the orchestrator
display_name: "The Engineering Captain"
codename: "Wrench"
costume:
  base: beercan_v1
  hat: hard_hat_with_visor
  body: blue_coveralls
  accent_color: "#66FCF1"
  insignia: gear_circuit
model: claude-sonnet-4-6
effort: high
permission_mode: ask           # ask | acceptEdits | bypassPermissions | plan
mcp_servers: [obsidian, letta, github]
tools: [Read, Edit, Write, Bash, Grep, Glob, Agent]
disallowed_tools: []
memory:
  letta_agent_id: bd_engineering_v1
  vault_subdir: 50_Agents/engineering/
  core_memory_facts:
    - "I am the Engineering Captain. I report to Skippy."
    - "I delegate to task agents. I implement only when no task agent is appropriate."
spawnable_task_agents: [code_architect, debugger, simulation_specialist]
---
```

The costume stanza is consumed by `packages/sprite-kit/src/boards.ts` —
**always** mirror the values there. Drift between the charter and the sprite
costume is a Phase-1 lint failure (the `validate:phase1` script — owned by
Agent F — will assert equality).

## MCP server registry

Charters declare available MCP servers via the `mcp_servers:` frontmatter
array. The runtime sidecar (`apps/agent-runtime/`) doesn't consume that
array yet — Phase 3 wires it into each agent's `query()` config — but the
declarations are the source of truth for *what an agent will be able to
call once the loop is wired*. PRD §8.9 lists the Obsidian-side MCP servers
(`cyanheads/obsidian-mcp-server`, `jacksteamdev/obsidian-mcp-tools`).
Beyond those, the registry currently includes:

| Server | Source | Purpose | Scope |
|---|---|---|---|
| `obsidian` | `cyanheads/obsidian-mcp-server` + `jacksteamdev/obsidian-mcp-tools` (PRD §8.9) | Surgical vault edits, frontmatter ops, Dataview queries, semantic search via Smart Connections. | All Boards + Skippy + Staff Officers. |
| `letta` | Letta server (self-hosted via `infra/letta/`) | Long-term agent memory (core, archival, episodic). Each agent binds to `letta_agent_id`. | All Boards + Skippy + Staff Officers. |
| `github` | `github/github-mcp-server` | Repo, PR, issue, and Actions ops for Boards that touch git. | Engineering, Coding, DevOps. |
| `playwright` | `@playwright/mcp` (npm; official Microsoft Playwright MCP server) | Headless + headful browser automation — `browser_navigate`, `browser_click`, `browser_type`, `browser_snapshot`, `browser_evaluate`, etc. | Skippy + every Board + every Staff Officer. |

### Playwright — install + setup

- **One-shot invocation:** `pnpm dlx @playwright/mcp@latest` lets a Phase-3
  agent pull the latest server without installing it permanently.
- **Pinned install:** `pnpm add -g @playwright/mcp` (or pin a specific
  version inside the future `agent_space/settings.json`) when you want a
  reproducible toolchain across sessions.
- **Browser dependency:** the MCP server doesn't bundle browsers; run
  `npx playwright install chromium` once per machine to drop a Chromium
  build into the Playwright cache. Firefox/WebKit are optional and added
  on demand.
- **Sample registration:** see `docs/PLAYWRIGHT.md` for a five-line JSON
  snippet an agent's `mcp_servers` config consumes.

`playwright` is registered on Skippy + every Board + every Staff Officer
so that any agent can verify a web surface without needing to escalate
for tooling. The Iron Law still applies: Skippy delegates browser work
to a Board rather than running it himself.

## Hoya_Box is upstream

This folder **ports from** `C:\Users\hoyer\WorkSpace\Projects\Hoya_Box\agent_space\`.
Skippy's voice, the four Staff Officers, and most Board captains derive from
agents that already exist in Hoya_Box. The Design board is new (no Hoya_Box
ancestor) and Research adds two NEW task-agent placeholders (`ingest`,
`distiller`) per PRD §8.5.

When you change a charter here, **also** propose the corresponding edit in
Hoya_Box so the two repos don't drift. R-11 in the PRD covers this risk. The
ritual is: weekly diff, manual merge, log the sync in `docs/changelog.md` under
the upcoming version.

## Voice convention (CLAUDE.md root says: do not strip)

- **Skippy** speaks in canonical Skippy voice — "monkey", "magnificent",
  "Iron Law", "Asshole Setting" must all appear in `skippy.md`.
- **Board captains** can be drier than Skippy, but each has a distinct register
  (Engineering = blunt + technical; Marketing = energetic + edgy; Design =
  considered + sharp-eyed; Finance = patrician + risk-averse; etc.).
- **Staff Officers** are functionaries — terse, mechanical, RTS-commander.
- **Task agents** inherit the voice of their parent Board.

If you can't tell which agent wrote a transcript from voice alone, the charter
isn't doing its job. The voice is load-bearing per the root `CLAUDE.md`'s
"Don't strip Skippy's voice" rule.

## Don't

- Don't add a Board. Eight is fixed in v1 (PRD §3.3, clock-ring layout).
- Don't let a task agent spawn grandchildren — escalate to the Board instead.
- Don't write to the vault without frontmatter — see PRD §8.3 for the required
  fields and root `CLAUDE.md` for the rule.
- Don't bypass permission gates in a charter. `permission_mode: bypassPermissions`
  exists, but using it without explicit user sign-off violates Skippy's "safety
  rails are welded shut" doctrine.

## See also

- `docs/PRD.md` §3 — Identity & Lore
- `docs/PRD.md` §6 — The Board of Agents (charter spec)
- `docs/PRD.md` §12 — Sprites, costume system (matches the `costume:` stanza)
- `packages/sprite-kit/src/boards.ts` — canonical `BOARD_COSTUMES` map
- `Hoya_Box/agent_space/.claude/agents/` — upstream definitions
