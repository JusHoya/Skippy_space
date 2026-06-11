// jobs/link-ingest.regression.test.ts — lock-in tests for two HIGH memory-pipeline
// bugs from docs/REVIEW-2026-06-10.md (node:test).
//
// Run via: node --import tsx --test src/jobs/link-ingest.regression.test.ts
//
//   1. LINK BUDGET froze on the OLDEST 50 notes. `.slice(0, NODE_BUDGET)` of the raw
//      (ULID-ascending = oldest-first) readdir order meant every fact past the first
//      50 was invisible to linking forever. We assert that with >50 atomic notes the
//      NEWEST ones land in a topic page's links and the oldest tail is the part shed.
//   2. INGEST hard-failed on external relative `.md` links. The verbatim external body
//      hit atomic.ts's wikilink guard and threw at job 1, stranding the drop in the
//      inbox. We assert an external body containing `./README.md` ingests successfully
//      and the relative link is neutralized in the written source note.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ulid } from 'ulid';

import { runLink } from './link.js';
import { runIngest } from './ingest.js';
import { neutralizeRelativeMdLinks } from './archival-mirror.js';
import { serializeNote, parseNote, validateFrontmatter } from '../frontmatter.js';
import { hasRelativeMdLink } from '../atomic.js';

const NODE_BUDGET = 50; // mirrors the §8.10 guard in link.ts

async function makeVault(...subs: string[]): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skippy-link-ingest-'));
  for (const sub of subs) await fs.mkdir(path.join(root, sub), { recursive: true });
  return root;
}

// ──────────────────────────────────────────────────────────────────────────────
// Bug 1 — link budget must keep the NEWEST notes, not the oldest 50.
// ──────────────────────────────────────────────────────────────────────────────

test('runLink keeps the NEWEST atomic notes when the corpus exceeds the node budget', async () => {
  const vaultRoot = await makeVault('10_Atomic', '20_Topics');

  // Mint a long, strictly time-ascending run of ULIDs (oldest-first), well past the
  // budget. `ulid(seedTime)` with increasing times is lexicographically ascending,
  // so `ids[0]` is the OLDEST and `ids[n-1]` is the NEWEST — exactly the disk order
  // the old `.slice(0, NODE_BUDGET)` would have frozen on the oldest end.
  const count = NODE_BUDGET + 20; // 70 notes
  const baseTime = 1_700_000_000_000;
  const ids: string[] = [];
  for (let i = 0; i < count; i++) ids.push(ulid(baseTime + i * 1000));
  assert.deepEqual([...ids].sort(), ids, 'sanity: ids are lexicographically ascending');

  // Every atomic note shares the keyword "transformer" with the topic so overlap > 0
  // for all of them — the ONLY thing deciding which get linked is the recency cut.
  for (const id of ids) {
    const fm = {
      id,
      title: 'transformer fact',
      created_at: new Date(baseTime).toISOString(),
      updated_at: new Date(baseTime).toISOString(),
      type: 'atomic_fact',
      status: 'active',
      tags: ['transformer'],
      source: 'ref:#test',
      authored_by: 'staff.distill',
      confidence: 0.6,
      distilled_from: [],
      supersedes: null,
      contradicts: [],
    };
    const note = serializeNote(fm, '\nThe transformer attends over every token.\n');
    await fs.writeFile(path.join(vaultRoot, '10_Atomic', `${id}.md`), note, 'utf8');
  }

  // One topic page that matches the shared keyword.
  const topicId = ulid(baseTime + count * 1000);
  const topicFm = {
    id: topicId,
    title: 'Transformer',
    created_at: new Date(baseTime).toISOString(),
    updated_at: new Date(baseTime).toISOString(),
    type: 'concept',
    status: 'active',
    tags: ['transformer'],
    source: null,
    authored_by: 'staff.link',
    confidence: 0.5,
    distilled_from: [],
    supersedes: null,
    contradicts: [],
  };
  const topicPath = path.join(vaultRoot, '20_Topics', `${topicId}.md`);
  await fs.writeFile(
    topicPath,
    serializeNote(topicFm, '\n# Transformer\n\nThe transformer concept page.\n'),
    'utf8',
  );

  const res = await runLink({ vaultRoot });
  assert.ok(res.linksAdded > 0, 'link job added at least one wikilink');

  const linkedBody = parseNote(await fs.readFile(topicPath, 'utf8')).body;
  const linkedIds = new Set(
    [...linkedBody.matchAll(/\[\[([0-9A-Za-z]{26})\]\]/g)].map((m) => m[1]!),
  );

  // The NEWEST notes (top of the descending sort) MUST be linked — this is the exact
  // bug: under the old oldest-first slice they were permanently excluded.
  const newest = ids.slice(-5);
  for (const id of newest) {
    assert.ok(linkedIds.has(id), `newest note ${id} must be in the linked set`);
  }

  // The budget still caps work: no more than NODE_BUDGET notes are linked, and the
  // VERY oldest note (which the old code would have kept) is the part that gets shed.
  assert.ok(
    linkedIds.size <= NODE_BUDGET,
    `linked ${linkedIds.size} notes; budget is ${NODE_BUDGET}`,
  );
  assert.ok(
    !linkedIds.has(ids[0]!),
    'the oldest note is shed by the budget (it is no longer kept in preference to new facts)',
  );
});

