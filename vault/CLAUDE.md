# Vault CLAUDE.md — the Schema

> Per Karpathy's `llm-wiki` doctrine: this file tells every agent how the wiki is structured, what they can write, and what they must not. Always read it before performing any vault operation.

## What this vault is

A Karpathy-style **AI wiki**: a persistent, compounding artifact of the user's knowledge, written and maintained mostly by AI agents, structured as Obsidian markdown notes. The metaphor: *Obsidian is the IDE; the LLM is the programmer; the wiki is the codebase.*

There is exactly **one Skippy_space vault**, and it lives in this folder. Cross-project memory belongs to Letta archival storage, not here.

## Three layers (Karpathy)

1. **Sources** — `60_Sources/` — immutable raw inputs (papers, articles, conversations). Never edit.
2. **The Wiki** — `10_Atomic/` + `20_Topics/` + `30_Projects/` + `50_Agents/` + `40_Daily/` — LLM-curated markdown. Atomic facts, concept pages, entity pages, project briefs, daily notes, agent personas.
3. **The Schema** — this file. Read first. Treat as a contract.

## Folder layout

```
vault/
  CLAUDE.md         (this file — schema)
  00_Inbox/         raw capture awaiting distill
  10_Atomic/        atomic_fact, snippet — concept-oriented
  20_Topics/        entity / concept pages — the wiki proper
  30_Projects/      project_brief, decisions, postmortems
  40_Daily/         YYYY-MM-DD.md, agent + human dailies (append-only)
  50_Agents/        per-agent persona pages, capability notes
    engineering/    one sub-dir per Board
    coding/
    design/
    marketing/
    finance/
    research/
    publishing/
    devops/
  60_Sources/       immutable raw sources
  90_Archive/       status:deprecated
  _index/           generated: graph stats, orphan list, contradiction log, proposals
```

## Required frontmatter (every note)

```yaml
---
id: 01HZX9K2P7M4QTYV3BRWC8XENF        # ULID, immutable, primary key
title: "<one-line title>"
created_at: 2026-04-29T14:32:11Z
updated_at: 2026-04-29T14:32:11Z
type: <see Note types below>
status: draft                          # draft | active | distilled | canonical | archived
tags: [<lowercase, kebab-case>]
source: <ref to 60_Sources/ doc, conv://, ref://, or external URL>
authored_by: <board.taskagent or "human">
confidence: 0.0..1.0                   # agent self-rating
distilled_from: ["<id>", ...]          # ULIDs of parent notes (if any)
supersedes: <id|null>                  # if this replaces an older note
contradicts: ["<id>", ...]             # ids of notes this conflicts with
---
```

Generate ULIDs via the `obsidian-ulid-plugin` (in-app) or the `ulid` npm package (in the agent runtime).

## Note types (closed set)

- `atomic_fact` — one claim, one citation
- `decision` — ADR-style: context / options / chosen / consequences
- `postmortem` — incident, root cause, fix, prevention
- `snippet` — runnable code or config fragment with provenance
- `external_source` — verbatim ingested artifact (lives in `60_Sources/`, immutable)
- `conversation_summary` — distilled agent/human exchange
- `agent_log` — raw, append-only, machine-written
- `daily` — `YYYY-MM-DD.md`, append-only
- `weekly` — `YYYY-Www.md`, append-only
- `project_brief` — durable project-level synthesis
- `entity` — Karpathy-native page about a thing/person/system
- `concept` — Karpathy-native page about an idea
- `agent_persona` — durable persona/capability sheet for an agent

## Linking & graph rules

- **Wikilinks always.** Use `[[note-title]]` not `[label](note.md)`. Obsidian's graph and unlinked-mentions only see wikilinks reliably.
- **Block refs** for citing a specific paragraph: `[[note-title^abc123]]`.
- **Aliases** in frontmatter for canonical-name resolution: `aliases: [Skippy, dashboard]`.
- **No `links_to` array in frontmatter.** Rely on body wikilinks; the graph is the source of truth.
- **`distilled_from`, `supersedes`, `contradicts`** *do* live in frontmatter — they encode relationships backlinks can't express.

## Concurrency rules (multi-agent safety)

1. **Atomic write.** Every write is `tmp` + `rename`, never partial. Use `write-file-atomic`.
2. **Per-file lock** for the rare contention path. Use `proper-lockfile` (~30s TTL).
3. **Append-only for `agent_log` and `daily`.** Never edit; only append timestamped sections.
4. **Three-way merge for `20_Topics/`.** Two simultaneous changes go through `_index/proposals/` for resolution.
5. **Contradictions are first-class, not errors.** When agent B's claim conflicts with agent A's, set `contradicts: [<a_id>]` on B; do *not* overwrite.
6. **Supersession is explicit.** A new canonical note declares `supersedes: <old_id>`; the old note gets `status: deprecated` and moves to `90_Archive/` after 30 days.

## Retrieval order (when an agent needs context)

1. **This CLAUDE.md** (you've read it — good).
2. **Direct path** — if the query names an entity, open `20_Topics/<name>.md` and follow body wikilinks one hop.
3. **Backlink walk** — 1–2 hops from the seed page, depth-bounded.
4. **Vector search** — Smart Connections, but only over `10_Atomic/` and `60_Sources/`. **Never** over `20_Topics/` (topics resolve by name, not similarity).
5. **Confidence + recency rerank** — penalize `confidence < 0.5`, `updated_at` older than 90 days unless `status: canonical`.

## The four-job memory pipeline

| Job | Trigger | Owner | Output |
|---|---|---|---|
| **Ingest** | file dropped in `00_Inbox/` or `60_Sources/` | `research.ingest` | normalized markdown w/ frontmatter, original moved to `60_Sources/` |
| **Distill** | new ingest event | `research.distiller` | atomic notes in `10_Atomic/`, candidate updates to `20_Topics/` |
| **Link** | post-distill + nightly cron | `staff.memory_manager` | adds wikilinks, fills `contradicts`, marks `supersedes` |
| **Lint/Review** | nightly + weekly | `staff.memory_manager` (read-only by default) | proposal notes in `_index/proposals/` for human/Skippy approval |

The lint job **never writes destructively.** It opens proposal notes, awaits approval.

## Things you must NOT do

- Don't write a note without all required frontmatter.
- Don't edit `60_Sources/` after creation. Sources are immutable.
- Don't create a note in `20_Topics/` if a near-duplicate (cosine > 0.92) already exists. Append/merge into the existing.
- Don't auto-canonicalize. `status: canonical` is set only by a human or by Skippy after explicit approval.
- Don't sync the vault to cloud. Git is the only sync. Cloud sync corrupts on multi-writer.
- Don't use Obsidian's "rename file with link updating" *and* a raw `fs.rename` — pick one. The Local REST API rename endpoint is the safe path.
- Don't write more than ~5,000 atomic notes before triggering a consolidation pass. Soft cap exists for a reason.

## Schema version

`v0.1` — 2026-04-29. Bump the `schema_version` in the next field whenever rules change. Agents that observe a schema mismatch must halt writes and request human review.

```yaml
schema_version: 0.1
```
