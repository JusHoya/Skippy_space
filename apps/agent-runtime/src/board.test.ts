// board.test.ts — delegation lifecycle: real success/failure propagation,
// guaranteed completion envelope on the failure arm, and one-mission-at-a-time
// serialization (review §6, board.ts:196/305/309).
//
// These run with the SDK gate OFF (PHASE3_AGENTS_ENABLED unset), so no API key
// or network is needed — the board takes the stub path. The serialization and
// envelope-emission contracts are gate-independent, which is exactly what we
// want to lock in.
//
// Run: node --import tsx --test src/board.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Board, type BoardDelegation } from './board.js';
import type { Charter } from './charter.js';

// ──────────────────────────────────────────────────────────────────────────────
// Test harness: capture every envelope the board writes to stdout.
// ──────────────────────────────────────────────────────────────────────────────

interface CapturedEnvelope {
  type: string;
  [k: string]: unknown;
}

/** Swap process.stdout.write for a capturing sink for the duration of `fn`,
 * returning the parsed JSONL envelopes the board emitted. */
async function captureEnvelopes(fn: () => Promise<void>): Promise<CapturedEnvelope[]> {
  const out: CapturedEnvelope[] = [];
  const original = process.stdout.write.bind(process.stdout);
  // protocol.ts writes `JSON.stringify(env) + '\n'` per envelope.
  (process.stdout as { write: unknown }).write = ((chunk: unknown): boolean => {
    const text = typeof chunk === 'string' ? chunk : String(chunk);
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed) as CapturedEnvelope);
      } catch {
        // Non-JSON line (shouldn't happen on this path) — ignore.
      }
    }
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    (process.stdout as { write: typeof original }).write = original;
  }
  return out;
}

/** Let queued microtasks (the fire-and-forget completion emission) drain. */
async function flushMicrotasks(): Promise<void> {
  // emitDelegationComplete is scheduled via queueMicrotask; a couple of awaits
  // on resolved promises is enough to drain it on the stub path.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function fakeCharter(boardId: 'engineering' | 'coding'): Charter {
  return {
    agentId: `board.${boardId}`,
    frontmatter: {},
    // warmUp() requires a body of at least 16 chars.
    body: `You are the ${boardId} board captain. Do the work.`,
    loaded: true,
    path: `/fake/${boardId}.md`,
  };
}

function delegation(id: string, brief: string): BoardDelegation {
  return { delegationId: id, missionBrief: brief, fromAgentId: 'skippy' };
}

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

test('accepted delegation emits a delegation_complete and returns to ready (stub path)', async () => {
  const board = new Board('engineering', fakeCharter('engineering'));
  await board.start();

  let ack: { decision: string } | undefined;
  const envs = await captureEnvelopes(async () => {
    ack = await board.receiveDelegation(delegation('d1', 'refactor the simulation architecture'));
    await flushMicrotasks();
  });

  assert.equal(ack?.decision, 'accept');

  const complete = envs.find((e) => e.type === 'delegation_complete');
  assert.ok(complete, 'a delegation_complete envelope must be emitted');
  assert.equal(complete.delegationId, 'd1');
  assert.equal(complete.fromBoardId, 'engineering');
  // The stub does no real work and cannot fail.
  assert.equal(complete.result, 'success');

  // Board must drop back to ready (the LAST board_state for it is 'ready').
  const states = envs.filter((e) => e.type === 'board_state');
  assert.equal(states.at(-1)?.state, 'ready');
  assert.equal(board.inspect().phase, 'ready');
});

test('FAILURE ARM: a failed mission still emits a delegation_complete with result:"failure"', async () => {
  // Drive the completion path's failure handling directly: the private
  // `runDelegation` is replaced so the gate-on branch resolves a failure tuple
  // exactly as a dead SDK run would. This exercises the renderer-reachable
  // failure arm without needing an API key.
  const board = new Board('coding', fakeCharter('coding'));
  await board.start();

  (board as unknown as { runDelegation: (env: BoardDelegation) => Promise<unknown> }).runDelegation =
    async () => ({ result: 'failure', summary: 'Board coding: real execution failed. SDK board execution failed: boom' });

  const envs = await captureEnvelopes(async () => {
    const ack = await board.receiveDelegation(delegation('d2', 'implement and test the new module'));
    assert.equal(ack.decision, 'accept');
    await flushMicrotasks();
  });

  const complete = envs.find((e) => e.type === 'delegation_complete');
  assert.ok(complete, 'failed missions must still emit a completion envelope');
  assert.equal(complete.result, 'failure', 'the failure arm must report result:"failure", never a fake success');
  assert.match(String(complete.summary), /failed/i);

  // Even on failure the board frees itself.
  assert.equal(board.inspect().phase, 'ready');
});

test('A THROW in the completion path still emits a failure completion (UI never hangs)', async () => {
  const board = new Board('coding', fakeCharter('coding'));
  await board.start();

  // runDelegation never throws by contract, but the receiveDelegation .catch
  // backstop must still convert a rejection into a failure envelope.
  (board as unknown as { runDelegation: (env: BoardDelegation) => Promise<unknown> }).runDelegation =
    async () => {
      throw new Error('kaboom in completion path');
    };

  const envs = await captureEnvelopes(async () => {
    await board.receiveDelegation(delegation('d3', 'fix the failing test'));
    await flushMicrotasks();
  });

  const complete = envs.find((e) => e.type === 'delegation_complete');
  assert.ok(complete, 'even a thrown error must produce a completion envelope');
  assert.equal(complete.result, 'failure');
  assert.equal(board.inspect().phase, 'ready');
});

test('SERIALIZE: a second delegation while busy is declined, not silently accepted', async () => {
  const board = new Board('engineering', fakeCharter('engineering'));
  await board.start();

  // Hold the first mission open: replace runDelegation with one that resolves
  // only when we release it, so the board stays busy across the second call.
  let release: () => void = () => {};
  const held = new Promise<{ result: 'success'; summary: string }>((resolve) => {
    release = () => resolve({ result: 'success', summary: 'done' });
  });
  (board as unknown as { runDelegation: (env: BoardDelegation) => Promise<unknown> }).runDelegation =
    async () => held;

  const first = await board.receiveDelegation(delegation('d4', 'optimize the fusion model'));
  assert.equal(first.decision, 'accept');
  assert.equal(board.inspect().phase, 'working');

  // Second delegation arrives mid-flight — must be declined, board stays working.
  const second = await board.receiveDelegation(delegation('d5', 'optimize the fusion model again'));
  assert.equal(second.decision, 'decline', 'a busy board must decline, not accept a concurrent mission');
  assert.match(String(second.counterText), /busy/i);
  assert.equal(board.inspect().phase, 'working', 'markReady must not fire while the first mission is in flight');

  // Release the first mission; board frees and accepts again.
  release();
  await flushMicrotasks();
  assert.equal(board.inspect().phase, 'ready');

  const third = await board.receiveDelegation(delegation('d6', 'refactor the simulation architecture'));
  assert.equal(third.decision, 'accept', 'a freed board accepts the next mission');
});
