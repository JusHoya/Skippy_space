# Appendix 06 — Skippy_space ↔ Obsidian Integration Surface Area

> Captured verbatim from the Obsidian research agent on 2026-04-29.

## 1. Vault as filesystem vs Obsidian-running

**Confirmed:** an Obsidian vault is just a folder of `.md` files plus a hidden `.obsidian/` directory of JSON config. Agents can fully read/write while the app is closed — Obsidian rebuilds its metadata cache on next launch. This is the foundation that makes Skippy_space possible.

**Implications:**

- **Sync.** Pick **one** sync strategy and stick to it. Recommended for Skippy_space: **git** (auto-commit every 5 min via cron, agents push to a `vault/` subdirectory inside the project repo). Cloud sync (Dropbox/iCloud) silently corrupts on simultaneous writes; Obsidian Sync ($4/mo) is great for users but opaque to agents; Syncthing is fine but adds a daemon. Git gives you free conflict detection, history, and undo — exactly what a multi-agent system needs.
- **Index freshness.** The `.obsidian/workspace.json`, graph cache, and Dataview index are only refreshed when the app is open. If an agent writes 50 new notes while Obsidian is closed, links and graph view update on next launch — usually fine, but **Smart Connections embeddings won't regenerate** until the app is open. Plan for a "boot-up reindex" pattern.
- **Plugin behaviors that only run when the app is open:** Templater scripts, Dataview live queries, Smart Connections embedding, Periodic Notes auto-creation, Tasks plugin recurrences. If your agents depend on any of these, the app must be running — drive Skippy_space to launch Obsidian headlessly on a schedule, or replicate the logic in your own code.

## 2. MCP servers for Obsidian

| Server | Repo | Tools exposed | Auth | Windows |
|---|---|---|---|---|
| **MarkusPfundstein/mcp-obsidian** | github.com/MarkusPfundstein/mcp-obsidian | `list_files_in_vault`, `list_files_in_dir`, `get_file_contents`, `search`, `patch_content`, `append_content`, `delete_file` | Bearer token from Local REST API plugin | Yes (Python, stdio) |
| **cyanheads/obsidian-mcp-server** | github.com/cyanheads/obsidian-mcp-server | Read/write/search + **surgical edits to headings, blocks, frontmatter** | Local REST API key | Yes (Node) |
| **jacksteamdev/obsidian-mcp-tools** | github.com/jacksteamdev/obsidian-mcp-tools (v0.2.31, Apr 2026) | Vault access, **semantic search**, Templater execution | Auto-configures Claude Desktop on install | Yes (installed as Obsidian community plugin) |
| **aaronsb/obsidian-semantic-mcp** | github.com/aaronsb/obsidian-semantic-mcp | Collapses 20+ tools into 5 workflow-aware ops with state hints | REST API key | Yes |
| **msdanyg/smart-connections-mcp** | github.com/msdanyg/smart-connections-mcp | Reads pre-computed Smart Connections embeddings; semantic search + connection graph + block-level access | None (reads `.smart-env/`) | Yes |
| **Obsidian Local REST API plugin** (the substrate) | github.com/coddingtonbear/obsidian-local-rest-api (v3.5+) | `GET/POST /vault/*`, `/active/`, `/periodic/{daily,weekly,...}/`, `/search/simple/`, `/search/` (Dataview DQL or JsonLogic), `/commands/`, `/tags/` | API key in plugin settings, HTTPS on `:27124` | Yes |

**Smart Connections** itself does not natively expose an HTTP API for external agents — but its embeddings on disk (`.smart-env/`) are readable, which is what `smart-connections-mcp` and `obsidian-mcp-tools` exploit. For Skippy_space, treat Smart Connections as an **embedding generator** rather than a query API.

