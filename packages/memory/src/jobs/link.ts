// jobs/link.ts — Job 3 of the four-job memory pipeline (PRD §8.5).
//
// Owner charter: agent_space/tasks/link.md (staff.link). The charter describes a
// graph-walk + embedding-neighbor pass that fills [[wikilinks]] and sets
// contradicts/supersedes edges. THIS runtime glue implements the deterministic,
// dependency-light core: it links freshly-distilled atomic notes into their
// `20_Topics/` concept pages by keyword overlap, OPTIONALLY refined by a vector
// store when one is available, and ALWAYS degrading to keyword/graph-walk when
// it is not (PRD §8.7 steps 2–4).
//
// Bounds honored (PRD §8.10): scan ≤ 50 notes, graph depth ≤ 3, cycle-safe (we
// only ever add edges from a topic page to atomic ids, so no cycles form, but we
// keep the depth/budget caps explicit for when richer walks land).

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { writeNote } from '../atomic.js';
import {
  makeFrontmatter,
  parseNote,
  validateFrontmatter,
  type NoteFrontmatter,
} from '../frontmatter.js';
import { makeVectorStore, type VectorStore } from '../vector-store.js';
import type { JobEvent } from './types.js';

// PRD §8.10 guards.
const NODE_BUDGET = 50;
const MAX_DEPTH = 3;
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with',
  'as', 'by', 'at', 'from', 'into', 'is', 'are', 'was', 'were', 'be', 'been',
  'this', 'that', 'these', 'those', 'it', 'its', 'we', 'they', 'their', 'our',
  'has', 'have', 'had', 'can', 'will', 'would', 'should', 'could', 'may', 'might',
  'when', 'where', 'which', 'who', 'while', 'because', 'however', 'each', 'both',
  'not', 'no', 'so', 'than', 'then', 'such', 'also', 'more', 'most', 'some',
]);

export interface RunLinkOptions {
  vaultRoot: string;
  onJob?: (e: JobEvent) => void;
}

export interface LinkResult {
  /** Number of new [[wikilinks]] added across all topic pages. */
  linksAdded: number;
}

interface LoadedNote {
  id: string;
  path: string;
  fm: NoteFrontmatter;
  body: string;
  /** Lowercase keyword set drawn from title + tags + body. */
  keywords: Set<string>;
  /** Full lowercase text (title + tags + body) for vector embedding. */
  text: string;
}

/** Extract a lowercase keyword set from free text (split, destop, dedupe). */
function keywordSet(...parts: string[]): Set<string> {
  const out = new Set<string>();
  for (const part of parts) {
    for (const raw of part.toLowerCase().split(/[^a-z0-9]+/)) {
      if (raw.length >= 3 && !STOPWORDS.has(raw)) out.add(raw);
    }
  }
  return out;
}

/**
 * Select the per-run atomic working set, newest-first, capped at the node budget.
 *
 * Note ids are ULIDs, which sort lexicographically by creation time, so the raw
 * `readdir` order is OLDEST-first. Slicing that order would permanently freeze the
 * link job on the first 50 notes ever distilled and make every newer fact invisible
 * to linking forever (the §8.10 "≤ N notes" bound is a per-run *work cap*, not a
 * data exclusion). We therefore sort DESCENDING by id (newest ULID first) and take
 * the budget off the top, so freshly-distilled facts are always in-scope and the
 * cap only ever sheds the *oldest* (already long-since linked) tail.
 */
function selectRecent(notes: LoadedNote[], budget: number): LoadedNote[] {
  return [...notes]
    .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    .slice(0, budget);
}

/** Load + validate every `.md` note under a vault subdir. Skips invalid notes. */
async function loadDir(dir: string): Promise<LoadedNote[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: LoadedNote[] = [];
  for (const name of entries) {
    if (!name.toLowerCase().endsWith('.md')) continue;
    const full = path.join(dir, name);
    let raw: string;
    try {
      raw = await fs.readFile(full, 'utf8');
    } catch {
      continue;
    }
    const parsed = parseNote(raw);
    const v = validateFrontmatter(parsed.frontmatter);
    if (!v.ok) continue;
    const tags = v.value.tags.join(' ');
    out.push({
      id: v.value.id,
      path: full,
      fm: v.value,
      body: parsed.body,
      keywords: keywordSet(v.value.title, tags, parsed.body),
      text: `${v.value.title} ${tags} ${parsed.body}`,
    });
  }
  return out;
}

