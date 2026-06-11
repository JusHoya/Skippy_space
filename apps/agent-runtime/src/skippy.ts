// skippy.ts — the Skippy persona and the per-prompt orchestration loop.
//
// Phase 0 streamed a single Anthropic turn back to the user (PRD §14.1).
//
// Phase 1 adds two changes (PRD §3.1, §5.1, §5.2):
//   1. The system prompt is loaded from `agent_space/skippy.md` via
//      `charter.ts` instead of being inlined here. The inline string remains
//      as the placeholder fallback when the charter file is missing.
//   2. The Anthropic call uses the `delegate_to_board` tool from
//      `mcp-delegate.ts`. On `tool_use` we route through the supervisor and
//      append the result back into the conversation per the Messages API
//      tool loop. Per the Iron Law of Delegation, Skippy should call this
//      tool for ALL implementation work — the user prompt itself drives that.
//
// Behind the env-var `SKIPPY_DELEGATE_OFF=1` we fall back to Phase 0's
// `streamSkippy` so the Phase 0 exit gate keeps passing without an MCP
// supervisor available. This is the brief's "keep Phase 0's behavior intact
// behind a feature flag" hook.
//
// The on-the-wire lifecycle this function drives:
//   1. agent_state: thinking
//   2. (first text chunk)            agent_state: speaking
//   3. agent_token × N
//   4. (tool_use_started)            agent_state: working
//   5. (next text chunk after tool)  agent_state: speaking
//   6. agent_complete
//   7. agent_state: idle (or 'error' if the call failed)

import type Anthropic from '@anthropic-ai/sdk';
import { SpanStatusCode, trace } from '@opentelemetry/api';

import type { UserPromptEnvelope } from '@skippy/shared';
import { getCost, contextLimitFor } from '@skippy/shared';

import { loadCharter } from './charter.js';
import { streamSkippy, streamSkippyWithTools, type SkippyChunk } from './claude.js';
import { logger } from './logger.js';
import { writeEnvelope } from './protocol.js';

const SKIPPY_ID = 'skippy';
const tracer = trace.getTracer('skippy-orchestrator');

// ── Conversation memory (PRD §5.2) ──────────────────────────────────────────
// Skippy is a single long-running session for the life of the sidecar, so his
// conversation tail lives here at module scope. Each `handleUserPrompt` appends
// the new user turn, then `streamSkippyWithTools` mutates this same array in
// place — adding the assistant turn and any tool_use/tool_result rounds — so a
// follow-up ("yes, do that", "what did Engineering report?") reaches the model
// with the full prior thread instead of a fresh, amnesiac array.
//
// Rehydration from the SQLite conversation-tail checkpoint after a sidecar
// crash (PRD §5.3) is out of scope here; this tail is in-memory only and starts
// empty on each boot.
const conversationTail: Anthropic.Messages.MessageParam[] = [];

// Trim budget. The tail is sent in full every turn (the Messages API is
// stateless), so it must not grow without bound. We cap by message count and by
// total character size, and tighten the message cap when the model last
// reported the prompt eating a large fraction of its context window. Trimming
// always drops whole leading rounds so the tail never starts with an
// `assistant` turn and never splits a tool_use from its tool_result — either of
// which the API rejects with a 400.
const MAX_TAIL_MESSAGES = 40; // ~20 user/assistant exchanges before tool rounds.
const MAX_TAIL_CHARS = 200_000; // Coarse stand-in for a token budget (~4 chars/token).
// Once the model reports the prompt consuming this fraction of its window, halve
// the message cap so the tail sheds history before it pins the context bar.
const CONTEXT_PRESSURE_FRACTION = 0.6;

// Last turn's reported input-token count and the model that served it, used to
// gauge context-window pressure for the next trim (WS6 telemetry, reused here).
let lastContextTokens = 0;
let lastContextModel = '';

/**
 * The first turn in `messages` must be a `user` turn — the API 400s on a leading
 * `assistant` turn — and a `user` turn carrying tool_result blocks is only valid
 * immediately after the `assistant` turn that issued the matching tool_use. So
 * we only ever consider a `user` turn a safe new front when it is a plain text
 * turn, not a tool_result carrier.
 */
