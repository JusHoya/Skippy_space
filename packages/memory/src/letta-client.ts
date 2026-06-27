// letta-client.ts — graceful client for the self-hosted Letta server (PRD §8 hot memory).
//
// Phase 3.5 (WS-C). Letta is Skippy's *hot* memory layer: core blocks (always in
// context), recall (conversation history), and archival (the searchable long-term
// store). The vault (atomic.ts / obsidian-rest.ts) is the *durable* layer; Letta is
// the fast, agent-native one in front of it.
//
// THE CONTRACT (mirrors obsidian-rest.ts): Letta is an *optional accelerator*, never
// a source of truth. So every method here is non-throwing and returns the same
// {ok}-discriminated result used across @skippy/memory. If the Letta server isn't
// running, the URL is wrong, or a call fails, the caller degrades — typically to the
// archival->vault mirror (jobs/archival-mirror.ts), which is pure filesystem and
// works with everything down.
//
// ZERO zod (unlike frontmatter.ts) — this module is imported by agent-runtime, which
// lives on a different zod major. We use plain TS shapes so the types cross that
// boundary safely. We parse responses defensively at runtime instead.
//
// KILL SWITCH: `LETTA_DISABLED=1` short-circuits *every* method to {ok:false} with
// ZERO network I/O — for offline CI, the exit-gate validators, and any run that must
// not touch :8283. `available()` likewise returns false immediately in that mode.
//
// ENDPOINTS (Letta REST, v1): VERIFIED 2026-06 against the current Letta server REST
// API (docs.letta.com, the line `infra/letta/docker-compose.yml` pins via
// `letta/letta:latest`). Paths confirmed:
//   - archival INSERT  → POST  /v1/agents/{id}/archival-memory          body { text }
//       https://docs.letta.com/api/python/resources/agents/subresources/passages/methods/create
//   - archival SEARCH  → GET   /v1/agents/{id}/archival-memory/search   ?query=&top_k=
//       https://docs.letta.com/api/python/resources/agents/subresources/passages/methods/search/
//   - core-memory EDIT → PATCH /v1/agents/{id}/core-memory/blocks/{label}  body { value }
//       https://docs.letta.com/api/resources/agents/subresources/blocks/methods/update/
//   - agent CREATE     → POST  /v1/agents                                body { name, memory_blocks }
//       https://docs.letta.com/api/resources/agents/methods/create/
//   - agent LIST       → GET   /v1/agents                                ?name=
//       https://docs.letta.com/api/resources/agents/methods/list/
// Letta's archival path/body and core-memory verb HAVE drifted across releases
// (older builds used POST /archival/insert + /archival/search with {content}/{limit},
// and /memory/block/{label}). Because the compose tag is the floating `:latest`, each
// write method below tries the VERIFIED-current shape FIRST and then falls back through
// the known legacy variants — so a version drift degrades (a fallback path may still
// answer) rather than hard-failing. Every method stays non-throwing and zod-free.

// ──────────────────────────────────────────────────────────────────────────────
// Result type — mirrors the {ok}-discriminated style used across @skippy/memory
// (RestResult in obsidian-rest.ts, ValidateResult in frontmatter.ts).
// ──────────────────────────────────────────────────────────────────────────────

export type LettaResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

/**
 * Health signal for the Letta hot-memory layer, so callers can tell *why* a method
 * degraded instead of only seeing `{ ok: false }`:
 *   - `connected` — the server answered the probe; reads/writes should work.
 *   - `degraded`  — reachable at the connection level but not healthy (a non-2xx
 *                   that isn't a transport failure, e.g. auth rejected or a server
 *                   error). Calls will likely keep failing, but the box is *up*.
 *   - `down`      — unreachable (ECONNREFUSED / DNS / timeout). The server is off.
 *   - `disabled`  — the `LETTA_DISABLED=1` kill switch is set; zero network was done.
 * `down` and `disabled` are both "no Letta," but distinguishing them lets ops tell a
 * crashed server from an intentional offline run.
 */
export type LettaStatus = 'connected' | 'degraded' | 'down' | 'disabled';

export interface LettaClientConfig {
  /** Base URL of the Letta server. Default: env LETTA_BASE_URL or :8283. */
  baseUrl?: string;
  /** Bearer token (Letta Cloud / authed self-host). Default: env LETTA_API_KEY. */
  apiKey?: string | undefined;
  /** Per-request timeout in ms. Default 2500. */
  timeoutMs?: number;
}

