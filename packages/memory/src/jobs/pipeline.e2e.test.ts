// pipeline.e2e.test.ts — WS5 exit-criterion test for the four-job pipeline.
//
// "Drop a paper into vault/00_Inbox/ and get a richly-linked set of atomic notes."
//
// This runs the WHOLE pipeline (ingest → distill → link → lint) with the
// deterministic `mockDistill` — NO LLM, NO Docker, NO Obsidian — over a tmp vault,
// and asserts the exit criterion end-to-end. It must finish well under a few
// seconds.
//
// Run via: node --import tsx --test src/jobs/pipeline.e2e.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runPipeline, mockDistill } from './index.js';
import { parseNote, validateFrontmatter } from '../frontmatter.js';

// ──────────────────────────────────────────────────────────────────────────────
// Fixture: a realistic multi-paragraph paper with a `# title`, ≥10 sentences, and
// repeated proper nouns (Transformer, Karpathy) so topics + links form.
// ──────────────────────────────────────────────────────────────────────────────
const FIXTURE = `# The Transformer Architecture and Atomic Memory

The Transformer architecture replaced recurrent networks for most sequence modeling tasks. Self-attention lets the Transformer weigh every token against every other token in a single layer. Karpathy has argued that the Transformer is a remarkably general differentiable computer. Because attention scales quadratically with sequence length, the Transformer becomes expensive on very long documents.

Atomic notes capture a single claim each so that a retriever can use them in isolation. Karpathy describes the wiki as a codebase that compounds knowledge over time. Each atomic note carries a source reference and a calibrated confidence value. A concept page in the wiki gathers related atomic notes by name rather than by similarity. The Transformer block combines multi-head attention with a position-wise feed-forward network. Layer normalization and residual connections stabilize training of deep Transformer stacks.

When Karpathy distills a paper, he extracts irreducible facts and links them into the existing graph. The link job walks the graph and fills wikilinks between related atomic notes and topic pages. The lint job is read-only and proposes cleanups without ever overwriting the record.`;

async function makeVault(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skippy-pipeline-'));
  for (const sub of ['00_Inbox', '10_Atomic', '20_Topics', '60_Sources', '_index/proposals']) {
    await fs.mkdir(path.join(root, sub), { recursive: true });
  }
  return root;
}

async function listMd(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).filter((f) => f.toLowerCase().endsWith('.md'));
  } catch {
    return [];
  }
}

