// jobs/archival-mirror.ts — mirror archival memory writes into the Obsidian vault.
//
// Phase 3.5 (WS-D, the "D4" mirror). When an agent appends to Letta's archival
// memory (letta-client.ts → appendArchival), we *also* mirror that text into the
// durable vault so the memory survives Letta being down, wiped, or migrated. This
// is the DURABLE FALLBACK: it is PURE FILESYSTEM — no Letta, no Obsidian REST — so
// it works even with every server offline. The agent-runtime caller wraps it in an
// OTel span; we keep this module side-effect-pure (no tracing here).
//
// Each board gets one append-only `agent_log` note under `50_Agents/{board}/`. The
// first write stamps a §8.3 frontmatter header (via writeNoteIfAbsent so a race or
// a re-run never clobbers it); every write appends a timestamped `## ... — archival`
// section through appendSection (append-only, PRD §8.5).
//
// WIKILINK GUARD: appendSection refuses relative `.md` markdown links (PRD §8.2).
// Archival text comes from agents and may contain them, so we neutralize relative
// `.md` links before appending and retry once; if it still can't be written we
// return {ok:false} cleanly. We never let the guard (or a lock) throw out of here.

import * as path from 'node:path';

import {
  appendSection,
  writeNoteIfAbsent,
  hasRelativeMdLink,
  WikilinkViolationError,
  type WriteResult,
} from '../atomic.js';
import { makeFrontmatter } from '../frontmatter.js';

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
 * - first write (file absent): stamp a §8.3 `agent_log` frontmatter header via
 *   writeNoteIfAbsent (idempotent — a concurrent create or a re-run won't clobber).
 * - every write: appendSection a `## {ts} — archival\n{text}` block (append-only).
 *
 * Never throws. A relative-`.md`-link in `text` is neutralized and retried once; a
 * lock contention returns {ok:false} (soft — the caller retries next cycle).
 */
export async function mirrorArchivalToVault(
  opts: MirrorArchivalOptions,
): Promise<MirrorResult> {
  const { board, text, vaultRoot } = opts;
  const ts = opts.ts ?? new Date().toISOString();
  const target = path.join(vaultRoot, '50_Agents', board, 'agent_log.md');

  // ── 1) Ensure the header note exists (idempotent create). ──────────────────
  // writeNoteIfAbsent is a no-op when the note already exists, so this is cheap on
  // every-but-the-first call. makeFrontmatter throws only on an invalid schema —
  // our inputs are fixed and valid, but we still guard so nothing escapes.
  try {
    const fm = makeFrontmatter({
      type: 'agent_log',
      status: 'active',
      authored_by: `board.${board}`,
      source: 'gen://letta-archival',
      title: `${board} — agent log`,
    });
    const created: WriteResult = await writeNoteIfAbsent(
      target,
      fm,
      `# ${board} — agent log\n`,
    );
    // `{written:false, reason:'locked'}` here just means someone else is creating
    // it right now — the append below will still target the same path, and if the
    // header isn't on disk yet appendSection will create a header-less file. That's
    // acceptable: the section is the durable record; the frontmatter is a one-time
    // nicety. We don't fail the mirror on a create-time lock.
    void created;
  } catch (err) {
    // A malformed-frontmatter throw (shouldn't happen with fixed inputs) must not
    // crash the mirror — degrade to {ok:false} so the caller can retry/alert.
    return { ok: false, path: target, error: errMsg(err) };
  }

  // ── 2) Append the timestamped archival section (append-only). ──────────────
  const section = `## ${ts} — archival\n${text}`;
  const first = await tryAppend(target, section);
  if (first.kind === 'ok') return { ok: true, path: target };
  if (first.kind === 'locked') {
    // Soft failure — the file is held by another writer; retry on the next cycle.
    return { ok: false, path: target, error: 'agent_log is locked; retry next cycle' };
  }

  // first.kind === 'wikilink' — the text carried a relative .md link. Neutralize it
  // and retry ONCE. (PRD §8.2: wikilinks only; relative md links are forbidden.)
  const cleaned = `## ${ts} — archival\n${neutralizeRelativeMdLinks(text)}`;
  const second = await tryAppend(target, cleaned);
  if (second.kind === 'ok') return { ok: true, path: target };
  if (second.kind === 'locked') {
    return { ok: false, path: target, error: 'agent_log is locked; retry next cycle' };
  }
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
  | { kind: 'wikilink' };

/**
 * appendSection wrapper that converts its outcomes into a small tagged union and
 * traps the WikilinkViolationError (the only thing appendSection throws for our
 * inputs) so the caller can decide to neutralize + retry. Any *other* throw is
 * re-raised — those are genuine I/O faults the caller's try/catch should see... but
 * since the public function must never throw, we trap everything and treat unknowns
 * as a soft 'locked' (retry-next-cycle) to be safe.
 */
async function tryAppend(target: string, text: string): Promise<AppendOutcome> {
  try {
    const res = await appendSection(target, text);
    if (res.written) return { kind: 'ok' };
    // The only non-written WriteResult reason appendSection emits is 'locked'.
    return { kind: 'locked' };
  } catch (err) {
    if (err instanceof WikilinkViolationError) return { kind: 'wikilink' };
    // Unexpected I/O error — degrade to a soft retry rather than throwing out.
    return { kind: 'locked' };
  }
}

// Matches a markdown link whose target is a relative `.md` path — a STRICT mirror
// of atomic.ts's guard (`[^)]*\.md(?:[)#?]|\s)`), so anything the writer would
// reject, this strips. Key points:
//   - the URL class is `[^)]*` (spaces ALLOWED): Obsidian/Windows filenames have
//     spaces (`[x](./My Project.md)`), and the guard accepts them, so we must too;
//   - a lookahead pins `.md` to the guard's exact terminators (`)`, `#`, `?`, or
//     whitespace), so we don't over-strip non-links like `[d](./a.md.html)`;
//   - the trailing `[^)]*\)` can't cross a `)`, so adjacent links don't merge
//     (`[a](./a.md) and [b](./b.md)` -> `a and b`, not `a`).
const RELATIVE_MD_LINK_G =
  /\[([^\]]*)\]\(\s*(?!https?:\/\/)[^)]*?\.md(?=[)#?\s])[^)]*\)/gi;

// Fallback for MALFORMED links the guard still flags but that lack a clean close
// paren (e.g. `[x](./foo.md and text` with no `)`): strip from the label through
// the `.md`-plus-trailing-token. Only used by the defensive loop below.
const RELATIVE_MD_LINK_LOOSE_G =
  /\[([^\]]*)\]\(\s*(?!https?:\/\/)[^)\n]*?\.md(?=[)#?\s]|$)[^)\n]*\)?/gi;

/**
 * Neutralize relative `.md` markdown links so the wikilink guard (atomic.ts) passes.
 * We keep the human-readable label and drop the link target, turning `[see](./foo.md)`
 * into `see` (a bare wikilink would mis-target, so we don't fabricate one). Absolute
 * http(s) links are untouched.
 *
 * Exported because Job 1 (ingest) reuses it: external/scraped drops routinely carry
 * relative `.md` links that would otherwise hard-fail the verbatim source-note write
 * (PRD §8.2). Agent-authored notes keep the hard-throwing guard; lossy external
 * content is neutralized so it archives instead of stranding in `00_Inbox/`.
 */
export function neutralizeRelativeMdLinks(text: string): string {
  const keep = (label: string): string => {
    const visible = label.trim();
    return visible.length > 0 ? visible : '(link removed)';
  };
  let out = text.replace(RELATIVE_MD_LINK_G, (_m, label: string) => keep(label));
  // Defense-in-depth: GUARANTEE the result satisfies atomic.ts's guard so an
  // external drop can never hard-fail ingest. The primary pass mirrors the guard
  // for well-formed links; any residual (malformed/abruptly-closed link, exotic
  // spacing) is stripped by the broader fallback, bounded to avoid pathological
  // loops. `hasRelativeMdLink` is the writer's own predicate, so this can't drift.
  for (let i = 0; i < 5 && hasRelativeMdLink(out); i++) {
    out = out.replace(RELATIVE_MD_LINK_LOOSE_G, (_m, label: string) => keep(label));
  }
  return out;
}

/** Extract a human-readable message from an unknown thrown value. */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