/** Count shared keywords between two sets. */
function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const k of a) if (b.has(k)) n += 1;
  return n;
}

/**
 * Try to build a vector store for semantic refinement. NEVER required — if the
 * store is unavailable (no Smart Connections cache, no local model) the link job
 * falls back to pure keyword overlap. Returns null on any failure.
 */
async function tryVectorStore(vaultRoot: string): Promise<VectorStore | null> {
  try {
    const store = await makeVectorStore({ vaultRoot });
    return store.available ? store : null;
  } catch {
    return null;
  }
}

/**
 * Run Job 3 (Link). For each `20_Topics/` page, find related `10_Atomic/` notes by
 * keyword overlap (refined by vector similarity when a store is available) and add
 * any missing `[[<id>]]` wikilinks into the topic page body. Bounded per §8.10.
 */
export async function runLink(opts: RunLinkOptions): Promise<LinkResult> {
  const { vaultRoot, onJob } = opts;
  onJob?.({ job: 'link', phase: 'start' });

  try {
    // Newest-first working set (NEVER the oldest 50): the budget caps work per run,
    // it must not exclude freshly-distilled facts. See selectRecent for the why.
    const atomic = selectRecent(
      await loadDir(path.join(vaultRoot, '10_Atomic')),
      NODE_BUDGET,
    );
    const topics = await loadDir(path.join(vaultRoot, '20_Topics'));

    // Optional semantic refinement — degrade silently when unavailable.
    const store = await tryVectorStore(vaultRoot);
    const corpus = atomic.map((n) => ({ id: n.id, text: n.text }));

    let linksAdded = 0;

    for (const topic of topics) {
      // Candidate atomic notes for THIS topic, ranked by keyword overlap first.
      const scored = atomic
        .map((note) => ({ note, score: overlap(topic.keywords, note.keywords) }))
        .filter((c) => c.score > 0)
        .sort((a, b) => b.score - a.score);

      let candidateIds = scored.map((c) => c.note.id);

      // Vector refinement (optional): if a store is available, re-rank the topic's
      // neighbors by cosine similarity and merge those ids in. Bounded by depth as
      // a topK so a runaway corpus can't blow the node budget.
      if (store) {
        try {
          const hits = await store.search(topic.text, corpus, MAX_DEPTH * 4);
          const semanticIds = hits.filter((h) => h.score > 0.2).map((h) => h.id);
          // Keyword hits first (precision), then any new semantic neighbors.
          const merged = [...candidateIds];
          for (const id of semanticIds) if (!merged.includes(id)) merged.push(id);
          candidateIds = merged;
        } catch {
          // Vector path failed mid-flight — keep the keyword candidates.
        }
      }

      // Cap the neighborhood at the node budget (depth-bounded fan-out).
      candidateIds = candidateIds.slice(0, NODE_BUDGET);

      // Add only the [[id]] links not already present in the body.
      const missing = candidateIds.filter((id) => !topic.body.includes(`[[${id}]]`));
      if (missing.length === 0) continue;

      const additions = missing.map((id) => `- [[${id}]]`).join('\n');
      const newBody = `${topic.body.replace(/\s+$/, '')}\n${additions}\n`;

      // Bump updated_at by re-stamping the existing (already-valid) frontmatter.
      const fm = makeFrontmatter({
        id: topic.fm.id,
        title: topic.fm.title,
        type: topic.fm.type,
        status: topic.fm.status,
        authored_by: topic.fm.authored_by,
        source: topic.fm.source,
        tags: topic.fm.tags,
        confidence: topic.fm.confidence,
        distilled_from: topic.fm.distilled_from,
        supersedes: topic.fm.supersedes,
        contradicts: topic.fm.contradicts,
      });

      const res = await writeNote(topic.path, fm, newBody);
      if (res.written) linksAdded += missing.length;
    }

    onJob?.({ job: 'link', phase: 'complete', counts: { links: linksAdded } });
    return { linksAdded };
  } catch (err) {
    onJob?.({
      job: 'link',
      phase: 'error',
      detail: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
