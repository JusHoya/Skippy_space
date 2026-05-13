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
