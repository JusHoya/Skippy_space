# Appendix 02 — Multi-Agent Orchestration Landscape

> Captured verbatim from the orchestration research agent on 2026-04-29.

The dashboard's RTS metaphor (Skippy at the top, board agents in the middle, task agents on the ground) maps cleanly onto the orchestrator/sub-agent pattern that has converged across every serious 2025-2026 framework. The real question is which spine to bolt the dashboard onto. Below are eight systems evaluated against Skippy's three-tier hierarchy, then a concrete recommendation.

## 1. Claude Agent SDK (Anthropic)

- **Primitive**: a `query()` loop with an `agents` map of `AgentDefinition`s. Subagents are invoked via the built-in `Agent` tool, get a fresh context window, and return only their final message back to the parent.
- **Hierarchy**: exactly two tiers natively — main agent plus subagents. Crucially, "**subagents cannot spawn their own subagents**." Skippy's three-tier model (Skippy -> board -> task) needs an explicit workaround: run each board agent as its own top-level `query()` process and treat task agents as that board's subagents.
- **Observability**: hooks (`PreToolUse`, `PostToolUse`, `SessionStart`, `SessionEnd`, `Stop`, `UserPromptSubmit`) fire callbacks with `agent_id` / `agent_type` populated when the hook runs inside a subagent — perfect for a dashboard's event stream.
- **Memory**: per-agent `memory: 'user' | 'project' | 'local'` plus CLAUDE.md inheritance; archival memory is BYO (Letta or Obsidian).
- **Tools / MCP**: every agent can carry its own `mcpServers`, `tools`/`disallowedTools`, `model` override, `effort`, `permissionMode`, and `background: true` for non-blocking execution. MCP servers can be in-process (no separate process), local stdio, or HTTP.
- **Runtime / license**: Python and TypeScript SDKs (`@anthropic-ai/claude-agent-sdk`, `claude-agent-sdk` on PyPI), MIT-licensed open source, GA in Oct 2025 with active updates through 2026.

## 2. LangGraph (LangChain)

- **Primitive**: stateful graph of nodes. Each node is a function or agent; edges define transitions. Supervisor and swarm patterns ship as templates.
- **Hierarchy**: arbitrary depth via subgraphs — supervisors managing sub-supervisors managing workers. This is the cleanest native fit for Skippy -> board -> task.
- **Observability**: best-in-class via LangSmith (zero-config trace per node, per LLM call, per tool result); also emits OpenTelemetry.
- **Memory**: built-in checkpointing of graph state to Postgres / SQLite / Redis, plus time-travel debugging and human-in-the-loop pauses.
- **Runtime / license**: Python and JS, MIT. Most production-mature open-source agent framework as of 2026.

## 3. CrewAI

- **Primitive**: `Crew` of `Agent`s with `role` / `goal` / `backstory` running `Task`s under either `Process.sequential` or `Process.hierarchical`.
- **Hierarchy**: `Process.hierarchical` adds a manager LLM that delegates and validates. Recent reporting (TDS, Apr 2026) shows the auto-manager often falls back to sequential execution and racks up latency unless you write a custom manager.
- **Observability**: first-party event hooks; integrates with Langfuse, AgentOps, LangSmith.
- **Memory**: short-term, long-term, and entity memory abstractions, plus user-memory.
- **Runtime / license**: Python only, MIT. Excellent for role-flavored prototypes; not what you want for a 24/7 dashboard.

## 4. Microsoft AutoGen / Magentic-One / AutoGen Studio

- **Primitive**: `GroupChat` with a `GroupChatManager` selecting the next speaker. `MagenticOneGroupChat` is the productionized variant with a planning ledger and re-planning loop.
- **Hierarchy**: nested group chats; specialized agents (`MultimodalWebSurfer`, `FileSurfer`, `MagenticOneCoderAgent`) compose into teams.
- **Observability**: OpenTelemetry; AutoGen Studio gives a no-code GUI but is more demo than dashboard.
- **Status (critical)**: AutoGen is in **maintenance mode**. New work is happening in **Microsoft Agent Framework** (RC1.0 shipped Feb 19, 2026). The community fork **AG2** continues the v0.2 lineage. Either way, a Skippy backbone built on AutoGen today bets on an unsupported runtime.
- **Runtime / license**: Python + .NET, MIT.

