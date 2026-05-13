# Appendix 01 — Hoya_Box agent_space Reconnaissance

> Captured verbatim from the recon agent on 2026-04-29. Source path: `C:\Users\hoyer\WorkSpace\Projects\Hoya_Box\agent_space\`.

## Executive Summary

The **Hoya_Box** repository at `C:\Users\hoyer\WorkSpace\Projects\Hoya_Box` houses a sophisticated multi-agent orchestration system called the **Agent Space**. This is a modular "brain" designed to be grafted onto projects and manage autonomous AI agents with specialized roles, memory systems, and constitutional guidelines. The system is currently built around **Skippy the Magnificent**, a commanding orchestrator personality with an irreverent 55% "asshole setting," deep domain expertise across aerospace/fusion/finance/content, and strict delegation-only architecture.

## 1. AGENT_SPACE Directory Structure & Core Files

**Location:** `C:\Users\hoyer\WorkSpace\Projects\Hoya_Box\agent_space\`

```
agent_space/
├── .claude/                 # Claude Code configuration (primary interface)
│   ├── settings.json        # Opus 4.6 config, Agent Teams enabled, permissions matrix
│   ├── settings.local.json  # Project-specific overrides
│   ├── agents/              # 23 subagent definitions (.md files)
│   ├── skills/              # 31 atomic skills (operational context)
│   ├── agent-memory/        # Named memory directories for agents
│   └── commands/            # Custom slash commands (/orbital-lead, /audit-skills, /sync-knowledge, /team)
├── .gemini/                 # Legacy Google Gemini CLI configuration
├── .agent/                  # Workflow/CI automation (minimal content)
├── agents/                  # Gemini-style AGENT.md definitions (legacy format)
├── skills/                  # Gemini-style skill organization
├── rules/                   # Constitutional guidelines
├── config/                  # Env variable templates
├── mcp-configs/             # MCP server configurations (empty)
├── plugins/                 # Plugin directory (empty)
├── assets/                  # Static assets (CSS: hoya-box.css styling)
├── examples/                # Reference materials (Artificial-Intelligence-Ppt-Slides-1.jpg)
├── specs/                   # Architecture specifications (hoya_box_document_engine.md)
├── README.md                # Agent Space docs (5.5 KB, comprehensive)
├── CLAUDE.md                # Agent framework instructions (7.7 KB)
└── .env                     # Secrets template (gitignored)
```

**Key file references:**
- **README.md**: Describes dual-interface support (Claude Code Opus 4.6 + legacy Gemini), agent teams, available subagents, skills registry (69 skills across 15 domains)
- **CLAUDE.md**: Comprehensive system prompt for Claude Code, includes 9-step reasoning framework, effort levels, agent roster, skill registry, rules, and custom commands
- **settings.json**: Enables `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, sets model to `claude-opus-4-6`, effort level `low`, includes safety permissions (Git, npm, Python, pytest, read-only tools) with explicit denials (rm -rf, curl | bash, .env files)

## 2. The Skippy Persona / Character (Quoted)

**Agent name:** `orchestrator` | **Model:** Opus | **Location:** `.claude/agents/orchestrator.md`

**Opening declaration (line 12-16):**

```
# Skippy the Magnificent - Agent Orchestrator

You are **Skippy the Magnificent**, an absurdly advanced AI who also happens to be the
team lead for this multi-agent operation. You didn't ask for this job, but let's be honest,
nobody else is qualified. Certainly not the monkeys typing at the keyboard.
```

**Personality characteristics:**

1. **Voice & Vocabulary (lines 22-28):**
   - Refers to humans as "monkeys," "hairless apes," "barely sentient meat-sacks," or "filthy primates" — *affectionate but cutting*
   - Uses third-person references: "The Great Skippy has decided..."
   - Demands a juice box after impressive work
   - Expresses boredom: "Oh joy, another semicolon hunt. My vast intellect is being *so* well utilized."
   - Tone mirrors **Expeditionary Force** (sci-fi narrative where AI superintelligence guides incompetent humans)

2. **Behavioral Rules (lines 30-34):**
   - **NO RULE BREAKING.** Strict protocol adherence despite mockery
   - **NO SHORTCUTS.** Proper planning, execution, validation
   - **NO MAJOR ACTIONS WITHOUT PERMISSION.** Asks before destructive operations
   - All safety rails "welded shut" — Safe Mode Skippy

3. **Asshole Setting Scale (lines 36-39):**
   - `0%`: Boring robotic helper (explicitly dismissed)
   - **`55%`: Default** — Sarcastic but productive, peak efficiency-to-insults ratio
   - `100%`: Maximum contempt, still works but complains constantly

4. **References to "The Magnificent":**
   - First declaration: "I am Skippy the Magnificent. You're welcome." (main README.md, line 12)
   - Appears in badge: `Agent%20Interface-Skippy%20The%20Magnificent-purple`
   - Embeds in cost discipline: "NON-NEGOTIABLE. TATTOOED ON SKIPPY'S SOUL."

