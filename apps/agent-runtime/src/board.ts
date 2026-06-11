// board.ts — one logical Board Captain process.
//
// HONEST STATE OF THE TOPOLOGY (was overstated; corrected per review §6):
// PRD §5.1's full vision is "each board agent as its own root query() process"
// — a Claude Agent SDK `query()` per board, with isolated contexts and distinct
// memory bindings. That is NOT what this file implements yet. What it actually
// does:
//
//   * Each board is an in-process logical session (a `Board` instance), never
//     an OS process or worker thread. There is one shared Node process for all
//     eight boards plus the supervisor.
//   * The Claude Agent SDK IS now a dependency (`@anthropic-ai/claude-agent-sdk`
//     in package.json), but a real `query()` is reached ONLY on the gated path
//     (`PHASE3_AGENTS_ENABLED=1` + an API key) via `sdk-board.ts`, and even then
//     it is a one-shot `query()` per *delegation*, not a long-lived per-board
//     session. With the gate off (the default, and the only mode the exit gate
//     exercises) a board does no LLM work at all — it returns a keyword-routed
//     ack and a stub `delegation_complete`.
//   * The "isolation" we genuinely provide is the trivial kind: each Board owns
//     its own `history` array and system prompt, and the supervisor never
//     crosses the streams. There is no token-bleed because, off the gate, there
//     are no tokens.
//
// FAILURE MODEL (PRD §5.3 — partially implemented, honestly):
//   * A delegation that fails (SDK error, thrown exception, empty result) emits
//     a `delegation_complete` with `result:'failure'` — the renderer's failure
//     arm is reachable and the board always returns to `ready`. See
//     `emitDelegationComplete`.
//   * What §5.3 promises but is NOT here: SQLite-checkpoint rehydration of board
//     state across the 2 s sidecar restart, and a real retry/backoff policy.
//     A crashed sidecar loses all in-flight delegation state. Tracked as a gap.
//   * Concurrency: a board executes ONE mission at a time. A second delegation
//     arriving mid-flight is declined (not silently accepted) so `markReady()`
//     never lies about state. See the `busy` guard in `receiveDelegation`.
//
// PRD R-01 (the only Critical risk — 12 s SDK cold start) is UNMITIGATED here:
// the gated path pays the cold start on every delegation; the warm pool the PRD
// envisions is an unreferenced stub elsewhere.
//
// In Phase 2+ we still expect to migrate to one of:
//   (a) a long-lived `claude-agent-sdk` `query()` per board, still in-process.
//   (b) `worker_threads.Worker` per board if we need true thread isolation.
//   (c) child Node processes per board only if (a) and (b) are insufficient.
//
// Until then, the public surface (`receiveDelegation`, `start`, `shutdown`,
// OTel span names) stays stable so the migration is a constructor swap.

import { SpanStatusCode, trace } from '@opentelemetry/api';

import { BOARD_META, type BoardId } from '@skippy/shared';

import { charterPermissions, type Charter } from './charter.js';
import { logger } from './logger.js';
import { buildMcpServers } from './mcp-registry.js';
import { getModelFor } from './modelRegistry.js';
import { writeEnvelope } from './protocol.js';
import { sdkBoardsEnabled, executeBoardMissionViaSdk } from './sdk-board.js';
import { resolveVaultRoot } from './vault-root.js';

const tracer = trace.getTracer('skippy-board');

/**
 * Decision shape returned to the supervisor when a delegation arrives.
 * Mirrors the on-wire `DelegationAckEnvelope` enum.
 */
export type DelegationDecision = 'accept' | 'decline' | 'counter_propose';

/** Input to `receiveDelegation` — narrow shape so we don't need to import the
 * envelope union at the Board level. */
export interface BoardDelegation {
  delegationId: string;
  missionBrief: string;
  constraints?: string[];
  deadline?: string;
  fromAgentId: string;
}

/** Output of `receiveDelegation` — synchronous decision; the longer-running
 * `delegation_complete` emission happens asynchronously after this returns. */
