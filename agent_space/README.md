# agent_space — Skippy + Board Charters

This directory ports from `C:\Users\hoyer\WorkSpace\Projects\Hoya_Box\agent_space\` and houses every agent definition, skill, command, and rule used by Skippy_space.

**Status:** scaffolded only. Charters and skills will be ported during Phase 1 of the roadmap (PRD §14.2).

## Layout (target)

```
agent_space/
├── CLAUDE.md           # agent-side instructions (mirrors Hoya_Box's CLAUDE.md, adapted for Skippy_space)
├── settings.json       # Claude Code settings: model, effort, permissions, hooks
├── settings.local.json # local overrides (gitignored)
├── boards/             # 8 Board captain charters (engineering, coding, design, marketing, finance, research, publishing, devops)
├── staff/              # Staff Officers: agent-creator, skill-auditor, memory-manager, psych-monitor
├── tasks/              # Task agent templates spawnable by Boards
├── skills/             # Atomic skills inheritable by agents
├── commands/           # Slash commands (/team, /sync-knowledge, /audit-skills, /orbital-lead)
├── rules/              # Constitutional guidelines (rules.md from Hoya_Box)
└── mcp-configs/        # MCP server configs (obsidian, letta, n8n, github, etc.)
```

## Sync ritual with Hoya_Box

Hoya_Box is upstream. When you change a charter or skill here, also propose the matching change in `Hoya_Box/agent_space/`. Drift is a known risk (PRD R-11) — keep the sync cadence weekly.

## See also

- PRD §3 — Identity & Lore (Skippy + Beercans + Board)
- PRD §6 — The Board of Agents (charters)
- `docs/research/01_hoyabox_recon.md` — full inventory of what's portable from Hoya_Box
