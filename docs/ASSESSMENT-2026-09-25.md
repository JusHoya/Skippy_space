# Skippy_space revival assessment

Assessment date: 2026-09-25. Baseline: `7b17b70` (2026-06-03). Working branch: `assessment/desktop-harness-prd-2026-09-25`.

## Recommendation

Keep the Tauri, React, Pixi, terminal, persona, and Markdown foundations. Rebuild the execution contracts and make a conversation workspace the default interface. Treat the RTS map as an operational view of real tasks and the Obsidian wiki as the evidence layer. Introduce provider-independent routing only after outcomes, permissions, cancellation, persistence, and costs are trustworthy.

Use the existing Alcyone model service first. Add a larger local candidate and an independent Atlas worker through measured admission gates. Use personal Codex/Claude Code sessions for the owner's subscription-backed development; use explicit API credentials and budgets for API workloads. Add Jev as an optional, evaluated decision adviser.

The implementation specification is [PRD v0.2](PRD.md). Supporting artifacts are the [research](research/08-revival-research-2026-09-25.md), [model and cluster plan](MODEL-AND-CLUSTER-PLAN.md), and [Claude Opus handoff](CLAUDE-OPUS-HANDOFF.md).

## Evidence and limits

This is a static code and configuration assessment, accompanied by primary-source research. The baseline contains 309 tracked files, substantial application code, seven `*.test.ts` files and two Playwright specs. The old README's claim that there is no app code is incorrect.

Reviewed the runtime's orchestration, SDK, model registry, MCP handlers, memory jobs and shutdown; shared contracts and pricing; Tauri commands, sidecar, PTY and Git handling; UI stores, map and HUD; memory schemas, ingestion, retrieval and clients; manifests, CI, infrastructure and historical screenshots. The existing `tests/visual/screenshots/hud-overview.png` is historical evidence, not a fresh run.

Node, pnpm, Cargo and ripgrep were unavailable on this session's PATH; `node_modules` was absent. Typecheck, unit tests, Playwright, Rust checks, application startup and installer validation were **not run**. No account entitlements, live cluster processes, model performance or service health were probed. No credentials were read, model weights downloaded, or sibling repositories changed.

Sibling snapshots inspected read-only:

| Repository | Local snapshot | How it informs this assessment |
|---|---|---|
| Pleiades | `main`, `90ab9b2`, 2026-08-23; local tracking reports behind by six commits | Intended topology, device ownership, loopback/SSH trust boundary, original LM Studio/Hermes plan |
| Money Printer | `revival/pleiades-2026-09`, `039bccb`, 2026-09-12 | Newer deployment configuration, recorded September measurements, actual vLLM/Hermes coexistence and factory controls |

Local Git tracking is not a fresh remote check. September 1/2 measurements are historical observations, not current telemetry. Later factory runbooks and code supersede the early survey where they conflict; for example, the survey's statement that no factory runner exists is obsolete. Do not turn old survey gaps into assertions about today's production state.

## What is worth preserving

| Area | Existing value | Needed evolution |
|---|---|---|
| Desktop | Tauri commands, sidecar, PTY, project tree, React shell | Stable installation paths, durable sessions, Windows validation |
| RTS | Layered sprites, eight boards, scene/ref-store separation, selection and telemetry | Same run IDs as the thread; true execution states; scoped keyboard controls |
| Runtime | Board charters, delegation envelopes, MCP registry, trace hooks | Provider/executor separation, tool policy, truthful completion, persisted scheduling |
| Wiki | Frontmatter validation, atomic writes, lock helpers, ingestion pipeline, Obsidian/Letta clients | Root containment, original preservation, conflict handling, reviewed knowledge, consistent embeddings |
| Observability | OTel, usage events, JSONL replay, UI telemetry | Correct per-attempt usage, reliable local event ledger, compatible optional export backend |
| Product identity | Skippy, board captains, charters and layered beercan assets | Preserve identity while allowing different models and a quieter work surface |

