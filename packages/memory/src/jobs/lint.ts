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
// Hard invariant: the ONLY path we ever write is `_index/proposals/<ulid>.md`.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { ulid } from 'ulid';

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

export interface RunLintOptions {
  vaultRoot: string;
  onJob?: (e: JobEvent) => void;
}

export interface LintResult {
  /** Absolute path to the single proposal note written under `_index/proposals/`. */
  proposalPath: string;
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
 * Run Job 4 (Lint). Read-only scan of `10_Atomic/` + `20_Topics/`; writes ONE
 * proposal note to `_index/proposals/<ulid>.md` summarizing orphans, sourceless
 * drafts, and stale notes. Returns the proposal path + orphan count.
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

    const date = new Date(now).toISOString().slice(0, 10);
    const proposalId = ulid();
    const proposalPath = path.join(
      vaultRoot,
      '_index',
      'proposals',
      `${proposalId}.md`,
    );

    const fm = makeFrontmatter({
      id: proposalId,
      title: `Lint proposal — ${date}`,
      type: 'agent_log',
      status: 'draft',
      authored_by: 'staff.lint',
      source: 'gen://lint',
      tags: ['lint', 'proposal', 'memory-pipeline'],
    });
    const body = renderProposalBody({ date, orphans, sourceless, stale });

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
