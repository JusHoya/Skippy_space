# @skippy/agent-runtime

Node 22 LTS sidecar that hosts the Skippy orchestrator. Spawned by the Tauri
shell (`apps/shell/src-tauri/src/sidecar.rs`). Speaks **JSONL** on stdin/stdout
and emits OpenTelemetry GenAI spans to a local collector.

This is Phase 0 of Skippy_space — see `docs/PRD.md` §14.1. It satisfies the
"hello-Skippy" exit criterion: the user issues a prompt and watches a beercan
transition `thinking → speaking → idle`. Phase 1 will replace the inline
Anthropic SDK call with the full Claude Agent SDK `query()` plus the Board /
Task three-tier delegation topology (PRD §5.1, §3.1 Iron Law of Delegation).

## Run modes

```pwsh
# Dev — tsx watch
pnpm --filter @skippy/agent-runtime dev

# Build (esbuild via tsup) → dist/index.js
pnpm --filter @skippy/agent-runtime build

# Start the built artifact directly (Rust shell does this in prod)
pnpm --filter @skippy/agent-runtime start

# Typecheck only
pnpm --filter @skippy/agent-runtime typecheck
```

## Environment variables

| Var                              | Required | Default                                | Notes                                                                 |
| -------------------------------- | -------- | -------------------------------------- | --------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`              | yes      | —                                      | Forwarded by the Tauri shell. Sidecar errors on first prompt if unset.|
| `SKIPPY_MODEL`                   | no       | `claude-opus-4-7`                      | Override the Skippy model (Phase 0 only).                             |
| `OTEL_EXPORTER_OTLP_ENDPOINT`    | no       | `http://localhost:4318/v1/traces`      | OTel collector. Sidecar soft-fails if unreachable.                    |
| `LOG_LEVEL`                      | no       | `info`                                 | pino level: `fatal | error | warn | info | debug | trace`.            |

## JSONL protocol contract

All envelope schemas live in `packages/shared` (Zod) and are mirrored by
`apps/shell/src-tauri/src/envelope.rs` (serde). Wire discriminant: `type` in
`snake_case`; field names on the wire are `camelCase`. One envelope per line.

### Inbound (stdin) — what the sidecar consumes

```json
{ "type": "user_prompt", "promptId": "<ulid>", "text": "...", "ts": "<rfc3339>" }
```

Unknown envelope types are logged and ignored — the Rust shell and renderer
can co-evolve without bricking the runtime.

### Outbound (stdout) — what the sidecar emits per Skippy turn

```json
{ "type": "agent_state", "agentId": "skippy", "state": "thinking",  "promptId": "...", "ts": "..." }
{ "type": "agent_state", "agentId": "skippy", "state": "speaking",  "promptId": "...", "ts": "..." }
{ "type": "agent_token", "agentId": "skippy", "promptId": "...", "text": "...", "ts": "..." }
... (many tokens) ...
{ "type": "agent_complete", "agentId": "skippy", "promptId": "...", "ts": "..." }
{ "type": "agent_state", "agentId": "skippy", "state": "idle",  "promptId": "...", "ts": "..." }
```

Free-form logs from the sidecar (and from anything that wants to surface in the
renderer log panel) use the `log` envelope:

```json
{ "type": "log", "level": "info|warn|error|debug", "source": "...", "message": "...", "ts": "..." }
```

## Channel discipline

- **stdout is sacred** — only JSONL envelopes go through it. The Rust shell
  parses every line; non-envelope output gets surfaced as a `debug` log.
- **stderr is for `pino` logs** — never log to stdout. The logger module sets
  `pino.destination(2)` for this reason.
- **stdin EOF triggers graceful shutdown** — when the shell closes our stdin,
  we drain OTel and exit 0.

## File map

```
src/
├── index.ts        entry — initOtel, install shutdown hooks, dispatch loop
├── protocol.ts     parse/write JSONL envelopes via @skippy/shared zod
├── skippy.ts       SKIPPY_SYSTEM prompt + handleUserPrompt() lifecycle
├── claude.ts       Anthropic Messages.stream() wrapper (Phase 0)
├── otel.ts         OTel SDK init + soft-fail
├── logger.ts       pino to stderr
├── warmpool.ts     stub — R-01 mitigation, populated in Phase 1
└── shutdown.ts     SIGTERM/SIGINT/stdin-EOF handlers
```