## Findings ranked by impact

P0 means a prerequisite for enabling real autonomous writes. P1 means a prerequisite for a reliable hybrid beta. P2 improves quality or usability. Findings below are source-observed paths or reasoned consequences, not reproduced live incidents.

| ID | Priority | Finding and evidence | Consequence and required response |
|---|---|---|---|
| A01 | P0 | [`board.ts`](../apps/agent-runtime/src/board.ts), `emitDelegationComplete`, reports `result: 'success'` after the stub path; [`sdk-board.ts`](../apps/agent-runtime/src/sdk-board.ts) catches failures into a fallback. SDK execution needs both a flag and an API key. | An acknowledgement or simulated summary can look like accomplished work. Separate demo, accepted, running, succeeded, failed and interrupted states; await terminal results and attach artifacts/validation. |
| A02 | P0 | [`sdk-board.ts`](../apps/agent-runtime/src/sdk-board.ts) sets `permissionMode: 'bypassPermissions'`; it does not translate charter tool permissions into an enforced execution policy. | Enabling the SDK expands authority beyond the apparent charter. Enforce worktree, tool, network and approval scope across executors before enabling writes. |
| A03 | P0 | [`mcp-handlers.ts`](../apps/agent-runtime/src/mcp-handlers.ts), `writeNote`, joins an untrusted path to the vault root without a containment check; [`atomic.ts`](../packages/memory/src/atomic.ts) does not supply that root boundary. | Traversal can escape the vault. Validate Windows paths and real ancestors, reject reparse-point escapes, and converge every write path on one broker. Preserve note identity on edits. |
| A04 | P0 | [`jobs/ingest.ts`](../packages/memory/src/jobs/ingest.ts) reads an inbox file as UTF-8 and later removes the source; [`vault-watcher.ts`](../packages/memory/src/vault-watcher.ts) accepts more than supported text formats. | Binary/PDF originals can be replaced by a lossy text representation. Keep immutable originals and hashes; use declared extractors; unsupported files remain intact with an explicit error. |
| A05 | P1 | [`git_autocommit.rs`](../apps/shell/src-tauri/src/git_autocommit.rs) and [`git-autocommit.mjs`](../scripts/git-autocommit.mjs) stage the vault then commit the shared index. | Already-staged unrelated changes can enter an automatic commit. Use an isolated index or an equivalent tested transaction and preserve the user's index on success and failure. |
| A06 | P1 | [`modelRegistry.ts`](../apps/agent-runtime/src/modelRegistry.ts), [`phase3prep.ts`](../packages/shared/src/phase3prep.ts), [`cmd_set_model.rs`](../apps/shell/src-tauri/src/cmd_set_model.rs) and UI contracts encode a closed Claude-only model set. Selections are in memory. | The picker cannot implement local/OpenAI routing or persistent policy. Replace closed model enums with validated provider/model capabilities and persistent assignments. |
| A07 | P1 | [`claude.ts`](../apps/agent-runtime/src/claude.ts) creates a new messages context per prompt. [`index.ts`](../apps/agent-runtime/src/index.ts) starts prompt handlers without serializing them. [`promptStore.ts`](../apps/ui/src/stores/promptStore.ts) maintains one current prompt and bounded nonpersistent history. | Overlapping prompts and restart can lose or misassociate conversation state. Persist threads/runs/attempts; sequence per-thread events; isolate concurrent worktrees. |
| A08 | P1 | [`Hotkeys.tsx`](../apps/ui/src/hud/Hotkeys.tsx) toggles UI pause; runtime input handling has no matching pause/cancel contract. Most [`CommandCard.tsx`](../apps/ui/src/hud/CommandCard.tsx) actions are disabled. | A paused animation is not a paused tool or model. Implement acknowledged runtime pause/cancel; expose availability and rejection explicitly. |
| A09 | P1 | [`shutdown.ts`](../apps/agent-runtime/src/shutdown.ts) can call `process.exit` on stdin end while [`index.ts`](../apps/agent-runtime/src/index.ts) also owns EOF cleanup of boards, memory and replay. | Cleanup races can lose events and leave ambiguous work. One awaited shutdown coordinator must checkpoint, cancel/drain and close resources. |
| A10 | P1 | [`pricing.ts`](../packages/shared/src/pricing.ts) has stale Opus pricing, an invented fallback rate for unknown models and no cached-token categories. [`claude.ts`](../apps/agent-runtime/src/claude.ts) can aggregate a loop using its last model; SDK costs are not carried into board completion. | Displayed cost is unsuitable for routing or budget enforcement. Meter individual attempts, retain source/rate version and represent unknowns. See current pricing evidence in the research appendix. |
| A11 | P1 | [`infra/langfuse/docker-compose.yml`](../infra/langfuse/docker-compose.yml) uses Langfuse v2 while [`otel-collector.yaml`](../infra/otel-collector/otel-collector.yaml) targets its newer OTLP endpoint with auth commented out. Compose includes broad host bindings/placeholder configuration. | Export configuration does not establish a working observability pipeline. Pin a supported, tested stack; bind locally; make export optional. Langfuse documents OTLP support from self-hosted 3.22.0; see research. |
| A12 | P1 | Sidecar packaging externalizes dependencies while shell resources and root resolution assume development artifacts/layout. See [`apps/agent-runtime`](../apps/agent-runtime/), [`sidecar.rs`](../apps/shell/src-tauri/src/sidecar.rs), [`vault-root.ts`](../apps/agent-runtime/src/vault-root.ts). | Clean-machine installation is unproven. Validate actual packaged dependencies and workspace/charter paths from an unrelated working directory; do not call the installer ready. |
| A13 | P1 | [CI](../.github/workflows/ci.yml) disables `cargo check`, has no test/build execution or Windows job, and invokes recursive lint without package lint implementations. | A green workflow would not demonstrate the desktop works. Add meaningful TypeScript tests, Windows Rust/build and desktop integration checks. |
| A14 | P2 | [`memory-jobs.ts`](../apps/agent-runtime/src/memory-jobs.ts) can use sentence-splitting mock distillation, including after provider failure. Input is truncated. [`embeddings.ts`](../packages/memory/src/embeddings.ts) mixes imported cache vectors with a particular query embedder without enforcing model identity. | Plausible generated notes and incompatible vectors can masquerade as evidence. Label extraction failures, keep drafts out of authoritative retrieval, and rebuild an owned, versioned index. |
| A15 | P2 | [`replay-writer.ts`](../apps/agent-runtime/src/replay-writer.ts) and [`replay.rs`](../apps/shell/src-tauri/src/replay.rs) support event/UI replay, not a complete execution checkpoint or filesystem restore. | Keep replay, resumption and Git restore distinct. Never silently rerun side effects while replaying. |
| A16 | P2 | Historical HUD screenshot and [`App.tsx`](../apps/ui/src/App.tsx) show a map-dominant surface, fragmented prompt/output/terminal panels and no integrated wiki workspace. Global shortcuts interfere with normal focus movement. | Build a persistent thread-centered shell with contextual RTS/wiki/diff views, accessible keyboard navigation and a reduced-motion/list alternative. |