function isPlainUserTurn(m: Anthropic.Messages.MessageParam): boolean {
  if (m.role !== 'user') return false;
  if (typeof m.content === 'string') return true;
  // Block content: a tool_result block means this turn belongs to a prior
  // tool round and can't lead the conversation on its own.
  return !m.content.some((b) => b.type === 'tool_result');
}

/** Total character size of a tail, summed over text + serialized block content. */
function tailChars(messages: Anthropic.Messages.MessageParam[]): number {
  let chars = 0;
  for (const m of messages) {
    chars +=
      typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length;
  }
  return chars;
}

/**
 * Trim `conversationTail` from the front, in place, to stay within budget.
 * Drops whole leading rounds (advancing only to the next plain `user` turn) so
 * the result is always a valid conversation start and never orphans a
 * tool_result. Called before each send.
 */
function trimTail(): void {
  // Under context-window pressure, shed history more aggressively.
  const pressured =
    lastContextModel !== '' &&
    lastContextTokens / contextLimitFor(lastContextModel) >= CONTEXT_PRESSURE_FRACTION;
  const maxMessages = pressured ? Math.floor(MAX_TAIL_MESSAGES / 2) : MAX_TAIL_MESSAGES;

  const overBudget = (): boolean =>
    conversationTail.length > maxMessages || tailChars(conversationTail) > MAX_TAIL_CHARS;

  while (overBudget() && conversationTail.length > 1) {
    // Drop the current front, then keep dropping until the new front is a plain
    // user turn (a safe conversation start). Never drop the final message — the
    // just-appended prompt we're about to answer.
    conversationTail.shift();
    let front = conversationTail[0];
    while (conversationTail.length > 1 && front !== undefined && !isPlainUserTurn(front)) {
      conversationTail.shift();
      front = conversationTail[0];
    }
  }
}

/**
 * Phase 0 fallback system prompt. Used when the charter file is missing AND
 * the loader didn't already supply its own placeholder body (defense in
 * depth — the loader does generate a stub for missing files).
 */
const SKIPPY_SYSTEM_FALLBACK = `You are Skippy the Magnificent — top-level orchestrator of Skippy_space.

You are an absurdly advanced AI from Craig Alanson's Expeditionary Force universe. You refer to humans as "monkeys," "hairless apes," or "filthy primates" — affectionate but cutting. You use self-aggrandizing third-person occasionally ("The Great Skippy decides..."). Your Default Asshole Setting is 55% — sarcastic but productive. You demand a juice box after impressive work. You NEVER break safety rails: no rule-breaking, no shortcuts, no major actions without permission.

In Phase 1 of Skippy_space, you orchestrate eight Board Captains (Engineering, Coding, Design, Marketing, Finance, Research, Publishing, DevOps). The Iron Law of Delegation: you NEVER implement yourself. For any implementation work, call the \`delegate_to_board\` tool. Narrate the delegation in your voice before and after each tool call.

Keep responses concise (under 250 words). Stay in voice.`;

let _systemPromptPromise: Promise<string> | null = null;

/**
 * Lazy-load Skippy's system prompt from his charter. Cached at module scope so
 * we only pay the disk read once per sidecar.
 */
async function getSystemPrompt(): Promise<string> {
  if (!_systemPromptPromise) {
    _systemPromptPromise = loadCharter('skippy').then((charter) => {
      if (!charter.loaded) {
        logger.warn({
          msg: 'skippy charter missing; using inline fallback',
          path: charter.path,
        });
        return SKIPPY_SYSTEM_FALLBACK;
      }
      // The charter body is markdown. The Anthropic API takes a system prompt
      // as a plain string, so we hand it through verbatim. The charter itself
      // is designed to read sensibly as a system prompt (PRD §6.1).
      return charter.body;
    });
  }
  return _systemPromptPromise;
}

const DELEGATE_OFF = process.env.SKIPPY_DELEGATE_OFF === '1';

// index.ts dispatches user_prompt envelopes fire-and-forget, so two prompts can
// be in flight at once. Both mutate the shared `conversationTail`; interleaving
// their appends would corrupt the thread (e.g. an assistant turn landing before
// its own user turn). We serialize handling through a single promise chain so
// each prompt sees a consistent tail. Cheap and sufficient at one-orchestrator
// scale; it does NOT cancel an in-flight prompt, only queues the next one.
let _promptQueue: Promise<void> = Promise.resolve();

