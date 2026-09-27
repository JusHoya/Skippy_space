// ingest/provenance.ts — who may write ingest provenance (FR-WIKI-03,
// FR-WIKI-02; M0 final red-team #1).
//
// A derived source note in `60_Sources/` is trusted by later ingests (orphan
// reuse after a crash, marker-validated dedup) and its body is what the
// distiller turns into atomic facts. So both the SUBTREE and the provenance
// frontmatter keys are reserved for the ingest pipeline:
//
//   - The vault broker refuses, by default, to create, update, patch or append
//     any note whose lexical OR real path lies under `60_Sources/`, and refuses
//     to set or change any of PROVENANCE_KEYS on any note (`ProvenanceViolationError`).
//     That default is what every MCP vault tool (obsidian_write_note,
//     obsidian_patch_frontmatter, obsidian_append_block), distill/link/lint,
//     daily and the archival mirror get.
//   - `runIngest` constructs its broker with `{ ingestWriter: INGEST_WRITER }`.
//     The symbol is a capability: it lives in this module, which the package
//     entry point (`@skippy/memory`, whose package.json `exports` is "." only)
//     does not re-export, so no consumer of the package -- in particular the
//     agent-runtime's MCP handlers -- can obtain it. Code with arbitrary file
//     system access is out of this threat model (it could write the vault
//     directly); the capability stops agents that only have the vault tools.
//
// Ingest itself does not trust frontmatter alone either: a 60_Sources note is
// adopted (orphan reuse or marker dedup) only if its provenance is the
// pipeline's AND its body is exactly what the recorded extractor derives from
// these very bytes (jobs/ingest.ts `verifySourceNote`), so even a note forged
// by hand in Obsidian cannot substitute its text for the drop's.

/** Folder of derived source notes and the originals store (PRD §8.2). */
export const SOURCES_DIR = '60_Sources';

/** `authored_by` of every ingest-derived source note. */
export const INGEST_AUTHOR = 'research.ingest';

/** The capability that unlocks 60_Sources/ and provenance keys in the broker. */
export const INGEST_WRITER: unique symbol = Symbol('skippy.memory.ingest-writer');