## Cluster context changes the plan

Pleiades names Alcyone as the DGX Spark and Atlas as the RTX 5070 Ti desktop. Its August serving decision chose LM Studio with vLLM as fallback. Money Printer's newer evidence records **`mp-vllm` on Alcyone's `127.0.0.1:8000`**, serving **`ykarout/Qwen3.5-9B-NVFP4`**, with Hermes using it. This is the last documented serving configuration; only an authenticated live inventory can establish what is loaded now.

Relevant sibling evidence, relative to this document:

- [Pleiades architecture](../../pleiades/docs/architecture.md) and [README](../../pleiades/README.md): topology and historical plan.
- [Money Printer deployment](../../money_printer/deploy/README.md): Alcyone/Maia responsibilities and access pattern.
- [Recorded cluster survey](../../money_printer/docs/factory/survey_facts_C_cluster_deploy.md): September 1/2 observations, including 65,536 context and Hermes output cap 8,192.
- [Prepared model-swap script](../../money_printer/deploy/spark/hermes_model_swap.sh): prior 35B configuration, 9B measurements and rollback mechanics; **not a command to run for this assessment**.
- [Current lab compose](../../money_printer/deploy/spark/docker-compose.lab.yml): factory's 16-core cpuset, 24 GB memory limit and no-network/no-GPU isolation.
- [Factory operator runbook](../../money_printer/docs/FACTORY.md) and [Hermes plugin manifest](../../money_printer/hermes_plugin/plugin.yaml): existing registry, promotion gates and 15 registered tools.

