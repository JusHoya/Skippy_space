// claude.ts — thin wrapper around Anthropic's Messages API (stream + tools).
//
// Phase 0 satisfied the hello-world bar in PRD §14.1 with `streamSkippy` (one
// turn, tokens streamed back).
//
// Phase 1 added `streamSkippyWithTools` — the same surface, plus the
// `delegate_to_board` tool from `mcp-delegate.ts`. Per the Iron Law of
// Delegation (PRD §3.1), Skippy should call this tool for ALL implementation
// work. The loop iterates while the model returns `stop_reason: 'tool_use'`,
// executes the tool, and appends the tool_result so the model can continue.
//
// Phase 3-prep (the hang fix): the Phase 1 implementation used
// `c.messages.create()` inside the tool loop. That call is non-streaming —
// the user sees nothing until the full Opus turn lands (20-40 s on a
// delegation-heavy prompt). We now use `c.messages.stream()` instead. The
// MessageStream type exposes BOTH:
//   • async iteration over RawMessageStreamEvent (per-token text deltas), and
//   • `finalMessage()` returning the full Message with stop_reason + blocks,
// so we can stream tokens AND drive the tool loop with the same call. See
// `node_modules/.../@anthropic-ai/sdk/lib/MessageStream.d.ts`.
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
import { getModelFor } from './modelRegistry.js';

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

// Phase 3-prep: model selection is dynamic. The boot-time `SKIPPY_MODEL` env
// var still wins as the registry's initial value (modelRegistry.ts) but every
// call below resolves through `getModelFor('skippy')` so a renderer-side
// `set_model` envelope takes effect on the very next request.
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
    model: getModelFor('skippy'),
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
 * Discriminated union yielded by `streamSkippyWithTools`.
 *
 * `text` chunks are forwarded straight to the user as agent_token envelopes.
 * `tool_use_started` / `tool_use_done` give the caller a hook to flip the
 * agent_state envelope to `working` while a delegation is in flight so the
 * user sees the orchestrator is alive between tokens (PRD §5.2). `bail` is
 * emitted exactly once when the MAX_TOOL_ITERATIONS cap fires.
 */
export type SkippyChunk =
  | { kind: 'text'; text: string }
  | { kind: 'tool_use_started'; toolName: string; iteration: number }
  | { kind: 'tool_use_done'; toolName: string; iteration: number }
  | { kind: 'bail'; iteration: number };

/**
 * Phase 1 streaming path — tool-use enabled, now token-streamed end-to-end.
 *
 * Per iteration:
 *   1. Open a MessageStream and yield `text` chunks as `text_delta` events arrive.
 *   2. Await `finalMessage()` to inspect `stop_reason` and content blocks.
 *   3. If `stop_reason !== 'tool_use'`, return.
 *   4. Otherwise, append the assistant turn, execute every tool_use block,
 *      append the tool_result blocks, and continue the loop. We emit
 *      `tool_use_started` / `tool_use_done` so the caller can flip
 *      agent_state to `working` for the duration of the supervisor call.
 *
 * Caller is responsible for the `agent_state` lifecycle around this generator
 * (thinking → speaking → working → speaking → idle).
 */
export async function* streamSkippyWithTools(
  system: string,
  userText: string,
): AsyncGenerator<SkippyChunk> {
  const c = client();
  const messages: Anthropic.Messages.MessageParam[] = [
    { role: 'user', content: userText },
  ];

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    const stream = c.messages.stream({
      model: getModelFor('skippy'),
      max_tokens: 1024,
      system,
      tools: [DELEGATE_TO_BOARD_TOOL],
      messages,
    });

    // Stream text deltas as they arrive so the user sees Skippy's narration
    // token-by-token (the hang fix — Phase 1 only delivered text once the
    // whole turn had landed).
    for await (const event of stream) {
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta' &&
        event.delta.text.length > 0
      ) {
        yield { kind: 'text', text: event.delta.text };
      }
    }

    // Stream is done. Inspect the assembled Message for stop_reason +
    // content blocks. finalMessage() resolves with the same shape that
    // messages.create() used to return, so the tool loop bookkeeping
    // below is unchanged from the Phase 1 implementation.
    const resp = await stream.finalMessage();

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
      yield { kind: 'tool_use_started', toolName: tu.name, iteration: iter };
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
      yield { kind: 'tool_use_done', toolName: tu.name, iteration: iter };
    }
    messages.push({ role: 'user', content: toolResults });
  }

  // If we hit the iteration cap, the model is in a loop. Yield a narrated
  // bail-out so the user sees it and the loop terminates cleanly.
  yield {
    kind: 'text',
    text: `\n\n[SKIPPY] My tool-use loop reached the iteration cap (${MAX_TOOL_ITERATIONS}). Stepping back to replan. The monkeys should ask again with a tighter scope.`,
  };
  yield { kind: 'bail', iteration: MAX_TOOL_ITERATIONS };
}

// TODO Phase 2: migrate to @anthropic-ai/claude-agent-sdk query() for true
// streamed tool-use, MCP server bindings, subagent spawn, and the full
// Skippy → Board → Task three-tier topology (PRD §5.1). The current
// implementation is intentionally minimal so Phase 1's exit criterion
// ("Skippy can call delegate_to_board and receive an ack") is hittable
// without taking the SDK dependency.
