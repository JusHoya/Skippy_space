// jobs/distill.ts — Job 2 of the four-job memory pipeline (PRD §8.5).
//
// Owner charter: agent_space/tasks/distiller.md (research.distiller). The real
// distiller is an LLM (Sonnet) that reads a source note and emits 8–15 calibrated
// atomic facts. THAT distiller is provided by agent-runtime later — NOT here.
//
// This module owns the *deterministic glue*: it accepts a swappable `DistillFn`
// so the exit-criterion test can run with NO LLM / Docker / Obsidian. We ship a
// deterministic `mockDistill` (sentence-splitter) and a `runDistill` orchestrator
// that:
//   1. Calls distill() to get atomic-note drafts.
//   2. Writes each draft to `10_Atomic/<ulid>.md` (type: atomic_fact, sourced).
//   3. Derives 1–3 candidate topic/entity names and create-or-appends a
//      `20_Topics/<slug>.md` concept page listing the atomic notes as [[wikilinks]].
//
// ARCHITECTURE: do NOT import @anthropic-ai/sdk or anything from agent-runtime.
// The LLM distiller injects itself by passing its own `DistillFn`.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { ulid } from 'ulid';

import {
  assertNoRelativeMdLinks,
  atomicWrite,
  isLocked,
  withFileLock,
  writeNote,
} from '../atomic.js';
import {
  makeFrontmatter,
  parseNote,
  serializeNote,
  validateFrontmatter,
  type NoteFrontmatter,
} from '../frontmatter.js';
import type { JobEvent } from './types.js';

// ──────────────────────────────────────────────────────────────────────────────
// Swappable distiller contract
// ──────────────────────────────────────────────────────────────────────────────

/** One atomic-note draft produced by a distiller, pre-frontmatter. */
export interface AtomicNoteDraft {
  title: string;
  body: string;
  confidence?: number;
  tags?: string[];
}

/** Input handed to a distiller: the normalized source note + the vault root. */
export interface DistillInput {
  sourceId: string;
  title: string;
  body: string;
  vaultRoot: string;
}

/** The swappable distiller. The LLM implementation lives in agent-runtime. */
export type DistillFn = (input: DistillInput) => Promise<AtomicNoteDraft[]>;

// ──────────────────────────────────────────────────────────────────────────────
// Deterministic mock distiller (no LLM, no randomness, no Date)
// ──────────────────────────────────────────────────────────────────────────────

const MIN_DRAFTS = 8;
const MIN_SENTENCE_LEN = 25;
const TITLE_WORD_LIMIT = 9;
const TITLE_CHAR_CAP = 80;

/** Collapse runs of whitespace and trim. */
function squash(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** First ~9 words of a sentence, char-capped — used as the atomic-note title. */
function deriveDraftTitle(sentence: string): string {
  const words = squash(sentence).split(' ');
  let title = words.slice(0, TITLE_WORD_LIMIT).join(' ');
  if (title.length > TITLE_CHAR_CAP) title = title.slice(0, TITLE_CHAR_CAP).trim();
  // Strip a trailing terminal punctuation mark from the title for cleanliness.
  return title.replace(/[.,;:!?]+$/, '').trim();
}

/**
 * Strip markdown structure (the leading `# heading`, list bullets, fences) before
 * sentence-splitting so a fixture's title line doesn't become a "fact". Keeps the
 * prose; this is deterministic, not a full markdown parser.
 */
function prepProse(body: string): string {
  const kept: string[] = [];
  let inFence = false;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (line.length === 0) continue;
    if (/^#{1,6}\s/.test(line)) continue; // headings
    // Drop the bullet/numbered-list marker but keep the item text.
    kept.push(line.replace(/^([-*+]|\d+\.)\s+/, ''));
  }
  return kept.join(' ');
}

/**
 * `mockDistill` — DETERMINISTIC stand-in for the LLM distiller.
 *
 * Split the prose into sentences (on `/[.!?]+\s/`), trim, keep those longer than
 * 25 chars. If fewer than 8 remain, ALSO split the longest sentences on
 * commas/semicolons until we have ≥8 drafts; if prose is still too thin, fall
 * back to a whitespace-chunk split so any reasonable paragraph yields ≥8 drafts.
 * No Math.random, no Date — order is the document order of the fragments.
 */
export const mockDistill: DistillFn = async (input) => {
  const prose = prepProse(input.body);

  // 1. Primary split on sentence terminators.
  let fragments = prose
    .split(/[.!?]+\s+/)
    .map(squash)
    .filter((s) => s.length > MIN_SENTENCE_LEN);

  // 2. If thin, split the LONGEST fragments on commas/semicolons (stable: we keep
  //    document order by splitting in place rather than re-sorting the corpus).
  if (fragments.length < MIN_DRAFTS) {
    const expanded: string[] = [];
    for (const frag of fragments) {
      if (frag.length > 60 && /[,;]/.test(frag)) {
        for (const piece of frag.split(/[;,]\s*/)) {
          const p = squash(piece);
          if (p.length > MIN_SENTENCE_LEN) expanded.push(p);
        }
      } else {
        expanded.push(frag);
      }
    }
    if (expanded.length >= fragments.length) fragments = expanded;
  }

  // 3. Last-resort pad: chunk the whole prose into word-windows so even an
  //    unpunctuated paragraph yields ≥8 drafts. Deterministic windowing.
  if (fragments.length < MIN_DRAFTS) {
    const words = prose.split(/\s+/).filter(Boolean);
    if (words.length >= MIN_DRAFTS) {
      const chunkCount = MIN_DRAFTS;
      const size = Math.ceil(words.length / chunkCount);
      const chunks: string[] = [];
      for (let i = 0; i < words.length; i += size) {
        const chunk = squash(words.slice(i, i + size).join(' '));
        if (chunk.length > 0) chunks.push(chunk);
      }
      // Prefer the chunk split only if it gives us at least as many usable drafts.
      if (chunks.length >= fragments.length) fragments = chunks;
    }
  }

  return fragments.map((sentence): AtomicNoteDraft => {
    const punctuated = /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
    return {
      title: deriveDraftTitle(sentence),
      body: punctuated,
      confidence: 0.6,
    };
  });
};

// ──────────────────────────────────────────────────────────────────────────────
// Topic / entity name derivation (deterministic)
// ──────────────────────────────────────────────────────────────────────────────

// Words we never treat as proper-noun topic candidates even when capitalized
// (sentence-initial capitalization, common connectors).
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with',
  'as', 'by', 'at', 'from', 'into', 'is', 'are', 'was', 'were', 'be', 'been',
  'this', 'that', 'these', 'those', 'it', 'its', 'we', 'they', 'their', 'our',
  'has', 'have', 'had', 'can', 'will', 'would', 'should', 'could', 'may', 'might',
  'when', 'where', 'which', 'who', 'while', 'because', 'however', 'each', 'both',
]);

