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

// ──────────────────────────────────────────────────────────────────────────────
// Result type — mirrors the {ok}-discriminated style used across @skippy/memory.
// ──────────────────────────────────────────────────────────────────────────────

export type RestResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

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

  // Cached availability probe. `undefined` = not yet probed; resets are not needed
  // for a job's lifetime (a job either has REST or it doesn't), but `available()`
  // accepts a `force` flag for long-lived clients that want to re-check.
  private availabilityProbe: Promise<boolean> | undefined;

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
    if (!this.hasKey()) return false;
    if (this.availabilityProbe === undefined || force) {
      this.availabilityProbe = this.probe();
    }
    return this.availabilityProbe;
  }

  private async probe(): Promise<boolean> {
    // The plugin's root `/` returns 200 with `{ status: "OK", ... }` for an
    // authenticated request. We treat any 2xx as reachable.
    const res = await this.request('GET', '/');
    return res.ok;
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
  ): Promise<{ ok: true; status: number; body: string } | { ok: false; error: string }> {
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
        return { ok: false, error: `HTTP ${res.status} ${res.statusText}: ${body.slice(0, 200)}` };
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
