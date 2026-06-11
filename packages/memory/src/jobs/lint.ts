// jobs/lint.ts — Job 4 of the four-job memory pipeline (PRD §8.5).
//
// Owner charter: agent_space/tasks/lint.md (staff.lint). The auditor is READ-ONLY
// on live notes — it NEVER writes destructively. Its only output is a single
// proposal note under `_index/proposals/` for a human / memory-manager to approve.
//
// This runtime glue surfaces three §8.5/§8.10 hygiene signals:
//   - Orphan atomic notes: no inbound [[<id>]] wikilink from any 20_Topics page.
//   - Sourceless drafts: atomic_fact notes parked as draft with no source (§8.10).
//   - Stale notes: updated_at older than 90 days (unlikely to fire in the test).
//
// Hard invariant: the ONLY path we ever write is the single ROLLING proposal note
// `_index/proposals/<ROLLING_PROPOSAL_ID>.md`. Earlier versions minted a fresh ULID
// every run, so each cron tick (every 24h, plus a weekly pass) left a new near-
// duplicate proposal nothing reads — unbounded vault growth (review §7). We now:
//   - write NOTHING when there are zero findings (a clean sweep needs no proposal), and
//   - overwrite ONE stable-id note when there are findings (newest sweep wins),
// so the proposals dir holds at most one note that always reflects the latest sweep.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { writeNote } from '../atomic.js';
import {
  makeFrontmatter,
  parseNote,
  validateFrontmatter,
  type NoteFrontmatter,
} from '../frontmatter.js';
import type { JobEvent } from './types.js';

const STALE_DAYS = 90;
const STALE_MS = STALE_DAYS * 24 * 60 * 60 * 1000;

// Stable ULID-shaped id for the SINGLE rolling proposal note. It is a fixed 26-char
// Crockford-base32 string (satisfies §8.3's `id` regex) so every lint run targets the
// same `_index/proposals/<id>.md` and OVERWRITES it instead of minting a new note. The
// vault therefore holds at most one proposal, always reflecting the latest sweep.
const ROLLING_PROPOSAL_ID = '0000000000LINT0R0LL1NG0PR0';

export interface RunLintOptions {
  vaultRoot: string;
  onJob?: (e: JobEvent) => void;
}

export interface LintResult {
  /**
   * Absolute path to the rolling proposal note under `_index/proposals/`, or `null`
   * when the sweep was clean (no findings) and nothing was written.
   */
  proposalPath: string | null;
  /** Number of orphan atomic notes found. */
  orphanCount: number;
}

interface LiveNote {
  id: string;
  path: string;
  fm: NoteFrontmatter;
  body: string;
}

/** Read + validate every `.md` note under a subdir (read-only). */
async function readDir(dir: string): Promise<LiveNote[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: LiveNote[] = [];
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
    out.push({ id: v.value.id, path: full, fm: v.value, body: parsed.body });
  }
  return out;
}

/** Collect every [[target]] wikilink target across a set of note bodies. */
function collectWikilinkTargets(notes: LiveNote[]): Set<string> {
  const targets = new Set<string>();
  const re = /\[\[([^\]|#^]+)/g;
  for (const note of notes) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(note.body)) !== null) {
      const t = m[1]?.trim();
      if (t) targets.add(t);
    }
  }
  return targets;
}

function renderProposalBody(args: {
  date: string;
  orphans: LiveNote[];
  sourceless: LiveNote[];
  stale: LiveNote[];
}): string {
  const { date, orphans, sourceless, stale } = args;
  const lines: string[] = [
    `## Lint Sweep — ${date}`,
    '',
    `### Orphans (${orphans.length})`,
    ...(orphans.length === 0
      ? ['- none']
      : orphans.map((n) => `- [[${n.id}]] — no inbound wikilink from any 20_Topics page`)),
    '',
    `### Sourceless drafts (${sourceless.length})`,
    ...(sourceless.length === 0
      ? ['- none']
      : sourceless.map((n) => `- [[${n.id}]] — atomic_fact draft with no source (PRD §8.10)`)),
    '',
    `### Stale-claim flags (${stale.length})`,
    ...(stale.length === 0
      ? ['- none']
      : stale.map((n) => `- [[${n.id}]] — updated_at older than ${STALE_DAYS} days`)),
    '',
    '> READ-ONLY proposal. Approve to enact. No live note was modified.',
    '',
  ];
  return lines.join('\n');
}

