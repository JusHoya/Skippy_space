// mcp-delegate.ts — the `delegate_to_board` tool exposed to Skippy.
//
// Path choice (per Agent F task brief):
//   We chose path (b) — define the tool as an Anthropic Messages-API tool
//   entry and intercept `stop_reason: 'tool_use'` in the Skippy loop. Reason:
//   `@anthropic-ai/claude-agent-sdk` is NOT in `apps/agent-runtime/package.json`
//   as of this writing (only `@anthropic-ai/sdk` is). Path (a) would require a
//   new dependency, and the brief explicitly forbids that. When the Agent SDK
//   lands in Phase 2, this module's `DELEGATE_TO_BOARD_TOOL` definition can
//   be reused verbatim — the JSON Schema is identical between the SDK custom-
//   tool surface and the Messages-API tool surface.
//
// The tool handler does NOT live in this file directly — the LLM loop in
// `skippy.ts` owns the loop bookkeeping, and on a tool_use it calls
// `handleDelegateToBoard(...)` here. We keep the schema + handler co-located
// so a future migration to the SDK only needs to wrap them differently.

import type Anthropic from '@anthropic-ai/sdk';

import { BOARDS, type BoardId } from '@skippy/shared';

import { getSupervisor, type SupervisorAck } from './supervisor.js';

/** The tool definition the Anthropic Messages API consumes. */
export const DELEGATE_TO_BOARD_TOOL: Anthropic.Messages.Tool = {
  name: 'delegate_to_board',
  description:
    'Delegate a mission to one of the eight Board Captains (Engineering, Coding, Design, Marketing, Finance, Research, Publishing, DevOps). USE THIS for ALL implementation work — the Iron Law of Delegation: Skippy NEVER implements himself. The tool returns an acknowledgement: accept | decline | counter_propose. After accept, the Board emits a delegation_complete envelope asynchronously.',
  input_schema: {
    type: 'object',
    properties: {
      board_name: {
        type: 'string',
        enum: [...BOARDS],
        description: 'Which Board Captain to delegate to. Must be one of the eight.',
      },
      mission_brief: {
        type: 'string',
        description:
          'A short, focused description of the mission. The Captain decomposes this into task agent assignments.',
      },
      constraints: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Optional list of binding constraints (e.g., "no new dependencies", "preserve existing API surface").',
      },
      deadline: {
        type: 'string',
        description: 'Optional ISO-8601 deadline. The Captain best-efforts to honor it.',
      },
    },
    required: ['board_name', 'mission_brief'],
  },
};

/** Input shape we expect from the model's tool_use block. We validate
 * lightly — the supervisor handles unknown boards gracefully. */
export interface DelegateToBoardInput {
  board_name: string;
  mission_brief: string;
  constraints?: string[];
  deadline?: string;
}

/** Result we hand back as the `tool_result` content block. Both Anthropic
 * and the Claude Agent SDK accept a JSON-stringified blob here. */
export interface DelegateToBoardOutput {
  delegation_id: string;
  board_name: string;
  decision: 'accept' | 'decline' | 'counter_propose';
  counter_text?: string;
  /** Human-readable summary the model can echo verbatim. */
  narration: string;
}

/** Coerce the model's tool_use `input` (which is `unknown` in the SDK type)
 * into our expected shape, with defensive defaults so a malformed call still
 * produces a tool_result instead of crashing the sidecar. */
function normalize(input: unknown): DelegateToBoardInput {
  const obj = (input ?? {}) as Record<string, unknown>;
  const board_name = typeof obj.board_name === 'string' ? obj.board_name : '';
  const mission_brief = typeof obj.mission_brief === 'string' ? obj.mission_brief : '';
  const constraints = Array.isArray(obj.constraints)
    ? obj.constraints.filter((x): x is string => typeof x === 'string')
    : undefined;
  const deadline = typeof obj.deadline === 'string' ? obj.deadline : undefined;
  const out: DelegateToBoardInput = { board_name, mission_brief };
  if (constraints !== undefined) out.constraints = constraints;
  if (deadline !== undefined) out.deadline = deadline;
  return out;
}

function isBoardId(s: string): s is BoardId {
  return (BOARDS as readonly string[]).includes(s);
}

/**
 * Execute one `delegate_to_board` tool call. Returns the structured output
 * that should be stringified into a `tool_result` content block. The loop
 * driver in `skippy.ts` is responsible for the conversation bookkeeping.
 */
export async function handleDelegateToBoard(
  input: unknown,
): Promise<DelegateToBoardOutput> {
  const parsed = normalize(input);
  if (!isBoardId(parsed.board_name)) {
    return {
      delegation_id: '',
      board_name: parsed.board_name,
      decision: 'decline',
      counter_text: `Unknown board: ${parsed.board_name}. Valid options: ${BOARDS.join(', ')}.`,
      narration: `The Great Skippy attempted to delegate to "${parsed.board_name}", which is not on the Board. Returning to plan.`,
    };
  }
  if (parsed.mission_brief.trim() === '') {
    return {
      delegation_id: '',
      board_name: parsed.board_name,
      decision: 'decline',
      counter_text: 'mission_brief was empty. Re-issue with a concrete one-sentence brief.',
      narration: `The ${parsed.board_name} Captain stared at me politely. Apparently "do something" is not a mission brief.`,
    };
  }
  const supervisor = getSupervisor();
  const ack: SupervisorAck = await supervisor.delegate(
    parsed.board_name,
    parsed.mission_brief,
    parsed.constraints,
    parsed.deadline,
  );
  const result: DelegateToBoardOutput = {
    delegation_id: ack.delegationId,
    board_name: ack.toBoardId,
    decision: ack.decision,
    narration: describeAck(ack, parsed.mission_brief),
  };
  if (ack.counterText !== undefined) {
    result.counter_text = ack.counterText;
  }
  return result;
}

function describeAck(ack: SupervisorAck, brief: string): string {
  switch (ack.decision) {
    case 'accept':
      return `Delegated to ${ack.toBoardId} Captain: "${brief}". Acknowledgement received. Task queued.`;
    case 'decline':
      return `${ack.toBoardId} Captain declined the brief: ${ack.counterText ?? 'no rationale provided'}. Reroute or replan.`;
    case 'counter_propose':
      return `${ack.toBoardId} Captain counter-proposes: ${ack.counterText ?? 'no rationale provided'}. Consider an alternate captain.`;
  }
}
