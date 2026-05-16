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

import { SpanStatusCode, trace } from '@opentelemetry/api';

import type { UserPromptEnvelope } from '@skippy/shared';

import { loadCharter } from './charter.js';
import { streamSkippy, streamSkippyWithTools, type SkippyChunk } from './claude.js';
import { logger } from './logger.js';
import { writeEnvelope } from './protocol.js';

const SKIPPY_ID = 'skippy';
const tracer = trace.getTracer('skippy-orchestrator');

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

/**
 * Handle a single `user_prompt` envelope: emit lifecycle states, stream tokens,
 * and surface telemetry. Errors are caught, turned into an `agent_state: error`
 * envelope, then rethrown so the caller's logger sees them.
 */
export async function handleUserPrompt(env: UserPromptEnvelope): Promise<void> {
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
          const stream: AsyncGenerator<SkippyChunk> = streamSkippyWithTools(
            system,
            env.text,
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
            }
          }
        }

        writeEnvelope({
          type: 'agent_complete',
          agentId: SKIPPY_ID,
          promptId: env.promptId,
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
