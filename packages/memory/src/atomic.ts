// TODO Phase 3 — atomic vault writes.
//
// Per PRD §8.6:
//   - `write-file-atomic` for normal writes (handles Windows EPERM retries).
//   - `proper-lockfile` for the contention path.
//   - `agent_log` and `daily` notes are append-only — separate code path.
//   - Wikilinks only ([[note]]), never relative markdown links.
//
// This module will export `writeNote(path, body, frontmatter)`,
// `appendLog(path, line)`, and the lock helpers.

export {};
