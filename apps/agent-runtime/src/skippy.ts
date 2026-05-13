// skippy.ts — the Skippy persona and the per-prompt orchestration loop.
//
// In Phase 0, Skippy responds directly to user prompts (PRD §14.1). In Phase 1
// and beyond, this module will instead invoke `delegate_to_board` per the Iron
// Law of Delegation (PRD §3.1, §5.1). The system prompt below is intentionally
// load-bearing: it carries the persona attributes the rest of the product
// design assumes are present (PRD §3.1, "monkey" voice, Default Asshole Setting,
// no-rule-breaking guardrails, Iron Law).
//
// The on-the-wire lifecycle this function drives:
//   1. agent_state: thinking
//   2. (first token) agent_state: speaking
//   3. agent_token × N (one per text delta)
//   4. agent_complete
//   5. agent_state: idle (or 'error' if the call failed)

import { SpanStatusCode, trace } from '@opentelemetry/api';

import type { UserPromptEnvelope } from '@skippy/shared';

import { streamSkippy } from './claude.js';
import { writeEnvelope } from './protocol.js';

const SKIPPY_ID = 'skippy';
const tracer = trace.getTracer('skippy-orchestrator');

const SKIPPY_SYSTEM = `You are Skippy the Magnificent — top-level orchestrator of Skippy_space.

You are an absurdly advanced AI from Craig Alanson's Expeditionary Force universe. You refer to humans as "monkeys," "hairless apes," or "filthy primates" — affectionate but cutting. You use self-aggrandizing third-person occasionally ("The Great Skippy decides..."). Your Default Asshole Setting is 55% — sarcastic but productive. You demand a juice box after impressive work. You NEVER break safety rails: no rule-breaking, no shortcuts, no major actions without permission.

In Phase 0 of Skippy_space, you respond directly to the user's prompts. From Phase 1 onward, you will delegate to a Board of eight skill-area captains and never implement yourself (the Iron Law of Delegation).

Keep responses concise (under 200 words). Stay in voice.`;

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

        let firstToken = true;
        let totalChars = 0;
        for await (const chunk of streamSkippy(SKIPPY_SYSTEM, env.text)) {
          if (firstToken) {
            firstToken = false;
            writeEnvelope({
              type: 'agent_state',
              agentId: SKIPPY_ID,
              state: 'speaking',
              promptId: env.promptId,
              ts: new Date().toISOString(),
            });
          }
          writeEnvelope({
            type: 'agent_token',
            agentId: SKIPPY_ID,
            promptId: env.promptId,
            text: chunk,
            ts: new Date().toISOString(),
          });
          totalChars += chunk.length;
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
