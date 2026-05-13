# @skippy/shared

The **interface contract** for the Skippy_space swarm. Every other package and
app imports types, schemas, and constants from here. Treat changes to this
package as breaking changes to the whole repo.

## Modules

| Module | Purpose | PRD ref |
|---|---|---|
| `envelope` | Zod schemas + types for every message that crosses the Tauri Channel / OTel stream (`user_prompt`, `agent_state`, `agent_token`, `agent_complete`, `log`) | §5.2 |
| `agents` | Canonical agent identifiers: `SKIPPY_ID`, `BOARDS`, `STAFF_OFFICERS`, the `AgentId` type, the Zod schema that validates them | §3.3, §5.1 |
| `states` | The eight canonical agent visual/lifecycle states (`idle`, `thinking`, `speaking`, `working`, `completed`, `error`, `spawning`, `despawning`) | §12.4 |
| `palette` | Color tokens (PRD §3.4 core + §12.3 board accents) as hex strings, plus a `PALETTE_NUM` map for Pixi APIs | §3.4, §12.3 |
| `ids` | `newPromptId()` (ULID), `isUlid()` validator | §8.3 |
| `time` | `isoNow()` — the only ISO-8601 timestamp helper anyone should reach for | — |

## Conventions

- All envelopes carry an `ts` field that is `z.string().datetime({ offset: true })` — RFC 3339 with timezone offset, always. Use `isoNow()` to mint.
- `AgentId` is a tagged string union: `'skippy' | 'board.<board>' | 'staff.<officer>' | 'task.<ulid>'`. The Zod schema enforces the prefix and the closed enum of board/officer names.
- `promptId` is a ULID minted by the renderer when the user submits a prompt; it threads through every downstream agent envelope so the UI can correlate.

## Why this package is small

The shared package is intentionally minimal. Anything domain-specific
(sprite rendering, memory writes, OTel collector wiring) belongs in the
package that owns that concern. `shared` is for things every package must
agree on — schemas, IDs, the palette, time.