## 5. OpenAI Agents SDK (Swarm successor)

- **Primitive**: `Agent` + `Handoff` + `Guardrail`. Control transfers explicitly between agents, carrying conversation context.
- **Hierarchy**: handoff chains, not trees. Skippy's "delegate without losing oversight" is awkward to express because handoffs hand over control rather than spawn subordinates.
- **Observability**: built-in tracing dashboard at platform.openai.com.
- **2026 update**: April 2026 release added a Codex-style **harness** with sandboxing, long-horizon resume bookkeeping, and forthcoming subagents in both Python and TypeScript — closing some gaps with Claude Agent SDK.
- **Runtime / license**: Python and TypeScript, MIT. Excellent if you live inside OpenAI; awkward as a Claude Code companion.

## 6. Letta (formerly MemGPT)

- **Primitive**: a stateful agent with OS-style memory tiers — core (in-context, RAM-equivalent), recall (conversation history), archival (vector DB, disk-equivalent). Agent state lives in Postgres.
- **Hierarchy**: supports skills and subagents, not designed as a primary orchestrator.
- **Observability**: REST API exposes every memory edit and tool call; integrates with Langfuse over OTel.
- **Memory** (the reason to care): Letta agents continuously self-edit memory blocks. New "sleep-time compute" lets the agent reorganize memory while idle — which is exactly the "long-term memory in Obsidian" behavior Skippy needs.
- **Runtime / license**: Python, Apache-2.0. Available as a self-hosted server with Python and TypeScript SDKs.

## 7. Mastra

- **Primitive**: TypeScript-native `Agent` with `Workflow`, `Memory`, `Tools`. Supervisor pattern shipped Feb 2026.
- **Hierarchy**: supervisor + specialist agents; coordinator-aggregator is the documented multi-agent pattern.
- **Observability**: built-in tracing, evals, telemetry; OpenTelemetry export. Integrates with Langfuse, LangSmith.
- **Memory**: persistent memory via LibSQL/Postgres, working memory, semantic recall.
- **Runtime / license**: Node/TS, Apache-2.0. 1.0 in Jan 2026, 1.8M weekly npm downloads, Series A. The strongest pick if Skippy_space goes full TypeScript.

## 8. n8n with AI Agent nodes

- **Primitive**: visual workflow with the LangChain-backed `AI Agent` node. The orchestrator pattern uses `AI Agent Tool` nodes to call other agents as tools.
- **Hierarchy**: nodes calling nodes — works, but is a workflow IDE, not a runtime SDK.
- **Observability**: execution logs, n8n Cloud monitoring.
- **Memory**: per-agent memory configuration in the node.
- **Use it for**: cross-cutting glue (Slack, Drive, Obsidian sync, scheduled triggers) rather than as Skippy's spine. Treat it as a tool agent that Skippy can call via webhook.

## 9. AG2, Pydantic AI, smolagents (quick scan)

- **AG2**: AutoGen v0.2 community fork, Python, MIT, conversational/group-chat-first. Mention only.
- **Pydantic AI**: type-safe single-agent loops with OTel built in. Not a multi-agent framework — but the right model for Skippy's tool wrappers if Python.
- **smolagents** (Hugging Face): code-execution-first ReAct agent. Niche; skip for Skippy.

---

## A. Recommended Architecture

**Primary backbone: Claude Agent SDK (TypeScript). Supporting: Letta for memory, n8n for external integrations.**