// ──────────────────────────────────────────────────────────────────────────────
// Bug 2 — external relative `.md` links must NOT abort ingest.
// ──────────────────────────────────────────────────────────────────────────────

test('runIngest neutralizes external relative .md links instead of hard-failing', async () => {
  const vaultRoot = await makeVault('00_Inbox', '60_Sources');
  const sourcePath = path.join(vaultRoot, '00_Inbox', 'scraped.md');

  // A realistic scraped/exported drop with relative `.md` links — the verbatim copy
  // of this body would trip atomic.ts's wikilink guard and (pre-fix) throw at job 1.
  const external =
    '# Setup Guide\n\n' +
    'See [the readme](./README.md) and the [setup notes](docs/setup.md) for details. ' +
    'Also review [the design](../design/overview.md#goals) before starting.\n';
  await fs.writeFile(sourcePath, external, 'utf8');

  // Pre-fix this REJECTS; post-fix it resolves cleanly.
  const result = await runIngest({ vaultRoot, sourcePath });

  // The drop was archived, not stranded.
  const written = await fs.readFile(result.sourceNotePath, 'utf8');
  const parsed = parseNote(written);
  const v = validateFrontmatter(parsed.frontmatter);
  assert.ok(v.ok, v.ok ? '' : v.errors.join('; '));
  assert.equal(v.ok && v.value.type, 'external_source');

  // The forbidden relative `.md` links must NOT survive into the vault body...
  assert.doesNotMatch(parsed.body, /\]\(\s*(?!https?:\/\/)[^)]*\.md[)#?\s]/i,
    'no relative .md markdown link survives in the ingested body');
  // ...but the human-readable labels are preserved (lossless archive of substance).
  assert.match(parsed.body, /the readme/);
  assert.match(parsed.body, /setup notes/);
  assert.match(parsed.body, /the design/);

  // And the inbox drop was removed (ingest moved+normalized it).
  const inboxGone = await fs
    .access(sourcePath)
    .then(() => false)
    .catch(() => true);
  assert.ok(inboxGone, 'the original inbox drop was removed after a successful ingest');
});

// The neutralizer must be a strict SUPERSET of atomic.ts's guard. The guard's URL
// class allows spaces (`[^)]*`), so spaced Obsidian/Windows filenames and `.md`+text
// before the close paren trip the guard — and previously slipped past a neutralizer
// that forbade spaces (`[^)\s]*`), re-stranding the drop. These are the exact gaps.
test('runIngest neutralizes guard-tripping links the old space-free regex missed', async () => {
  const vaultRoot = await makeVault('00_Inbox', '60_Sources');
  const sourcePath = path.join(vaultRoot, '00_Inbox', 'spaced.md');

  const external =
    '# Exported notes\n\n' +
    'Open [my notes](./My Project.md) first. ' + // spaced filename
    'Then [the spec](docs/the spec.md#intro) and ' + // spaced + anchor
    'finally [more](./foo.md and more) somewhere.\n'; // .md followed by text before )
  await fs.writeFile(sourcePath, external, 'utf8');

  const result = await runIngest({ vaultRoot, sourcePath });
  const parsed = parseNote(await fs.readFile(result.sourceNotePath, 'utf8'));

  // No relative .md link may survive — assert against atomic.ts's ACTUAL guard.
  assert.equal(hasRelativeMdLink(parsed.body), false, 'no guard-tripping link survives');
  assert.match(parsed.body, /my notes/);
  assert.match(parsed.body, /the spec/);
  assert.match(parsed.body, /more/);
});

test('neutralizeRelativeMdLinks output always satisfies the writer guard', () => {
  const cases = [
    '[a](./a.md)',
    '[b](../b.md#frag)',
    '[c](notes/c.md )', // trailing space before close
    '[d](./My Project.md)', // spaced filename
    '[e](./e.md and trailing text)', // text before close
    '[f](./f.md', // malformed: no close paren
    '[g](./a.md) and [h](./b.md)', // adjacent links must not greedily merge
    '[keep](https://example.com/x.md)', // absolute http — must be UNtouched
  ];
  for (const c of cases) {
    assert.equal(hasRelativeMdLink(neutralizeRelativeMdLinks(c)), false, `still tripped guard: ${c}`);
  }
  // Absolute links survive verbatim; adjacent relatives neutralize independently.
  assert.match(
    neutralizeRelativeMdLinks('[keep](https://example.com/x.md)'),
    /https:\/\/example\.com\/x\.md/,
  );
  assert.match(neutralizeRelativeMdLinks('[g](./a.md) and [h](./b.md)'), /g and h/);
});
