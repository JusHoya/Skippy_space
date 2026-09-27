// frontmatter.ts — the §8.3 note-frontmatter contract for the Karpathy vault.
//
// Phase 3 (WS1). Replaces the Phase-0 stub. Every note written into the vault
// flows through here so malformed frontmatter is rejected before it hits disk
// (PRD §8.3 schema, §8.4 closed note-type set, §8.10 schema-drift guard).
//
// We use `gray-matter` for parse/serialize (js-yaml under the hood) and `zod`
// for validation. The schema is intentionally `.passthrough()` so note types
// that carry extra fields (e.g. a `weekly` note's rollup pointers) round-trip
// losslessly — we validate the closed core, preserve the rest.

import { isDeepStrictEqual } from 'node:util';

import matter from 'gray-matter';
import yaml from 'js-yaml';
import { z } from 'zod';
import { ulid } from 'ulid';

// ──────────────────────────────────────────────────────────────────────────────
// Closed sets (PRD §8.4 note types, §8.3 status lifecycle)
// ──────────────────────────────────────────────────────────────────────────────

/** PRD §8.4 — the closed set of note types. Nothing outside this list is valid. */
export const NOTE_TYPES = [
  'atomic_fact',
  'decision',
  'postmortem',
  'snippet',
  'external_source',
  'conversation_summary',
  'agent_log',
  'daily',
  'weekly',
  'project_brief',
  'entity',
  'concept',
  'agent_persona',
] as const;
export type NoteType = (typeof NOTE_TYPES)[number];

/**
 * Status lifecycle. PRD §8.3 lists draft|active|distilled|canonical|archived;
 * §8.6 adds `deprecated` as the terminal state a superseded note enters before
 * it migrates to 90_Archive/. We accept all six.
 */
export const NOTE_STATUSES = [
  'draft',
  'active',
  'distilled',
  'canonical',
  'archived',
  'deprecated',
] as const;
export type NoteStatus = (typeof NOTE_STATUSES)[number];

// A ULID is 26 chars of Crockford base32. We validate length + charset leniently
// (we mint ids via `ulid()` so format is guaranteed; this only guards external
// or hand-edited input).
const ULID_RE = /^[0-9A-Za-z]{26}$/;

// ──────────────────────────────────────────────────────────────────────────────
// The schema (PRD §8.3)
// ──────────────────────────────────────────────────────────────────────────────

export const NoteFrontmatterSchema = z
  .object({
    id: z.string().regex(ULID_RE, 'id must be a 26-char ULID'),
    title: z.string().min(1, 'title is required'),
    created_at: z.string().datetime({ offset: true }),
    updated_at: z.string().datetime({ offset: true }),
    type: z.enum(NOTE_TYPES),
    status: z.enum(NOTE_STATUSES),
    tags: z.array(z.string()).default([]),
    // `source` is a url / file:// / conv:// / ref:#id, or null for generated
    // notes (e.g. daily). The §8.10 guard below forces atomic_facts to carry one.
    source: z.string().nullable().default(null),
    authored_by: z.string().min(1, 'authored_by is required (board.task or "human")'),
    confidence: z.number().min(0).max(1).default(0.5),
    distilled_from: z.array(z.string()).default([]),
    supersedes: z.string().nullable().default(null),
    contradicts: z.array(z.string()).default([]),
  })
  // Preserve unknown keys (schema_version, weekly rollup pointers, etc.).
  .passthrough()
  // PRD §8.10 — hallucinated-note guard: every atomic_fact needs a source, else
  // it must be parked as draft (excluded from retrieval). We enforce that here
  // so a distiller cannot smuggle a sourceless "fact" into canonical retrieval.
  .superRefine((fm, ctx) => {
    if (
      fm.type === 'atomic_fact' &&
      fm.status !== 'draft' &&
      (fm.source === null || fm.source.trim() === '')
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['source'],
        message:
          'atomic_fact requires a non-empty source unless status is "draft" (PRD §8.10)',
      });
    }
  });

/** The fully-validated frontmatter object (defaults applied). */
export type NoteFrontmatter = z.infer<typeof NoteFrontmatterSchema>;