/** Slugify a topic name into a stable, filesystem-safe page id. */
export function topicSlug(name: string): string {
  return squash(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Derive 1–3 candidate topic/entity names from the source title + the most
 * frequent capitalized tokens in the body. Deterministic: ties break by first
 * appearance order. Always returns at least one candidate (the title-derived one)
 * so every distill produces a topic page.
 */
export function deriveTopicNames(title: string, body: string): string[] {
  const names: string[] = [];
  const seenSlugs = new Set<string>();

  const push = (name: string): void => {
    const clean = squash(name).replace(/[.,;:!?]+$/, '').trim();
    if (clean.length < 2) return;
    const slug = topicSlug(clean);
    if (slug.length === 0 || seenSlugs.has(slug)) return;
    seenSlugs.add(slug);
    names.push(clean);
  };

  // 1. Frequent capitalized tokens (proper-noun-ish) from the body. Count + first
  //    appearance order are both captured so the ranking is fully deterministic.
  const counts = new Map<string, { count: number; order: number; display: string }>();
  const tokenRe = /\b([A-Z][A-Za-z0-9]+(?:[ -][A-Z][A-Za-z0-9]+)*)\b/g;
  let order = 0;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(body)) !== null) {
    const display = m[1];
    if (!display) continue;
    const key = display.toLowerCase();
    const firstWord = display.split(/[ -]/)[0]?.toLowerCase() ?? '';
    if (STOPWORDS.has(key) || STOPWORDS.has(firstWord)) continue;
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, { count: 1, order: order++, display });
  }

  const ranked = [...counts.values()].sort(
    (a, b) => b.count - a.count || a.order - b.order,
  );
  // Prefer tokens that actually recur (count ≥ 2) — those are real topics, not
  // one-off sentence-initial capitals.
  for (const entry of ranked) {
    if (entry.count >= 2) push(entry.display);
    if (names.length >= 3) break;
  }

  // 2. Always include a title-derived topic so there's at least one page. Use the
  //    title's leading proper-noun phrase if present, else the whole title.
  if (names.length < 3) {
    const titleProper = /\b([A-Z][A-Za-z0-9]+(?:[ -][A-Z][A-Za-z0-9]+)*)\b/.exec(title);
    push(titleProper?.[1] ?? title);
  }

  // 3. Pad from singletons if we still have nothing useful (degenerate input).
  if (names.length === 0) {
    for (const entry of ranked) {
      push(entry.display);
      if (names.length >= 1) break;
    }
  }
  if (names.length === 0) push(title);

  return names.slice(0, 3);
}

// ──────────────────────────────────────────────────────────────────────────────
// runDistill — write atomic notes + topic pages
// ──────────────────────────────────────────────────────────────────────────────

