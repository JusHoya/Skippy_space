# infra/

Self-hosted dependencies, all in Docker:

- **`langfuse/`** — Langfuse + Postgres for OTel-traced agent observability. `docker compose up -d`.
- **`letta/`** — Letta server for hot agent memory (core/recall/archival). Mirrors archival writes to the Obsidian vault.
- **`n8n/`** — n8n workflow exports (Gmail, Calendar, Drive, Bridgemind RSS, scheduled triggers). Wrapped behind a single MCP server that Skippy reaches.

**Status:** placeholder. docker-compose files generated in Phase 1.

See PRD §9 (Telemetry), §11.2 (install order), and `docs/research/02_orchestration_frameworks.md` for justification.
