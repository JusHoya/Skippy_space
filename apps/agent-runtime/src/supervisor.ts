// supervisor.ts — owns the eight Board Captains.
//
// PRD §5.1 specifies a Skippy ↔ 8 Boards topology. PRD R-01 specifies "warm
// pool of 2–3 pre-initialized SDK contexts" to avoid the 12s SDK cold-start;
// for the boards specifically, we mitigate by spawning all 8 *concurrently*
// at sidecar startup. Sequential start would block sidecar boot by up to
// 8 × cold-start; concurrent start collapses that to ~1 × cold-start in the
// best case. We use `Promise.allSettled` so one board failing to load its
// charter does not block the other seven.
//
// The supervisor exposes a `delegate(...)` method that the `delegate_to_board`
// MCP tool calls into — see `mcp-delegate.ts`. The supervisor is the single
// owner of the boards Map; nothing else should touch a Board instance
// directly.

import { trace } from '@opentelemetry/api';
import { ulid } from 'ulid';

import { BOARDS, type BoardId } from '@skippy/shared';

import { Board, type BoardAck, type BoardDelegation } from './board.js';
import { loadCharter } from './charter.js';
import { logger } from './logger.js';
import { writeEnvelope } from './protocol.js';

const tracer = trace.getTracer('skippy-supervisor');

/** Result returned to Skippy by `supervisor.delegate(...)`. Mirrors the
 * on-wire `DelegationAckEnvelope` but is a plain object so the MCP tool
 * handler can return it directly as a tool result. */
export interface SupervisorAck {
  delegationId: string;
  toBoardId: BoardId;
  decision: 'accept' | 'decline' | 'counter_propose';
  counterText?: string;
}

export class BoardSupervisor {
  private readonly boards = new Map<BoardId, Board>();
  private started = false;

  /**
   * Load all eight charters in parallel, spawn all eight Boards in parallel.
   * Failures are logged but do not block the supervisor — the user can still
   * delegate to the boards that succeeded. The boot returns when *every*
   * settle has resolved (success or failure), so the caller knows whether
   * to update the UI's board roster.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    await tracer.startActiveSpan('skippy.supervisor.start', async (span) => {
      const results = await Promise.allSettled(
        BOARDS.map(async (id) => {
          const charter = await loadCharter(`board.${id}`);
          const board = new Board(id, charter);
          await board.start();
          this.boards.set(id, board);
          return id;
        }),
      );
      const ok = results.filter((r) => r.status === 'fulfilled').length;
      const fail = results.length - ok;
      logger.info({ msg: 'supervisor start complete', ok, fail });
      span.setAttribute('skippy.supervisor.boards_ok', ok);
      span.setAttribute('skippy.supervisor.boards_fail', fail);
      if (fail > 0) {
        for (const r of results) {
          if (r.status === 'rejected') {
            logger.warn({ msg: 'board failed to start', err: String(r.reason) });
            writeEnvelope({
              type: 'log',
              level: 'warn',
              source: 'agent-runtime',
              message: `Board start failure: ${String(r.reason)}`,
              ts: new Date().toISOString(),
            });
          }
        }
      }
      span.end();
    });
  }

  /**
   * Skippy's `delegate_to_board` lands here. Emits a `delegation` envelope to
   * the renderer, hands the brief to the target board, awaits the ack, and
   * returns it. The `delegation_complete` envelope is emitted by the Board
   * after the ack returns; we do not block on it.
   */
  async delegate(
    toBoardId: BoardId,
    missionBrief: string,
    constraints?: string[],
    deadline?: string,
  ): Promise<SupervisorAck> {
    const delegationId = ulid();
    return tracer.startActiveSpan(
      'skippy.supervisor.delegate',
      {
        attributes: {
          'skippy.supervisor.to_board': toBoardId,
          'skippy.supervisor.delegation_id': delegationId,
        },
      },
      async (span): Promise<SupervisorAck> => {
        try {
          const board = this.boards.get(toBoardId);
          if (!board) {
            // The supervisor was asked for a board that didn't start. We
            // synthesize a decline so Skippy's loop can carry on gracefully.
            writeEnvelope({
              type: 'log',
              level: 'warn',
              source: 'skippy.supervisor',
              message: `delegate_to_board called for unknown/down board: ${toBoardId}`,
              ts: new Date().toISOString(),
            });
            const ack: SupervisorAck = {
              delegationId,
              toBoardId,
              decision: 'decline',
              counterText: `Board ${toBoardId} is not online. Retry after the board reports board_ready, or pick a sibling.`,
            };
            return ack;
          }

          // 1. Announce the delegation on the wire so the renderer can light
          //    up the throne -> hex-pad path arrow.
          const delegationEnv = {
            type: 'delegation' as const,
            delegationId,
            fromAgentId: 'skippy' as const,
            toBoardId,
            missionBrief,
            ...(constraints && constraints.length > 0 ? { constraints } : {}),
            ...(deadline ? { deadline } : {}),
            ts: new Date().toISOString(),
          };
          writeEnvelope(delegationEnv);

          // 2. Hand the brief to the board and await its ack.
          const delegation: BoardDelegation = {
            delegationId,
            missionBrief,
            fromAgentId: 'skippy',
            ...(constraints ? { constraints } : {}),
            ...(deadline ? { deadline } : {}),
          };
          const ack: BoardAck = await board.receiveDelegation(delegation);

          // 3. Mirror the ack on the wire.
          writeEnvelope({
            type: 'delegation_ack',
            delegationId: ack.delegationId,
            fromBoardId: ack.boardId,
            decision: ack.decision,
            ...(ack.counterText ? { counterText: ack.counterText } : {}),
            ts: new Date().toISOString(),
          });

          span.setAttribute('skippy.supervisor.decision', ack.decision);

          const result: SupervisorAck = {
            delegationId: ack.delegationId,
            toBoardId: ack.boardId,
            decision: ack.decision,
            ...(ack.counterText ? { counterText: ack.counterText } : {}),
          };
          return result;
        } finally {
          span.end();
        }
      },
    );
  }

  /** Snapshot of all boards — used by health-check / debug envelopes. */
  inspect(): Array<ReturnType<Board['inspect']>> {
    return Array.from(this.boards.values()).map((b) => b.inspect());
  }

  /** Drain all boards on shutdown. We do not await an arbitrary in-flight
   * task — Phase 2 will add a graceful drain window. */
  async shutdown(): Promise<void> {
    await Promise.allSettled(
      Array.from(this.boards.values()).map((b) => b.shutdown()),
    );
    this.boards.clear();
  }
}

let _instance: BoardSupervisor | null = null;

/** Process-wide singleton accessor. The MCP tool handler and the
 * `index.ts` lifecycle both need to reach the same supervisor. */
export function getSupervisor(): BoardSupervisor {
  if (!_instance) _instance = new BoardSupervisor();
  return _instance;
}

/** Test-only / shutdown helper. */
export function resetSupervisor(): void {
  _instance = null;
}