export interface RunDistillOptions {
  vaultRoot: string;
  source: { sourceId: string; title: string; body: string };
  /** The swappable distiller. Defaults to `mockDistill` when omitted. */
  distill?: DistillFn;
  onJob?: (e: JobEvent) => void;
}

export interface DistillResult {
  atomicPaths: string[];
  atomicIds: string[];
  topicPaths: string[];
}

/** Render a topic page body listing the atomic notes as [[id]] wikilinks. */
function renderTopicBody(name: string, atomicIds: string[]): string {
  const lines = [
    `# ${name}`,
    '',
    `Concept page seeded by \`research.distiller\`. Atomic facts distilled for this topic:`,
    '',
    ...atomicIds.map((id) => `- [[${id}]]`),
    '',
  ];
  return lines.join('\n');
}

// Mirror the §8.3 schema's own validators (NoteFrontmatterSchema in frontmatter.ts:
// `id` = 26-char ULID charset, `created_at` = offset datetime) so we only PRESERVE a
// pre-existing id/created_at when it is actually schema-valid — a malformed one mints
// fresh rather than being carried back out of the degraded-page fallback.
const ULID_RE = /^[0-9A-Za-z]{26}$/;
const OFFSET_DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
function isOffsetDateTime(s: string): boolean {
  return OFFSET_DATETIME_RE.test(s) && !Number.isNaN(Date.parse(s));
}

/**
 * Merge the already-read text of an EXISTING topic page with new atomic [[id]]
 * links, bumping `updated_at` without clobbering identity. Topics are by-name and
 * accumulate facts across distills, so this is a read-modify-write — the CALLER
 * holds the per-file lock across the read + this merge + the write so concurrent
 * pipeline runs can't lose links or stomp each other's pages (review §3).
 *
 * Identity is preserved verbatim: the original `created_at` and `id` are carried
 * through (never re-stamped to now / re-minted), and unknown passthrough
 * frontmatter fields (schema_version, rollup pointers, …) round-trip losslessly.
 * Only `updated_at` (and required-field backfill on a degraded page) changes.
 */
function mergeTopicPage(
  raw: string,
  name: string,
  atomicIds: string[],
  now: Date,
): { fm: NoteFrontmatter; body: string } {
  const parsed = parseNote(raw);

  // Append only the ids not already present as [[id]] wikilinks.
  const missing = atomicIds.filter((id) => !parsed.body.includes(`[[${id}]]`));
  const additions = missing.map((id) => `- [[${id}]]`).join('\n');
  const body =
    missing.length > 0
      ? `${parsed.body.replace(/\s+$/, '')}\n${additions}\n`
      : parsed.body;

  // Start from the RAW frontmatter so every field — including unknown passthrough
  // keys the §8.3 schema doesn't name — survives the round-trip untouched.
  const existing = parsed.frontmatter;
  const nowIso = now.toISOString();

  // Preserve the existing id verbatim — but only if it is a VALID §8.3 ULID. A
  // non-empty-but-malformed id (a hand-broken page) must mint a fresh valid one,
  // else both the merge below AND the degraded fallback would carry an invalid id
  // straight back out, never re-validating (review §3 reconciliation). Same for
  // created_at: reuse a valid offset-datetime, otherwise synthesize `now`.
  const existingId =
    typeof existing.id === 'string' && ULID_RE.test(existing.id) ? existing.id : ulid();
  const createdAt =
    typeof existing.created_at === 'string' && isOffsetDateTime(existing.created_at)
      ? existing.created_at
      : nowIso;

  const merged: Record<string, unknown> = {
    ...existing,
    id: existingId,
    // Backfill the §8.3 core only where the existing page is missing/blank it, so a
    // page authored by another tool (or a slightly degraded one) re-validates
    // without losing whatever it already carried.
    title: typeof existing.title === 'string' && existing.title.length > 0
      ? existing.title
      : name,
    type: 'concept',
    status: typeof existing.status === 'string' && existing.status.length > 0
      ? existing.status
      : 'active',
    authored_by:
      typeof existing.authored_by === 'string' && existing.authored_by.length > 0
        ? existing.authored_by
        : 'research.distiller',
    source:
      'source' in existing ? existing.source : 'gen://distill',
    created_at: createdAt,
    updated_at: nowIso,
  };

  const v = validateFrontmatter(merged);
  if (v.ok) return { fm: v.value, body };

  // Still invalid after backfill (e.g. a malformed status/source the schema rejects)
  // — fall back to a clean, valid frontmatter but KEEP the original id + created_at
  // so identity is never lost (review §3: never re-mint an id for an existing page).
  const fm = makeFrontmatter({
    id: existingId,
    title: name,
    type: 'concept',
    status: 'active',
    authored_by: 'research.distiller',
    source: 'gen://distill',
    now,
  });
  fm.created_at = createdAt;
  return { fm, body };
}