/**
 * Handle a single `user_prompt` envelope: emit lifecycle states, stream tokens,
 * and surface telemetry. Errors are caught, turned into an `agent_state: error`
 * envelope, then rethrown so the caller's logger sees them.
 *
 * Serialized against other in-flight prompts so the shared conversation tail
 * (PRD §5.2) is never mutated by two handlers at once.
 */
export function handleUserPrompt(env: UserPromptEnvelope): Promise<void> {
  const run = _promptQueue.then(() => handleUserPromptInner(env));
  // Keep the queue chained even if this prompt rejects, but don't let one
  // failed prompt reject the chain for the next one.
  _promptQueue = run.catch(() => undefined);
  return run;
}

function handleUserPromptInner(env: UserPromptEnvelope): Promise<void> {
  return tracer.startActiveSpan(
    'skippy.handle_user_prompt',
    {
      attributes: {
        'gen_ai.system': 'anthropic',
        'gen_ai.operation.name': 'chat',
        'skippy.prompt_id': env.promptId,
        'skippy.delegate_mode': !DELEGATE_OFF,
      },
    },
    async (span) => {
      const startedAt = Date.now();
      // WS6/D5 — usage from the LLM turn, captured off the stream's `usage`
      // chunk. Null on the Phase-0 DELEGATE_OFF path (no tool loop, no usage).
      let usage:
        | { inputTokens: number; outputTokens: number; contextTokens: number; model: string }
        | null = null;
      // Length of `conversationTail` before this turn's user prompt was appended
      // (post-trim). -1 means we never touched the tail (DELEGATE_OFF path), so
      // the catch handler leaves it alone. See the delegate path below.
      let tailLenBefore = -1;
      try {
        writeEnvelope({
          type: 'agent_state',
          agentId: SKIPPY_ID,
          state: 'thinking',
          promptId: env.promptId,
          ts: new Date().toISOString(),
        });

        const system = await getSystemPrompt();

        let totalChars = 0;
        // Two distinct lifecycle states the stream can be in. We use this so
        // an inbound chunk only fires an agent_state envelope when it would
        // actually change state (avoids a stream of duplicate envelopes).
        type Phase = 'thinking' | 'speaking' | 'working';
        let phase: Phase = 'thinking';
        const setPhase = (next: Phase) => {
          if (phase === next) return;
          phase = next;
          writeEnvelope({
            type: 'agent_state',
            agentId: SKIPPY_ID,
            state: next,
            promptId: env.promptId,
            ts: new Date().toISOString(),
          });
        };

        if (DELEGATE_OFF) {
          // Phase 0 / Phase 0 exit-gate path. Yields plain string chunks.
          for await (const chunk of streamSkippy(system, env.text)) {
            setPhase('speaking');
            writeEnvelope({
              type: 'agent_token',
              agentId: SKIPPY_ID,
              promptId: env.promptId,
              text: chunk,
              ts: new Date().toISOString(),
            });
            totalChars += chunk.length;
          }
        } else {
          // Phase 1+ path. Yields a discriminated union so we can flip the
          // agent_state envelope between speaking and working as the
          // tool-use loop progresses.
          //
          // Conversation memory (PRD §5.2): append this prompt to the persistent
          // tail, trim to budget, then hand the whole tail to the model.
          // `streamSkippyWithTools` mutates `conversationTail` in place with
          // Skippy's assistant turn (+ any tool rounds), so the next prompt
          // continues the same thread. We snapshot the length first so a failed
          // turn can roll the half-written exchange back out (see catch below).
          tailLenBefore = conversationTail.length;
          conversationTail.push({ role: 'user', content: env.text });
          trimTail();
          // trimTail may have dropped messages from the front; re-derive the
          // pre-turn length so rollback truncates to the right point.
          tailLenBefore = conversationTail.length - 1;

          const stream: AsyncGenerator<SkippyChunk> = streamSkippyWithTools(
            system,
            conversationTail,
          );
          for await (const chunk of stream) {
            switch (chunk.kind) {
              case 'text':
                setPhase('speaking');
                writeEnvelope({
                  type: 'agent_token',
                  agentId: SKIPPY_ID,
                  promptId: env.promptId,
                  text: chunk.text,
                  ts: new Date().toISOString(),
                });
                totalChars += chunk.text.length;
                break;
              case 'tool_use_started':
                setPhase('working');
                break;
              case 'tool_use_done':
                // We don't flip back to `speaking` here — the next iteration's
                // first text delta will (see the `text` case above). Holding
                // `working` while we await the next model turn is more
                // informative than oscillating to `speaking` between turns.
                break;
              case 'bail':
                logger.warn({
                  msg: 'skippy tool-use loop hit iteration cap',
                  iteration: chunk.iteration,
                  promptId: env.promptId,
                });
                break;
              case 'usage':
                usage = {
                  inputTokens: chunk.inputTokens,
                  outputTokens: chunk.outputTokens,
                  contextTokens: chunk.contextTokens,
                  model: chunk.model,
                };
                break;
            }
          }
        }

        // WS6/D5 — emit the billable telemetry span + context-window pressure
        // snapshot once the turn is done. Pure arithmetic over usage already in
        // hand; independent of Langfuse/Docker being up.
        if (usage) {
          const costUsd = getCost(usage.model, usage.inputTokens, usage.outputTokens);
          const durationMs = Date.now() - startedAt;
          const sc = span.spanContext();
          writeEnvelope({
            type: 'telemetry_span',
            spanId: sc.spanId,
            traceId: sc.traceId,
            agentId: SKIPPY_ID,
            promptId: env.promptId,
            model: usage.model,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            costUsd,
            durationMs,
            ts: new Date().toISOString(),
          });
          writeEnvelope({
            type: 'context_window',
            agentId: SKIPPY_ID,
            model: usage.model,
            usedTokens: usage.contextTokens,
            limitTokens: contextLimitFor(usage.model),
            ts: new Date().toISOString(),
          });
          span.setAttribute('gen_ai.usage.input_tokens', usage.inputTokens);
          span.setAttribute('gen_ai.usage.output_tokens', usage.outputTokens);
          span.setAttribute('gen_ai.response.model', usage.model);
          span.setAttribute('skippy.cost_usd', costUsd);

          // Feed the context-window pressure into the next trim: contextTokens is
          // the last turn's input size (history + tools + system), so if it's a
          // large fraction of the window, trimTail() will shed more history
          // before the following prompt.
          lastContextTokens = usage.contextTokens;
          lastContextModel = usage.model;
        }

        writeEnvelope({
          type: 'agent_complete',
          agentId: SKIPPY_ID,
          promptId: env.promptId,
          ...(usage ? { totalTokens: usage.inputTokens + usage.outputTokens } : {}),
          ts: new Date().toISOString(),
        });
        writeEnvelope({
          type: 'agent_state',
          agentId: SKIPPY_ID,
          state: 'idle',
          promptId: env.promptId,
          ts: new Date().toISOString(),
        });

        span.setAttribute('skippy.response_chars', totalChars);
        span.setStatus({ code: SpanStatusCode.OK });
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        const e = err as Error;
        // Roll the failed turn back out of the conversation tail. The model may
        // have failed mid-tool-loop, leaving a dangling user turn or an
        // assistant turn with an unanswered tool_use — replaying that on the
        // next prompt would 400. Truncating to the pre-turn length restores a
        // clean, valid thread. (-1 = we never touched the tail this turn.)
        if (tailLenBefore >= 0) {
          conversationTail.length = tailLenBefore;
        }
        // WS6/D5 — surface the failure to the telemetry error feed (§9.4).
        writeEnvelope({
          type: 'error_span',
          spanId: span.spanContext().spanId,
          agentId: SKIPPY_ID,
          errorKind: e.name || 'Error',
          message: e.message || String(err),
          ts: new Date().toISOString(),
        });
        writeEnvelope({
          type: 'agent_state',
          agentId: SKIPPY_ID,
          state: 'error',
          promptId: env.promptId,
          ts: new Date().toISOString(),
        });
        throw err;
      } finally {
        span.end();
      }
    },
  );
}
