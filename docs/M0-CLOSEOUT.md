# M0 close-out (reliable foundation)

Closed 2026-09-27 on `m0/foundation`. Code measured at `4dba546`, then documentation-only commits. Exit gate per [PRD](PRD.md) §12: **G0, with unrun checks recorded**.

**Result: M0 is closed with G0 partially met.** Every P0 finding from the [assessment](ASSESSMENT-2026-09-25.md) (A01–A05) has been reworked and hardened across five fix rounds, and each round was checked by an independent adversarial verification. The final verification still found two high-severity gaps (M0-G01, M0-G12). They are recorded below as tracked issues and must be closed before autonomous writes or live SDK execution are enabled (M2). None of them is reachable in the default configuration: live execution is off without `PHASE3_AGENTS_ENABLED` plus a key, boards have no read roots unless `SKIPPY_PROJECT_ROOT` is set, and autocommit only acts on the local vault.

Baseline results and unrun checks: [M0-BASELINE.md](M0-BASELINE.md). Defaults introduced during M0: PRD §14 OQ-13 … OQ-21.

## Exit criteria

| # | Criterion (source) | Final verdict | Evidence summary | Open issues |
|---|---|---|---|---|
| EC1 | Truthful delegation (A01, FR-RUN-01) | Not met | Ack before completion. Gates for disabled execution, missing key and demo. Task-agent errors, refusals, denials and withheld tools. Main-thread truncation judged per turn, with 125/125 live-mock scenarios stable. Legacy reader. UI and Rust guards. | G01–G05 |
| EC2 | Tool authority (A02, FR-SEC-01/02, FR-BOARD-01) | Partial | No bypass in the options actually passed to `query()`. 87/87 Read/Write/Edit denial cases. The Grep/Glob tree gate matches the real CLI's rg argv on 69 shapes. Charter parsing fails closed. No grandchildren. Roots only from explicit context. The Rust spawn lane is refused by default. | G06–G08 |
| EC3 | Vault write containment (A03, FR-SEC-02, FR-WIKI-02) | Partial | Single broker. Windows path, junction and real-ancestor checks, rechecked at write time. Hash CAS. Identity and byte-exact preservation. Append-only and reserved paths. Provenance capability. The Unicode skeleton covers all 973 NTFS aliases in the BMP. | G09–G11 |
| EC4 | Original retention (A04, FR-WIKI-03) | Met | Originals by hash. Declared encodings. Unsupported files kept with authenticated error sidecars. Crash-safe resume. Dedup. Every drop ingested or reported. | none |
| EC5 | Autocommit isolation (A05, FR-WIKI-06) | Not met | Isolated temp index. User-staged work preserved. Non-ASCII paths, literal pathspecs, gitlinks, sparse checkout. Filtered paths and LFS pointers refused. 67-case parity between the Node and Rust engines. Aba stress runs show 0 leaks. | G12–G18 |
| EC6 | Baseline and CI (T00, FR-OPS-03) | Met, against the T00 exit evidence | Explicit lint scripts, glob test runners, a Windows Rust/build CI job, and a fixed pnpm setup. First green CI run on both jobs at `3f70549` (see baseline). | none |
| EC7 | Unrun checks recorded | Met | [M0-BASELINE.md](M0-BASELINE.md), verified against observed runs. | none |

## Open issues (tracked; carry into M1/M2)

Severity reflects the final adversarial verification. "Default config" means the issue is not reachable unless a later feature or environment setting enables it.