/** Default self-hosted Letta server URL (matches .env.example LETTA_BASE_URL). */
const DEFAULT_BASE_URL = 'http://localhost:8283';
const DEFAULT_TIMEOUT_MS = 2500;

/** One normalized archival search hit: the stored text and an optional provenance. */
export interface ArchivalHit {
  text: string;
  source?: string;
}

/** A minimal agent record (id + human-readable name), normalized from list/create. */
export interface LettaAgentSummary {
  /** Letta's DB id (e.g. `agent-<uuid>`). May be '' if a create response omits it. */
  id: string;
  /** The agent's human handle (matches a charter's `memory.letta_agent_id`). */
  name: string;
}

/** One core-memory block to seed at agent-create time (e.g. persona/human). */
export interface MemoryBlockSpec {
  label: string;
  value: string;
}

/** Spec for {@link LettaClient.createAgent}. Only `name` is required; the server
 * applies its configured default LLM + embedding when `model`/`embedding` are
 * omitted, which is the usual self-hosted path. */
export interface CreateAgentSpec {
  name: string;
  memoryBlocks?: MemoryBlockSpec[];
  model?: string;
  embedding?: string;
}

/** HTTP statuses that mean "the server answered but rejected this route/body" — the
 * only case where trying the next (legacy) endpoint variant can succeed. */
const RETRYABLE_SHAPE = new Set([400, 404, 405, 415, 422]);

/**
 * A best-effort client for the Letta REST API. Construct it freely even when Letta
 * is offline — every method degrades to `{ ok: false }`, never throws. Call
 * `available()` first if you want to skip work entirely when Letta is down.
 *
 * Set `LETTA_DISABLED=1` in the environment to force the whole client into a
 * zero-network degraded mode (CI / exit gates).
 */