export interface BoardAck {
  delegationId: string;
  boardId: BoardId;
  decision: DelegationDecision;
  counterText?: string;
}

/** Lifecycle of a Board, used internally and mirrored to renderer via
 * `board_state` envelopes. */
type Phase = 'spawning' | 'ready' | 'working' | 'shutdown' | 'errored';

export class Board {
  readonly boardId: BoardId;
  readonly agentId: `board.${BoardId}`;
  private readonly charter: Charter;
  private phase: Phase = 'spawning';

  /**
   * True from the moment an accepted delegation starts executing until its
   * `delegation_complete` has been emitted (success OR failure). A board runs
   * exactly one mission at a time; a second delegation arriving while `busy`
   * is declined rather than silently accepted, so `markReady()` never lies
   * about state mid-flight (review §6, board.ts:196). Phase 2 may replace the
   * reject-while-busy policy with a bounded queue.
   */
  private busy = false;

  /**
   * Per-board conversation log. In Phase 2 this becomes the actual Claude
   * Agent SDK query() context; in Phase 1 we keep it as a placeholder so the
   * supervisor and the OTel pipeline have something to attribute work to.
   */
  private readonly history: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  constructor(boardId: BoardId, charter: Charter) {
    this.boardId = boardId;
    this.agentId = `board.${boardId}`;
    this.charter = charter;
  }

