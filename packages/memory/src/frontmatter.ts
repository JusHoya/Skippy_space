// TODO Phase 3 — gray-matter parse/serialize + PRD §8.3 schema validation.
//
// Required fields (from PRD §8.3):
//   id (ULID), title, created_at, updated_at, type, status, tags,
//   source, authored_by, confidence, distilled_from, supersedes, contradicts.
//
// Validation will happen here so atomic writers can reject malformed
// frontmatter before hitting disk.

export {};