export class LettaClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;

  // Cached health probe. `undefined` = not yet probed. A job either has Letta or it
  // doesn't for its lifetime; `available()`/`status()` take a `force` flag for
  // long-lived clients that want to re-check. We cache the richer `LettaStatus` and
  // derive the boolean `available()` from it, so a single probe answers both.
  private statusProbe: Promise<LettaStatus> | undefined;

  constructor(config: LettaClientConfig = {}) {
    // Trim a trailing slash so we can join paths with a leading slash uniformly.
    const url = config.baseUrl ?? process.env.LETTA_BASE_URL ?? DEFAULT_BASE_URL;
    this.baseUrl = url.replace(/\/+$/, '');
    // An explicit `apiKey: undefined` in config should still fall through to env.
    this.apiKey =
      config.apiKey !== undefined ? config.apiKey : process.env.LETTA_API_KEY;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** True when the kill switch is set; every method short-circuits, zero network. */
  private disabled(): boolean {
    return process.env.LETTA_DISABLED === '1';
  }

  /**
   * Cached reachability probe. Returns false IMMEDIATELY (no network) when
   * `LETTA_DISABLED=1`. Otherwise GETs `/` and, on a 404, falls back to
   * `/v1/health` — different Letta versions answer one or the other. Any failure
   * (ECONNREFUSED, timeout, non-2xx on both) yields false, never throws. Pass
   * `force: true` to bypass the cache.
   */
  async available(force = false): Promise<boolean> {
    return (await this.status(force)) === 'connected';
  }

  /**
   * Cached health signal — see {@link LettaStatus}. Returns `disabled` IMMEDIATELY
   * (no network) under `LETTA_DISABLED=1`. Otherwise probes the server and reports
   * `connected` / `degraded` / `down` so callers can distinguish a working server
   * from one that's up-but-unhealthy from one that's off. Never throws. Pass
   * `force: true` to bypass the cache.
   */
  async status(force = false): Promise<LettaStatus> {
    if (this.disabled()) return 'disabled';
    if (this.statusProbe === undefined || force) {
      this.statusProbe = this.probe();
    }
    return this.statusProbe;
  }

  private async probe(): Promise<LettaStatus> {
    // Root `/` answers on most builds; some only expose `/v1/health`. Treat any 2xx
    // as reachable (`connected`). We only fall through to the health route on a 404 —
    // a reachable server that simply lacks the root handler.
    const root = await this.request('GET', '/');
    if (root.ok) return 'connected';
    if (root.status === 404) {
      const health = await this.request('GET', '/v1/health');
      if (health.ok) return 'connected';
      // 404 on root but health also non-2xx: the box is up (it answered HTTP) but
      // not serving a healthy API → degraded, not down.
      return health.status !== undefined ? 'degraded' : 'down';
    }
    // A non-2xx status on root (auth rejected, 5xx, etc.) means the server answered
    // — it's reachable but unhealthy → degraded. A `status === undefined` here means
    // the request never completed at the HTTP level (ECONNREFUSED / timeout / DNS) →
    // the server is down.
    return root.status !== undefined ? 'degraded' : 'down';
  }

  /**
   * Search an agent's archival memory. VERIFIED current shape:
   * GET /v1/agents/{agentId}/archival-memory/search?query=&top_k= → `{ results }`.
   *
   * Falls back to the legacy POST shapes (`/archival/search` and
   * `/archival-memory/search` with a `{ query, limit }` body) when the current path
   * 404/405/422s, so a drifted server still answers. The response shape varies across
   * versions (a bare array, `{ results: [...] }`, `{ passages: [...] }`, or passages
   * carrying a `text`/`content` field), so we map defensively to `ArchivalHit[]`.
   */
  async searchArchival(
    agentId: string,
    query: string,
    limit = 10,
  ): Promise<LettaResult<{ results: ArchivalHit[] }>> {
    const id = encodeURIComponent(agentId);
    const res = await this.requestFirstOk([
      // VERIFIED 2026-06: GET archival-memory/search with query params.
      { method: 'GET', path: withQuery(`/v1/agents/${id}/archival-memory/search`, { query, top_k: limit }) },
      // Legacy POST variants (pre-rename / POST-search builds).
      { method: 'POST', path: `/v1/agents/${id}/archival-memory/search`, body: { query, top_k: limit } },
      { method: 'POST', path: `/v1/agents/${id}/archival/search`, body: { query, limit } },
    ]);
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, data: { results: normalizeArchivalHits(res.json) } };
  }

  /**
   * Append a passage to an agent's archival memory. VERIFIED current shape:
   * POST /v1/agents/{agentId}/archival-memory with `{ text }`.
   *
   * Falls back through the known legacy variants — the older `/archival/insert`
   * route and the `{ content }` body shape — when the current path/shape 404/405/422s,
   * so a drifted server still writes. The insert response (often the created passage,
   * sometimes an array of them) may or may not carry an id; we extract it defensively.
   */
  async appendArchival(
    agentId: string,
    text: string,
  ): Promise<LettaResult<{ id?: string }>> {
    const id = encodeURIComponent(agentId);
    const res = await this.requestFirstOk([
      // VERIFIED 2026-06: POST archival-memory with { text }.
      { method: 'POST', path: `/v1/agents/${id}/archival-memory`, body: { text } },
      // Legacy route (pre-rename builds).
      { method: 'POST', path: `/v1/agents/${id}/archival/insert`, body: { text } },
      // Body-shape variant some releases used (`content` instead of `text`).
      { method: 'POST', path: `/v1/agents/${id}/archival-memory`, body: { content: text } },
    ]);
    if (!res.ok) return { ok: false, error: res.error };
    const newId = extractId(res.json);
    return { ok: true, data: newId !== undefined ? { id: newId } : {} };
  }

  /**
   * Replace the value of a core-memory block (always-in-context memory). VERIFIED
   * current shape: PATCH /v1/agents/{agentId}/core-memory/blocks/{block} with
   * `{ value }`.
   *
   * Falls back through the known legacy verb/path variants (POST same path, and
   * PATCH `/memory/block/{label}`) when the current shape 404/405/422s, so a drifted
   * server still applies the edit.
   */
  async editCore(
    agentId: string,
    block: string,
    value: string,
  ): Promise<LettaResult<unknown>> {
    const id = encodeURIComponent(agentId);
    const b = encodeURIComponent(block);
    const res = await this.requestFirstOk([
      // VERIFIED 2026-06: PATCH core-memory/blocks/{label} with { value }.
      { method: 'PATCH', path: `/v1/agents/${id}/core-memory/blocks/${b}`, body: { value } },
      // Verb variant some proxies/builds accept.
      { method: 'POST', path: `/v1/agents/${id}/core-memory/blocks/${b}`, body: { value } },
      // Legacy path (pre-rename builds).
      { method: 'PATCH', path: `/v1/agents/${id}/memory/block/${b}`, body: { value } },
    ]);
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, data: res.json };
  }

  /**
   * List agents on the server, optionally filtered by `name` (exact-name query).
   * GET /v1/agents?name= → `LettaAgentSummary[]`. Used by the letta-bootstrap job to
   * decide whether a board's agent already exists (idempotent provisioning). Returns
   * `{ ok: false }` — never throws — when Letta is down/disabled. The response is a
   * bare array of agent objects each carrying `id` + `name`; we map defensively.
   */
  async listAgents(name?: string): Promise<LettaResult<LettaAgentSummary[]>> {
    const path =
      name !== undefined && name.length > 0
        ? withQuery('/v1/agents', { name })
        : '/v1/agents';
    const res = await this.request('GET', path);
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, data: normalizeAgentSummaries(res.json) };
  }

  /**
   * Create an agent. VERIFIED current shape: POST /v1/agents with
   * `{ name, memory_blocks: [{ label, value }] }` (the server applies its own
   * configured default LLM + embedding when those fields are omitted). Returns the
   * created agent's `{ id, name }`. Used by letta-bootstrap to provision a board's
   * agent when `listAgents(name)` finds none. Non-throwing; `{ ok: false }` when Letta
   * is down/disabled or the create is rejected.
   */
  async createAgent(spec: CreateAgentSpec): Promise<LettaResult<LettaAgentSummary>> {
    const body: Record<string, unknown> = { name: spec.name };
    if (spec.memoryBlocks && spec.memoryBlocks.length > 0) {
      body.memory_blocks = spec.memoryBlocks.map((b) => ({ label: b.label, value: b.value }));
    }
    if (spec.model !== undefined) body.model = spec.model;
    if (spec.embedding !== undefined) body.embedding = spec.embedding;
    const res = await this.request('POST', '/v1/agents', body);
    if (!res.ok) return { ok: false, error: res.error };
    const summary = normalizeAgentSummary(res.json);
    if (summary === undefined) {
      // A 2xx with an unrecognizable body still means the agent was created; surface
      // the name we asked for so the caller can proceed (id is best-effort).
      return { ok: true, data: { id: extractId(res.json) ?? '', name: spec.name } };
    }
    return { ok: true, data: summary };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Fallback driver — try a sequence of (method, path, body) candidates, returning
  // the first 2xx. Continues to the next candidate ONLY on a "wrong shape/path"
  // status (the server answered but rejected the route or body: 400/404/405/415/422).
  // A transport failure (status undefined → server down/timeout) stops immediately —
  // every candidate would fail the same way and burn a full timeout each. A hard
  // status (401/403/5xx) likewise stops: a different path won't fix auth or a crash.
  // ──────────────────────────────────────────────────────────────────────────

  private async requestFirstOk(
    candidates: Array<{ method: string; path: string; body?: unknown }>,
  ): Promise<
    | { ok: true; status: number; json: unknown }
    | { ok: false; status?: number; error: string }
  > {
    let last: { ok: false; status?: number; error: string } = {
      ok: false,
      error: 'no request attempted',
    };
    for (const c of candidates) {
      const res = await this.request(c.method, c.path, c.body);
      if (res.ok) return res;
      last = res;
      // Only a recoverable shape/path rejection is worth another candidate.
      if (res.status === undefined || !RETRYABLE_SHAPE.has(res.status)) break;
    }
    return last;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Low-level request — the single place that touches the network. Wraps fetch
  // with a JSON body, an optional bearer header, an AbortController timeout, and
  // total error capture so no method above ever throws. Honors LETTA_DISABLED by
  // short-circuiting before any fetch.
  // ──────────────────────────────────────────────────────────────────────────

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<
    | { ok: true; status: number; json: unknown }
    | { ok: false; status?: number; error: string }
  > {
    // Kill switch — zero network. Mirrors obsidian-rest's no-key short-circuit.
    if (this.disabled()) {
      return { ok: false, error: 'Letta disabled' };
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(this.hasKey() ? { Authorization: `Bearer ${this.apiKey ?? ''}` } : {}),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      const raw = await res.text();
      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          error: `HTTP ${res.status} ${res.statusText}: ${raw.slice(0, 200)}`,
        };
      }
      // Tolerate an empty 2xx body (e.g. a 204) — treat as `null` JSON.
      const json = raw.length > 0 ? safeJsonParse(raw) : null;
      return { ok: true, status: res.status, json };
    } catch (err) {
      // ECONNREFUSED, AbortError (timeout), DNS — all land here. Degrade.
      return { ok: false, error: errMsg(err) };
    } finally {
      clearTimeout(timer);
    }
  }

  /** True iff a bearer token is configured. No token is fine for an open self-host. */
  private hasKey(): boolean {
    return typeof this.apiKey === 'string' && this.apiKey.length > 0;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Defensive response normalization (no zod — Letta shapes drift across versions)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Coerce a Letta archival-search response into `ArchivalHit[]`. Accepts:
 *   - a bare array of passages,
 *   - `{ results: [...] }`,
 *   - `{ archival_memory: [...] }`,
 * where each passage is a string OR carries `text` / `content`, and an optional
 * `source` / `source_id`. Anything unrecognized maps to `[]` rather than throwing.
 */
function normalizeArchivalHits(json: unknown): ArchivalHit[] {
  const rows = pickArray(json);
  const hits: ArchivalHit[] = [];
  for (const row of rows) {
    if (typeof row === 'string') {
      if (row.length > 0) hits.push({ text: row });
      continue;
    }
    if (typeof row === 'object' && row !== null) {
      const r = row as Record<string, unknown>;
      const text =
        typeof r['text'] === 'string'
          ? r['text']
          : typeof r['content'] === 'string'
            ? r['content']
            : undefined;
      if (text === undefined || text.length === 0) continue;
      const source =
        typeof r['source'] === 'string'
          ? r['source']
          : typeof r['source_id'] === 'string'
            ? r['source_id']
            : undefined;
      // exactOptionalPropertyTypes: only attach `source` when it's a real string.
      hits.push(source !== undefined ? { text, source } : { text });
    }
  }
  return hits;
}

/** Find the passage array inside the various wrapper shapes Letta returns. */
function pickArray(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  if (typeof json === 'object' && json !== null) {
    const o = json as Record<string, unknown>;
    if (Array.isArray(o['results'])) return o['results'];
    if (Array.isArray(o['archival_memory'])) return o['archival_memory'];
    if (Array.isArray(o['passages'])) return o['passages'];
  }
  return [];
}

/**
 * Coerce a Letta list-agents response into `LettaAgentSummary[]`. Accepts a bare
 * array OR a `{ agents: [...] }` / `{ results: [...] }` wrapper, mapping any element
 * carrying a string `id`/`name` through {@link normalizeAgentSummary}. Unrecognized
 * rows are dropped rather than throwing.
 */
function normalizeAgentSummaries(json: unknown): LettaAgentSummary[] {
  const rows = Array.isArray(json)
    ? json
    : typeof json === 'object' && json !== null
      ? (Array.isArray((json as Record<string, unknown>)['agents'])
          ? ((json as Record<string, unknown>)['agents'] as unknown[])
          : Array.isArray((json as Record<string, unknown>)['results'])
            ? ((json as Record<string, unknown>)['results'] as unknown[])
            : [])
      : [];
  const out: LettaAgentSummary[] = [];
  for (const row of rows) {
    const s = normalizeAgentSummary(row);
    if (s !== undefined) out.push(s);
  }
  return out;
}

/** Map a single agent object to `{ id, name }`, or undefined if it has neither. */
function normalizeAgentSummary(json: unknown): LettaAgentSummary | undefined {
  if (typeof json !== 'object' || json === null) return undefined;
  const o = json as Record<string, unknown>;
  const id = typeof o['id'] === 'string' ? o['id'] : undefined;
  const name = typeof o['name'] === 'string' ? o['name'] : undefined;
  if (id === undefined && name === undefined) return undefined;
  return { id: id ?? '', name: name ?? '' };
}

/** Append a query string to a path, URL-encoding values and skipping undefined ones.
 * Numbers/booleans are stringified. No leading `?` is added when nothing applies. */
function withQuery(path: string, params: Record<string, string | number | undefined>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length > 0 ? `${path}?${parts.join('&')}` : path;
}

/** Pull an `id` out of an insert response (object or `{ id }`-bearing array head). */
function extractId(json: unknown): string | undefined {
  const obj =
    Array.isArray(json) && json.length > 0
      ? json[0]
      : json;
  if (typeof obj === 'object' && obj !== null) {
    const id = (obj as Record<string, unknown>)['id'];
    if (typeof id === 'string') return id;
  }
  return undefined;
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

/** Parse JSON without throwing; bad JSON degrades to `null`. */
function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** Extract a human-readable message from an unknown thrown value. */
function errMsg(err: unknown): string {
  if (err instanceof Error) {
    // AbortController fires a DOMException named 'AbortError' on timeout.
    if (err.name === 'AbortError') return 'request timed out';
    return err.message;
  }
  return String(err);
}
