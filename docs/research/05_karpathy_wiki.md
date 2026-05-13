# Appendix 05 — Karpathy's AI Wiki: Spec for Skippy_space

> Captured verbatim from the Karpathy research agent on 2026-04-29.

## 1. What is "Karpathy's AI wiki"?

In **early April 2026**, Andrej Karpathy posted on X about a workflow shift away from using LLMs primarily as code generators, and toward using them to maintain a personal knowledge base. He followed the tweet (16M+ views) with a GitHub gist titled "llm-wiki" that laid out the architecture explicitly. As of the time of the post, his own wiki on a single research topic had grown to roughly 100 articles and ~400,000 words — none of which he wrote directly.

The gist defines three layers, in his own words:

- **Raw sources** — *"your curated collection of source documents. Articles, papers, images, data files. These are immutable."*
- **The wiki** — *"a directory of LLM-generated markdown files. Summaries, entity pages, concept pages, comparisons, an overview, a synthesis."*
- **The schema** — *"a document (e.g. CLAUDE.md for Claude Code or AGENTS.md for Codex) that tells the LLM how the wiki is structured."*

His central metaphor: *"Obsidian is the IDE; the LLM is the programmer; the wiki is the codebase."* Sources are the source code, the LLM is the compiler, the wiki is the executable. He explicitly contrasts this with RAG: *"the LLM is rediscovering knowledge from scratch on every question. There's no accumulation,"* whereas *"the wiki is a persistent, compounding artifact. The cross-references are already there. The contradictions have already been flagged."* He nods to lineage: *"This is related in spirit to Vannevar Bush's Memex (1945) — a personal, curated knowledge store with associative trails between documents."*

That is the load-bearing primary source. Note: the **2025 LLM Year in Review** on his bearblog does not discuss this — it covers RLVR, Cursor, Claude Code, vibe coding, and Nano Banana, but not knowledge management. So the wiki idea is squarely an early-2026 artifact, not a long-running Karpathy thread.

## 2. The mechanism — what he actually advocates

Endorsed explicitly in the gist:

- **Ingest**: feed a new document; *"a single source might touch 10–15 wiki pages."* The LLM extracts and integrates rather than appending.
- **Integrate / update entity & concept pages**: the unit of organization is the *entity page* and the *concept page* — not the source document.
- **Flag contradictions**: when new data conflicts with old claims, the wiki notes it.
- **Lint**: periodic sweep for *"contradictions between pages, stale claims that newer sources have superseded, orphan pages with no inbound links."*
- **Filing query results**: *"good answers can be filed back into the wiki as new pages."*

**Community extrapolations** (flag these, do not credit Karpathy):