| ID | Sev | Area | Issue | Suggested fix |
|---|---|---|---|---|
| M0-G01 | High | EC1 | A main-thread provider error, refusal, `pause_turn` or `max_output_tokens` inside a segment that gets no `result` (a background task agent is still running) ends `succeeded`. Causes: main-thread `<synthetic>` messages and the main-thread `StopFailure` hook are ignored (`sdk-board.ts` ~974, ~1157). `truncationOf` accepts a superseded turn whose stop reason is `refusal`/`pause_turn`. | Record main-thread synthetic errors and `StopFailure` in the run-failure ledger. Judge superseded turns against `NORMAL_STOP_REASONS`, not just non-null. |
| M0-G02 | Low | EC1 | A non-streamed turn with `stop_reason:null` whose tool was run is judged truncated. This is a false failure that fails closed. | Track tool_use ids for non-streamed turns. |
| M0-G03 | Low | EC1 | A tool_use rejected for invalid input (an `is_error` tool_result) counts as "executed" when judging a cut turn. | Count only successful tool results. |
| M0-G04 | Residual | EC1 | Blocks that never started after a mid-stream cut leave no trace, so they are undetectable. Truncation inside a task agent has no structured signal (OQ-20). | Revisit with the T10 adapters. |
| M0-G05 | Low | EC1 | A `succeeded` envelope that carries a failure `reason` passes the TypeScript and Rust guards. No writer produces one. | Add to `terminalRecordViolations` and the Rust mirror. |
| M0-G06 | Medium, conditional | EC2 | With an inherited environment of `USE_BUILTIN_RIPGREP=0`, an `rg` on PATH, and a `RIPGREP_CONFIG_PATH` containing `--follow`, the CLI's system rg follows junctions, so Grep/Glob read outside the roots. | Pass a scrubbed, explicit `env` to `query()`, and pin the builtin rg. |
| M0-G07 | Low, latent | EC2 | If the `onDecision` callback throws, the PreToolUse hook fails open. Production passes no callback. | Wrap it in try/catch and deny on error. |
| M0-G08 | Low | EC2 | Reparse directories that are not name surrogates (for example OneDrive) are skipped by the scan but walked by rg. | Treat unknown reparse tags as a bound hit and deny. |
| M0-G09 | Medium-low | EC3 | Two creates of lookalike directories at the same moment in one process can both succeed. | Take the create guard for every directory level. |
| M0-G10 | Low | EC3 | An agent can pre-create a lookalike name that blocks a system writer. A missing board's agent_log folder is reported. A distill topic page is **dropped silently**, because `jobs/distill.ts` swallows `VaultPathError`. | Surface the distill error. Restrict agent-created names to ASCII slugs, or reserve the system namespaces. |
| M0-G11 | Low | EC3 | A case-variant `_ingest-errors` folder makes the pipeline's own records get re-reported on every restart. | Resolve the fallback folder by its on-disk name. |
| M0-G12 | High | EC5 | A `working-tree-encoding` attribute re-encodes a plaintext secret into a blob the scanner cannot see. Checkout restores it byte for byte. The module headers wrongly call this safe. | Refuse any path with `working-tree-encoding`, like `filter`. Correct the headers and OQ-19. |
| M0-G13 | Medium | EC5 | The attribute snapshot misses `attr.tree`, a relative `core.attributesFile` (resolved against the process cwd), a case-variant `.GitAttributes`, and directories holding a non-repo `.git`. | Snapshot every source git reads (via `git config --get attr.tree`, repo-relative resolution, and a case-insensitive walk that doesn't skip on a bare `.git` entry). |
| M0-G14 | Residual | EC5 | A flip and flip-back of an attribute source between observations is reachable within a few ticks under a fast toggler (documented in OQ-19). | Override clean filters during our own add, or read attributes from the committed tree only. |
| M0-G15 | Low | EC5 | A UTF-32 `working-tree-encoding` makes every tick fail with an explicit error. | Closed by the M0-G12 fix. |
| M0-G16 | Medium | EC5 | A crash between `update-ref` and the index sync, before the pending marker is written, leaves a staged revert. | Write the marker as an intent before `update-ref`. |
| M0-G17 | Medium-low | EC5 | A marker dropped after a branch switch leaves a staged revert (same commit, different ref). | On a ref mismatch with `HEAD == new`, sync rather than drop. |
| M0-G18 | Low | EC5 | A literal-pathspec reset can wipe a staged child entry when a directory became a file. Not re-verified after the round-5 rewrite. | Re-verify, then scope the reset to exact entries. |
| M0-G19 | Low | Cost | Task agents ignore the board's `maxTurns` (60 sub-turns seen against `maxTurns: 6`). | Enforce per-agent turn and budget caps (FR-COST, T12). |
| M0-G20 | Resolved | EC6 | CI had never run green (26 historical runs failed). Resolved 2026-09-27: first green run at `3f70549` on ubuntu and windows, after test-portability fixes. | none |

Deferred by the PRD, not counted: OQ-13 validation disposition, OQ-14 approval channel, OQ-17 (secrets in ordinarily named files, hardlinks), no `cancelled` producer yet, the process-exit shutdown race and hung-provider timeout (T07), and the proper Claude CLI adapter (T10).

## Owner decisions pending

1. `CLAUDE.md` convention 5 still names `write-file-atomic`. Vault writers now use `atomicWriteContained` (`packages/memory/src/safe-write.ts`).
2. Hoya_Box upstream sync (not applied):
   - In `agent_space/CLAUDE.md`, the `permission_mode` line should state that `bypassPermissions` is rejected.
   - The `delegate_to_board` guidance should say: "accept means accepted, never completed; only succeeded means done".
3. Behaviour changes to accept:
   - Obsidian REST is read-only.
   - `claude_code_spawn` is refused unless `SKIPPY_ALLOW_UNGATED_CLAUDE_SPAWN=1`.
   - Boards have no read roots unless `SKIPPY_PROJECT_ROOT` is set.
   - Broad Grep/Glob are denied until narrowed (OQ-18).
   - User-staged vault notes are not autocommitted.
   - Filtered and LFS vault paths are never autocommitted.
   - The Unicode skeleton over-refuses some names (OQ-21).
4. `m0/foundation` is the pivot trunk and stays off `main` until the owner confirms it. Draft PR #1 (`m0/foundation` → `main`) exists only to run CI and must not be merged yet. M1+ branches target `m0/foundation`.

## Routing ledger (summary)

| Round | Dispatches |
|---|---|
| Implementation (WS-A…F) | sprint-builder ×3 (baseline/CI, ingest, autocommit), sprint-engineer ×3 (delegation, tool authority, vault broker) |
| Verification round 1 | sprint-redteam ×3 |
| Fix round 1 | sprint-builder ×3, sprint-engineer ×2, sprint-scout ×1 (CI, OQs, baseline; missed items finished by the orchestrator) |
| Verification round 2 | sprint-redteam ×3 |
| Fix round 2 | sprint-engineer ×3 (escalated from Tier 2), sprint-architect ×1 (escalated from Tier 3) |
| Final verification | sprint-redteam ×4 |
| Targeted round 3 | sprint-engineer ×3, sprint-architect ×1; verification sprint-redteam ×4 |
| Round 4 (four highs) | sprint-engineer ×3, sprint-architect ×1; verification sprint-redteam ×4 |
| Simplification round | sprint-engineer ×4; verification sprint-redteam ×4 (plus 4 launched and stopped for the owner's network test, then relaunched) |

Tally: Haiku ×1 · Sonnet ×6 · Opus ×44 · Fable ×3.

Calibration notes:
- Ingest and autocommit should have started at Tier 3; both are data-loss and security-sensitive areas with Windows and git edge cases.
- The security areas needed a threat model before implementation. Each verification round found a new class of problem rather than a regression.
- Tier-1 agents are not reliable for accuracy-critical documentation.
- Worktree agents can start from `main`, so every prompt must begin with a reset to the integration branch.
- Simplifying to fail-closed rules (refuse filtered paths, gate the exact rg tree, conservative fold) converged faster than patching point by point.