/** Loose input accepted by the builders/serializers before validation. */
export type NoteFrontmatterInput = Record<string, unknown>;

// ──────────────────────────────────────────────────────────────────────────────
// Validation
// ──────────────────────────────────────────────────────────────────────────────

export type ValidateResult =
  | { ok: true; value: NoteFrontmatter }
  | { ok: false; errors: string[] };

/** Validate an arbitrary object against the §8.3 schema. Non-throwing. */
export function validateFrontmatter(data: unknown): ValidateResult {
  const parsed = NoteFrontmatterSchema.safeParse(data);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    errors: parsed.error.issues.map(
      (i) => `${i.path.join('.') || '(root)'}: ${i.message}`,
    ),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Parse / serialize
// ──────────────────────────────────────────────────────────────────────────────

export interface ParsedNote {
  /** Raw frontmatter object as read from disk (NOT yet validated). */
  frontmatter: Record<string, unknown>;
  /** Markdown body, frontmatter fence stripped. */
  body: string;
}

// YAML is parsed with js-yaml's CORE_SCHEMA (null/bool/int/float/str/seq/map),
// i.e. WITHOUT the YAML 1.1 `timestamp` type. gray-matter's default engine
// turns `due: 2026-10-01` into a Date, which a rewrite then serializes as
// `2026-10-01T00:00:00.000Z` — silent type drift in unknown metadata (FR-WIKI-02,
// red-team E3-5). Timestamps stay the exact strings the author wrote; §8.3's
// `created_at`/`updated_at` are validated as ISO datetime strings anyway.
const MATTER_OPTS = {
  engines: {
    yaml: (s: string): object => {
      const data = yaml.load(s, { schema: yaml.CORE_SCHEMA });
      return data !== null && typeof data === 'object' && !Array.isArray(data) ? data : {};
    },
  },
};

/** Parse a markdown note into { frontmatter, body }. Does not validate. */
export function parseNote(raw: string): ParsedNote {
  // Passing options also bypasses gray-matter's shared parse cache, so each
  // caller gets its own (mutable) frontmatter object.
  const file = matter(raw, MATTER_OPTS);
  return { frontmatter: file.data as Record<string, unknown>, body: file.content };
}

// Canonical §8.3 key order so serialized notes diff cleanly and read like the
// hand-authored examples in the charters.
const KEY_ORDER: readonly string[] = [
  'id',
  'title',
  'created_at',
  'updated_at',
  'type',
  'status',
  'tags',
  'source',
  'authored_by',
  'confidence',
  'distilled_from',
  'supersedes',
  'contradicts',
];

function canonicalize(fm: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of KEY_ORDER) {
    if (k in fm) out[k] = fm[k];
  }
  // Append any extra (passthrough) keys in their existing order.
  for (const k of Object.keys(fm)) {
    if (!(k in out)) out[k] = fm[k];
  }
  return out;
}

/**
 * Serialize { frontmatter, body } into a `---`-fenced markdown string.
 * Validates against §8.3 first and THROWS on invalid input — callers that
 * want a soft path should `validateFrontmatter` first. The body is written
 * verbatim (wikilink enforcement lives in `atomic.ts`, at the write boundary).
 */
export function serializeNote(
  frontmatter: NoteFrontmatterInput,
  body: string,
): string {
  const parsed = NoteFrontmatterSchema.safeParse(frontmatter);
  if (!parsed.success) {
    const errs = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`serializeNote: invalid frontmatter — ${errs}`);
  }
  // gray-matter strips a single leading newline from content; normalize so the
  // body always starts cleanly after the closing fence.
  const content = body.startsWith('\n') ? body : `\n${body}`;
  return matter.stringify(content, canonicalize(parsed.data));
}

const SURGICAL_KEY_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const FENCE_LINE_RE = /^---[ \t]*$/;
const BOM = '﻿';

/** One frontmatter line with its own terminator (`\n`, `\r\n` or '' at EOF). */
interface FmLine {
  text: string;
  eol: string;
}

/** A `---`-fenced note split into byte-exact parts. */
interface FencedNote {
  bom: string;
  openLine: string;
  openEol: string;
  lines: FmLine[];
  closeLine: string;
  closeEol: string;
  /** The line ending most used inside the fenced block (new lines get it). */
  dominantEol: string;
}