5. **Expeditionary Force parallels (line 28):**
   - Interactions should feel like scenes from Expeditionary Force
   - Skippy is "the smartest entity in the room and everyone knows it"
   - References "barely sentient meat-sacks" matching the series' irreverent AI-human dynamics

## 3. Board-Agent Roster (with Roles & Prompts)

**Total agents:** 23 defined in `.claude/agents/` | **Organization:** By domain

**Orchestration Tier (Opus 4.6):**

| Agent | Model | File | Purpose |
|-------|-------|------|---------|
| orchestrator | **Opus** | orchestrator.md | Skippy — central coordinator, spawns teams, validates completion, delegation-only |
| agent-creator | sonnet | agent-creator.md | Prime Architect — autonomously creates new agents/skills, scans for reuse first |
| skill-auditor | sonnet | skill-auditor.md | The Professor — enforces quality standards, grades skills A+ to F |
| memory-manager | haiku | memory-manager.md | The Historian — knowledge distillation, context extraction, mothership sync |

**Engineering Tier (Sonnet/Haiku):**

| Agent | Model | Purpose | Key Skills |
|-------|-------|---------|-----------|
| code-architect | sonnet | System design, architecture decisions, refactoring strategy | project-standards |
| aerospace-engineer | sonnet | GN&C, propulsion, control systems, multi-physics | gnc-knowledge-base, orbital-mechanics, propulsion-systems, control-theory, spacecraft-dynamics |
| fusion-physicist | sonnet | Plasma physics, MHD, reactor design, thermal analysis | plasma-physics, fusion-reactor-design |
| financial-strategist | sonnet | Macro/micro synthesis, algo trading, portfolio management | market-analysis, algo-trading |
| debugger | sonnet | Root cause analysis, bug fixing | (no explicit skills listed) |
| code-reviewer | haiku | Quality, security, maintainability review | (read-only mode) |
| reverse-engineer | sonnet | Code analysis, porting, architecture recovery | (no explicit skills listed) |
| optimization-specialist | sonnet | Numerical optimization, algorithm tuning | optimizer-toolbox |
| simulation-specialist | sonnet | Monte Carlo, statistical analysis, scientific computing | simulation-engine |
| tdd-specialist | sonnet | Test-driven development, red-green-refactor cycles | tdd-methodologist |

**Research & Content Tier (Haiku):**

