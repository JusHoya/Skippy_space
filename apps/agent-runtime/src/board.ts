// board.ts — one logical Board Captain process.
//
// PRD §5.1 says "each board agent as its own root query() process" — at the
// SDK level, that means a Claude Agent SDK `query()` per board, isolated
// contexts, distinct system prompts, distinct memory bindings. For Phase 1 we
// run each board as an in-process logical session rather than an OS-level
// child process for three reasons:
//
//   1. The Claude Agent SDK npm package (`@anthropic-ai/claude-agent-sdk`) is
//      not yet in `apps/agent-runtime/package.json` (only `@anthropic-ai/sdk`
//      is). Spawning a query() per board would require either landing that
//      dep or reimplementing the query loop. Both are >Phase-1 scope.
//   2. PRD R-01 calls out the 12s SDK cold-start; OS-process-per-board would
//      multiply that 8× on boot. In-process boards warm in parallel almost
//      instantly because they only need to load a charter and register a
//      session id — no second `node` process to spin up.
//   3. The PRD's "process" language is about *logical* isolation (one query()
//      context per board, distinct conversation state, no token bleed between
//      boards). An in-process Board class achieves that contract trivially:
//      each Board holds its own `messages: []` history and its own system
//      prompt, and the supervisor never crosses the streams.
//
// In Phase 2+ we expect to migrate to one of:
//   (a) `claude-agent-sdk` `query()` per board, still in this process.
//   (b) `worker_threads.Worker` per board if we need true thread isolation.
//   (c) child Node processes per board only if (a) and (b) are insufficient.
//
// Until then, the public surface (`receiveDelegation`, `start`, `shutdown`,
// OTel span names) stays stable so the migration is a constructor swap.

import { SpanStatusCode, trace } from '@opentelemetry/api';

import { BOARD_META, type BoardId } from '@skippy/shared';

import type { Charter } from './charter.js';
import { logger } from './logger.js';
import { writeEnvelope } from './protocol.js';

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
   * `delegation_complete` envelope once the (stubbed) work is done.
   *
   * For Phase 1 the policy is intentionally simple:
   *   - obvious-wrong-board heuristic -> decline.
   *   - otherwise -> accept + emit a delegation_complete with a stub summary.
   *
   * The heuristic uses a tiny keyword match against the board's scope; it
   * intentionally errs toward `accept` so most missions flow through (the
   * acceptance criterion only requires "Skippy can call delegate_to_board and
   * receive an ack").
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

          const decision = this.decideDelegation(env);
          const ack: BoardAck =
            decision === 'counter_propose'
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

          span.setAttribute('skippy.delegation.decision', decision);

          // Fire-and-forget the completion emission; do not await it on the
          // ack path. Supervisor / Skippy continue without blocking.
          if (decision === 'accept') {
            queueMicrotask(() => {
              this.emitDelegationComplete(env);
            });
          } else {
            // Drop back to ready immediately on decline/counter.
            queueMicrotask(() => {
              this.markReady();
            });
          }

          span.setStatus({ code: SpanStatusCode.OK });
          return ack;
        } catch (err) {
          span.recordException(err as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          this.markReady();
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

  private emitDelegationComplete(env: BoardDelegation): void {
    writeEnvelope({
      type: 'delegation_complete',
      delegationId: env.delegationId,
      fromBoardId: this.boardId,
      result: 'success',
      summary: `Board ${this.boardId} acknowledges and is queuing this mission. Concrete task spawn is Phase 2.`,
      ts: new Date().toISOString(),
    });
    this.markReady();
  }

  private markReady(): void {
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
