# Cloud orchestration: tiers, cost and metering

Researched 2026-09-26 for [PRD v0.2](../PRD.md) decision D-01 (Skippy and board captains orchestrate on a cloud model; move to the cheapest sustaining tier). **[V]** = checked on an official page that day; **[U]** = unverified/third-party; **[J]** = judgment or estimate. Prices change: re-verify before purchase or budget configuration.

## 1. Anthropic

**Consumer plans** [V] ([pricing](https://claude.com/pricing), [Max](https://support.claude.com/en/articles/11049741-what-is-the-max-plan), [Claude Code with plans](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan)):

| Plan | Price | Claude Code | Models | Limits |
|---|---|---|---|---|
| Pro | $20/mo ($17 annual) | Yes | Opus, Sonnet, Haiku | 5-hour rolling session + weekly cap |
| Max 5x | $100/mo | Yes | all | 5× Pro per session + weekly |
| Max 20x | $200/mo | Yes | all | 20× Pro per session + weekly |

Chat and Claude Code share one pool. Limits are **not published as tokens** (third-party hour estimates are for older models [U]). Usage credits continue past limits at API rates with an optional cap ([extra usage](https://support.claude.com/en/articles/12429409-extra-usage-for-paid-claude-plans)). Cache TTL: 1 hour inside plan usage, 5 minutes on usage credits or API default ([costs](https://code.claude.com/docs/en/costs)).

**API, USD per million tokens** [V] ([pricing](https://platform.claude.com/docs/en/about-claude/pricing)):

| Model | Input | 5-min write | 1-h write | Cache read | Output | Batch in/out |
|---|---|---|---|---|---|---|
| Opus 5.5 | 4 | 5 | 8 | 0.20 | 20 | 2 / 10 |
| Sonnet 5 | 2 | 2.50 | 4 | 0.20 | 10 | 1 / 5 |
| Haiku 4.5 | 1 | 1.25 | 2 | 0.10 | 5 | 0.50 / 2.50 |
| Fable 5.1 | 10 | 12.50 | 20 | 0.25 | 50 | 5 / 25 |

Sonnet 5's $2/$10 is now standard (the planned September increase was cancelled). Batch 50% stacks with caching. Opus 5.5 thinking cannot be disabled — only effort (default `medium`); thinking bills as output. Models from 4.7 onward use a tokenizer producing ~30% more tokens for the same text: **measure** per-turn sizes.

**Subscription login from Skippy** [V] ([legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)): products, including Agent SDK use, "should use API key authentication"; third parties may not offer Claude.ai login, route through subscription credentials or handle subscription tokens. It does not prevent "an end user from signing in to the unmodified Claude Code binary with their own Claude subscription," and limits assume "ordinary, individual usage." [J] Skippy launching the owner's own unmodified `claude` fits the carve-out for personal use; an always-on orchestration loop may exceed ordinary usage, and the SDK automation lane uses an API key. See OQ-10.

## 2. OpenAI

**ChatGPT/Codex** ([Codex pricing](https://learn.chatgpt.com/docs/pricing)): Plus $20 (GPT-6 Sol, Luna; Sol 15–150, Luna 350–3,000, Astra 5–45 messages per 5 h). Pro "from $100/month": 5x tier Sol 70–700, Astra 25–225; 20x tier (~$200 [U]) Sol 300–3,000, Astra 100–900. Weekly limits "may apply," unquantified. Astra access on Plus is ambiguous [U]. The Codex model that authored the 2026-09-25 revival documents was GPT-6 Astra.

**API, USD per million tokens, standard** [V] ([pricing](https://developers.openai.com/api/docs/pricing)): gpt-6-astra 10 / 1.00 cached / 50 out; **gpt-6-sol 2 / 0.20 / 10**; gpt-6-luna 0.10 / 0.01 / 0.50; gpt-5.6-terra 2 / 0.20 / 12; gpt-5.6-luna 0.20 / 0.02 / 1.20; gpt-5.4-mini 0.75 / 0.075 / 4.50. GPT-6 and 5.6 charge cache writes (≈1.25× input). Reasoning bills as output. Long context 2×.

## 3. Metering sources (FR-COST-01)

- **Claude Code:** `CLAUDE_CODE_ENABLE_TELEMETRY=1` with OTLP exporters; `claude_code.token.usage` by type (input/output/cacheRead/cacheCreation), model, `query_source`, effort, `agent.name`; `claude_code.cost.usage` is a list-price estimate; `/usage` shows cache hit rate and plan-usage bars ([monitoring](https://code.claude.com/docs/en/monitoring-usage)). One page line says metrics "require active subscription" — verify against a real export [U].
- **Agent SDK:** result `total_cost_usd`, `modelUsage` (includes subagents; `usage` does not), dedupe per-step usage by message ID, read output from the result message, `maxBudgetUsd` cap ([cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking)).
- **Messages API:** `usage.input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens`.
- **Codex app-server:** `thread/tokenUsage/updated` [V] ([app-server](https://learn.chatgpt.com/docs/app-server)); `account/rateLimits/read|updated` (window `usedPercent`, `resetsAt`, `planType`) is community-documented only [U] — optional telemetry.

## 4. Cost model [J]

Assume 15k input (12k cache read + 3k new) and 1.5k output per orchestration turn; 30-day month.

| Model | $/turn cold | $/turn cached | 50/day | 200/day | 600/day (cached) |
|---|---|---|---|---|---|
| Opus 5.5 | 0.090 | 0.047 | $71 | $284 | $853 |
| Sonnet 5 / gpt-6-sol | 0.045 | 0.025 | $37 | $149 | $448 |
| Haiku 4.5 | 0.023 | 0.013 | $19 | $75 | $224 |
| gpt-5.6-luna | 0.005 | 0.003 | $4 | $17 | $50 |

At 50 turns/day (~one per 20 minutes) a 5-minute cache mostly expires; the 80% hit rate needs the 1-hour TTL (Opus 5.5 ≈ $0.056/turn with 1-h writes). Output is ~60% of cached cost, so effort/thinking settings matter more than prompt size.

Plausible tiers (limits are not tokens; unverified): 50/day → Claude Pro on Sonnet or ChatGPT Plus on Sol; 200/day → a $100 tier; 600/day → $100 on Sonnet/Sol, $200 for Opus.

## 5. Recommended procedure for D-01

1. **Measure two weeks** on a dedicated Anthropic API workspace with a spend cap (~$50). Log every call's usage to the local ledger and OTel keyed by run/attempt/board: cache-hit ratio, output per turn, turns/day, peak turns per 5-hour window. Put the frozen system prompt + charters behind a 1-hour cache breakpoint; volatile state after it.
2. **Default orchestrator: Sonnet 5 with caching**; Opus 5.5 for replanning after failure, cross-board conflicts and high-risk plans, with a per-run budget. At 200/day Opus 5.5 is only ~1.9× Sonnet, so promote it if evaluations show Sonnet under-plans.
3. **A/B and cheap lanes:** gpt-6-sol (same price); Haiku 4.5 or gpt-5.6-luna for status/summary turns. Don't switch models turn-by-turn (caches are per model). Jev and deterministic rules absorb routine classification (PRD §9).
4. **Switching thresholds** on 30-day orchestrator-only spend: < $20 → API or Pro/Plus; $20–80 → Pro/Plus if 5-hour peaks stay < 70%; $80–150 → a $100 tier if not shared with heavy coding; > $200 → $200 tier **or port orchestration to Alcyone**. Step up if 5-hour usage peaks > 80% twice a week or a weekly cap is hit; step down after two weeks under 30%.
5. **Quality guardrails:** plan rework rate, Opus escalations per 100 turns, per-board task success, tokens per **completed task**.
