// claude.truncation.test.ts — lock-in test for max_tokens truncation handling.
//
// Proves the fix for the silent-truncation bug (review §runtime, claude.ts:139)
// AND its reconciliation: before, a turn that hit the (1024-token) output budget
// came back with `stop_reason: 'max_tokens'` and the generator just ended — the
// user saw a reply cut off mid-sentence with no signal. We do NOT auto-continue:
// re-prompting from a trailing assistant turn produces consecutive assistant
// messages (invalid role alternation) once a second truncation or the persisted
// tail is involved. Instead the loop, on `max_tokens`:
//   • persists the partial assistant turn (so the tail stays coherent + alternating),
//   • emits exactly one `{kind:'truncated', continued:false}` signal, and
//   • ends cleanly with a single usage envelope (no second model call, no hang).
// MAX_OUTPUT_TOKENS is sized so this path is rare in practice.
//
// We inject a fake Anthropic-shaped client via the claude.ts test seam and drive
// configurable per-call stop_reasons. No live API key / network required.
//
// Run: node --import tsx --test src/claude.truncation.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type Anthropic from '@anthropic-ai/sdk';

import {
  streamSkippyWithTools,
  __setClientForTest,
  type SkippyChunk,
} from './claude.js';

type Reply = { text: string; stop: Anthropic.Messages.Message['stop_reason'] };

// A MessageStream stand-in: async-iterable over one text delta + finalMessage()
// carrying the requested stop_reason.
function fakeStream(reply: Reply, model = 'claude-opus-4-7') {
  const finalMessage: Anthropic.Messages.Message = {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: reply.text }],
    stop_reason: reply.stop,
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 20 },
  };
  return {
    async *[Symbol.asyncIterator]() {
      yield {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: reply.text },
      } as Anthropic.Messages.RawMessageStreamEvent;
    },
    async finalMessage() {
      return finalMessage;
    },
  };
}

/** Fake client that replays a scripted sequence of stop_reasons. */
function scriptedClient(replies: Reply[]) {
  let i = 0;
  let calls = 0;
  const fake = {
    messages: {
      stream() {
        calls += 1;
        const reply = replies[i] ?? replies[replies.length - 1];
        i += 1;
        if (!reply) throw new Error('scriptedClient: no replies configured');
        return fakeStream(reply);
      },
    },
  } as unknown as Anthropic;
  return { fake, callCount: () => calls };
}

async function collect(gen: AsyncGenerator<SkippyChunk>): Promise<SkippyChunk[]> {
  const out: SkippyChunk[] = [];
  for await (const chunk of gen) out.push(chunk);
  return out;
}

test('max_tokens truncation surfaces a clean incomplete signal without re-prompting', async () => {
  const { fake, callCount } = scriptedClient([
    { text: 'Listen up, monkey, here is the plan… ', stop: 'max_tokens' },
  ]);
  __setClientForTest(fake);
  try {
    const tail: Anthropic.Messages.MessageParam[] = [
      { role: 'user', content: 'Give me a long plan.' },
    ];
    const chunks = await collect(streamSkippyWithTools('SYSTEM', tail));

    // No re-prompt — exactly one model call (auto-continuation would corrupt the
    // role alternation, so we deliberately don't do it).
    assert.equal(callCount(), 1, 'a truncated turn is NOT re-prompted');

    const truncations = chunks.filter(
      (c): c is { kind: 'truncated'; continued: boolean } => c.kind === 'truncated',
    );
    assert.equal(truncations.length, 1, 'exactly one truncation signal');
    assert.equal(
      truncations[0]?.continued,
      false,
      'truncation is surfaced as incomplete (continued:false), never auto-continued',
    );

    // The partial text still reaches the caller (nothing dropped on truncation).
    const text = chunks
      .filter((c): c is { kind: 'text'; text: string } => c.kind === 'text')
      .map((c) => c.text)
      .join('');
    assert.match(text, /here is the plan/);

    // Terminal usage envelope emitted exactly once (no hang).
    assert.equal(chunks.filter((c) => c.kind === 'usage').length, 1);

    // The partial assistant turn is persisted so the tail stays coherent AND
    // alternating (user → assistant) — the next prompt appends a user turn,
    // which is valid; an auto-continue would have left two assistant turns.
    assert.equal(tail.length, 2, 'partial assistant turn persisted into the tail');
    assert.equal(tail[1]?.role, 'assistant');
  } finally {
    __setClientForTest(null);
  }
});

test('a normal end_turn after streaming persists one alternating assistant turn', async () => {
  const { fake, callCount } = scriptedClient([
    { text: 'The magnificent has spoken.', stop: 'end_turn' },
  ]);
  __setClientForTest(fake);
  try {
    const tail: Anthropic.Messages.MessageParam[] = [
      { role: 'user', content: 'Say something.' },
    ];
    const chunks = await collect(streamSkippyWithTools('SYSTEM', tail));

    assert.equal(callCount(), 1);
    assert.equal(chunks.filter((c) => c.kind === 'truncated').length, 0, 'no truncation on a clean turn');
    assert.equal(chunks.filter((c) => c.kind === 'usage').length, 1);
    // Tail ends on a single assistant turn — alternation preserved for the next prompt.
    assert.equal(tail.length, 2);
    assert.equal(tail[1]?.role, 'assistant');
  } finally {
    __setClientForTest(null);
  }
});
