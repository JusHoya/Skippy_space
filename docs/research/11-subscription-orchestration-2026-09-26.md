# Subscription-backed orchestration

Researched 2026-09-26 for [PRD v0.2](../PRD.md) decision D-05: the owner does not want to maintain prepaid API wallets for Skippy's cloud orchestrator. Supersedes the "dedicated API key" measurement proposal in [research 10](10-cloud-orchestration-cost-2026-09-26.md) §5 for orchestration; research 10's pricing and cost model still apply to overflow and API lanes. "(unverified)" means the primary page could not be fetched.

## 1. Codex app-server on the owner's ChatGPT Pro login

- **Supported embedding.** Use `codex app-server` "when you want a deep integration inside your own product: authentication, conversation history, approvals, and streamed agent events." `account/login/start` type `chatgpt` means "Codex owns the ChatGPT OAuth flow, persists tokens, and refreshes them automatically"; Skippy never handles tokens. Do not use `chatgptAuthTokens` (for hosts that already own ChatGPT auth). Set `clientInfo.name` so the client appears in OpenAI compliance logs. [app-server](https://learn.chatgpt.com/docs/app-server)
- **Automation guidance.** API keys are recommended for "programmatic Codex CLI workflows, such as CI/CD jobs" ([auth](https://learn.chatgpt.com/docs/auth), [non-interactive](https://learn.chatgpt.com/docs/non-interactive-mode)) — a recommendation aimed at shared runners, not a ban on a personal desktop client. OpenAI endorses subscription use in third-party harnesses ([Codex for OSS](https://developers.openai.com/community/codex-for-oss)). Consumer terms forbid programmatic *extraction* ([terms](https://openai.com/policies/row-terms-of-use/), unverified primary text); a Pro fair-use clause is reported by third parties (unverified). Rules: single user, human-paced volume, no 24/7 loops.
- **Quota.** Pro is 5× or 20× Plus with rolling 5-hour and weekly windows; local and cloud Codex share the pool ([pricing](https://learn.chatgpt.com/docs/pricing)).
- **Planner configuration.** `sandboxPolicy: {"type":"readOnly"}`, approval `never`, no write tools; persona via `developer_instructions` and an AGENTS.md in the orchestrator's working directory (`thread/start` reports `instructionSources`); per-turn `outputSchema` for structured plans; per-thread model/effort overrides. Discover models with `model/list` (Pro lists GPT-6 Astra/Sol/Luna, GPT-5.6, GPT-5.4 mini) — never hard-code.

## 2. Claude Code headless on the owner's Max login

- **Terms** ([legal and compliance](https://code.claude.com/docs/en/legal-and-compliance), [consumer terms](https://www.anthropic.com/legal/consumer-terms)): OAuth supports "ordinary use of Claude Code"; products and Agent SDK use should use API keys; the carve-out permits "an end user … signing in to the unmodified Claude Code binary with their own Claude subscription"; automated access is otherwise barred "except … via an Anthropic API Key or where we otherwise explicitly permit it"; enforcement may occur without notice.
- **Permitted:** Skippy spawning the owner's unmodified `claude` binary, logged in via Anthropic's own `/login`, on the owner's machine, human-supervised and bursty.
- **Not permitted:** importing `@anthropic-ai/claude-agent-sdk` with subscription credentials (the existing gated SDK board path stays API-key-only); reading or copying OAuth tokens; sharing access; always-on daemons.
- **Mechanics** ([headless](https://code.claude.com/docs/en/headless), [CLI reference](https://code.claude.com/docs/en/cli-reference)): `-p` with `--output-format stream-json --verbose --include-partial-messages`, or a persistent `--input-format stream-json` process; `--resume <id>`; `--json-schema`; `--append-system-prompt-file` for the Skippy persona; read-only planner via `--permission-mode plan` (or `dontAsk`) with `--allowedTools "Read,Grep,Glob"`; `system/api_retry` events expose `rate_limit`/`billing_error`. **Never `--bare`** on this lane — it ignores OAuth and requires an API key, and is slated to become the `-p` default: pin the Claude Code version and pass flags explicitly.

## 3. Billing without manual top-ups

| Lane | Mechanism | Hard stop |
|---|---|---|
| Claude Max overflow | "Extra usage" credits: auto-reload plus monthly spending cap, API rates, covers chat and Claude Code ([help](https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans)) | Cap reached → overage stops until next period |
| Anthropic API key | Console auto-reload (trigger balance + reload amount) and monthly spend limit; invoicing on contract ([help](https://support.claude.com/en/articles/8977456-how-do-i-pay-for-my-claude-api-usage)) | Spend limit |
| OpenAI API key | Auto-recharge with monthly recharge limit (caps automatic purchases, not usage); exhausted → `credit_balance_exhausted` ([help](https://help.openai.com/en/articles/8264644-setting-up-and-managing-prepaid-api-billing)) | Recharge limit |
| ChatGPT Pro Codex | Purchasable credits with automatic reload "if available to your account" ([help](https://help.openai.com/en/articles/12642688-using-credits-for-flexible-usage-in-chatgpt-freegopluspro-sora)); personal monthly cap unverified | Enforce an app-side budget |

A cap is a failure condition Skippy surfaces as blocked, never as success (FR-RUN-01, FR-COST-03).

## 4. Quota visibility and backoff

- **Codex:** `account/rateLimits/read` (works right after initialize) and push `account/rateLimits/updated`: windows `{usedPercent, windowDurationMins, resetsAt}`, `rateLimitReachedType`, `planType`, `credits`; `thread/tokenUsage/updated` per thread. Classify windows by duration (300 min, 10,080 min), not slot; a missing window is unknown, not unlimited.
- **Claude Code:** status-line JSON `rate_limits.five_hour` / `seven_day` `{used_percentage, resets_at}` (Pro/Max, after first response) ([statusline](https://code.claude.com/docs/en/statusline)); `RateLimitInfo` events with `utilization`, `resets_at`, `overage_status` in the SDK stream ([TS reference](https://code.claude.com/docs/en/agent-sdk/typescript)) — presence in `-p` stream-json unverified; `api_retry{error:"rate_limit"}`; `total_cost_usd`. OTel reports tokens and cost, not remaining quota.
- **Policy:** ≥70% of a 5-hour window → new planning turns go to the other subscription; ≥85% → non-critical turns local-only; reached limit → hard stop for that lane.

## 5. Recommended lane design

1. **Primary orchestrator: Codex app-server, ChatGPT Pro.** Managed login, read-only sandbox, approval `never`, Skippy persona, runtime model discovery (Sol/Astra for planning, Luna for cheap routing turns). Most explicitly sanctioned custom-client route with a first-class quota API.
2. **Secondary / reviewer: `claude -p` on Max.** Unmodified binary, owner's login, no `--bare`, plan mode, restricted tools, persona file, `--resume`. Human-paced; not a daemon.
3. **Local fallback:** the Alcyone model through the local executor adapter when both subscriptions cross thresholds or auth fails; plans marked degraded.
4. **API key only for:** Agent SDK library use, always-on/background automation (schedulers, watchers, n8n) and evaluation runs — with auto-reload and a hard monthly cap (e.g. ~$50 each vendor). Enable Claude extra usage with a cap as the Claude-lane overflow.
5. **Event-driven orchestration:** Skippy plans when the owner starts or changes a mission and at task checkpoints; status, summaries and triage go to rules, Jev and local models. No polling loop on a subscription lane.

## 6. Open questions

- "Ordinary use" has no published ceiling → default ≤ ~1 subscription orchestrator turn per minute, only while the owner is active.
- Personal Codex credit monthly cap → assume none; app-side budget.
- `rate_limit_event` in `-p` stream-json → poll status/parse `api_retry` until verified.
