// claude.ts — thin wrapper around Anthropic's Messages API (stream + tools).
//
// Phase 0 satisfied the hello-world bar in PRD §14.1 with `streamSkippy` (one
// turn, tokens streamed back).
//
// Phase 1 adds `streamSkippyWithTools` — the same surface, plus the
// `delegate_to_board` tool from `mcp-delegate.ts`. Per the Iron Law of
// Delegation (PRD §3.1), Skippy should call this tool for ALL implementation
// work. The loop iterates while the model returns `stop_reason: 'tool_use'`,
// executes the tool, and appends the tool_result so the model can continue.
//
// We pick the Messages-API tool-use path because `@anthropic-ai/claude-agent-sdk`
// is not yet a dependency in `apps/agent-runtime/package.json`. The SDK can be
// substituted later by replacing this file alone — the tool definition in
// `mcp-delegate.ts` is identical in shape.

import Anthropic from '@anthropic-ai/sdk';

import {
  DELEGATE_TO_BOARD_TOOL,
  handleDelegateToBoard,
} from './mcp-delegate.js';

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
const MAX_TOOL_ITERATIONS = 6; // Generous; Skippy rarely cascades > 2 boards in one turn.

/**
 * Phase 0 streaming path — single turn, no tools. Kept verbatim so the
 * Phase 0 exit gate keeps passing if the tool-use path errors at runtime.
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

/**
 * Phase 1 streaming path — tool-use enabled. Yields incremental text deltas
 * the same way `streamSkippy` does, *plus* invokes `handleDelegateToBoard`
 * whenever the model emits a `tool_use` block. Tool results are appended to
 * the conversation and the loop continues until the model returns
 * `stop_reason: 'end_turn' | 'stop_sequence' | 'max_tokens'`.
 *
 * Caller is responsible for the `agent_state` lifecycle around this generator
 * (thinking → speaking → idle).
 */
export async function* streamSkippyWithTools(
  system: string,
  userText: string,
): AsyncGenerator<string> {
  const c = client();
  const messages: Anthropic.Messages.MessageParam[] = [
    { role: 'user', content: userText },
  ];

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    // Each iteration: one full Messages.create roundtrip (we use non-streaming
    // for the tool-use path because we need the full response to inspect
    // stop_reason + content blocks; the SDK does not give us a clean way to
    // do both streaming AND tool-use loop in v0.30).
    //
    // The "stream" of text deltas we yield from this generator therefore
    // emits one final chunk per assistant turn rather than per-token. This is
    // a Phase 1 compromise: the user still sees a paragraph land as it
    // resolves; per-token granularity comes back in Phase 2 when we adopt
    // the Claude Agent SDK's query() which exposes both surfaces cleanly.
    const resp = await c.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system,
      tools: [DELEGATE_TO_BOARD_TOOL],
      messages,
    });

    // Yield any assistant text from this turn so the user sees Skippy's
    // narration before tool dispatch.
    for (const block of resp.content) {
      if (block.type === 'text' && block.text.length > 0) {
        yield block.text;
      }
    }

    // If the model is done, exit.
    if (resp.stop_reason !== 'tool_use') {
      return;
    }

    // Append the assistant turn verbatim, then dispatch each tool_use and
    // append a matching tool_result block.
    messages.push({ role: 'assistant', content: resp.content });

    const toolUseBlocks = resp.content.filter(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use',
    );
    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const tu of toolUseBlocks) {
      if (tu.name === 'delegate_to_board') {
        const result = await handleDelegateToBoard(tu.input);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: JSON.stringify(result),
        });
      } else {
        // Unknown tool — emit an error result so the model can recover.
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          is_error: true,
          content: `Unknown tool: ${tu.name}`,
        });
      }
    }
    messages.push({ role: 'user', content: toolResults });
  }

  // If we hit the iteration cap, the model is in a loop. Yield a narrated
  // bail-out so the user sees it and the loop terminates cleanly.
  yield `\n\n[SKIPPY] My tool-use loop reached the iteration cap (${MAX_TOOL_ITERATIONS}). Stepping back to replan. The monkeys should ask again with a tighter scope.`;
}

// TODO Phase 2: migrate to @anthropic-ai/claude-agent-sdk query() for true
// streamed tool-use, MCP server bindings, subagent spawn, and the full
// Skippy → Board → Task three-tier topology (PRD §5.1). The current
// implementation is intentionally minimal so Phase 1's exit criterion
// ("Skippy can call delegate_to_board and receive an ack") is hittable
// without taking the SDK dependency.