**Install flow (all servers):** install the Local REST API plugin in Obsidian → enable, copy API key → add MCP server config to your client (`claude_desktop_config.json` or Skippy's own MCP config) with `OBSIDIAN_API_KEY` env var → restart client.

## 3. Direct file ops vs MCP

**Default: direct file ops.** Markdown is the API. `fs.readFile` / `fs.writeFile` to `vault/`, paired with `gray-matter` for frontmatter parsing, gives you zero-dependency, deterministic, fast access — and works whether or not Obsidian is running.

**Use MCP/REST when you need:**

- **Surgical edits inside an open note** (replace a heading, append to a block ref) without re-serializing the whole file — `PATCH /vault/{file}` with the `Heading`/`Block` operation header.
- **Dataview DQL queries** at runtime — only available via the running plugin.
- **Triggering Obsidian commands** (e.g., "open graph view", "run Templater template").
- **Semantic search** — piggyback on Smart Connections rather than rolling your own.

**Rule of thumb:** writes go through filesystem (atomic rename, deterministic). Reads-with-meaning go through MCP.

## 4. Frontmatter conventions

```yaml
---
id: 01HZX9K2P7M4QTYV3BRWC8XENF        # ULID, immutable, primary key
title: "Karpathy AI wiki — atomic note pattern"
created_at: 2026-04-29T14:32:11Z
updated_at: 2026-04-29T14:32:11Z
type: concept                           # concept | log | distillation | source | task | agent-state
status: draft                           # draft | active | distilled | archived
tags: [memory, wiki, agents]
source: https://karpathy.ai/...
authored_by: skippy.researcher          # agent id, or "human"
confidence: 0.7                         # 0.0–1.0, agent self-rating
distilled_from: ["01HZX8...", "01HZX7..."]  # ULIDs of parent atomic notes
supersedes: null
---
```

**Choices justified:**

- **`id` = ULID, not filename.** Filenames are human-meaningful and renamable; the ULID is the immutable handle agents reference. Use the **obsidian-ulid-plugin** (NickAnderegg) or generate in your own create-note helper.
- **`updated_at`** is rewritten on every agent edit. Cheap, makes "what changed today" trivial.
- **No `links_to`.** Rely on `[[wikilinks]]` in body — Obsidian already maintains a graph. Duplicating it in frontmatter rots.
- **`distilled_from` / `supersedes`** are explicit because backlinks alone can't express "this note replaced those three."
- **`authored_by` + `confidence`** lets the dashboard filter "show me low-confidence claims that need review."

## 5. Note linking & graph

- **Wikilinks always.** `[[note-title]]` over `[note](note.md)` — Obsidian's graph and unlinked-mentions only see wikilinks well.
- **Block refs (`[[note^abc123]]`)** for citing a specific paragraph in a distillation. Agents can append a block via REST API's `PATCH` with `Operation: append, Target-Type: block`.
- **Aliases** (`aliases: [Skippy, dashboard]` in frontmatter) so agents can write `[[Skippy]]` and resolve to the canonical note.
- **Avoid orphans** with a nightly Dataview query that flags notes with zero backlinks for the user/agent to either link or archive:

  ```dataview
  TABLE file.ctime, length(file.inlinks) as backlinks
  FROM "" WHERE length(file.inlinks) = 0 AND type != "log"
  ```

- **Avoid broken-link rot:** when an agent renames a note, use the REST API's rename endpoint or run Obsidian with the "update links on rename" setting on. Never let agents rename via raw `fs.rename` without rewriting incoming links — write a helper that does both.
- **Dataview as agent-readable query layer:** agents can `POST /search/` with `Content-Type: application/vnd.olrapi.dataview.dql+txt` and a DQL TABLE query, getting back structured JSON. This is the cleanest way for agents to ask "what notes match X."

## 6. Concurrency & conflicts

**Pick: atomic write (tmp + rename) + per-file proper-lockfile + git as the safety net.**

- **`write-file-atomic`** (npm) writes to `note.md.tmp` then `fs.rename` — readers always see a complete file. Note the **Windows EPERM gotcha** (Defender/Search indexer holding transient locks) — wrap rename in retry-with-backoff, or use `proper-lockfile` to serialize.
- **`proper-lockfile`** (moxystudio) for the rare path where two agents edit the same note in the same second. Uses `mkdir`-strategy lockfile, works on network shares, has stale-lock detection via mtime.
- **Append-only daily notes** for agent logs — `daily/2026-04-29.md` never has competing rewrites, only appends. Use REST API's `POST /periodic/daily/` with append semantics, or a mutex'd `appendFile`.
- **Git auto-commit every 5 min** as the conflict resolver of last resort. If two agents somehow stomp the same note, you have history and `git diff` to recover.
- **Skip CRDTs.** Yjs/Automerge are overkill for atomic notes that change once a minute, and Obsidian itself can't read CRDT state.

## 7. Watching the vault

- **Use `chokidar` v4+**, not raw `fs.watch`. fs.watch on Windows reports renames as a delete+add pair, often double-fires, and misses files entirely with some editors.
- **Set `awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 }`** — Obsidian saves by replacing the file, which fires multiple events; this debounces.
- **Set `atomic: 100`** so chokidar collapses the tmp+rename pattern that `write-file-atomic` (and Obsidian itself) produces. Don't go lower — a 2.x regression briefly broke this on Windows; 3.6+/4.x are fine.
- **Ignore `.obsidian/`, `.git/`, `*.tmp`** — they generate constant noise.
- **Pitfall:** if Skippy_space writes a note, your own watcher will fire on that write. Stamp every agent write with the agent's id in a side-channel (in-memory set of "recently written paths") and skip those events for ~500ms.

## 8. Embedding / semantic search

**Recommendation: piggyback on Smart Connections for v1, migrate to LanceDB at v2.**

- **Smart Connections (free tier)** uses bundled **TaylorAI/bge-micro-v2 (384-dim)** locally, indexes the whole vault, persists to `.smart-env/`. Zero cost, zero infra, already what the user has if they Obsidian. Read it via `smart-connections-mcp` or directly.
- **LanceDB** when you outgrow it — embedded (no server), Apache Arrow on disk, memory-mapped, scales past RAM. Best ergonomics for an embedded Node/Python agent runtime.
- **sqlite-vec** (the modern successor to deprecated sqlite-vss) is fine if you already have a SQLite store for agent telemetry — co-locate vectors there.
- **Skip Chroma** for Skippy_space: it nudges you toward a server process, which is overkill for a single-user dashboard.
- **Skip in-memory + periodic rebuild:** rebuild cost balloons past ~5K notes and a dashboard restart shouldn't cost 30s.

## 9. Recommended stack for Skippy_space (Day 1, in install order)

1. **Initialize the vault** — `Skippy_space/vault/` as the Obsidian vault root, `.gitignore` `.obsidian/workspace*.json` and `.smart-env/`, then `git init` with auto-commit cron.
2. **Obsidian + Local REST API plugin** (coddingtonbear, v3.5+) — your HTTP control plane for any in-app operation.
3. **Smart Connections plugin** (brianpetro) — local embeddings for free.
4. **obsidian-ulid-plugin** + **Dataview** + **Templater** — frontmatter ID, query layer, structured note creation.
5. **Node toolchain in Skippy_space:** `gray-matter`, `write-file-atomic`, `proper-lockfile`, `chokidar` (v4), `ulid`. These cover frontmatter, atomic write, locking, watch, ID generation.
6. **MCP wrapper:** start with **cyanheads/obsidian-mcp-server** (surgical edits + frontmatter ops) — most complete tool surface. Add **jacksteamdev/obsidian-mcp-tools** in parallel for semantic search via Smart Connections.
7. **Vector store:** Smart Connections for now; reserve a `vault/.skippy/vectors.lance` path for the LanceDB migration.

---

### Sources

- [coddingtonbear/obsidian-local-rest-api](https://github.com/coddingtonbear/obsidian-local-rest-api)
- [Local REST API interactive docs](https://coddingtonbear.github.io/obsidian-local-rest-api/)
- [MarkusPfundstein/mcp-obsidian](https://github.com/MarkusPfundstein/mcp-obsidian)
- [cyanheads/obsidian-mcp-server](https://github.com/cyanheads/obsidian-mcp-server)
- [jacksteamdev/obsidian-mcp-tools](https://github.com/jacksteamdev/obsidian-mcp-tools)
- [aaronsb/obsidian-semantic-mcp](https://github.com/aaronsb/obsidian-semantic-mcp)
- [ToKiDoO/mcp-obsidian-advanced](https://github.com/ToKiDoO/mcp-obsidian-advanced)
- [msdanyg/smart-connections-mcp](https://github.com/msdanyg/smart-connections-mcp)
- [brianpetro/obsidian-smart-connections](https://github.com/brianpetro/obsidian-smart-connections)
- [Smart Connections — Local-first semantic search](https://smartconnections.app/smart-connections/)
- [blacksmithgu/obsidian-dataview](https://github.com/blacksmithgu/obsidian-dataview)
- [Dataview Query Structure](https://blacksmithgu.github.io/obsidian-dataview/queries/structure/)
- [paulmillr/chokidar](https://github.com/paulmillr/chokidar)
- [chokidar atomic option Windows regression #812](https://github.com/paulmillr/chokidar/issues/812)
- [npm/write-file-atomic](https://github.com/npm/write-file-atomic)
- [write-file-atomic Windows EPERM #227](https://github.com/npm/write-file-atomic/issues/227)
- [moxystudio/node-proper-lockfile](https://github.com/moxystudio/node-proper-lockfile)
- [LanceDB — embedded vector DB](https://www.lancedb.com/blog/openclaw-memory-from-zero-to-lancedb-pro)
- [SQLite-vec embedded vector search](https://dev.to/aairom/embedded-intelligence-how-sqlite-vec-delivers-fast-local-vector-search-for-ai-3dpb)
- [Chroma vs LanceDB comparison](https://zilliz.com/comparison/chroma-vs-lancedb)
- [tvanreenen/obsidian-unique-identifiers (ULID/UUID/CUID)](https://github.com/tvanreenen/obsidian-unique-identifiers)
- [NickAnderegg/obsidian-ulid-plugin](https://github.com/NickAnderegg/obsidian-ulid-plugin)
- [UUIDs in Obsidian — Skærsø](https://skaersoe.com/2025/06/26/uuids-in-obsidian/)
- [Nested YAML Frontmatter — BBBBlog](https://bbbburns.com/blog/2025/07/nested-yaml-frontmatter-for-obsidian-book-notes/)
- [Obsidian + AI: From Plugin to Full Agent Integration — 3sztof](https://3sztof.github.io/posts/obsidian-smart-connections-mcp/)