- The user already runs Claude Code; `claude-agent-sdk` shares the same harness, hooks, and MCP plumbing — so the dashboard is *introspecting the same engine* the user already trusts, not running a parallel stack.
- Subagents already match "board -> task" perfectly. Sidestep the no-grandchildren constraint by running **Skippy as one root `query()`**, then **each board agent (engineering, coding, design, ...) as its own `query()` process** that Skippy launches and supervises via MCP. Inside each board, task agents are first-class subagents. Three tiers, no hacks.
- Hooks are the dashboard's nervous system. `PreToolUse` / `PostToolUse` / `SessionStart` / `SessionEnd` events stream straight into the sprite engine so each agent's "animation state" (idle / thinking / tool-calling / blocked / done) is derived deterministically — no polling.
- `background: true` on subagents is exactly the RTS "build queue" semantic — fire-and-forget with status visible in the dashboard.
- Per-agent `model`, `effort`, `permissionMode`, `mcpServers`, `tools` mean each board can be tuned independently (e.g., Finance gets read-only, Coding gets Bash + Write).
- TypeScript over Python: the dashboard, terminal (xterm.js), and Obsidian plugin layer are all TS-native. Mastra would be the alternative spine here, but bolting Mastra on top of the Claude harness adds an abstraction that buys nothing the SDK doesn't already give you.
- Layer **Letta** behind every board agent as the long-term memory MCP server. Letta's core/archival/recall model is purpose-built for "what did we learn last week"; expose `letta_search_archival`, `letta_append_archival`, and `letta_edit_core` as MCP tools to every board agent. Mirror archival writes into Obsidian markdown via a hook on `PostToolUse` so Obsidian stays the user-facing source of truth.
- Use **n8n** as the integration plane (Gmail, Calendar, Drive, scheduled triggers, the Bridgemind RSS pull). Skippy reaches it through a single MCP server that wraps n8n webhooks.
- Reject CrewAI, AutoGen, OpenAI Agents SDK as the *primary* backbone: they don't share Claude Code's runtime, which means double the auth, double the prompt management, and a parallel hooks story.

## B. Telemetry & Observability Stack Pick

**Recommendation: Langfuse, self-hosted, fed via OpenTelemetry GenAI semantic conventions.**