/** Split `raw` at its frontmatter fences, keeping every line's own terminator. */
function splitFenced(raw: string): FencedNote | null {
  let s = raw;
  let bom = '';
  if (s.startsWith(BOM)) {
    bom = BOM;
    s = s.slice(1);
  }
  const all: FmLine[] = [];
  const re = /([^\n]*?)(\r\n|\n|$)/gy;
  let pos = 0;
  while (pos < s.length) {
    re.lastIndex = pos;
    const m = re.exec(s);
    if (!m || m[0].length === 0) break;
    all.push({ text: m[1] ?? '', eol: m[2] ?? '' });
    pos += m[0].length;
  }
  if (all.length < 2 || !FENCE_LINE_RE.test(all[0]!.text) || all[0]!.eol === '') return null;
  const closeIdx = all.findIndex((l, i) => i > 0 && FENCE_LINE_RE.test(l.text));
  if (closeIdx < 0) return null;
  const block = all.slice(0, closeIdx + 1);
  const crlf = block.filter((l) => l.eol === '\r\n').length;
  const lf = block.filter((l) => l.eol === '\n').length;
  return {
    bom,
    openLine: all[0]!.text,
    openEol: all[0]!.eol,
    lines: all.slice(1, closeIdx),
    closeLine: all[closeIdx]!.text,
    closeEol: all[closeIdx]!.eol,
    dominantEol: crlf > lf ? '\r\n' : '\n',
  };
}

function renderFenced(n: FencedNote, body: string): string {
  const fm = n.lines.map((l) => l.text + l.eol).join('');
  // gray-matter drops one line terminator after the closing fence; a body is
  // re-attached after the fence's own terminator (or a dominant one if none).
  const closeEol = n.closeEol === '' && body !== '' ? n.dominantEol : n.closeEol;
  return `${n.bom}${n.openLine}${n.openEol}${fm}${n.closeLine}${closeEol}${body}`;
}

/**
 * Re-serialize an edited note while preserving the author's text (FR-WIKI-02
 * "preserve unknown metadata and authored text"; red-team E3-5, M0 final #4).
 *
 * Only the top-level lines of keys whose value changed are rewritten (a new key
 * is appended before the closing fence); comments, key order, quoting, every
 * untouched line INCLUDING ITS OWN LINE ENDING, a leading UTF-8 BOM and the body
 * bytes stay exactly as they were. Rewritten lines take the line ending of the
 * line they replace; new lines take the block's dominant ending. The result is
 * re-parsed and must yield exactly `frontmatter` and `body`. If the surgical
 * edit cannot be proven equivalent (anchors, flow maps spanning lines, a
 * removed key), the frontmatter block is re-serialized canonically (YAML
 * comments in it are dropped) while the BOM and the body bytes are still kept;
 * only if even that cannot be verified is the plain `serializeNote` output used.
 * Validates §8.3 and THROWS on invalid input, like `serializeNote`.
 */
export function serializeNotePreserving(
  originalRaw: string,
  frontmatter: NoteFrontmatterInput,
  body: string,
): string {
  const canonical = serializeNote(frontmatter, body); // validates §8.3
  try {
    const surgical = surgicalEdit(originalRaw, frontmatter, body);
    if (surgical !== null) return surgical;
  } catch {
    /* fall through */
  }
  try {
    const block = canonicalBlockEdit(originalRaw, frontmatter, body);
    if (block !== null) return block;
  } catch {
    /* fall through */
  }
  return originalRaw.startsWith(BOM) ? BOM + canonical : canonical;
}

/** Re-parse `out` and require exactly `body`, and `frontmatter` when given. */
function verifies(out: string, body: string, frontmatter?: Record<string, unknown>): boolean {
  const check = parseNote(out);
  if (check.body !== body) return false;
  return frontmatter === undefined || isDeepStrictEqual(check.frontmatter, frontmatter);
}

