# Claude Opus implementation handoff

Use this with [PRD v0.2](PRD.md), not as a replacement for it. Start from the assessment branch, read the working tree, and preserve unrelated changes. The specification is a proposal for incremental implementation; no runtime feature or cluster deployment was implemented during assessment.

## Read in this order

1. [Project conventions](../CLAUDE.md) and [PRD](PRD.md).
2. [Assessment](ASSESSMENT-2026-09-25.md), especially A01-A05 and the validation limits.
3. [Model/cluster plan](MODEL-AND-CLUSTER-PLAN.md), before making any serving decision.
4. [Research](research/08-revival-research-2026-09-25.md), especially account integration boundaries and Jev semantics.
5. The source files for the selected ticket. The [archived PRD](archive/PRD-v0.1-2026-04-29.md) is historical context.

The requested implementation model family is Claude Opus. As researched on 2026-09-25, `claude-opus-5-5` is a candidate if available through the owner's account/client. Verify supported IDs and SDK/CLI compatibility rather than copying the repo's older fixed model enum. Model selection for implementation does not mandate Opus for every runtime task. [Current official Opus documentation](https://platform.claude.com/docs/en/models/opus-5-5/overview)

## First implementation session

Record branch/HEAD, dirty files, Node/pnpm/Rust/Tauri versions and available native prerequisites. The assessment environment lacked Node, pnpm and Cargo and did not run builds or tests. Do not inherit a green baseline that does not exist. Review installation scope before changing machine software; do not start telemetry containers just to run unit tests.

Use the pinned package manager/lockfile first. Avoid a blanket dependency upgrade. Runtime currently uses Zod 4 for the Agent SDK boundary while shared/memory use Zod 3; either preserve that boundary or migrate it deliberately with contracts/tests. Pin any new native client and local serving configuration before its qualification run.

Once the toolchain is available, baseline commands from the repository root are:

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm --filter @skippy/memory test
pnpm --filter @skippy/agent-runtime test
pnpm build:runtime
pnpm --filter @skippy/ui build
cargo check --manifest-path apps/shell/src-tauri/Cargo.toml
```

Run relevant checks after each change. Existing runtime tests cover the MCP registry, not task execution; existing memory scripts enumerate specific files, so new regression tests must be added to the runner. Root recursive lint currently has no meaningful package lint coverage. Add explicit lint configuration/scripts in the baseline ticket before calling lint a release check.

For UI changes, follow [Playwright guidance](PLAYWRIGHT.md) and run `pnpm test:visual` with the required browser tooling. Native PTY, IPC, sidecar and installation checks need Tauri/Windows; a browser-only screenshot does not validate them. Live provider tests are separately enabled and budgeted, never an implicit requirement of ordinary CI.

## Ticket sequence

Ticket sizes are relative: S = contained change, M = cross-module slice, L = split into reviewable increments. They are not calendar estimates. Do not implement the entire table in one unreviewable change.

| Ticket | Size / dependencies | Scope and source entry points | Exit evidence / PRD |
|---|---|---|---|
| T00 Baseline and CI | M; none | Manifests, lockfile, `.github/workflows/ci.yml`, test runners; record environment and failures | Explicit lint, unit tests and Windows Rust/build path; FR-OPS-03 |
| T01 Truthful delegation | M; T00 baseline | `board.ts`, `sdk-board.ts`, `mcp-delegate.ts`, shared completion envelopes and UI consumers | Disabled/stub/error paths cannot produce success; acknowledgement distinct from completion; FR-RUN-01 |
| T02 Tool authority | M; T01 | `sdk-board.ts`, `charter.ts`, `mcp-registry.ts`, scoped execution context | No unconditional bypass; denied tool/write actually fails; FR-SEC-01/02, FR-BOARD-01 |
| T03 Vault and ingest safety | M; T00 | `mcp-handlers.ts`, memory `atomic.ts`, `frontmatter.ts`, `obsidian-rest.ts`, jobs/ingest and watcher | Path/junction containment, stable IDs, append-only, external-edit conflict and preserved binary originals; FR-WIKI-02/03 |
| T04 Isolate autocommit | S; T00 | Rust `git_autocommit.rs`, `scripts/git-autocommit.mjs` | Temporary repo tests with unrelated staged edits, failed commit and index preservation; FR-WIKI-06 |
| T05 Shared domain protocol | M; T01-T03 | shared envelopes/model contracts, Rust mirrors, UI channel parser | Versioned task/run/attempt/control/usage DTO fixtures validate in both languages; FR-ARCH-02/03 |
| T06 Durable sessions and worktrees | L; T04-T05 | New runtime persistence/scheduler modules; `index.ts`, `supervisor.ts`, prompt/delegation stores | Two threads, one writer per worktree, checkpoint/crash recovery and reversible migration; FR-RUN-02/03/04/07 |
| T07 Cancel and shutdown | M; T06 | `shutdown.ts`, `index.ts`, `sidecar.rs`, PTY, UI controls | Acknowledged pause/cancel, bounded process drain, late-event behavior and restart tests; FR-RUN-05/06 |
| T08 Workspace shell | M; T05-T06 | `App.tsx`, `index.css`, stores, HUD, terminal and selection | Persistent rail/thread/inspector/dock with linked artifacts; keyboard navigation; FR-UI-01/02/04/05 |
| T09 Codex account executor | M; T02,T05-T07 | New adapter; reuse shell process boundary; inspect installed app-server protocol | Managed login, discovery, thread/turn lifecycle, approvals, cancellation, quota and billing labels; FR-PROV-01 |
| T10 Claude executors | M; T02,T05-T07 | `claude.ts`, `sdk-board.ts`, `claudeCode.ts`, PTY; separate CLI/API adapters | Unmodified personal CLI lane and explicit API lane; no token extraction; policy and terminal result tests; FR-PROV-02/03 |
| T11 Existing local endpoint | M; T02,T05-T07 | New compatibility adapter and connection configuration | Read-only live inventory, tunnel/health/model identity and capability suite; no container replacement; FR-PROV-04, FR-CLUSTER-01/03 |
| T12 Budgeted router | L; T09-T11 | Replace `modelRegistry.ts`, evolve shared pricing/model limits, per-attempt usage store | Policy filtering, reservations, pins, bounded escalation and cost/quota tests; FR-ROUTE-01..05, FR-COST-01..03 |
| T13 Model qualification and Atlas | M; T11-T12 | Evaluation fixtures/manifests, endpoint capability catalog, connections UI | Model-plan suite and mixed-load report; acquisition separate from service loading; FR-CLUSTER-02/04/05/06 |
| T14 Wiki workspace and retrieval | L; T03,T06,T08 | Wiki UI; memory jobs, embeddings/vector store; source preview | Owned versioned index, lexical fallback, citations and reviewed/draft distinction; FR-WIKI-01/04/05 |
| T15 Decision inbox and Jev shadow | M; T06,T12,T14 | Typed decision store, adapter, UI and wiki export | Rules first, validated typed prediction, owner disposition, outage fallback, labelled shadow report; FR-JEV-01..07 |
| T16 RTS as live projection | M; T06-T08 | `SceneRoot.tsx`, HUD, ref-store, events, hotkeys | One task identity across map/list/thread; truthful state; reduced-motion/no-WebGL; FR-UI-03/06/07 |
| T17 Release and operations | L; enabled feature tickets | Infra config, exporter, Tauri resources, sidecar resolution, migration/backup and installer | Optional-service outage tests, clean Windows install, rollback and G0-G8 report; FR-OPS-01..05 |

M0 consists of T00-T04. T03 and T04 have independent file surfaces after the baseline is established; this is a dependency observation, not an instruction to launch additional agents. T08 can use labelled protocol fixtures while native adapters develop. T15 shadow mode can ship without automatic Jev decisions. T13 must not turn a candidate download into a production service swap.

## Contracts to establish before provider work

These are design sketches, not drop-in SDK signatures:

```typescript
type BillingLane = 'subscription' | 'api' | 'local';
type Outcome = 'succeeded' | 'failed' | 'cancelled' | 'interrupted' | 'blocked';

interface ExecutionRequest {
  workspaceId: string;
  taskId: string;
  runId: string;
  attemptId: string;
  worktreePath: string;
  modelDeploymentId: string;
  contextManifestId: string;
  policySnapshotId: string;
  budgetReservationId: string;
}

interface RouteDecision {
  policyVersion: string;
  eligibleDeploymentIds: string[];
  rejected: Array<{ deploymentId: string; reasonCode: string }>;
  selectedDeploymentId: string | null;
  disposition: 'dispatch' | 'queue' | 'review';
  publicReason: string;
}
```

Every executor supplies a normalized event stream and terminal disposition, while retaining native IDs and raw error codes in redacted diagnostics. Inference adapters alone cannot emit a task success. Validation belongs to the task's acceptance criteria, not a model's "done" sentence. A successful executor whose tests fail produces a failed/needs-review task disposition.

Do not pass a universal tool list into all providers. Custom local loops use the shared broker. Native clients must enforce equivalent workspace/approval policy through supported native controls. If a native client cannot honor a required restriction, reject that route or expose it only as an explicitly manual session.

## Jev integration example

The following illustrates the documented request shape with **synthetic**, nonsensitive state. Production question wording/options are versioned and evaluated; this is not a qualified policy.

```json
{
  "model": "jev-1.13.0",
  "state": {
    "task": "Add a unit test for an existing pure utility",
    "eligible_routes": ["local_small", "premium_session"],
    "evidence": {"files_affected": 1, "acceptance_test_defined": true}
  },
  "questions": {
    "suggested_route": {
      "type": "choice",
      "instructions": "Recommend a route only from the eligible routes. Choose review if evidence is insufficient.",
      "criteria": {
        "local_small": "A bounded task with clear, executable validation and no unresolved dependencies.",
        "premium_session": "Complex reasoning or broad changes justify a stronger eligible executor.",
        "review": "Insufficient or contradictory evidence for a route recommendation."
      }
    }
  }
}
```

Send through the documented TypeSafe adapter, not through a chat-completions wrapper. The deterministic route filter precedes this call and validates the selected option afterwards. Cost/privacy gates may prevent the call entirely. Store the actual returned model version and distribution; do not substitute an LLM-written explanation for a typed result. [Official API](https://docs.typesafe.ai/api)

## Per-ticket evidence packet

Include the linked requirement and problem, files changed, state/schema migration, meaningful tests, actual command results, known limits and rollback. Record any live provider/model costs and hardware configuration. If native tests cannot run, state that plainly; browser fixtures do not close a native release gate.

Use small commits/PRs when requested by the implementation session. Never commit credentials or generated sensitive transcripts. Keep sibling repositories read-only unless the owner specifically expands that session's scope. Treat source reports and historical measurements as references, not current host observations.

## Copyable kickoff prompt

> Implement the Skippy_space revival from docs/PRD.md v0.2 using this handoff. Read CLAUDE.md, the assessment, research and model plan. Preserve the existing worktree and confirm the baseline/toolchain. Begin with T00-T04 and close G0 before enabling more autonomous execution. Fix truthful outcomes, permission enforcement, vault containment/source retention and autocommit isolation with regression tests. Continue in bounded vertical slices through the dependency table, reporting actual validation and unresolved native checks. Preserve Skippy, the eight boards, Tauri/React/Pixi and the Obsidian vault. Use supported personal Codex/Claude Code integrations separately from paid APIs. Keep Pleiades/Money Printer read-only during application implementation; do not replace mp-vllm, expose a LAN listener, download large models or inspect sealed data as a side effect. Jev begins in shadow mode and never overrides deterministic authority. Revalidate current provider interfaces/model IDs before integrating them. Do not claim a task is complete because a stub or a model says so.

## Definition of a completed revival beta

The owner can resume a real thread, perform a bounded task on a qualified local route, escalate to an eligible personal or budgeted API executor, inspect its tests/diff, view the same task in RTS, cite/review a wiki note and record a decision. Cancellation, restarts, unavailable services and unknown costs behave honestly. G0-G8 evidence exists for the features enabled in the release. Unqualified candidates remain explicitly experimental or disabled.