- Open source under MIT, self-hostable in 5 minutes via Docker Compose, single-node Langfuse + Postgres handles ~5M spans/day for $50-80/month.
- Langfuse exposes a native OTLP endpoint at `/api/public/otel`, so the Claude Agent SDK hooks emit standard `gen_ai.*` spans (the OTel SIG's GenAI agent semantic conventions cover tasks, actions, agent teams, memory, artifacts) and Langfuse renders them as session replays — exactly the "rewind a board agent" feature the dashboard wants.
- Prompt management, evals, datasets, and the Playground are all open source as of June 2025, so nothing forces a paid tier.

Alternatives (and why they lose):

- **LangSmith**: best-in-class for LangGraph, but couples observability to a vendor and you don't get a free self-host. Skip unless the backbone changes to LangGraph.
- **Arize Phoenix**: OpenTelemetry-native, strong drift/RAG metrics, also OSS — a viable swap if RAG quality monitoring becomes a bigger concern than session replay. Heavier ops (Postgres + K8s assumptions).
- **OpenLLMetry / raw OpenTelemetry GenAI conventions**: not a backend, an instrumentation layer. Use it *underneath* whatever backend you pick. With Langfuse as the backend, OpenLLMetry is a good fallback adapter for any non-Anthropic agents that join Skippy later.

## C. Three Concrete Reads

1. **Claude Agent SDK Subagents docs** — the canonical contract for hierarchy, tool inheritance, and the no-grandchildren rule. https://code.claude.com/docs/en/agent-sdk/subagents
2. **"The Observability Agent" cookbook** — a worked example of orchestrator -> parallel subagents with tracing hooks. Directly applicable to Skippy's per-board telemetry stream. https://platform.claude.com/cookbook/claude-agent-sdk-02-the-observability-agent
3. **"Rearchitecting Letta's Agent Loop: Lessons from ReAct, MemGPT, & Claude Code"** — Letta's own dissection of how Claude Code's loop differs from ReAct, with concrete guidance on bolting persistent memory onto a Claude-style agent. The single best primer for the Skippy + Letta + Obsidian memory layer. https://www.letta.com/blog/letta-v1-agent

---

## Sources

- [Claude Agent SDK overview](https://platform.claude.com/docs/en/agent-sdk/overview)
- [Claude Agent SDK subagents](https://code.claude.com/docs/en/agent-sdk/subagents)
- [Claude Agent SDK hooks](https://platform.claude.com/docs/en/agent-sdk/hooks)
- [Claude Agent SDK MCP](https://platform.claude.com/docs/en/agent-sdk/mcp)
- [Claude Agent SDK Python on GitHub](https://github.com/anthropics/claude-agent-sdk-python)
- [The observability agent cookbook](https://platform.claude.com/cookbook/claude-agent-sdk-02-the-observability-agent)
- [LangGraph repo](https://github.com/langchain-ai/langgraph)
- [LangGraph overview docs](https://docs.langchain.com/oss/python/langgraph/overview)
- [LangSmith with LangGraph tracing](https://markaicode.com/langsmith-langgraph-tracing-multi-agent-workflows/)
- [LangGraph in 2026](https://dev.to/ottoaria/langgraph-in-2026-build-multi-agent-ai-systems-that-actually-work-3h5)
- [CrewAI hierarchical process docs](https://docs.crewai.com/en/learn/hierarchical-process)
- [Why CrewAI's Manager-Worker Architecture Fails](https://towardsdatascience.com/why-crewais-manager-worker-architecture-fails-and-how-to-fix-it/)
- [AutoGen GitHub](https://github.com/microsoft/autogen)
- [Magentic-One docs](https://microsoft.github.io/autogen/stable//user-guide/agentchat-user-guide/magentic-one.html)
- [OpenAI Agents SDK docs](https://openai.github.io/openai-agents-python/)
- [OpenAI Agents SDK April 2026 evolution](https://www.openlinksw.com/data/html/openai-agents-sdk-next-evolution-infographic.html)
- [Letta GitHub](https://github.com/letta-ai/letta)
- [Letta v1 Agent loop blog](https://www.letta.com/blog/letta-v1-agent)
- [MemGPT is now part of Letta](https://www.letta.com/blog/memgpt-and-letta)
- [Mastra agents overview](https://mastra.ai/docs/agents/overview)
- [Mastra TypeScript framework guide 2026](https://www.generative.inc/mastra-ai-the-complete-guide-to-the-typescript-agent-framework-2026)
- [n8n multi-agent solutions](https://hatchworks.com/blog/ai-agents/multi-agent-solutions-in-n8n/)
- [n8n multi-agent systems blog](https://blog.n8n.io/multi-agent-systems/)
- [Pydantic AI vs smolagents 2026](https://jangwook.net/en/blog/en/python-ai-agent-library-comparison-2026/)
- [2026 AI Agent Framework Showdown: Claude Agent SDK vs LangGraph vs OpenAI](https://qubittool.com/blog/ai-agent-framework-comparison-2026)
- [Langfuse vs Arize Phoenix vs LangSmith comparison](https://www.getmaxim.ai/articles/choosing-the-right-ai-evaluation-and-observability-platform-an-in-depth-comparison-of-maxim-ai-arize-phoenix-langfuse-and-langsmith/)
- [Langfuse OpenTelemetry integration](https://langfuse.com/integrations/native/opentelemetry)
- [Langfuse GitHub](https://github.com/langfuse/langfuse)
- [OpenTelemetry GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
- [OpenTelemetry GenAI agent spans](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/)
- [OpenLLMetry semantic conventions](https://www.traceloop.com/docs/openllmetry/contributing/semantic-conventions)
- [Self-hosted LLM observability comparison 2026](https://www.spheron.network/blog/llm-observability-gpu-cloud-langfuse-arize-phoenix-helicone/)