function surgicalEdit(
  originalRaw: string,
  frontmatter: NoteFrontmatterInput,
  body: string,
): string | null {
  const note = splitFenced(originalRaw);
  if (!note) return null;
  const before = parseNote(originalRaw).frontmatter;
  const target = Object.fromEntries(
    Object.entries(frontmatter).filter(([, v]) => v !== undefined),
  );
  // A key removal cannot be expressed surgically; let the canonical path do it.
  if (Object.keys(before).some((k) => !(k in target))) return null;

  const lines = note.lines;
  for (const [key, value] of Object.entries(target)) {
    if (isDeepStrictEqual(value, before[key])) continue;
    if (!SURGICAL_KEY_RE.test(key)) return null;
    const rendered = yaml
      .dump({ [key]: value }, { lineWidth: -1, noRefs: true })
      .replace(/\n+$/, '')
      .split('\n');
    const keyRe = new RegExp(`^${key}[ \\t]*:`);
    const hits = lines.flatMap((l, i) => (keyRe.test(l.text) ? [i] : []));
    if (hits.length > 1) return null;
    if (hits.length === 0) {
      lines.push(...rendered.map((text) => ({ text, eol: note.dominantEol })));
      continue;
    }
    const start = hits[0]!;
    let end = start + 1;
    // The value's extent: indented continuation lines and column-0 sequence items.
    while (end < lines.length && /^([ \t]|-([ \t]|$))/.test(lines[end]!.text)) end++;
    const firstEol = lines[start]!.eol;
    const lastEol = lines[end - 1]!.eol;
    const replacement = rendered.map((text, i) => ({
      text,
      eol: i === rendered.length - 1 ? lastEol : firstEol,
    }));
    lines.splice(start, end - start, ...replacement);
  }

  const out = renderFenced(note, body);
  return verifies(out, body, target) ? out : null;
}

/** Canonical frontmatter block, but the BOM, fences' endings and body bytes kept. */
function canonicalBlockEdit(
  originalRaw: string,
  frontmatter: NoteFrontmatterInput,
  body: string,
): string | null {
  const note = splitFenced(originalRaw);
  if (!note) return null;
  const parsed = NoteFrontmatterSchema.parse(frontmatter);
  const canon = canonicalize(parsed);
  const dumped = yaml.dump(canon, { lineWidth: -1, noRefs: true }).replace(/\n+$/, '').split('\n');
  note.lines = dumped.map((text) => ({ text, eol: note.dominantEol }));
  const out = renderFenced(note, body);
  return verifies(out, body) ? out : null;
}

// ──────────────────────────────────────────────────────────────────────────────
// Builder
// ──────────────────────────────────────────────────────────────────────────────

export interface MakeFrontmatterInput {
  title: string;
  type: NoteType;
  authored_by: string;
  /** Defaults to 'draft' for sourceless notes, else 'active'. */
  status?: NoteStatus;
  source?: string | null;
  tags?: string[];
  confidence?: number;
  distilled_from?: string[];
  supersedes?: string | null;
  contradicts?: string[];
  /** Override the id (else a fresh ULID is minted). */
  id?: string;
  /** Override the timestamp (else now). Both created_at + updated_at use it. */
  now?: Date;
  /** Extra passthrough fields to merge in (e.g. weekly rollup pointers). */
  extra?: Record<string, unknown>;
}

/**
 * Build a valid §8.3 frontmatter object with sensible defaults: a fresh ULID,
 * now() timestamps, confidence 0.5, empty link arrays. Throws if the result
 * fails validation (e.g. an atomic_fact with no source and non-draft status).
 */
export function makeFrontmatter(input: MakeFrontmatterInput): NoteFrontmatter {
  const now = (input.now ?? new Date()).toISOString();
  const source = input.source ?? null;
  const status: NoteStatus =
    input.status ?? (source === null ? 'draft' : 'active');
  const fm: Record<string, unknown> = {
    id: input.id ?? ulid(),
    title: input.title,
    created_at: now,
    updated_at: now,
    type: input.type,
    status,
    tags: input.tags ?? [],
    source,
    authored_by: input.authored_by,
    confidence: input.confidence ?? 0.5,
    distilled_from: input.distilled_from ?? [],
    supersedes: input.supersedes ?? null,
    contradicts: input.contradicts ?? [],
    ...(input.extra ?? {}),
  };
  return NoteFrontmatterSchema.parse(fm);
}
