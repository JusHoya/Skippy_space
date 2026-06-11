// obsidian-rest.ts — graceful client for the Obsidian Local REST API (PRD §8.9).
//
// Phase 3 (WS2). The Local REST API plugin (coddingtonbear, v3.5+) exposes an
// HTTP control plane over the running Obsidian app: surgical note edits, frontmatter
// PATCHes, Dataview/simple search, command triggers. We use it for the things the
// filesystem path (atomic.ts) is bad at — in-place edits + search of the *live*
// index — and for nothing the filesystem can't already do safely.
//
// THE CONTRACT (PRD §8.9 line 3): the vault's source of truth is the filesystem.
// REST is an optional accelerator. So every method here is non-throwing and returns
// a discriminated result; if Obsidian isn't running, the key is unset, or the call
// fails, the caller degrades to the `fs` path. We NEVER let a write be "successful"
// only because REST accepted it — REST writes are surgical edits on notes the fs
// layer already owns.
//
// Ports: the plugin serves HTTPS on :27124 (self-signed cert) and, when enabled,
// plain HTTP on :27123. We default to the non-TLS port to dodge the self-signed-cert
// rejection that Node's fetch would otherwise throw; an https:// URL is still honored
// if the caller sets one (and has the cert trusted / NODE_TLS_REJECT_UNAUTHORIZED).
//
// SAME RAILS AS THE fs PATH (CLAUDE.md #5 / PRD §8.2-§8.3): REST writes are still
// vault writes, so they must honor the same invariants atomic.ts enforces — wikilinks
// only (no relative `.md` links) on any appended markdown, and the §8.3 frontmatter
// contract on any frontmatter PATCH. We REUSE the canonical guards/validators from
// atomic.ts + frontmatter.ts here rather than re-deriving them, so the two write
// paths can never drift. A guard/validation failure degrades to `{ ok: false }`
// *before* the network call — REST must not be a backdoor around the rules.

import { hasRelativeMdLink } from './atomic.js';
import { validateFrontmatter, makeFrontmatter } from './frontmatter.js';

// ──────────────────────────────────────────────────────────────────────────────
// Result type — mirrors the {ok}-discriminated style used across @skippy/memory.
// ──────────────────────────────────────────────────────────────────────────────

export type RestResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

/**
 * Health signal for the Obsidian REST layer (D1), mirroring Letta's `LettaStatus`
 * so callers can tell *why* a method degraded rather than only seeing `{ ok: false }`:
 *   - `connected` — the plugin answered the probe; surgical edits/search should work.
 *   - `degraded`  — reachable at the connection level but not healthy (a non-2xx that
 *                   isn't a transport failure, e.g. the bearer token was rejected).
 *   - `down`      — unreachable (ECONNREFUSED / DNS / timeout); Obsidian/the plugin
 *                   is off, so callers should take the `fs` path.
 *   - `no-key`    — no `OBSIDIAN_API_KEY` configured; REST is definitionally
 *                   unavailable and zero network was done (the analogue of Letta's
 *                   `disabled`).
 */
export type ObsidianStatus = 'connected' | 'degraded' | 'down' | 'no-key';

export interface ObsidianRestConfig {
  /** Base URL of the Local REST API. Default: env OBSIDIAN_API_URL or the :27123 HTTP port. */
  apiUrl?: string;
  /** Bearer token from the plugin's settings. Default: env OBSIDIAN_API_KEY. */
  apiKey?: string | undefined;
  /** Per-request timeout in ms. Default 2500. */
  timeoutMs?: number;
}

const DEFAULT_API_URL = 'http://127.0.0.1:27123';
const DEFAULT_TIMEOUT_MS = 2500;

/**
 * A best-effort client for the Obsidian Local REST API. Construct it freely even
 * when Obsidian is offline — every method degrades to `{ ok: false }`. Call
 * `available()` first if you want to skip work entirely when REST is down.
 */
export class ObsidianRestClient {
  private readonly apiUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;

  // Cached health probe. `undefined` = not yet probed; resets are not needed for a
  // job's lifetime (a job either has REST or it doesn't), but `available()`/`status()`
  // accept a `force` flag for long-lived clients that want to re-check. We cache the
  // richer `ObsidianStatus` and derive the boolean `available()` from it.
  private statusProbe: Promise<ObsidianStatus> | undefined;