The 9B service was chosen to free resources; adding a second large resident model can undo that benefit. The historical 35B reservation was about 51.1 GB versus about 21.9 GB for the 9B configuration. Those are service/configuration measurements, not bare model sizes. The factory is memory-bandwidth-bound despite being CPU-only. Coexistence must be measured with Hermes and factory load together.

Preserve Alcyone's loopback boundary and reach it through SSH forwarding. Start with at most one Skippy request admitted to the shared service; four configured sequences are not four spare slots. Preserve Hermes's documented context requirement. Put optional embeddings/reranking and a quantized 9B development worker on Atlas when practical. An on-demand 35B service on a separate loopback port requires a measured resource budget and a separate deployment decision.

Maia remains the Money Printer sandbox, Electra remains reserved for PiBoy, and the phone is not a reliable always-on worker. The NAS and upgraded switching in the Pleiades plan are not evidence of current storage or network capacity. No distributed model-memory pooling or NAS-hosted live SQLite is proposed.

## Strategic choices and alternatives

| Choice | Recommendation | Why |
|---|---|---|
| UI direction | Conversation workspace with first-class RTS and Wiki tabs/split views | Reuses existing visualization while improving sustained coding, review and decisions |
| Harness | Incremental TypeScript scheduler, normalized adapters and a shared tool policy | The main gaps are contracts and state, not the lack of another orchestration framework |
| Local serving | Existing vLLM first; LM Studio/llama.cpp-compatible Atlas endpoint after qualification | Matches newer operating evidence and avoids migrating Hermes just to integrate Skippy |
| Subscriptions | Official, per-user Codex and unmodified Claude Code execution lanes | Uses existing plans without confusing them with API credits or collecting login tokens |
| Hard tasks | Direct premium routing when complexity/risk warrants it | Forcing every task through a small model wastes retries and can lower quality |
| Jev | Shadow evaluation, then selective low-risk recommendations | Probabilities help routing and triage; they cannot enforce permissions or prove business decisions correct |
| Memory | Markdown source of truth, local durable index, optional Letta mirror | Keeps ownership and search operable when external services are unavailable |
| Infrastructure | Local event storage first, optional compatible OTel export | Avoids requiring an entire telemetry stack merely to start a development conversation |

## Readiness verdict

This is a promising implemented prototype, not a blank project and not a verified autonomous workbench. Its most valuable parts can be retained. Repairing the four P0 paths, establishing durable execution, and then adding provider/account lanes is the critical path. The UI shell can develop against those contracts using unmistakably labeled fixtures. Cluster expansion and Jev activation follow evaluation gates, not model release announcements.

The [handoff](CLAUDE-OPUS-HANDOFF.md) converts these findings into bounded implementation tickets. The [model plan](MODEL-AND-CLUSTER-PLAN.md) gives the requested download shortlist, placement, intended work and qualification procedure.
