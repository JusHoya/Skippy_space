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
// ENDPOINTS (Letta REST, v1): several are flagged PROVISIONAL below — Letta's archival
// body shape and core-memory verb/path have shifted across releases, so we encode our
// best current guess and mark each with a TODO to reconcile against the live server.

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
   * Search an agent's archival memory. POST /v1/agents/{agentId}/archival/search
   * with `{ query, limit }`. Returns normalized `{ results }`. The response shape
   * varies across Letta versions (a bare array, `{ results: [...] }`, or passages
   * with a `text`/`content` field), so we map defensively to `ArchivalHit[]`.
   */
  async searchArchival(
    agentId: string,
    query: string,
    limit = 10,
  ): Promise<LettaResult<{ results: ArchivalHit[] }>> {
    const res = await this.request(
      'POST',
      `/v1/agents/${encodeURIComponent(agentId)}/archival/search`,
      { query, limit },
    );
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, data: { results: normalizeArchivalHits(res.json) } };
  }

  /**
   * Append a passage to an agent's archival memory.
   * POST /v1/agents/{agentId}/archival/insert with `{ text }`.
   *
   * TODO(letta-provisional): Letta v1's archival insert body shape has drifted
   * across releases (`{ text }` vs `{ content }` vs `{ memory: { ... } }`). We send
   * `{ text }` first as the most common contract; reconcile against the live server
   * and widen if a 422 surfaces.
   */
  async appendArchival(
    agentId: string,
    text: string,
  ): Promise<LettaResult<{ id?: string }>> {
    const res = await this.request(
      'POST',
      `/v1/agents/${encodeURIComponent(agentId)}/archival/insert`,
      { text },
    );
    if (!res.ok) return { ok: false, error: res.error };
    // The insert response (often the created passage) may or may not carry an id.
    const id = extractId(res.json);
    return { ok: true, data: id !== undefined ? { id } : {} };
  }

  /**
   * Replace the value of a core-memory block (always-in-context memory).
   * PATCH /v1/agents/{agentId}/core-memory/blocks/{block} with `{ value }`.
   *
   * TODO(letta-provisional): the exact path AND verb for core-block edits have
   * varied (`/core-memory/blocks/{label}` PATCH vs `/memory/block/{label}` POST vs a
   * label query param). We encode PATCH + `/core-memory/blocks/{block}` as the
   * current best guess; reconcile against the live server.
   */
  async editCore(
    agentId: string,
    block: string,
    value: string,
  ): Promise<LettaResult<unknown>> {
    const res = await this.request(
      'PATCH',
      `/v1/agents/${encodeURIComponent(agentId)}/core-memory/blocks/${encodeURIComponent(block)}`,
      { value },
    );
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, data: res.json };
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
