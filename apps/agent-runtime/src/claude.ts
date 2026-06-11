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
// is not yet a dependency in `apps/agent-runtime/package.json`. (The gated SDK
// path that DOES take the dependency lives in `sdk-board.ts`, behind
// `PHASE3_AGENTS_ENABLED`; this file is the always-on Messages-API fallback.)
// The SDK can be substituted later by replacing this file alone — the tool
// definition in `mcp-delegate.ts` is identical in shape.

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

/**
 * Test-only seam. Inject a fake Anthropic-shaped client (just `messages.stream`)
 * so the conversation-memory + tool-loop behavior can be exercised without a
 * network call or API key. Pass `null` to reset to the real lazily-built client.
 * Not used in production code.
 */
export function __setClientForTest(fake: Anthropic | null): void {
  _client = fake;
}

// Phase 3-prep: model selection is dynamic. The boot-time `SKIPPY_MODEL` env
// var still wins as the registry's initial value (modelRegistry.ts) but every
// call below resolves through `getModelFor('skippy')` so a renderer-side
// `set_model` envelope takes effect on the very next request.
const MAX_TOOL_ITERATIONS = 6; // Generous; Skippy rarely cascades > 2 boards in one turn.

// Output budget per API call. 1024 silently truncated Skippy's longer turns
// (the API returns `stop_reason: 'max_tokens'` and the stream just stops
// mid-sentence). 4096 comfortably covers a narrated orchestration turn plus a
// delegate_to_board tool call; truncation past it is now handled explicitly
// (see the `max_tokens` branch in the tool loop) rather than ending silently.
// Sized to comfortably cover a full narrated Skippy orchestration turn plus a
// delegate_to_board tool call, so hitting it (and the truncation path below) is
// rare. These are streamed messages.stream() calls with no timeout pressure, so
// a generous budget costs nothing when unused.
const MAX_OUTPUT_TOKENS = 8192;

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
    max_tokens: MAX_OUTPUT_TOKENS,
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

  // Don't let a hit on the output budget end the turn silently. This hello-world
  // path has no tool loop to continue into, so surface the truncation inline so
  // the user knows Skippy's reply was cut off rather than simply finished.
  const final = await stream.finalMessage();
  if (final.stop_reason === 'max_tokens') {
    yield '\n\n[SKIPPY truncated: hit the output budget — ask me to continue.]';
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
  | { kind: 'bail'; iteration: number }
  // Emitted when a turn hit the `max_tokens` output budget. `continued` is
  // always false now (we don't auto-continue — that corrupts role alternation);
  // the caller uses it to flag a genuinely incomplete reply so the user knows to
  // ask Skippy to continue.
  | { kind: 'truncated'; continued: boolean }
  // Emitted exactly once at the end of the turn (WS6 / D5). `inputTokens` +
  // `outputTokens` are summed across all tool-loop iterations for cost;
  // `contextTokens` is the LAST turn's input count (the conversation-tail size)
  // for the context-window-pressure bar. `model` is the model the API reported
  // actually serving the request.
  | {
      kind: 'usage';
      inputTokens: number;
      outputTokens: number;
      contextTokens: number;
      model: string;
    };

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
 *
 * Conversation memory (PRD §5.2): Skippy is one long-running session, so the
 * caller owns a persistent `messages` tail and hands it in here. We require it
 * to already end with the new `user` turn (skippy.ts appends + trims it before
 * calling). We MUTATE it in place — appending the assistant turn and the
 * tool_result `user` turn for every tool-loop iteration — so that when this
 * generator returns, the tail the caller holds includes Skippy's full reply
 * (text + any tool-use/tool-result rounds). The next prompt then continues the
 * same thread instead of hitting a fresh, amnesiac model. The Anthropic
 * Messages API is stateless: we send the whole tail every turn (history + the
 * single tools array + system), exactly as the manual tool-loop pattern
 * prescribes.
 */
export async function* streamSkippyWithTools(
  system: string,
  messages: Anthropic.Messages.MessageParam[],
): AsyncGenerator<SkippyChunk> {
  const c = client();

  // WS6 telemetry accumulators: sum tokens across the tool loop for cost;
  // track the last turn's input count for context-window pressure.
  let totalInput = 0;
  let totalOutput = 0;
  let lastInput = 0;
  let usedModel: string = getModelFor('skippy');

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    const stream = c.messages.stream({
      model: getModelFor('skippy'),
      max_tokens: MAX_OUTPUT_TOKENS,
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

    // Accumulate usage from this turn (WS6). The Anthropic SDK reports usage on
    // every finalMessage; input_tokens is the full prompt (history + tools).
    totalInput += resp.usage.input_tokens ?? 0;
    totalOutput += resp.usage.output_tokens ?? 0;
    lastInput = resp.usage.input_tokens ?? lastInput;
    usedModel = resp.model ?? usedModel;

    // Output budget hit mid-turn. Don't end silently (the original 1024 bug),
    // but don't try to auto-continue either: re-prompting from a trailing
    // assistant turn produces consecutive assistant messages (invalid role
    // alternation) once a second truncation or the persisted tail is involved.
    // With MAX_OUTPUT_TOKENS sized for a full narrated orchestration turn this
    // is rare; when it does happen we persist the partial assistant turn (so the
    // tail stays coherent and alternating) and surface the truncation as a
    // terminal signal — the caller flags the reply as genuinely incomplete and
    // the user can ask Skippy to continue with a fresh prompt.
    if (resp.stop_reason === 'max_tokens') {
      messages.push({ role: 'assistant', content: resp.content });
      yield { kind: 'truncated', continued: false };
      yield {
        kind: 'usage',
        inputTokens: totalInput,
        outputTokens: totalOutput,
        contextTokens: lastInput,
        model: usedModel,
      };
      return;
    }

    if (resp.stop_reason !== 'tool_use') {
      // Final turn — no more tools. Persist the assistant reply into the
      // caller's tail so the next prompt continues the thread with Skippy's
      // last answer in view (PRD §5.2). This is the same in-place append the
      // tool-use branch below does; doing it here too means every terminal path
      // leaves `messages` ending on a coherent assistant turn.
      messages.push({ role: 'assistant', content: resp.content });
      yield {
        kind: 'usage',
        inputTokens: totalInput,
        outputTokens: totalOutput,
        contextTokens: lastInput,
        model: usedModel,
      };
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
  // bail-out so the user sees it and the loop terminates cleanly. Record it as
  // the assistant turn too, so the caller's persisted conversation tail closes
  // the final tool round with a coherent reply instead of dangling on a
  // tool_result the model never answered.
  const bailText = `\n\n[SKIPPY] My tool-use loop reached the iteration cap (${MAX_TOOL_ITERATIONS}). Stepping back to replan. The monkeys should ask again with a tighter scope.`;
  messages.push({ role: 'assistant', content: bailText });
  yield { kind: 'text', text: bailText };
  yield {
    kind: 'usage',
    inputTokens: totalInput,
    outputTokens: totalOutput,
    contextTokens: lastInput,
    model: usedModel,
  };
  yield { kind: 'bail', iteration: MAX_TOOL_ITERATIONS };
}

// TODO Phase 2: migrate to @anthropic-ai/claude-agent-sdk query() for true
// streamed tool-use, MCP server bindings, subagent spawn, and the full
// Skippy → Board → Task three-tier topology (PRD §5.1). The current
// implementation is intentionally minimal so Phase 1's exit criterion
// ("Skippy can call delegate_to_board and receive an ack") is hittable
// without taking the SDK dependency.
