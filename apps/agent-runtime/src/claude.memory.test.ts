// claude.memory.test.ts — lock-in test for Skippy's conversation memory.
//
// Proves the fix for the "amnesiac follow-up" bug (PRD §5.2): the per-session
// conversation tail accumulates user + assistant turns ACROSS calls, so a
// second prompt reaches the model with the first turn still in its input.
//
// We inject a fake Anthropic-shaped client (just `messages.stream`) via the
// test seam in claude.ts, capture the `messages` array handed to each
// `stream()` call, and assert the second call's input contains the first
// exchange. No live API key / network required.
//
// Run: node --import tsx --test src/claude.memory.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type Anthropic from '@anthropic-ai/sdk';

import { streamSkippyWithTools, __setClientForTest } from './claude.js';

// A MessageStream stand-in: async-iterable over deltas + finalMessage().
function fakeStream(text: string, model = 'claude-opus-4-7') {
  const finalMessage: Anthropic.Messages.Message = {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 20 },
  };
  return {
    async *[Symbol.asyncIterator]() {
      yield {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text },
      } as Anthropic.Messages.RawMessageStreamEvent;
    },
    async finalMessage() {
      return finalMessage;
    },
  };
}

/** Build a fake client that records every `messages.stream` call's params. */
function recordingClient(replies: string[]) {
  const calls: Anthropic.Messages.MessageParam[][] = [];
  let i = 0;
  const fake = {
    messages: {
      stream(params: { messages: Anthropic.Messages.MessageParam[] }) {
        // Snapshot (deep) the messages as the SDK would see them at call time,
        // before the generator mutates the array further.
        calls.push(JSON.parse(JSON.stringify(params.messages)));
        const reply = replies[i] ?? replies[replies.length - 1] ?? '';
        i += 1;
        return fakeStream(reply);
      },
    },
  } as unknown as Anthropic;
  return { fake, calls };
}

async function drain(gen: AsyncGenerator<unknown>): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _ of gen) {
    /* consume */
  }
}

test('sequential prompts: second model call includes the first turn (conversation memory)', async () => {
  const { fake, calls } = recordingClient([
    'Fine, monkey. The Engineering board is on it.',
    'Engineering reported the build is green, you magnificent primate.',
  ]);
  __setClientForTest(fake);

  // The caller (skippy.ts) owns a persistent tail. Simulate that here.
  const tail: Anthropic.Messages.MessageParam[] = [];

  try {
    // Prompt 1.
    tail.push({ role: 'user', content: 'Delegate the build to Engineering.' });
    await drain(streamSkippyWithTools('SYSTEM', tail));

    // After the first turn the generator must have persisted Skippy's reply.
    assert.equal(tail.length, 2, 'tail holds user + assistant after first turn');
    assert.equal(tail[0]?.role, 'user');
    assert.equal(tail[1]?.role, 'assistant');

    // Prompt 2 — a follow-up that only makes sense WITH history.
    tail.push({ role: 'user', content: 'What did Engineering report?' });
    await drain(streamSkippyWithTools('SYSTEM', tail));

    // Two model calls happened.
    assert.equal(calls.length, 2, 'two stream() calls');
    const firstCall = calls[0];
    const secondCall = calls[1];
    assert.ok(firstCall && secondCall, 'both calls recorded');

    // The bug: the first call's input was just the lone first prompt.
    assert.equal(firstCall.length, 1);
    assert.equal(firstCall[0]?.content, 'Delegate the build to Engineering.');

    // The fix: the SECOND call's input carries the entire prior exchange —
    // first user turn, first assistant reply, then the follow-up.
    assert.ok(
      secondCall.length >= 3,
      `second call should include history; got ${secondCall.length} messages`,
    );
    assert.equal(secondCall[0]?.role, 'user');
    assert.equal(secondCall[0]?.content, 'Delegate the build to Engineering.');
    assert.equal(secondCall[1]?.role, 'assistant');
    const assistantText = JSON.stringify(secondCall[1]?.content);
    assert.match(assistantText, /Engineering board is on it/);
    assert.equal(secondCall[secondCall.length - 1]?.content, 'What did Engineering report?');
  } finally {
    __setClientForTest(null);
  }
});