test('exit criterion: drop a paper → richly-linked atomic notes', async () => {
  const started = Date.now();
  const vaultRoot = await makeVault();
  const sourcePath = path.join(vaultRoot, '00_Inbox', 'transformer-paper.md');
  await fs.writeFile(sourcePath, FIXTURE, 'utf8');

  const result = await runPipeline({ vaultRoot, sourcePath, distill: mockDistill });

  // ── (a) a valid external_source note exists in 60_Sources, inbox is emptied ──
  const sourceFiles = await listMd(path.join(vaultRoot, '60_Sources'));
  assert.equal(sourceFiles.length, 1, 'exactly one source note in 60_Sources');
  const sourceRaw = await fs.readFile(
    path.join(vaultRoot, '60_Sources', sourceFiles[0]!),
    'utf8',
  );
  const sourceParsed = parseNote(sourceRaw);
  const sourceV = validateFrontmatter(sourceParsed.frontmatter);
  assert.ok(sourceV.ok, sourceV.ok ? '' : sourceV.errors.join('; '));
  assert.equal(sourceV.ok && sourceV.value.type, 'external_source');
  const sourceId = sourceV.ok ? sourceV.value.id : '';
  assert.equal(sourceId, result.ingest.sourceId, 'returned sourceId matches the written note');

  // 00_Inbox no longer contains the original drop.
  const inboxLeft = await listMd(path.join(vaultRoot, '00_Inbox'));
  assert.equal(inboxLeft.length, 0, '00_Inbox is emptied after ingest');
  assert.equal(
    await fs.access(sourcePath).then(() => true).catch(() => false),
    false,
    'the original drop was removed',
  );

  // ── (b) ≥8 valid atomic_fact notes, each sourced + distilled_from the source ──
  const atomicFiles = await listMd(path.join(vaultRoot, '10_Atomic'));
  assert.ok(atomicFiles.length >= 8, `expected ≥8 atomic notes, got ${atomicFiles.length}`);
  for (const f of atomicFiles) {
    const raw = await fs.readFile(path.join(vaultRoot, '10_Atomic', f), 'utf8');
    const parsed = parseNote(raw);
    const v = validateFrontmatter(parsed.frontmatter);
    assert.ok(v.ok, v.ok ? '' : `${f}: ${(v as { errors: string[] }).errors.join('; ')}`);
    if (!v.ok) continue;
    assert.equal(v.value.type, 'atomic_fact', `${f} is an atomic_fact`);
    assert.ok(
      typeof v.value.source === 'string' && v.value.source.trim().length > 0,
      `${f} has a non-empty source`,
    );
    assert.ok(
      v.value.distilled_from.includes(sourceId),
      `${f} distilled_from contains the source id`,
    );
  }

  // ── (c) at least one 20_Topics page body contains a [[...]] wikilink ──────────
  const topicFiles = await listMd(path.join(vaultRoot, '20_Topics'));
  assert.ok(topicFiles.length >= 1, 'at least one topic page was created');
  let topicWithLink = 0;
  for (const f of topicFiles) {
    const raw = await fs.readFile(path.join(vaultRoot, '20_Topics', f), 'utf8');
    if (/\[\[[^\]]+\]\]/.test(parseNote(raw).body)) topicWithLink += 1;
  }
  assert.ok(topicWithLink >= 1, 'at least one topic page contains a [[wikilink]]');
  assert.ok(result.link.linksAdded >= 1, 'link job added ≥1 wikilink');

  // ── (d) exactly the proposal note(s) under _index/proposals; nothing stray ────
  const proposalFiles = await listMd(path.join(vaultRoot, '_index', 'proposals'));
  assert.equal(proposalFiles.length, 1, 'exactly one lint proposal note');
  const proposalRaw = await fs.readFile(
    path.join(vaultRoot, '_index', 'proposals', proposalFiles[0]!),
    'utf8',
  );
  const proposalV = validateFrontmatter(parseNote(proposalRaw).frontmatter);
  assert.ok(proposalV.ok, proposalV.ok ? '' : proposalV.errors.join('; '));
  assert.equal(proposalV.ok && proposalV.value.authored_by, 'staff.lint');
  assert.equal(
    path.join(vaultRoot, '_index', 'proposals', proposalFiles[0]!),
    result.lint.proposalPath,
    'returned proposalPath matches the written note',
  );

  // No files were written outside the expected dirs. 90_Archive / 30_Projects /
  // 40_Daily / 50_Agents must not have appeared.
  for (const stray of ['30_Projects', '40_Daily', '50_Agents', '90_Archive']) {
    const left = await listMd(path.join(vaultRoot, stray));
    assert.equal(left.length, 0, `no notes written to ${stray}`);
  }
  // _index itself should hold only the proposals subtree (no stray notes at root).
  const indexRootMd = await listMd(path.join(vaultRoot, '_index'));
  assert.equal(indexRootMd.length, 0, 'no notes written to _index root');

  // ── (e) wall-clock well under a few seconds ──────────────────────────────────
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5000, `pipeline took ${elapsed}ms, expected < 5000ms`);
});

test('mockDistill is deterministic and yields ≥8 drafts for a normal paragraph', async () => {
  const para =
    'Alpha is the first claim with enough length to survive the filter. ' +
    'Beta extends the second claim well past the minimum character threshold. ' +
    'Gamma states a third independent fact about the system under study. ' +
    'Delta records a fourth observation that the distiller should keep. ' +
    'Epsilon notes a fifth measurable property of the configuration. ' +
    'Zeta captures a sixth distinct claim worth retaining for retrieval. ' +
    'Eta adds a seventh fact that stands on its own without context. ' +
    'Theta closes with an eighth and final self-contained statement here.';

  const input = { sourceId: 'S', title: 'Greek Letters', body: para, vaultRoot: '/tmp' };
  const a = await mockDistill(input);
  const b = await mockDistill(input);

  assert.ok(a.length >= 8, `expected ≥8 drafts, got ${a.length}`);
  assert.deepEqual(
    a.map((d) => d.title),
    b.map((d) => d.title),
    'mockDistill is deterministic across calls',
  );
  for (const d of a) {
    assert.ok(d.title.length > 0, 'draft has a title');
    assert.ok(d.body.length > 0, 'draft has a body');
    assert.equal(d.confidence, 0.6, 'draft confidence is 0.6');
  }
});
