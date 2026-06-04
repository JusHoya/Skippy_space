// @skippy/memory — Phase 0 stub.
//
// PRD §8 owns this package's scope. Phase 3 will populate:
//   - Letta client (core/recall/archival via MCP).
//   - Obsidian REST + filesystem client.
//   - Frontmatter parse/write (gray-matter) with the §8.3 schema.
//   - Atomic writes (write-file-atomic + proper-lockfile, PRD §8.6).
//   - The four-job pipeline glue (PRD §8.5).
//
// Today we only re-export ULID generation so other packages have a stable
// import surface.

export * from './frontmatter.js';
export * from './atomic.js';
export * from './ulid.js';
export * from './daily.js';
// Phase 3 (WS2) — graceful-degradation client layer.
export * from './obsidian-rest.js';
// Phase 3.5 (WS-C) — Letta hot-memory client (non-throwing, zero-dep types).
export * from './letta-client.js';
export * from './embeddings.js';
export * from './vector-store.js';
// Phase 3 (WS5) — the four-job memory pipeline + inbox watcher.
export * from './jobs/index.js';
export * from './vault-watcher.js';