/**
 * Run Job 2 (Distill). Calls `distill` (default `mockDistill`) to get atomic
 * drafts, writes each to `10_Atomic/<ulid>.md`, then create-or-appends 1–3
 * `20_Topics/<slug>.md` concept pages linking the atomic notes as [[wikilinks]].
 */
export async function runDistill(opts: RunDistillOptions): Promise<DistillResult> {
  const { vaultRoot, source, onJob } = opts;
  const distill = opts.distill ?? mockDistill;
  onJob?.({ job: 'distill', phase: 'start', detail: source.title });

  try {
    const drafts = await distill({
      sourceId: source.sourceId,
      title: source.title,
      body: source.body,
      vaultRoot,
    });

    const atomicPaths: string[] = [];
    const atomicIds: string[] = [];
    // Keep each written note's id alongside its searchable text so topic seeding
    // can pick the by-name subset (the rest are left for the Link job, Job 3).
    const written: Array<{ id: string; text: string }> = [];

    for (const draft of drafts) {
      const id = ulid();
      const target = path.join(vaultRoot, '10_Atomic', `${id}.md`);
      const fm = makeFrontmatter({
        id,
        title: draft.title,
        type: 'atomic_fact',
        status: 'distilled',
        source: source.sourceId,
        distilled_from: [source.sourceId],
        authored_by: 'research.distiller',
        confidence: draft.confidence ?? 0.6,
        ...(draft.tags ? { tags: draft.tags } : {}),
      });
      const res = await writeNote(target, fm, draft.body);
      if (res.written) {
        atomicPaths.push(target);
        atomicIds.push(id);
        written.push({
          id,
          text: `${draft.title} ${draft.body} ${(draft.tags ?? []).join(' ')}`.toLowerCase(),
        });
      }
    }

    onJob?.({
      job: 'distill',
      phase: 'progress',
      detail: 'atomic notes written',
      counts: { atomic: atomicIds.length },
    });

    // Topic/entity pages — by-name (PRD §8.7). The distiller seeds each topic with
    // only the atomic notes that MENTION the topic name (its direct candidate
    // updates); the broader keyword/semantic neighbors are left for the Link job
    // (Job 3) to wire in. If a topic happens to match no atomic note by name we
    // fall back to seeding all ids so the page is never empty.
    const topicNames = deriveTopicNames(source.title, source.body);
    const topicPaths: string[] = [];

    for (const name of topicNames) {
      const slug = topicSlug(name);
      if (slug.length === 0) continue;
      const topicPath = path.join(vaultRoot, '20_Topics', `${slug}.md`);

      const needle = name.toLowerCase();
      const byName = written.filter((w) => w.text.includes(needle)).map((w) => w.id);
      const seedIds = byName.length > 0 ? byName : atomicIds;

      // Hold the per-file lock across the ENTIRE read-modify-write. The topic page
      // is by-name and accumulates links across distills, so a bare read-then-write
      // (the old `fileExists` → `mergeTopicPage` → `writeNote` sequence, with the
      // read OUTSIDE writeNote's lock) let a concurrent pipeline run clobber the
      // page and drop links between our read and our write (review §3). We mirror
      // writeNote's guard + validation here so nothing is skipped by going direct.
      try {
        const wrote = await withFileLock(topicPath, async () => {
          let fm: NoteFrontmatter;
          let body: string;
          // Re-check existence INSIDE the lock so an interleaved create can't be lost.
          let raw: string | null = null;
          try {
            raw = await fs.readFile(topicPath, 'utf8');
          } catch {
            raw = null;
          }
          if (raw !== null) {
            ({ fm, body } = mergeTopicPage(raw, name, seedIds, new Date()));
          } else {
            fm = makeFrontmatter({
              title: name,
              type: 'concept',
              status: 'active',
              authored_by: 'research.distiller',
              source: 'gen://distill',
            });
            body = renderTopicBody(name, seedIds);
          }
          assertNoRelativeMdLinks(body, topicPath);
          await atomicWrite(topicPath, serializeNote(fm, body));
          return true;
        });
        if (wrote) topicPaths.push(topicPath);
      } catch (err) {
        // On lock contention, skip this topic — the next distill pass re-seeds it
        // (matches writeNote's soft-skip-on-`locked` contract; nothing is lost since
        // the by-name links are re-derived deterministically each run).
        if (!isLocked(err)) throw err;
      }
    }

    onJob?.({
      job: 'distill',
      phase: 'complete',
      detail: source.title,
      counts: { atomic: atomicIds.length },
    });

    return { atomicPaths, atomicIds, topicPaths };
  } catch (err) {
    onJob?.({
      job: 'distill',
      phase: 'error',
      detail: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
