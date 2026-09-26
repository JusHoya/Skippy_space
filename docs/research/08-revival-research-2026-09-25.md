# Revival research and decision rationale

Researched 2026-09-25. This appendix supports [PRD v0.2](../PRD.md) and the [model plan](../MODEL-AND-CLUSTER-PLAN.md). Product recommendations are design judgments; vendor benchmarks, specifications and dated local measurements are not Skippy performance results. Model availability, account limits, pricing and runtime compatibility must be rechecked during implementation.

## 1. Desktop interaction model

OpenAI's current desktop documentation describes a workspace for projects, conversations and artifacts; the older Codex app documentation redirects to the current ChatGPT desktop documentation. Use the user's requested Codex-style interaction pattern: a project/thread rail, readable central work area, contextual review and a terminal. Keep Skippy's own branding and beercan/RTS identity. The goal is familiar navigation, not a pixel-for-pixel reproduction. [Official desktop documentation](https://learn.chatgpt.com/docs/app)

Recommended composition: thread in the center by default; Worktree, Wiki and RTS as peer views of the selected mission; an inspector for evidence, tool approvals and route explanations; a collapsible terminal/events dock. The map remains useful for allocation and activity, but a user should not need to interpret animation to discover whether a change passed tests. Preserve Pixi's transient ref-store and avoid rendering token streams through the animation state path.

