// claude.ts — thin wrapper around Anthropic's Messages streaming API.
//
// Phase 0 satisfies the hello-world bar in PRD §14.1: one Skippy turn, tokens
// streamed back. Phase 1 will migrate this to the full Claude Agent SDK
// `query()` with subagent tool-use, board delegation, and MCP servers (see
// PRD §5.1 and the Iron Law of Delegation in §3.1).

import Anthropic from '@anthropic-ai/sdk';

let _client: Anthropic | null = null;

function client(): Anthropic {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY not set in agent-runtime env');
    }
    _client = new Anthropic();
  }
  return _client;
}

const MODEL = process.env.SKIPPY_MODEL ?? 'claude-opus-4-7';

/**
 * Yields incremental text deltas from a Skippy turn. Caller is responsible for
 * wrapping each delta in an `agent_token` envelope and for the surrounding
 * `agent_state` lifecycle (thinking → speaking → idle).
 */
export async function* streamSkippy(
  system: string,
  userText: string,
): AsyncGenerator<string> {
  const stream = client().messages.stream({
    model: MODEL,
    max_tokens: 1024,
    system,
    messages: [{ role: 'user', content: userText }],
  });

  for await (const event of stream) {
    if (
      event.type === 'content_block_delta' &&
      event.delta.type === 'text_delta'
    ) {
      yield event.delta.text;
    }
  }
}

// TODO Phase 1: migrate to @anthropic-ai/claude-agent-sdk query() with
// subagent tool-use, MCP server bindings, and the Skippy → Board → Task
// three-tier topology (PRD §5.1). The current implementation is intentionally
// minimal so Phase 0's exit criterion ("the user can ask Skippy a question
// and watch a beercan say 'thinking' → 'speaking' → 'idle'") is hittable
// without the full SDK contract.