  constructor(config: ObsidianRestConfig = {}) {
    // Trim a trailing slash so we can join paths with a leading slash uniformly.
    const url = config.apiUrl ?? process.env.OBSIDIAN_API_URL ?? DEFAULT_API_URL;
    this.apiUrl = url.replace(/\/+$/, '');
    // An explicit `apiKey: undefined` in config should still fall through to env.
    this.apiKey =
      config.apiKey !== undefined ? config.apiKey : process.env.OBSIDIAN_API_KEY;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** True iff a bearer token is configured. No token → REST is definitionally unavailable. */
  private hasKey(): boolean {
    return typeof this.apiKey === 'string' && this.apiKey.length > 0;
  }

  /**
   * Cached reachability probe. Returns true only if a key is set AND the endpoint
   * answers a GET on `/` (the plugin's root returns an auth/status payload). Any
   * failure — no key, ECONNREFUSED, timeout, non-2xx — yields false, never throws.
   * Pass `force: true` to bypass the cache.
   */
  async available(force = false): Promise<boolean> {
    return (await this.status(force)) === 'connected';
  }

  /**
   * Cached health signal — see {@link ObsidianStatus}. Returns `no-key` IMMEDIATELY
   * (no network) when no bearer token is configured. Otherwise probes the plugin and
   * reports `connected` / `degraded` / `down` so callers can distinguish a working
   * REST plugin from one that's up-but-unhealthy (e.g. a rejected token) from one
   * that's off. Never throws. Pass `force: true` to bypass the cache.
   */
  async status(force = false): Promise<ObsidianStatus> {
    if (!this.hasKey()) return 'no-key';
    if (this.statusProbe === undefined || force) {
      this.statusProbe = this.probe();
    }
    return this.statusProbe;
  }

  private async probe(): Promise<ObsidianStatus> {
    // The plugin's root `/` returns 200 with `{ status: "OK", ... }` for an
    // authenticated request. We treat any 2xx as `connected`. A non-2xx that still
    // carried an HTTP status (the box answered, e.g. a 401 rejected token) is
    // `degraded`; a transport failure with no status (ECONNREFUSED/timeout) is `down`.
    const res = await this.request('GET', '/');
    if (res.ok) return 'connected';
    return res.status !== undefined ? 'degraded' : 'down';
  }

  /**
   * Read a vault-relative file's raw content (markdown incl. frontmatter).
   * `vaultRelPath` is POSIX-style relative to the vault root, e.g. `10_Atomic/x.md`.
   */
  async readFile(vaultRelPath: string): Promise<RestResult<string>> {
    const res = await this.request('GET', `/vault/${encodePath(vaultRelPath)}`, {
      // Ask for the raw markdown rather than the JSON note-wrapper.
      accept: 'text/markdown',
    });
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, data: res.body };
  }