- Daily/weekly review cycles (this is Tiago Forte / PARA / Zettelkasten lineage, not Karpathy).
- "Atomic notes" terminology (Luhmann/Matuschak, not Karpathy — he says "entity pages" and "concept pages").
- Vector embeddings + hybrid retrieval (community implementations like Graphify and OmegaWiki add this; Karpathy's pitch is that a large context window often makes RAG unnecessary).

## 3. Predecessors / cousins

**Zettelkasten (Luhmann, ~1950s–98)** — Roughly 90,000 hand-numbered index cards producing 70 books. Three rules: one idea per card, unique alphanumeric ID, explicit cross-card links. The lasting insight is that **connection is the unit of value, not collection** — links across distant domains are where new thought lives.

**Andy Matuschak's Evergreen Notes** — Notes should be *atomic* (one concept per note) and *concept-oriented* (filed by idea, not by author/book/project). His framing: *"Better note-taking misses the point; what matters is better thinking."* Crucial for our spec: filing-by-concept means a fact about, say, agent retries lives once, not duplicated across every project that touches it.

**MemGPT / Letta (2023, ongoing)** — OS-inspired hierarchical memory: a fixed-size **core memory** (RAM-equivalent, key facts/persona) and an unbounded **archival memory** (disk-equivalent, vector or graph store). The agent itself decides when to page data in/out via tool calls. The lesson: *agents need explicit, addressable tiers* — what's always-in-context, what's queryable, what's cold storage.

**A-MEM (Xu et al., NeurIPS 2025)** — Explicitly described as "Zettelkasten for agents." Each memory is an atomic note with structured attributes (context, keywords, tags). When a new memory arrives, the system generates the note, finds related historical memories by similarity, establishes links, and **evolves the attributes of older notes** based on what the new one reveals. Memory token usage drops 85–93% versus baselines. The killer feature for us: *memory evolution* — old notes are not immutable, their tags and summaries get rewritten as the network's understanding deepens.

## 4. Concrete spec for Skippy_space

### Note schema (YAML frontmatter)

```yaml
id: 20260429T1432-atomic-retry-budget    # ULID-style; immutable
type: atomic_fact                         # see types below
source: [ref:src/papers/a-mem.pdf, conv:agent_log/2026-04-28]
agent_authored_by: distiller_v1           # which agent wrote it
created_at: 2026-04-29T14:32:00Z
updated_at: 2026-04-29T14:32:00Z
tags: [memory, retries, agent-orchestration]
links_to: [[20_Topics/agent_memory]], [[10_Atomic/exponential_backoff]]
confidence: 0.85                          # 0-1; degrades over time without reinforcement
status: draft | reviewed | canonical | deprecated
supersedes: null                          # id of older note this replaces
contradicts: []                           # ids of notes this conflicts with
```

### Note types

- `atomic_fact` — one claim, one citation
- `decision` — ADR-style: context / options / chosen / consequences
- `postmortem` — incident, root cause, fix, prevention
- `snippet` — runnable code or config fragment with provenance
- `external_source` — verbatim ingested artifact (immutable, lives in `_sources/`)
- `conversation_summary` — distilled agent/human exchange
- `agent_log` — raw, append-only, machine-written
- `daily` / `weekly` — periodic review notes
- `project_brief` — durable project-level synthesis
- `entity` / `concept` — Karpathy-native page types (the wiki's main artifacts)

### Folder layout

```
vault/
  CLAUDE.md                  # Karpathy's "schema" — agents read this first
  00_Inbox/                  # raw capture, fleeting thoughts, awaiting distill
  10_Atomic/                 # atomic_fact, snippet — concept-oriented (Matuschak)
  20_Topics/                 # entity/concept pages — the Karpathy wiki proper
  30_Projects/               # project_brief, decisions, postmortems
  40_Daily/                  # YYYY-MM-DD.md, agent + human dailies
  50_Agents/                 # per-agent persona pages, capability notes
  60_Sources/                # immutable raw sources (Karpathy's "source code")
  90_Archive/                # deprecated, status:deprecated lives here
  _index/                    # generated: graph stats, orphan list, contradiction log
```

### Ingest -> Distill -> Link -> Review (4 agent jobs)

| Job | Trigger | Agent | Output |
|---|---|---|---|
| **Ingest** | file dropped in `00_Inbox/` or `60_Sources/` | `ingest-runner` (cheap model, file-watcher trigger) | normalized markdown with frontmatter, original moved to `60_Sources/` |
| **Distill** | new ingest event | `distiller` (strong model, queued) | atomic notes in `10_Atomic/`, candidate updates to `20_Topics/` entity pages |
| **Link** | post-distill, also nightly | `linker` (graph-walk over backlinks + embedding similarity) | adds `links_to`, fills `contradicts`, marks `supersedes` |
| **Review/Lint** | nightly (daily note) + weekly (weekly note) | `librarian` (read-only by default; proposes diffs) | orphan list, contradiction queue, stale-claim flags, weekly synthesis note |

The librarian never writes destructively — it opens a PR-style proposal note in `_index/proposals/` that a human or supervisor agent approves.

### Retrieval strategy (hybrid, in priority order)

1. **CLAUDE.md preamble** — always loaded; tells the agent the schema and where canonical pages live.
2. **Direct path lookup** — if the query names an entity (`agent_memory`), open `20_Topics/agent_memory.md` and follow `links_to` one hop. This is Karpathy's preferred mode.
3. **Backlink walk** — 1–2 hop graph traversal from seed pages, depth-bounded.
4. **Vector search fallback** — only over `10_Atomic/` and `60_Sources/`, never over `20_Topics/` (topic pages should be reachable by name, not similarity).
5. **Confidence + recency reranking** — penalize `confidence < 0.5` and `updated_at` older than 90 days unless `status: canonical`.

### Conflict / merge rules

- **One writer per note per minute**: a file lock (`.lock` sidecar with agent id + TTL) prevents concurrent overwrites.
- **Append-only for `agent_log` and `daily`**: never edit, only append timestamped sections.
- **Three-way merge for `20_Topics/`**: when two agents propose changes, the librarian runs a structured diff and produces a merged draft for review.
- **Contradictions are first-class, not errors**: if agent B asserts something incompatible with agent A's note, do not overwrite — set `contradicts: [<a_id>]` on the new note and open a contradiction-resolution task.
- **Supersession is explicit**: a new canonical note must list `supersedes: <old_id>`, and the old note gets `status: deprecated` (moved to `90_Archive/` after 30 days).

## 5. Risks & failure modes

- **Hallucinated notes** — guard: every claim in `atomic_fact` requires a `source` ref to a `60_Sources/` doc or `agent_log` line. Notes without sources are auto-tagged `status: draft` and excluded from retrieval until reviewed.
- **Infinite link cycles** — guard: graph walks bounded to depth 3 and node budget 50; the linker job runs cycle detection nightly and flags suspicious clusters.
- **Stale info dominating retrieval** — guard: confidence decays linearly past 90 days unless reinforced by a new corroborating ingest; retrieval reranker penalizes stale notes; weekly lint surfaces top 10 stalest high-traffic notes.
- **Vault bloat** — guard: librarian enforces a soft cap (e.g., 5,000 notes in `10_Atomic/`); exceeding triggers a consolidation pass that merges near-duplicates (cosine > 0.92) into single canonical notes with `supersedes` chains. Karpathy's gist explicitly endorses this: *integrate, don't append.*
- **Echo chambers / agent groupthink** — guard: track `agent_authored_by` distribution per topic; if one agent authored >70% of a topic's pages, route the next ingest to a different agent for diversification.
- **Schema drift** — guard: `CLAUDE.md` is version-pinned in frontmatter; agents that observe a schema mismatch must halt writes and request human review.

---

**Honesty checkpoint**: the only Karpathy-direct material is the April 2026 gist + tweet. Everything about daily reviews, confidence decay, atomic-note nomenclature, and the four-agent pipeline is community lore (Luhmann/Matuschak/A-MEM/MemGPT) layered on top of his three-layer architecture. The PRD should cite the gist for the *what* and the cousins for the *how*.

## Sources

- [llm-wiki gist - Karpathy](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
- [Karpathy 2025 LLM Year in Review](https://karpathy.bearblog.dev/year-in-review-2025/) (no wiki content; confirmed null)
- [VentureBeat: Karpathy LLM Knowledge Base architecture](https://venturebeat.com/data/karpathy-shares-llm-knowledge-base-architecture-that-bypasses-rag-with-an)
- [LLM Wiki in Obsidian - aimaker substack](https://aimaker.substack.com/p/llm-wiki-obsidian-knowledge-base-andrej-karphaty)
- [Karpathy's LLM Wiki in Production - Aaron Fulkerson](https://aaronfulkerson.com/2026/04/12/karpathys-pattern-for-an-llm-wiki-in-production/)
- [Karpathy LLM Wiki - MindStudio](https://www.mindstudio.ai/blog/andrej-karpathy-llm-wiki-knowledge-base-claude-code)
- [A-MEM: Agentic Memory for LLM Agents (arXiv 2502.12110)](https://arxiv.org/abs/2502.12110)
- [A-MEM: Zettelkasten for agents - Alpha's Manifesto](https://blog.alphasmanifesto.com/2026/04/11/a-mem-zettelkasten-for-agents/)
- [MemGPT paper (arXiv 2310.08560)](https://arxiv.org/abs/2310.08560)
- [Letta MemGPT concepts docs](https://docs.letta.com/concepts/memgpt/)
- [Andy Matuschak - Evergreen notes](https://notes.andymatuschak.org/Evergreen_notes)
- [Evergreen notes should be atomic](https://notes.andymatuschak.org/Evergreen_notes_should_be_atomic)
- [Evergreen notes should be concept-oriented](https://notes.andymatuschak.org/Evergreen_notes_should_be_concept-oriented)
- [Zettelkasten Method introduction](https://zettelkasten.de/introduction/)
- [Zettelkasten - Wikipedia](https://en.wikipedia.org/wiki/Zettelkasten)