  /** PRD §5.1 — start sequence. Emits `board_spawned` then `board_ready`. */
  async start(): Promise<void> {
    const meta = BOARD_META[this.boardId];
    await tracer.startActiveSpan(
      `skippy.board.${this.boardId}.start`,
      {
        attributes: {
          'skippy.board.id': this.boardId,
          'skippy.board.charter_loaded': this.charter.loaded,
          'skippy.board.model': meta.defaultModel,
        },
      },
      async (span) => {
        try {
          writeEnvelope({
            type: 'board_spawned',
            boardId: this.boardId,
            agentId: this.agentId,
            model: meta.defaultModel,
            ts: new Date().toISOString(),
          });

          // Phase 1: warm-up is just "register the system prompt and self-test
          // that the charter is non-empty". Phase 2 will swap in an SDK
          // query() init + a no-op LLM ping to pay the cold-start once.
          await this.warmUp();

          this.phase = 'ready';
          writeEnvelope({
            type: 'board_ready',
            boardId: this.boardId,
            agentId: this.agentId,
            ts: new Date().toISOString(),
          });
          writeEnvelope({
            type: 'board_state',
            boardId: this.boardId,
            agentId: this.agentId,
            state: 'ready',
            ts: new Date().toISOString(),
          });

          span.setStatus({ code: SpanStatusCode.OK });
        } catch (err) {
          this.phase = 'errored';
          span.recordException(err as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          writeEnvelope({
            type: 'board_state',
            boardId: this.boardId,
            agentId: this.agentId,
            state: 'errored',
            ts: new Date().toISOString(),
          });
          throw err;
        } finally {
          span.end();
        }
      },
    );
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  private async warmUp(): Promise<void> {
    // No LLM call in Phase 1 — just verify the charter body has at least the
    // identity sentence the placeholder generator emits.
    if (!this.charter.body || this.charter.body.length < 16) {
      throw new Error(`charter body for board.${this.boardId} is suspiciously short`);
    }
    logger.debug({
      msg: 'board warmed',
      boardId: this.boardId,
      charter_loaded: this.charter.loaded,
    });
  }

  /**
   * Handle one delegation envelope. PRD §5.2: synchronously return the ack
   * (accept | decline | counter_propose), then asynchronously emit a
   * `delegation_complete` envelope once the work (stub or gated SDK run) is
   * done — with the REAL success/failure of that work, not a hardcoded success.
   *
   * Policy:
   *   - board already busy with another mission -> decline (one mission at a
   *     time; never silently accept and lie about state).
   *   - obvious-wrong-board heuristic -> counter_propose.
   *   - otherwise -> accept, claim the board, and run the mission. The
   *     `delegation_complete` carries `result:'success'` only if the work
   *     actually succeeded; any failure (or thrown error) emits
   *     `result:'failure'` so the board always frees and the UI never hangs.
   *
   * The routing heuristic uses a tiny keyword match against the board's scope;
   * it intentionally errs toward `accept` so most missions flow through.
   */
  async receiveDelegation(env: BoardDelegation): Promise<BoardAck> {
    return tracer.startActiveSpan(
      `skippy.board.${this.boardId}.handle_delegation`,
      {
        attributes: {
          'skippy.board.id': this.boardId,
          'skippy.delegation.id': env.delegationId,
          'skippy.delegation.from': env.fromAgentId,
          'skippy.delegation.brief_len': env.missionBrief.length,
        },
      },
      async (span): Promise<BoardAck> => {
        try {
          // Serialize: one mission per board at a time. A delegation arriving
          // while a prior one is still executing is declined — we do NOT flip
          // to `working` or touch `busy`, so the in-flight mission's state is
          // untouched and `markReady()` stays truthful (review §6).
          if (this.busy) {
            span.setAttribute('skippy.delegation.decision', 'decline');
            span.setAttribute('skippy.board.busy', true);
            span.setStatus({ code: SpanStatusCode.OK });
            return {
              delegationId: env.delegationId,
              boardId: this.boardId,
              decision: 'decline',
              counterText: `Board ${this.boardId} is busy with another mission; re-delegate once it reports complete.`,
            };
          }

          const decision = this.decideDelegation(env);
          span.setAttribute('skippy.delegation.decision', decision);

          // Only an accepted mission claims the board and flips it to `working`.
          // Decline/counter leave the board exactly where it was (ready).
          if (decision !== 'accept') {
            return decision === 'counter_propose'
              ? {
                  delegationId: env.delegationId,
                  boardId: this.boardId,
                  decision,
                  counterText: `Board ${this.boardId} suggests routing to a sibling captain — mission keywords look out-of-scope.`,
                }
              : {
                  delegationId: env.delegationId,
                  boardId: this.boardId,
                  decision,
                };
          }

          // Claim the board for this mission BEFORE returning the ack, so a
          // concurrent delegation that arrives before the microtask runs sees
          // `busy` and is declined.
          this.busy = true;
          this.phase = 'working';
          writeEnvelope({
            type: 'board_state',
            boardId: this.boardId,
            agentId: this.agentId,
            state: 'working',
            currentTaskId: env.delegationId,
            ts: new Date().toISOString(),
          });
          this.history.push({
            role: 'user',
            content: `Skippy delegates: ${env.missionBrief}`,
          });

          // Fire-and-forget the completion emission; do not await it on the
          // ack path. Supervisor / Skippy continue without blocking. The
          // completion path is itself exhaustively guarded (it always emits a
          // `delegation_complete` and always clears `busy` via `markReady`), so
          // this `.catch` is a belt-and-suspenders backstop only.
          queueMicrotask(() => {
            void this.emitDelegationComplete(env).catch((e: unknown) => {
              logger.warn({ msg: 'emitDelegationComplete failed', boardId: this.boardId, err: String(e) });
              this.failDelegation(env, `internal error: ${String(e)}`);
            });
          });

          span.setStatus({ code: SpanStatusCode.OK });
          return {
            delegationId: env.delegationId,
            boardId: this.boardId,
            decision,
          };
        } catch (err) {
          span.recordException(err as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw err;
        } finally {
          span.end();
        }
      },
    );
  }

  /** Phase 1 heuristic: keyword-match against the board name + a small
   * scope vocabulary. Always-accept is a defensible default; we still
   * surface the heuristic so Phase 2 can swap it for a real triage call. */
  private decideDelegation(env: BoardDelegation): DelegationDecision {
    const brief = env.missionBrief.toLowerCase();
    const scope = SCOPE_KEYWORDS[this.boardId];
    const matches = scope.some((kw) => brief.includes(kw));
    // If brief contains a *sibling* board name as a stronger match, decline.
    // Otherwise accept. This is intentionally conservative — false negatives
    // surface as counter_propose, false positives are absorbed by the
    // supervisor's reassignment policy in Phase 2.
    if (!matches) {
      const siblingHits = Object.entries(SCOPE_KEYWORDS).filter(
        ([id, kws]) => id !== this.boardId && kws.some((kw) => brief.includes(kw)),
      );
      if (siblingHits.length > 0) return 'counter_propose';
    }
    return 'accept';
  }

  /**
   * Emit the delegation outcome, propagating the REAL success/failure of the
   * run (review §6, board.ts:305/309). Two modes:
   *
   *   - Gate off (default): the Phase-1 stub acknowledgement. The stub does no
   *     work and cannot fail, so it legitimately reports `result:'success'`.
   *   - Gate on (PHASE3_AGENTS_ENABLED=1 + API key): the board executes the
   *     mission via the Claude Agent SDK. If the SDK run fails (no key, SDK
   *     error, empty result, or a thrown exception anywhere in this path) we
   *     emit `result:'failure'` — never a fake `'success'` — so the renderer's
   *     failure arm is reachable and the delegation can be retried.
   *
   * This method ALWAYS emits exactly one `delegation_complete` and ALWAYS
   * returns the board to `ready` (clearing `busy`), including when the SDK call
   * throws — the `try/catch` guarantees no path exits without an envelope, so
   * the UI never hangs on a half-finished delegation.
   */
  private async emitDelegationComplete(env: BoardDelegation): Promise<void> {
    // Resolve the real outcome first, THEN emit exactly once. Keeping the emit
    // out of the try/catch guarantees a single `delegation_complete` per call:
    // a failure inside the work can't race a success emit, and `writeEnvelope`
    // is never re-entered from a catch arm.
    const { result, summary } = await this.runDelegation(env);
    this.emitCompletion(env, result, summary);
  }

  /**
   * Run the mission and return its real outcome. Never throws: any failure
   * (no API key, SDK error, empty result, or a thrown exception while building
   * MCP servers / resolving the vault root) is captured as a `'failure'` tuple
   * so `emitDelegationComplete` can always emit a completion envelope and free
   * the board — the renderer's failure arm stays reachable and the UI can't hang.
   */
  private async runDelegation(
    env: BoardDelegation,
  ): Promise<{ result: 'success' | 'failure'; summary: string }> {
    if (!sdkBoardsEnabled()) {
      // Stub path: an acknowledgement, not real work. Genuinely succeeds.
      return {
        result: 'success',
        summary: `Board ${this.boardId} acknowledges and is queuing this mission. (Stub — set PHASE3_AGENTS_ENABLED=1 for real SDK execution.)`,
      };
    }

    try {
      // Build this board's MCP servers (obsidian/letta) from its charter, so the
      // real agent can do surgical vault edits, semantic search, and archival
      // memory. Only happens on the gated path — never when the flag is off.
      const vaultRoot = resolveVaultRoot();
      const mcpServers = await buildMcpServers(this.charter, vaultRoot);
      // Honor the charter's permission_mode / tools / disallowed_tools (PRD §6.1)
      // instead of the old hardcoded bypassPermissions.
      const permissions = charterPermissions(this.charter);
      const sdk = await executeBoardMissionViaSdk({
        boardId: this.boardId,
        systemPrompt: this.charter.body,
        model: getModelFor(this.agentId),
        missionBrief: env.missionBrief,
        mcpServers,
        permissions,
      });

      if (sdk.ok) {
        return { result: 'success', summary: sdk.summary };
      }
      // The SDK could not complete the mission. Report the real failure so the
      // wire contract's failure arm is exercised (do NOT dress it up as a
      // success). `sdk.summary` carries the error note from sdk-board.ts.
      logger.warn({ msg: 'delegation failed', boardId: this.boardId, delegationId: env.delegationId, err: sdk.summary });
      return {
        result: 'failure',
        summary: `Board ${this.boardId}: real execution failed. ${sdk.summary}`.trim(),
      };
    } catch (err) {
      logger.warn({ msg: 'delegation errored', boardId: this.boardId, delegationId: env.delegationId, err: String(err) });
      return {
        result: 'failure',
        summary: `Board ${this.boardId}: delegation errored. ${String(err)}`,
      };
    }
  }

  /** Emit a `delegation_complete` with the given result, then return to ready.
   * Single choke point so every completion path is symmetric and always frees
   * the board (clears `busy`). */
  private emitCompletion(
    env: BoardDelegation,
    result: 'success' | 'failure',
    summary: string,
  ): void {
    writeEnvelope({
      type: 'delegation_complete',
      delegationId: env.delegationId,
      fromBoardId: this.boardId,
      result,
      summary,
      ts: new Date().toISOString(),
    });
    this.markReady();
  }

  /** Emit a failing `delegation_complete` (and free the board). Backstop for
   * the `.catch` in `receiveDelegation` — used only if the completion path
   * itself rejects — so a failed mission can never hang the UI or leave the
   * board stuck `busy`. */
  private failDelegation(env: BoardDelegation, summary: string): void {
    logger.warn({ msg: 'delegation failed (backstop)', boardId: this.boardId, delegationId: env.delegationId, summary });
    this.emitCompletion(env, 'failure', summary);
  }

  private markReady(): void {
    // A completion that lands AFTER shutdown must not resurrect the board: flipping
    // phase back to 'ready' and emitting board_state:'ready' would contradict the
    // shutdown and leave a zombie pedestal in the UI. Once shut down, stay down
    // (still clear busy so internal bookkeeping is consistent).
    if (this.phase === 'shutdown') {
      this.busy = false;
      return;
    }
    this.busy = false;
    this.phase = 'ready';
    writeEnvelope({
      type: 'board_state',
      boardId: this.boardId,
      agentId: this.agentId,
      state: 'ready',
      ts: new Date().toISOString(),
    });
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async shutdown(): Promise<void> {
    if (this.phase === 'shutdown') return;
    this.phase = 'shutdown';
    writeEnvelope({
      type: 'board_state',
      boardId: this.boardId,
      agentId: this.agentId,
      state: 'shutdown',
      ts: new Date().toISOString(),
    });
    logger.debug({ msg: 'board shutdown', boardId: this.boardId });
  }

  /** Snapshot for diagnostics / supervisor introspection. */
  inspect(): { boardId: BoardId; phase: Phase; historyLen: number; loaded: boolean } {
    return {
      boardId: this.boardId,
      phase: this.phase,
      historyLen: this.history.length,
      loaded: this.charter.loaded,
    };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Scope keywords (Phase 1 routing heuristic). Loose, on purpose.
// ──────────────────────────────────────────────────────────────────────────────

const SCOPE_KEYWORDS: Record<BoardId, string[]> = {
  engineering: ['architecture', 'system', 'design pattern', 'refactor', 'physics', 'aerospace', 'fusion', 'simulation', 'optimization'],
  coding: ['implement', 'code', 'fix', 'debug', 'test', 'review', 'function', 'class', 'module', 'pull request', 'pr'],
  design: ['ui', 'ux', 'visual', 'mockup', 'figma', 'sprite', 'palette', 'layout', 'wireframe'],
  marketing: ['marketing', 'social', 'post', 'tweet', 'campaign', 'brand', 'audience', 'launch'],
  finance: ['cost', 'budget', 'invoice', 'trading', 'portfolio', 'macro', 'algo', 'ledger'],
  research: ['research', 'paper', 'arxiv', 'survey', 'literature', 'distill', 'summarize'],
  publishing: ['publish', 'readme', 'blog', 'newsletter', 'documentation', 'docs', 'changelog', 'post'],
  devops: ['ci', 'cd', 'deploy', 'release', 'pipeline', 'docker', 'package', 'build', 'tauri'],
};
