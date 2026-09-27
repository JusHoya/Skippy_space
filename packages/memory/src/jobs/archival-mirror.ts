// jobs/archival-mirror.ts — mirror archival memory writes into the Obsidian vault.
//
// Phase 3.5 (WS-D, the "D4" mirror). When an agent appends to Letta's archival
// memory (letta-client.ts → appendArchival), we *also* mirror that text into the
// durable vault so the memory survives Letta being down, wiped, or migrated. This
// is the DURABLE FALLBACK: it is PURE FILESYSTEM — no Letta, no Obsidian REST — so
// it works even with every server offline. The agent-runtime caller wraps it in an
// OTel span; we keep this module side-effect-pure (no tracing here).
//
// Each board gets one append-only `agent_log` note under `50_Agents/{board}/`.
// Writes go through the vault broker's `appendNote` (M0 WS-D, FR-WIKI-02): the
// first write creates the §8.3 header and the first section under one lock, so a
// race can no longer leave a header-less log; later writes append only. The
// board name is part of the path, so the broker's containment check rejects a
// board like `../../x` (FR-SEC-02).
//
// WIKILINK GUARD: the broker refuses relative `.md` markdown links (PRD §8.2).
// Archival text comes from agents and may contain them, so we neutralize relative
// `.md` links before appending and retry once; if it still can't be written we
// return {ok:false} cleanly. We never let the guard (or a lock) throw out of here.

import * as path from 'node:path';

import { WikilinkViolationError } from '../atomic.js';
import { makeFrontmatter } from '../frontmatter.js';
import { VaultBroker } from '../vault-broker.js';

/** Outcome of a mirror attempt. `path` is the agent_log note targeted either way. */
export interface MirrorResult {
  ok: boolean;
  path: string;
  error?: string;
}

export interface MirrorArchivalOptions {
  /** Board name, e.g. 'research'. Selects 50_Agents/{board}/agent_log.md. */
  board: string;
  /** The archival text to mirror (one passage). */
  text: string;
  /** Absolute path to the vault root. */
  vaultRoot: string;
  /** ISO timestamp for the section header. Defaults to now. */
  ts?: string;
}

/**
 * Mirror one archival passage into the board's append-only `agent_log` note.
 *
 * - target: `{vaultRoot}/50_Agents/{board}/agent_log.md`.
 * - first write (file absent): the broker creates the §8.3 `agent_log` header and
 *   the first section atomically under the note's lock.
 * - every write: append a `## {ts} — archival\n{text}` block (append-only).
 *
 * Never throws. A relative-`.md`-link in `text` is neutralized and retried once; a
 * lock contention returns {ok:false} (soft — the caller retries next cycle); a path
 * the broker rejects returns {ok:false} with the reason.
 */
export async function mirrorArchivalToVault(
  opts: MirrorArchivalOptions,
): Promise<MirrorResult> {
  const { board, text, vaultRoot } = opts;
  const ts = opts.ts ?? new Date().toISOString();
  const rel = `50_Agents/${board}/agent_log.md`;
  const target = path.join(vaultRoot, '50_Agents', board, 'agent_log.md');
  const broker = new VaultBroker(vaultRoot);

  let init: { frontmatter: Record<string, unknown>; body: string };
  try {
    init = {
      frontmatter: makeFrontmatter({
        type: 'agent_log',
        status: 'active',
        authored_by: `board.${board}`,
        source: 'gen://letta-archival',
        title: `${board} — agent log`,
      }),
      body: `# ${board} — agent log\n`,
    };
  } catch (err) {
    // A malformed-frontmatter throw (shouldn't happen with fixed inputs) must not
    // crash the mirror — degrade to {ok:false} so the caller can retry/alert.
    return { ok: false, path: target, error: errMsg(err) };
  }

  const first = await tryAppend(broker, rel, `## ${ts} — archival\n${text}`, init);
  if (first.kind === 'ok') return { ok: true, path: target };
  if (first.kind === 'locked') {
    // Soft failure — the file is held by another writer; retry on the next cycle.
    return { ok: false, path: target, error: 'agent_log is locked; retry next cycle' };
  }
  if (first.kind === 'error') return { ok: false, path: target, error: first.error };

  // first.kind === 'wikilink' — the text carried a relative .md link. Neutralize it
  // and retry ONCE. (PRD §8.2: wikilinks only; relative md links are forbidden.)
  const cleaned = `## ${ts} — archival\n${neutralizeRelativeMdLinks(text)}`;
  const second = await tryAppend(broker, rel, cleaned, init);
  if (second.kind === 'ok') return { ok: true, path: target };
  if (second.kind === 'locked') {
    return { ok: false, path: target, error: 'agent_log is locked; retry next cycle' };
  }
  if (second.kind === 'error') return { ok: false, path: target, error: second.error };
  // Still a violation after neutralization (shouldn't happen) — fail cleanly.
  return {
    ok: false,
    path: target,
    error: 'archival text still contains a relative markdown link after neutralization',
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

type AppendOutcome =
  | { kind: 'ok' }
  | { kind: 'locked' }
  | { kind: 'wikilink' }
  | { kind: 'error'; error: string };

/**
 * broker.appendNote wrapper that converts its outcomes into a small tagged union.
 * The WikilinkViolationError is trapped so the caller can neutralize + retry; path
 * rejections, append-only violations and I/O faults become `error` (never thrown).
 */
async function tryAppend(
  broker: VaultBroker,
  rel: string,
  text: string,
  init: { frontmatter: Record<string, unknown>; body: string },
): Promise<AppendOutcome> {
  try {
    const res = await broker.appendNote(rel, text, { init });
    if (res.ok) return { kind: 'ok' };
    if (res.reason === 'locked') return { kind: 'locked' };
    return { kind: 'error', error: `agent_log append not completed (${res.reason})` };
  } catch (err) {
    if (err instanceof WikilinkViolationError) return { kind: 'wikilink' };
    return { kind: 'error', error: errMsg(err) };
  }
}

// Matches a markdown link whose target is a relative `.md` path — the same family
// atomic.ts's guard rejects: `](./foo.md)`, `](../bar.md#h)`, `](notes/baz.md)`.
// Permits absolute http(s) links. We capture the visible label so we can keep it.
const RELATIVE_MD_LINK_G =
  /\[([^\]]*)\]\(\s*(?!https?:\/\/)[^)]*\.md(?:[)#?][^)]*)?\)/gi;

/**
 * Neutralize relative `.md` markdown links so the broker's wikilink guard passes. We keep
 * the human-readable label and drop the link target, turning `[see](./foo.md)` into
 * `see` (a bare wikilink would mis-target, so we don't fabricate one). Absolute
 * http(s) links are untouched.
 */
function neutralizeRelativeMdLinks(text: string): string {
  return text.replace(RELATIVE_MD_LINK_G, (_match, label: string) => {
    const visible = label.trim();
    return visible.length > 0 ? visible : '(link removed)';
  });
}

/** Extract a human-readable message from an unknown thrown value. */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
