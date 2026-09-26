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

import {
  BOARD_META,
  deriveTaskOutcome,
  nonSuccessRecord,
  type BoardId,
  type DelegationCompleteEnvelope,
  type ExecutionMode,
  type ExecutorTerminal,
  type TerminalRecord,
} from '@skippy/shared';

import type { Charter } from './charter.js';
import { resolveExecutionGate, type ExecutionGate } from './execution-gate.js';
import { logger } from './logger.js';
import { buildMcpServers } from './mcp-registry.js';
import { getModelFor } from './modelRegistry.js';
import { writeEnvelope } from './protocol.js';
import { executeBoardMissionViaSdk } from './sdk-board.js';
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

/** Output of `receiveDelegation` — the triage decision only. An `accept` means
 * the work is *accepted*, never completed (FR-RUN-01); the supervisor then
 * calls `runAcceptedDelegation`, which awaits a terminal result and emits the
 * single `delegation_complete` record. */
export interface BoardAck {
  delegationId: string;
  boardId: BoardId;
  decision: DelegationDecision;
  counterText?: string;
  /** For an accept: how the work is expected to execute (advisory; the gate
   * is re-evaluated authoritatively when execution starts). */
  execution?: ExecutionGate;
}

/** Lifecycle of a Board, used internally and mirrored to renderer via
 * `board_state` envelopes. */
type Phase = 'spawning' | 'ready' | 'working' | 'shutdown' | 'errored';

/** Live executor for an accepted mission; returns only after a terminal result. */
export type BoardExecutor = (req: {
  boardId: BoardId;
  charter: Charter;
  missionBrief: string;
}) => Promise<ExecutorTerminal>;

/** Injectable collaborators (tests supply fakes; production uses defaults). */
export interface BoardDeps {
  /** Decide demo / live / blocked. Defaults to `resolveExecutionGate()`. */
  gate?: () => ExecutionGate;
  /** Live executor. Defaults to the Claude Agent SDK path (`sdk-board.ts`). */
  executeLive?: BoardExecutor;
}