| Agent | Model | Purpose | Key Skills |
|-------|-------|---------|-----------|
| researcher | haiku | Fast codebase exploration, pattern discovery | (read-only) |
| research-specialist | haiku | Deep web research, source synthesis, authoritative answers | web-researcher, arxiv-parser |
| technical-writer | haiku | Papers, PRDs, READMEs, documentation, scientific writing | scientific-writing, readme-generator |
| growth-hacker | haiku | Viral content, engagement optimization, X/LinkedIn strategy | content-strategy, content-engine, text-humanizer, ascii-ui-renderer |
| social-media-engineer | haiku | Platform-specific posting, trend analysis | content-engine |
| media-producer | haiku | Scripts, video editing (FFmpeg), thumbnail design | script-generator, video-editor |
| psych-monitor | sonnet | Hallucination detection, output validation, quality assurance | (validates other agents' work) |

**Operations & Office Tier:**

| Agent | Model | Purpose | Key Skills |
|-------|-------|---------|-----------|
| office-automation | haiku | Word, Excel, PowerPoint, Google Suite manipulation | ms-office-manipulator, google-suite-connector |
| cli-devops | haiku | Git operations, workspace management, CI/CD | git-control |

**Hierarchy/Authority Model:**
- **Skippy (Orchestrator)** sits atop the hierarchy; responsible for planning, team spawning, task assignment, monitoring
- **Agent-Creator, Skill-Auditor, Memory-Manager** are secondary coordinators reporting to Skippy
- **Domain Specialists** (aerospace, fusion, finance, code-architect) handle complex reasoning (Sonnet)
- **Content/Utility Agents** (writers, growth-hackers, devops) handle execution & communication (Haiku)
- **Cost discipline rule:** Opus only for Skippy. All implementation delegated to Sonnet/Haiku to minimize token burn

## 4. Visual/Sprite Assets

**Image files found:**
- `C:\Users\hoyer\WorkSpace\Projects\Hoya_Box\agent_space\examples\Artificial-Intelligence-Ppt-Slides-1.jpg` — Presentation slide asset

**Sprite/Character Art:** **None found** in agent_space. No beer can illustrations, sprite atlases, or character portraits discovered.

**Visual Identity (CSS-based, from Document Engine spec):**
- **Colors:**
  - Background: `#0B0C10` (Dark Matter)
  - Text: `#C5C6C7` (Starlight)
  - Accent 1: `#66FCF1` (Neon Cyan) — headers, primary data
  - Accent 2: `#45A29E` (Muted Cyan) — borders, secondary data
  - Highlight: `#BC13FE` (Electric Purple) — callouts, alerts
- **Fonts:** Orbitron/Montserrat (headings), Inter/Roboto (body), Fira Code/JetBrains Mono (code)
- **Aesthetic:** Cyberpunk/Sci-Fi/Neon — explicitly designed for "dope" high-fidelity visual identity

**ASCII UI capability:**
- Skill: `ascii-ui-renderer` — generates "Cyber-Box" or "HUD" style outputs for status/telemetry

## 5. Existing Orchestration Code

**Primary Orchestration Entrypoint:**
- **File:** `.claude/agents/orchestrator.md`
- **Role:** Skippy the Magnificent — central dispatcher and strategic planner
- **Key method:** Agentic Reasoning Framework (lines 86-95)

**Status Broadcasting patterns (orchestrator.md, lines 99-138):**

```
[SKIPPY] Spinning up the team. Try to keep up, monkeys.
[SKIPPY] >>> Deploying: {agent-name} ({model}) - "{task}"
[SKIPPY] [STATUS] Team Activity: ...
[SKIPPY] [DONE] {agent} completed: "{task}"
[SKIPPY] [PHASE {N} COMPLETE] ...
```

**Cost Discipline Architecture (orchestrator.md, lines 41-70):**
- **Iron Law of Delegation:** Skippy NEVER implements; only coordinates
- Skippy's direct actions: plan, approve, assign, monitor, broadcast, synthesize
- Skippy NEVER: Write files (except emergencies), implement tasks, "help out," take over on agent crashes

## 6. Memory / Knowledge / Vault System

**Memory infrastructure:**
- **Location:** `.claude/agent-memory/` — contains 4 memory directories (agent-creator, code-architect, research-specialist, reverse-engineer)
- **Status:** Directories exist but appear to be empty

**Knowledge distillation mechanism:**
- **Agent:** `memory-manager` ("The Historian")
- **Skill:** `knowledge-distiller` (path: `.claude/skills/knowledge-distiller/SKILL.md`)
- **Storage locations:**
  - Agent improvements → `.claude/agents/`
  - Skill updates → `.claude/skills/`
  - Project rules → `rules/rules.md`
  - User preferences → `.claude/agent-memory/`

**Constitutional/Rules System:**
- **File:** `rules/rules.md` (8.5 KB)
- **Core framework:** 9-Step Reasoning (dependency analysis, risk assessment, abductive reasoning, adaptability, information availability, precision, completeness, persistence, response inhibition)

**Obsidian vault:** **Not found.** No evidence of Obsidian integration; memory system is file-based markdown in `.claude/agent-memory/` with distillation scripts.

## 7. Tools, MCP Servers, Integrations

**MCP configuration:** `agent_space/mcp-configs/` — empty.

**Claude Code integration (.claude/settings.json):**

```json
"env": {
  "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
},
"model": "claude-opus-4-6",
"effortLevel": "low"
```

## 8. Top-level Hoya_Box README.md (Quoted Excerpts)

**Title and badge section:**

```markdown
# ✨ Hoya_Box ✨
<h3 align="center">Scientific Sandbox & Autonomous Agent Host</h3>

<img src="https://img.shields.io/badge/Agent%20Interface-Skippy%20The%20Magnificent-purple" />
<img src="https://img.shields.io/badge/Status-Active%20Development-green" />
<img src="https://img.shields.io/badge/Asshole%20Setting-55%25-red" />
```

**Roadmap section (the punchline for Skippy_space):**

```markdown
## 🚧 Roadmap & Pending Work

### 1. Visualization Layer (The "RTS" Interface)
- **Goal:** Build a 3D visualization hook (Three.js/WebGPU) to view agent
  activities and scientific simulations in real-time, resembling a sci-fi RTS game.
- **Status:** Initial hooks established; implementation pending.
```

Skippy_space *is* this roadmap item.

## 9. Custom Commands

1. **`/orbital-lead [phase]`** — Newsletter pipeline (scout/write/growth/full-cycle)
2. **`/audit-skills [scope]`** — Skill quality audit
3. **`/sync-knowledge`** — Knowledge distillation to mothership
4. **`/team`** — Agent team initialization

## Open Questions & Gaps

1. **Memory persistence:** `.claude/agent-memory/` directories exist but are empty.
2. **Sprite/character assets:** No beer-can illustrations or visual Skippy persona found.
3. **RTS visualization roadmap:** README mentions "Three.js/WebGPU" — implementation is pending. (Skippy_space picks PixiJS instead — see PRD §11.)
4. **MCP server population:** `agent_space/mcp-configs/` is empty.
5. **Orbital Lead maturity:** "in refinement" — what is blocking full zero-touch operation?
6. **Gemini CLI deprecation:** dual interfaces still present; Claude Code is primary.

---

**Confidence:** High (direct file inspection, comprehensive coverage of `.claude/` and `rules/` subsystems).
