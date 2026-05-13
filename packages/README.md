# packages/

Shared workspace packages:

- **`shared/`** — types, event-envelope schemas (Zod), constants. Imported by `apps/shell`, `apps/ui`, and `apps/agent-runtime`.
- **`memory/`** — Letta client, Obsidian REST + filesystem client, frontmatter parser (`gray-matter`), ULID gen, atomic-write + lockfile helpers.
- **`otel/`** — OpenTelemetry collector config, custom exporter that fans to Langfuse + a Tauri Channel.
- **`sprite-kit/`** — PixiJS sprite components, costume layering system, animation registry, atlas loader.

**Status:** stubs only. Begin Phase 0 (`shared`) and Phase 1 (`memory`, `otel`, `sprite-kit`).