Use native Obsidian interoperability: Markdown on disk, wikilinks, backlinks and an explicit Open in Obsidian action. A filesystem-backed in-app reader/editor provides a dependable baseline; the optional Local REST API plugin must not become a second ungoverned writer. [Obsidian URI documentation](https://help.obsidian.md/Extending+Obsidian/Obsidian+URI), [plugin maintainer documentation](https://coddingtonbear.github.io/obsidian-local-rest-api/)

Use WCAG 2.2 as the accessibility acceptance reference for contrast, keyboard access, visible focus and usable zoom/reflow. The map needs an equivalent task list and reduced-motion behavior. [W3C WCAG 2.2](https://www.w3.org/TR/WCAG22/)

Tauri capabilities constrain exposed surfaces, but custom command implementations still require path and argument validation. Treat vault writes, terminal processes and provider credentials as backend responsibilities, not renderer utilities. [Tauri capabilities](https://v2.tauri.app/security/capabilities/)

## 2. Accounts and execution are different concerns

| Lane | Proposed integration | Billing and product boundary |
|---|---|---|
| Owner's OpenAI Pro | Codex app-server subprocess using its managed ChatGPT sign-in | Subscription allowances and actual account eligibility; no assumed API credit |
| Owner's Claude Max | User signs into installed, unmodified Claude Code; Skippy launches an appropriately scoped session | Personal session usage, rate limits and account settings remain visible |
| OpenAI/Anthropic APIs | Explicit keys through their supported APIs/SDK | Separate metered usage and hard configured budgets |
| Local models | Existing vLLM or qualified LM Studio/compatible endpoints | No vendor token bill; electricity, contention and latency still matter |
| Jev | TypeSafe API key through its documented endpoint | Separate hosted classification expense and data disclosure |

Codex supports both ChatGPT authentication and separately billed API-key authentication. Its app-server provides a supported integration surface, including managed login, threads, turns, approvals, model discovery and rate-limit reporting. Prefer that surface over terminal-output scraping or homemade OAuth. Pin the executable and test the exact protocol version. [Codex authentication](https://learn.chatgpt.com/docs/auth), [Codex app-server](https://learn.chatgpt.com/docs/app-server)

Anthropic distinguishes a user's login to the **unmodified Claude Code binary**, including when hosted in a product, from a third-party product offering its own Claude.ai login or routing through subscription credentials. Build the Max lane around the former; use API credentials for the product's SDK automation lane. Do not extract or pool personal tokens. Users must retain the binary's supported authentication choices. Confirm distribution terms before shipping that integration to others. [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance), [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)

This means two abstractions are needed. An **inference adapter** provides messages or typed predictions. An **agent executor** owns a session, tools, approvals and completion. An OpenAI-compatible HTTP endpoint is not automatically interchangeable with Codex's agent runtime; a Claude Code session is not an Anthropic API key. Normalize task inputs and public events while retaining native session IDs and permissions.

## 3. Models, pricing and routing

At research time Anthropic lists `claude-opus-5-5` for demanding work, with standard API input/output pricing of $4/$20 per million tokens. It is a candidate for the requested Opus implementation, subject to account availability and current CLI/SDK support. The existing code's Opus 4.7 $15/$75 table is stale; the official pricing page lists that older model at $5/$25. Avoid putting a single rate or model enum in business logic. [Opus 5.5 overview](https://platform.claude.com/docs/en/models/opus-5-5/overview), [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing)

The current Anthropic catalog also lists Sonnet 5 and Haiku 4.5; use task-level evaluations to decide whether an intermediate paid tier adds value between local execution and premium review. Retrieve actual OpenAI model choices from the installed Codex client/account instead of assuming the desktop and API expose identical catalogs. [Anthropic model catalog](https://platform.claude.com/docs/en/models/overview), [OpenAI model documentation](https://developers.openai.com/api/docs/models)

RouteLLM provides research evidence for learning quality/cost tradeoffs from preference data. Its published savings do not transfer automatically to Skippy's tools, tasks or subscription constraints. Begin with inspectable rules, collect outcomes and compare policies on held-out project tasks. [RouteLLM paper](https://arxiv.org/abs/2406.18665)

Proposed order: enforce data/tool/budget constraints; remove unhealthy or incompatible candidates; estimate task difficulty and retrieval needs; rank feasible executors by observed task success, cost and queue time; execute; validate; escalate at a checkpoint when justified. A complex schema migration can start on Opus/Codex directly. A small documentation correction can stay local. Do not route solely by prompt length or ask a premium model to classify every trivial request.

Cache reuse, prompt size, output caps, retrieval and avoiding repeated failed attempts often matter as much as token price. Evaluate **cost per accepted task**, retaining API expense, subscription usage, optional subscription allocation, local energy estimates and user review time as separate fields. Unknown usage stays unknown. Never show a made-up fallback rate as an invoice.

## 4. Local hardware and serving

DGX Spark provides 128 GB unified memory, an Arm CPU and GB10 GPU; RTX 5070 Ti provides 16 GB discrete VRAM. Their capacities do not form a single shared model-memory pool. The desktop's display/other workloads also consume VRAM. Hardware specifications establish ceilings, not useful context lengths or tokens per second. [DGX Spark specifications](https://www.nvidia.com/en-eu/products/workstations/dgx-spark/), [RTX 5070 family specifications](https://www.nvidia.com/en-us/geforce/graphics-cards/50-series/rtx-5070-family/)

NVIDIA publishes a Spark vLLM playbook and an agent-model path for Qwen3.6-35B-A3B-NVFP4. Its reference configuration is a qualification starting point, not permission to replace the already-used container. GB10/Arm compatibility, image digest, kernels, parser and context settings must be recorded together. [NVIDIA vLLM playbook](https://build.nvidia.com/spark/vllm), [agent-ready models](https://build.nvidia.com/spark/vllm/agent-ready-models), [vLLM Qwen3.6 Spark recipe](https://recipes.vllm.ai/Qwen/Qwen3.6-35B-A3B?features=tool_calling,reasoning&hardware=dgx_spark_gb10)

The current Money Printer evidence is stronger than a generic deployment recommendation: it already records a working local vLLM/Hermes setup and a move from a larger model to a smaller one for memory headroom. Preserve that service and evaluate any new deployment alongside its actual workload. The [assessment](../ASSESSMENT-2026-09-25.md) records the exact source snapshots and caveats.

LM Studio provides local serving and compatibility APIs; Ollama documents OpenAI API compatibility with limits that differ by endpoint, including stateful behavior. Do not infer function calling, JSON-schema enforcement, cancellation or context handling from the phrase "OpenAI-compatible." Probe each feature with the exact server/model combination before enabling a route. [LM Studio server](https://lmstudio.ai/docs/developer/core/server), [Ollama compatibility](https://docs.ollama.com/api/openai-compatibility), [Ollama tool calling](https://docs.ollama.com/capabilities/tool-calling), [vLLM serving documentation](https://docs.vllm.ai/en/latest/serving/online_serving/)

The download shortlist is intentionally small: existing 9B, a 35B local escalation model, an Atlas-sized quantization, and dedicated retrieval models. A second architecture, GPT-OSS-20B, is a conditional benchmark challenger. See the [model plan](../MODEL-AND-CLUSTER-PLAN.md) for exact repositories, resource caveats and task assignments.

## 5. What Jev actually contributes

The relevant Jev is **TypeSafe AI's System One model**. It returns structured choices, scores or yes/no probabilities instead of free-form answer prose. Choice and score outputs include distributions and confidence; `noul` returns a yes probability without the same confidence field. This fits board assignment, evidence sufficiency and triage, not code generation or factual research. [TypeSafe introduction](https://docs.typesafe.ai/introduction)

Jev is **not token-free**. The published `jev-1.13.0` price is $0.042 per million input tokens, with free output tokens. Its documented limits are 64k tokens for a request and 32k for the state plus longest question. Pin a version, not `jev-latest`. Public documentation describes hosted access; this research did not establish downloadable weights or a supported self-hosted edition. Customer training exclusion does not imply default zero retention; enterprise ZDR is separately mentioned. [TypeSafe models and data handling](https://docs.typesafe.ai/models)

For scale only: 10,000 decisions at 2,000 billable input tokens each would be 20 million tokens, or **$0.84** at that published rate. This excludes any other services, retries or future pricing. Calculate actual charges from reported usage; do not promise this average payload or savings.

Integration uses `POST https://api.typesafe.ai/v1/systemone`, Bearer authentication, a model, shared state and keyed typed questions. The JavaScript SDK can fit the existing TypeScript runtime. Validate outputs, enforce timeouts and honor rate-limit backoff. Question instructions/criteria carry meaning; question keys are identifiers, not hidden prompts. [API reference](https://docs.typesafe.ai/api), [JavaScript SDK](https://docs.typesafe.ai/sdk/javascript)

Confidence is a property of the predicted distribution, not an independent proof or automatically calibrated correctness estimate for the organization. Include an explicit insufficient-evidence choice. Evaluate predicted probabilities against labelled outcomes, stratified by task family and risk. Do not multiply correlated question probabilities as though independent. [Confidence documentation](https://docs.typesafe.ai/confidence), [composite scoring pattern](https://docs.typesafe.ai/patterns/composite-scoring)

TypeSafe documents weaknesses around exact arithmetic, dates, literal/indirect meanings, long distracting state and structural invariants. Keep calculations and permission rules in code; send concise, relevant evidence. Treat user/retrieved text as untrusted evidence even when it contains instructions. Vendor speed and "zero hallucination" marketing are not project acceptance criteria. [Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13), [intent routing pattern](https://docs.typesafe.ai/patterns/intent-routing)

Recommended introduction: collect organizational decisions in a local inbox; run Jev in shadow mode next to deterministic rules and a local classifier; review disagreements; promote only evaluated low-risk classes. Keep owner approvals and existing Money Printer statistical promotion gates intact. Jev can flag a missing report or suggest which board should review it; it does not replace statistical validation, capital controls or business accountability.

## 6. Memory, durability and observability

Markdown files should remain human-owned knowledge. Store source hashes, provenance, review state and stable note IDs; reject stale edits instead of overwriting an Obsidian user's changes. Rebuild embeddings when their model/revision/dimensions/template changes. Similarity scores are retrieval signals, not truth confidence. Keep generated drafts separate from reviewed/canonical material.

Make the local event database the durable execution record; export sanitized OTel asynchronously. Langfuse's compatibility documentation places the OpenTelemetry endpoint at self-hosted version 3.22.0 or later, whereas this repo pins v2. At research time the compatibility page identifies v4 as GA. Select a supported release with its actual dependencies and migration procedure rather than merely changing an image tag to v3 or `latest`. [Langfuse compatibility](https://langfuse.com/docs/compatibility)

Replay should reconstruct the UI from recorded events without tool execution. Resumption should create or attach a valid execution attempt from a checkpoint. File rollback should be an explicit Git operation. Keeping those actions separate is essential to honest observability and safe recovery.

## 7. Decisions deferred until evidence exists

No exact local throughput, maximum simultaneous agents, cloud-spend savings, Jev error threshold, or new model residency policy is claimed as measured. The implementation must produce a reproducible evaluation manifest, service inventory and mixed-load results before those promises appear in the product. Model downloads and deployment changes are proposed in the companion plan; none occurred during this assessment.