  /**
   * Surgically PATCH a single frontmatter field on a note. Uses the plugin's
   * PATCH contract: target the `frontmatter` content-type with the field name in
   * the `Target` header (Operation: replace). The value is JSON-encoded so arrays
   * / numbers / strings all round-trip. This edits the live note in place without
   * us re-serializing the whole file.
   */
  async patchFrontmatter(
    vaultRelPath: string,
    key: string,
    value: unknown,
  ): Promise<RestResult<true>> {
    // §8.3 guard: a frontmatter PATCH is a vault write, so the new value must hold
    // for the field it targets (e.g. `type`/`status` are closed enums, `confidence`
    // is 0..1). We validate the single field against the canonical schema *before*
    // touching the network so REST can't smuggle an out-of-schema value past the
    // contract the fs path enforces. Fields the §8.3 schema doesn't constrain
    // (passthrough keys like `schema_version`) pass through untouched.
    const fieldErr = validateFrontmatterField(key, value);
    if (fieldErr !== null) {
      return { ok: false, error: `patchFrontmatter: ${fieldErr}` };
    }
    const res = await this.request('PATCH', `/vault/${encodePath(vaultRelPath)}`, {
      contentType: 'application/json',
      headers: {
        Operation: 'replace',
        'Target-Type': 'frontmatter',
        Target: key,
      },
      // The Local REST API expects the JSON value as the body for a frontmatter PATCH.
      body: JSON.stringify(value),
    });
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, data: true };
  }

  /**
   * Append a markdown block to the end of a note (creates the note if missing).
   * Append-only — matches the §8.5 agent_log/daily semantics without re-reading.
   */
  async appendBlock(vaultRelPath: string, markdown: string): Promise<RestResult<true>> {
    // Wikilink guard (CLAUDE.md #5 / PRD §8.2): appended markdown is a vault write,
    // so relative `.md` links are forbidden here exactly as in atomic.ts. We reuse
    // atomic.ts's own predicate (single source of truth) and degrade to {ok:false}
    // before the network call rather than throwing — callers expect a soft result.
    if (hasRelativeMdLink(markdown)) {
      return {
        ok: false,
        error: `appendBlock to "${vaultRelPath}" contains a relative markdown link; use [[wikilinks]] only (PRD §8.2)`,
      };
    }
    const res = await this.request('POST', `/vault/${encodePath(vaultRelPath)}`, {
      contentType: 'text/markdown',
      body: markdown,
    });
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, data: true };
  }

  /**
   * Simple full-text search via the plugin's `/search/simple/` endpoint. Returns
   * matched note paths with a relevance score. If the endpoint is unsupported on
   * the installed plugin version (404), this degrades to `{ ok: false }` and the
   * caller should fall back to graph-walk/keyword (PRD §8.7 step 3-4).
   */
  async search(query: string): Promise<RestResult<SearchHit[]>> {
    // `/search/simple/` takes the query as a `query` URL param and returns an
    // array of `{ filename, score, matches }`. We normalize to SearchHit[].
    const res = await this.request(
      'POST',
      `/search/simple/?query=${encodeURIComponent(query)}`,
      { accept: 'application/json' },
    );
    if (!res.ok) return { ok: false, error: res.error };
    try {
      const parsed = JSON.parse(res.body) as unknown;
      if (!Array.isArray(parsed)) {
        return { ok: false, error: 'search: unexpected response shape (not an array)' };
      }
      const hits: SearchHit[] = parsed.map((row) => {
        const r = row as { filename?: unknown; score?: unknown };
        return {
          path: typeof r.filename === 'string' ? r.filename : '',
          score: typeof r.score === 'number' ? r.score : 0,
        };
      });
      return { ok: true, data: hits };
    } catch (err) {
      return { ok: false, error: `search: bad JSON — ${errMsg(err)}` };
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Low-level request — the single place that touches the network. Wraps fetch
  // with a bearer header, an AbortController timeout, and total error capture so
  // no method above ever throws.
  // ──────────────────────────────────────────────────────────────────────────

  private async request(
    method: string,
    pathAndQuery: string,
    opts: {
      accept?: string;
      contentType?: string;
      headers?: Record<string, string>;
      body?: string;
    } = {},
  ): Promise<
    | { ok: true; status: number; body: string }
    | { ok: false; status?: number; error: string }
  > {
    if (!this.hasKey()) {
      return { ok: false, error: 'OBSIDIAN_API_KEY is not set; REST is unavailable' };
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey ?? ''}`,
      ...(opts.accept ? { Accept: opts.accept } : {}),
      ...(opts.contentType ? { 'Content-Type': opts.contentType } : {}),
      ...(opts.headers ?? {}),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.apiUrl}${pathAndQuery}`, {
        method,
        headers,
        ...(opts.body !== undefined ? { body: opts.body } : {}),
        signal: controller.signal,
      });
      const body = await res.text();
      if (!res.ok) {
        // Carry the HTTP status so `probe()` can tell `degraded` (the box answered)
        // from `down` (a transport failure that never reaches this branch).
        return {
          ok: false,
          status: res.status,
          error: `HTTP ${res.status} ${res.statusText}: ${body.slice(0, 200)}`,
        };
      }
      return { ok: true, status: res.status, body };
    } catch (err) {
      // ECONNREFUSED, AbortError (timeout), DNS, TLS — all land here. Degrade.
      return { ok: false, error: errMsg(err) };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** A normalized search result: a vault-relative path and a relevance score. */
export interface SearchHit {
  path: string;
  score: number;
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Validate a single frontmatter field against the §8.3 schema, returning a human
 * error string or `null` if the value is acceptable for that key. Reuses the
 * canonical validators (`makeFrontmatter` for a valid baseline + `validateFrontmatter`
 * for the check) rather than re-listing the enums/ranges, so REST and the fs path
 * can't drift.
 *
 * We validate the field in isolation by overriding it on a known-valid baseline and
 * keeping only the issues that target the patched key — so the schema's cross-field
 * `superRefine` (e.g. atomic_fact↔source) never produces a false positive about a
 * *different* field we aren't touching. Keys the §8.3 schema doesn't constrain
 * (passthrough) are always accepted.
 */
function validateFrontmatterField(key: string, value: unknown): string | null {
  // A baseline that satisfies the schema with zero superRefine coupling: a non-
  // atomic_fact type with a source means the §8.10 sourceless-fact rule never fires,
  // so any residual issue is attributable to the field we override below.
  const baseline = makeFrontmatter({
    title: 'patch-probe',
    type: 'concept',
    authored_by: 'obsidian.rest',
    source: 'ref:patch-probe',
    status: 'active',
  }) as Record<string, unknown>;
  const candidate = { ...baseline, [key]: value };
  const res = validateFrontmatter(candidate);
  if (res.ok) return null;
  // `validateFrontmatter` formats issues as `"<path>: <message>"`. Keep only the
  // ones whose path is the patched key — passthrough keys (not in the §8.3 core
  // set) never produce an issue for their own path, so they pass through untouched,
  // and cross-field superRefine issues (which target a *different* field) are
  // excluded so we never reject a value the patched field actually accepts.
  const prefix = `${key}: `;
  const own = res.errors.filter((e) => e.startsWith(prefix));
  return own.length > 0 ? own.join('; ') : null;
}

/** Percent-encode a vault-relative path segment-wise (keep the `/` separators). */
function encodePath(vaultRelPath: string): string {
  return vaultRelPath
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
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
