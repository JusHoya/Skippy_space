// modelRegistry.ts — Phase 3-prep (Zone 5).
//
// In-memory binding of {scope → modelId} for the sidecar process. The Rust
// shell forwards `set_model` envelopes from the renderer (via the
// `dispatch_set_model` Tauri command); `index.ts` parses them off stdin and
// calls `setModelFor(scope, modelId)` here. LLM call sites pull the live
// binding at request time via `getModelFor(agentId)` so a click in the
// dashboard takes effect on the very next call (in-flight calls keep their
// original model — per `SetModelEnvelope`'s contract in @skippy/shared).
//
// Per CLAUDE.md, model bindings are a UI-visible discrete state and not
// per-frame data, so storing them in a plain in-process Map is the right
// trade — restart of the sidecar resets the registry to its charter defaults,
// which is the expected behavior in Phase 3-prep. Persistence across sidecar
// restarts is deferred to the Letta-backed memory layer (PRD §8).

import { BOARDS, BOARD_META, type BoardId, type ModelId } from '@skippy/shared';

import { logger } from './logger.js';

/**
 * Scope vocabulary the sidecar understands. Mirrors `ModelScope` in
 * @skippy/shared but kept here as a local type so the registry remains a
 * lightweight surface (no Zod re-validation; the renderer + shell already
 * checked the wire payload).
 */
export type ScopeId = 'skippy' | `board.${BoardId}`;

/**
 * Boot-time default for Skippy. The `SKIPPY_MODEL` env var (forwarded by the
 * Rust sidecar.rs supervisor) wins if set so headless tests + the Phase 0
 * exit-gate can still pin the model from the environment. After the renderer
 * sends its first `set_model`, the env-var value is shadowed by the user's
 * choice.
 */
const SKIPPY_BOOT_DEFAULT: ModelId = (process.env.SKIPPY_MODEL ?? 'claude-opus-4-7') as ModelId;

/** Seed the per-board defaults from each charter's `defaultModel`. */
function defaultBoardBindings(): Map<ScopeId, ModelId> {
  const out = new Map<ScopeId, ModelId>();
  out.set('skippy', SKIPPY_BOOT_DEFAULT);
  for (const id of BOARDS) {
    out.set(`board.${id}`, BOARD_META[id].defaultModel as ModelId);
  }
  return out;
}

const bindings: Map<ScopeId, ModelId> = defaultBoardBindings();

/**
 * Rebind a scope to a model. Logs the change at info level so transcripts and
 * Langfuse traces can correlate cost shifts with user actions. No persistence
 * — this lives in process memory only.
 */
export function setModelFor(scope: ScopeId, modelId: ModelId): void {
  const prev = bindings.get(scope);
  bindings.set(scope, modelId);
  logger.info({
    msg: 'model rebind',
    scope,
    modelId,
    previous: prev ?? null,
  });
}

/**
 * Resolve the active model for an agent id.
 *
 * - `skippy`        → the Skippy binding (default Opus 4.7).
 * - `board.<id>`    → that board's binding (default per BOARD_META).
 * - any other id    → the Skippy binding as a conservative fallback (callers
 *                     can pass `'skippy'` explicitly to be precise).
 *
 * The Skippy fallback is deliberate: task agents in Phase 3-prep don't yet
 * track their parent agent in the registry, and Skippy is the cheapest
 * agent to "miss-bill" against because the user is already paying attention
 * to him (the next user-facing prompt will visibly use Opus).
 */
export function getModelFor(agentId: string): ModelId {
  if (agentId === 'skippy') {
    return bindings.get('skippy') ?? SKIPPY_BOOT_DEFAULT;
  }
  if (agentId.startsWith('board.')) {
    const scope = agentId as ScopeId;
    const bound = bindings.get(scope);
    if (bound) return bound;
    // Unknown board id — fall through to Skippy fallback.
  }
  return bindings.get('skippy') ?? SKIPPY_BOOT_DEFAULT;
}

/** Snapshot of the registry — used by tests and the `/model` debug command. */
export function snapshotBindings(): Record<ScopeId, ModelId> {
  return Object.fromEntries(bindings) as Record<ScopeId, ModelId>;
}
