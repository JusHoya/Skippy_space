// @skippy/memory — Phase 0 stub.
//
// PRD §8 owns this package's scope. Phase 3 will populate:
//   - Letta client (core/recall/archival via MCP).
//   - Obsidian REST + filesystem client.
//   - Frontmatter parse/write (gray-matter) with the §8.3 schema.
//   - Atomic writes (contained O_EXCL temp + rename, proper-lockfile; PRD §8.6).
//   - The four-job pipeline glue (PRD §8.5).
//
// Today we only re-export ULID generation so other packages have a stable
// import surface.

export * from './frontmatter.js';
// Only the wikilink guard is public. The legacy absolute-path writers in
// atomic.ts (atomicWrite/writeNote/writeNoteIfAbsent/appendSection/
// withFileLock) prove no containment and have no production callers, so they
// are no longer exported (M0 red-team round 2); atomic.test.ts still covers them.
export { WikilinkViolationError, assertNoRelativeMdLinks } from './atomic.js';
// M0 WS-D (FR-SEC-02, FR-WIKI-02) — vault path containment + the single write broker.
export * from './vault-path.js';
export * from './vault-broker.js';
export { atomicWriteContained, TargetExistsError, type AtomicWriteOptions } from './safe-write.js';
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
// M0 WS-E (FR-WIKI-03) — explicit ingest-failure reporting, for runtime wiring
// that needs to record an unsupported drop outside `runIngest` itself (E4-5).
export {
  recordUnsupported,
  recordIngestRejection,
  readIngestError,
  type IngestErrorRecord,
} from './ingest/errors.js';
export { INGEST_ERRORS_DIR, type IngestRejectReason } from './ingest/containment.js';