/** Production live executor: charter-scoped MCP servers + Claude Agent SDK. */
const sdkExecutor: BoardExecutor = async ({ boardId, charter, missionBrief }) => {
  // Build this board's MCP servers (obsidian/letta) from its charter, so the
  // real agent can do surgical vault edits, semantic search, and archival
  // memory. Only happens on the live path — never when the gate is closed.
  const vaultRoot = resolveVaultRoot();
  const mcpServers = await buildMcpServers(charter, vaultRoot);
  return executeBoardMissionViaSdk({
    boardId,
    systemPrompt: charter.body,
    model: getModelFor(`board.${boardId}`),
    missionBrief,
    mcpServers,
    // The tool policy is derived from this same charter (T02).
    charter,
  });
};

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

  private readonly gate: () => ExecutionGate;
  private readonly executeLive: BoardExecutor;

  /** Accepted delegations without a terminal record yet (id -> mode). A
   * delegation leaves this map exactly once, when its terminal record is
   * emitted; late executor results for an already-terminal id are dropped. */
  private readonly inflight = new Map<string, ExecutionMode>();

  constructor(boardId: BoardId, charter: Charter, deps: BoardDeps = {}) {
    this.boardId = boardId;
    this.agentId = `board.${boardId}`;
    this.charter = charter;
    this.gate = deps.gate ?? (() => resolveExecutionGate());
    this.executeLive = deps.executeLive ?? sdkExecutor;
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
   * Handle one delegation envelope. PRD §5.2: return the ack
   * (accept | decline | counter_propose). An `accept` only means *accepted*;
   * execution starts when the supervisor calls `runAcceptedDelegation` after
   * the ack is on the wire, so the ack always precedes the terminal record.
   *
   * For Phase 1 the policy is intentionally simple:
   *   - obvious-wrong-board heuristic -> counter_propose.
   *   - otherwise -> accept.
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
              : decision === 'accept'
                ? {
                    delegationId: env.delegationId,
                    boardId: this.boardId,
                    decision,
                    execution: this.gate(),
                  }
                : {
                    delegationId: env.delegationId,
                    boardId: this.boardId,
                    decision,
                  };

          span.setAttribute('skippy.delegation.decision', decision);

          if (decision !== 'accept') {
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

  /**
   * Execute an accepted delegation and emit its single terminal
   * `delegation_complete` record (PRD v0.2 FR-RUN-01). Resolves with the
   * emitted envelope once the terminal result has been awaited (null if the
   * delegation was already terminal, e.g. interrupted); never rejects.
   *
   *   gate demo    → `simulated` (explicit SKIPPY_DEMO_MODE=1; no work done)
   *   gate blocked → `blocked`   (execution disabled / missing credentials)
   *   gate live    → `delegation_state: running`, await the executor, then
   *                  `deriveTaskOutcome` — the only path to `succeeded`.
   *   any throw    → `failed` (runtime_error).
   */
  async runAcceptedDelegation(env: BoardDelegation): Promise<DelegationCompleteEnvelope | null> {
    return tracer.startActiveSpan(
      `skippy.board.${this.boardId}.execute_delegation`,
      {
        attributes: {
          'skippy.board.id': this.boardId,
          'skippy.delegation.id': env.delegationId,
        },
      },
      async (span) => {
        let mode: ExecutionMode = 'live';
        let record: TerminalRecord;
        // Register before anything can throw so every accepted delegation is
        // guaranteed exactly one terminal record.
        this.inflight.set(env.delegationId, mode);
        try {
          const gate = this.gate();
          mode = gate.kind === 'demo' ? 'demo' : 'live';
          span.setAttribute('skippy.execution.gate', gate.kind);
          this.inflight.set(env.delegationId, mode);

          if (gate.kind === 'demo') {
            record = nonSuccessRecord(
              'simulated',
              'demo',
              {
                code: 'demo_mode',
                message: 'SKIPPY_DEMO_MODE=1: labelled simulation; no work was performed.',
              },
              `SIMULATED (demo mode) — Board ${this.boardId} did not execute this mission. No work was performed.`,
            );
          } else if (gate.kind === 'blocked') {
            record = nonSuccessRecord(
              'blocked',
              'live',
              gate.reason,
              `Board ${this.boardId} did not execute this mission: ${gate.reason.message}`,
            );
          } else {
            writeEnvelope({
              type: 'delegation_state',
              delegationId: env.delegationId,
              fromBoardId: this.boardId,
              state: 'running',
              mode: 'live',
              ts: new Date().toISOString(),
            });
            const terminal = await this.executeLive({
              boardId: this.boardId,
              charter: this.charter,
              missionBrief: env.missionBrief,
            });
            // No acceptance criteria exist yet (pre-M1), so the validation
            // disposition is `not_defined`; see PRD OQ-13.
            record = deriveTaskOutcome(terminal, 'not_defined');
          }
        } catch (err) {
          span.recordException(err as Error);
          record = nonSuccessRecord('failed', mode, {
            code: 'runtime_error',
            message: `Board ${this.boardId} runtime error before a terminal result.`,
            detail: String(err),
          });
        }

        span.setAttribute('skippy.delegation.outcome', record.outcome);
        if (record.outcome === 'failed' || record.outcome === 'blocked') {
          span.setStatus({ code: SpanStatusCode.ERROR, message: record.reason?.code ?? record.outcome });
        } else if (record.outcome === 'succeeded') {
          span.setStatus({ code: SpanStatusCode.OK });
        }
        const emitted = this.emitTerminal(env.delegationId, record);
        span.end();
        return emitted;
      },
    );
  }

  /** Emit the terminal record once per delegation. Returns null (and emits
   * nothing) if the delegation already reached a terminal state, e.g. it was
   * interrupted by shutdown before a late executor result arrived. */
  private emitTerminal(delegationId: string, record: TerminalRecord): DelegationCompleteEnvelope | null {
    if (!this.inflight.has(delegationId)) {
      logger.warn({
        msg: 'late terminal result dropped; delegation already terminal',
        boardId: this.boardId,
        delegationId,
        outcome: record.outcome,
      });
      return null;
    }
    this.inflight.delete(delegationId);
    const envelope: DelegationCompleteEnvelope = {
      type: 'delegation_complete',
      delegationId,
      fromBoardId: this.boardId,
      ...record,
      ts: new Date().toISOString(),
    };
    writeEnvelope(envelope);
    this.history.push({ role: 'assistant', content: `[${record.outcome}] ${record.summary}` });
    if (this.phase !== 'shutdown') this.markReady();
    return envelope;
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
    // Accepted work that has not reached a terminal state is interrupted, not
    // silently abandoned (FR-RUN-06). Late executor results are then dropped.
    for (const [delegationId, mode] of Array.from(this.inflight)) {
      this.emitTerminal(
        delegationId,
        nonSuccessRecord('interrupted', mode, {
          code: 'shutdown',
          message: `Board ${this.boardId} shut down before the delegation reached a terminal result.`,
        }),
      );
    }
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
  inspect(): { boardId: BoardId; phase: Phase; historyLen: number; loaded: boolean; inflight: number } {
    return {
      boardId: this.boardId,
      phase: this.phase,
      historyLen: this.history.length,
      loaded: this.charter.loaded,
      inflight: this.inflight.size,
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