/**
 * Run Job 4 (Lint). Read-only scan of `10_Atomic/` + `20_Topics/`. When the sweep
 * finds anything (orphans, sourceless drafts, or stale notes) it OVERWRITES the
 * single rolling proposal note `_index/proposals/<ROLLING_PROPOSAL_ID>.md` with the
 * latest summary. A clean sweep writes NOTHING (and leaves any prior proposal in
 * place for a human to clear once enacted). Returns the proposal path (or `null`
 * when nothing was written) + orphan count.
 */
export async function runLint(opts: RunLintOptions): Promise<LintResult> {
  const { vaultRoot, onJob } = opts;
  onJob?.({ job: 'lint', phase: 'start' });

  try {
    const atomic = await readDir(path.join(vaultRoot, '10_Atomic'));
    const topics = await readDir(path.join(vaultRoot, '20_Topics'));

    // Inbound link targets come from topic pages (the linker writes [[<id>]] there).
    // We also consider atomic-to-atomic links so a future linker pass counts too.
    const linkedTargets = collectWikilinkTargets([...topics, ...atomic]);

    const orphans = atomic.filter((n) => !linkedTargets.has(n.id));
    const sourceless = atomic.filter(
      (n) =>
        n.fm.type === 'atomic_fact' &&
        n.fm.status === 'draft' &&
        (n.fm.source === null || String(n.fm.source).trim() === ''),
    );

    const now = Date.now();
    const stale = atomic.filter((n) => {
      const t = Date.parse(n.fm.updated_at);
      return Number.isFinite(t) && now - t > STALE_MS && n.fm.status !== 'canonical';
    });

    // Nothing to propose → write NOTHING. A clean sweep that minted a note every run
    // is exactly the unbounded-growth bug we're fixing; the absence of a proposal is
    // itself the signal that the vault is hygienic. (review §7)
    if (orphans.length === 0 && sourceless.length === 0 && stale.length === 0) {
      onJob?.({ job: 'lint', phase: 'complete', counts: { proposals: 0 } });
      return { proposalPath: null, orphanCount: 0 };
    }

    const date = new Date(now).toISOString().slice(0, 10);
    // Single rolling proposal: a STABLE id so repeated runs overwrite one note rather
    // than accumulating near-duplicates. The newest sweep always wins.
    const proposalPath = path.join(
      vaultRoot,
      '_index',
      'proposals',
      `${ROLLING_PROPOSAL_ID}.md`,
    );

    const fm = makeFrontmatter({
      id: ROLLING_PROPOSAL_ID,
      title: `Lint proposal — ${date}`,
      type: 'agent_log',
      status: 'draft',
      authored_by: 'staff.lint',
      source: 'gen://lint',
      tags: ['lint', 'proposal', 'memory-pipeline'],
    });
    const body = renderProposalBody({ date, orphans, sourceless, stale });

    // writeNote overwrites atomically under a per-file lock, so the rolling note is
    // replaced (not appended) — it is a proposal, NOT an append-only agent_log/daily.
    const res = await writeNote(proposalPath, fm, body);
    if (!res.written) {
      throw new Error(
        `lint: could not write proposal ${proposalPath} (reason: ${res.reason})`,
      );
    }

    onJob?.({ job: 'lint', phase: 'complete', counts: { proposals: 1 } });
    return { proposalPath, orphanCount: orphans.length };
  } catch (err) {
    onJob?.({
      job: 'lint',
      phase: 'error',
      detail: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
