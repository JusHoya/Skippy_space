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

import matter from 'gray-matter';
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

/** Parse a markdown note into { frontmatter, body }. Does not validate. */
export function parseNote(raw: string): ParsedNote {
  const file = matter(raw);
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
