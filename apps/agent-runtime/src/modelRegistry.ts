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

import { AVAILABLE_MODELS, BOARDS, BOARD_META, type BoardId, type ModelId } from '@skippy/shared';

import { logger } from './logger.js';

/**
 * Scope vocabulary the sidecar understands. Mirrors `ModelScope` in
 * @skippy/shared but kept here as a local type so the registry remains a
 * lightweight surface (no Zod re-validation; the renderer + shell already
 * checked the wire payload).
 */
export type ScopeId = 'skippy' | `board.${BoardId}`;

/** The Skippy fallback model — also the conservative default when a trust
 * boundary hands us an unknown model string. Opus is what the PRD pins Skippy
 * to (§3.3); a board that fell back here would at least not be silently
 * mis-billed against the *wrong* tier without a warning in the log. */
const OPUS_DEFAULT: ModelId = 'claude-opus-4-7';

/** Set of model ids the sidecar knows how to price/route, derived from the
 * shared `AVAILABLE_MODELS` registry so the two never drift. */
const KNOWN_MODEL_IDS: ReadonlySet<string> = new Set(AVAILABLE_MODELS.map((m) => m.id));

/**
 * Validate a model string at a trust boundary (env var, charter, BOARD_META)
 * and narrow it to `ModelId`. An unknown id is NOT cast through silently — that
 * was the old footgun: a typo'd model fell through `as ModelId` and then hit the
 * pricing table's Sonnet fallback, mis-billing without a trace. Here we warn and
 * fall back to an explicit, known default the caller chooses.
 */
function toModelId(value: string | undefined, fallback: ModelId, context: string): ModelId {
  if (value !== undefined && KNOWN_MODEL_IDS.has(value)) return value as ModelId;
  if (value !== undefined) {
    logger.warn({
      msg: 'unknown model id at trust boundary; using safe fallback',
      context,
      value,
      fallback,
    });
  }
  return fallback;
}

/**
 * Boot-time default for Skippy. The `SKIPPY_MODEL` env var (forwarded by the
 * Rust sidecar.rs supervisor) wins if set so headless tests + the Phase 0
 * exit-gate can still pin the model from the environment. After the renderer
 * sends its first `set_model`, the env-var value is shadowed by the user's
 * choice. The env value is validated, not blindly cast — an unknown
 * `SKIPPY_MODEL` warns and falls back to Opus rather than silently routing to
 * Sonnet pricing.
 */
const SKIPPY_BOOT_DEFAULT: ModelId = toModelId(
  process.env.SKIPPY_MODEL,
  OPUS_DEFAULT,
  'SKIPPY_MODEL env',
);

/**
 * Seed the per-board defaults from `BOARD_META.defaultModel`. This is the
 * *fallback* tier: once a board's charter loads, `setBoardModelFromCharter`
 * overrides it with the charter's own `model:` when that field is present and
 * valid (PRD §6.1). `BOARD_META.defaultModel` is itself validated rather than
 * cast — a bad literal there warns and falls back to Opus.
 */
function defaultBoardBindings(): Map<ScopeId, ModelId> {
  const out = new Map<ScopeId, ModelId>();
  out.set('skippy', SKIPPY_BOOT_DEFAULT);
  for (const id of BOARDS) {
    out.set(
      `board.${id}`,
      toModelId(BOARD_META[id].defaultModel, OPUS_DEFAULT, `BOARD_META[${id}].defaultModel`),
    );
  }
  return out;
}

const bindings: Map<ScopeId, ModelId> = defaultBoardBindings();

/** Scopes the user (or a `set_model` envelope) has explicitly rebound. A
 * charter load must NOT clobber a user's live choice, so charter seeding is
 * skipped for any scope present here. */
const userOverridden = new Set<ScopeId>();

/**
 * Rebind a scope to a model. Logs the change at info level so transcripts and
 * Langfuse traces can correlate cost shifts with user actions. No persistence
 * — this lives in process memory only.
 */
export function setModelFor(scope: ScopeId, modelId: ModelId): void {
  const prev = bindings.get(scope);
  bindings.set(scope, modelId);
  // A user/renderer rebind is authoritative: mark the scope so a later charter
  // load (boards settle asynchronously) can't quietly stomp the live choice.
  userOverridden.add(scope);
  logger.info({
    msg: 'model rebind',
    scope,
    modelId,
    previous: prev ?? null,
  });
}

/**
 * Seed a board's binding from its charter's `model:` field (PRD §6.1). Called by
 * the charter loader once a board charter settles, so the per-board model is the
 * charter's declared model — `BOARD_META.defaultModel` is only the fallback when
 * the charter omits or mis-spells `model:`. This is what makes the charter's
 * `model` an honored contract rather than dead frontmatter.
 *
 * No-ops when the user has already rebound this board (their live choice wins)
 * so a slow charter load never reverts a click. The charter value is validated;
 * an unknown id warns and leaves the existing `BOARD_META`-seeded binding in
 * place.
 */
export function setBoardModelFromCharter(boardId: BoardId, model: unknown): void {
  const scope: ScopeId = `board.${boardId}`;
  if (userOverridden.has(scope)) return;
  if (typeof model !== 'string' || model === '') return; // charter omitted `model:`
  if (!KNOWN_MODEL_IDS.has(model)) {
    logger.warn({
      msg: 'charter declares unknown model; keeping BOARD_META default',
      scope,
      value: model,
      fallback: bindings.get(scope) ?? null,
    });
    return;
  }
  const resolved = model as ModelId;
  if (bindings.get(scope) === resolved) return; // already on the charter model
  bindings.set(scope, resolved);
  logger.info({ msg: 'board model seeded from charter', scope, model: resolved });
}

/**
 * Resolve the active model for an agent id.
 *
 * - `skippy`        → the Skippy binding (default Opus 4.7, or `SKIPPY_MODEL`).
 * - `board.<id>`    → that board's binding. The binding is the charter's `model:`
 *                     once its charter has loaded (`setBoardModelFromCharter`),
 *                     falling back to `BOARD_META.defaultModel` before the
 *                     charter settles or when it omits/mis-spells the field.
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
