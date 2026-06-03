// frontmatter.test.ts — WS1 unit tests (node:test, no extra test framework).
//
// Run via: node --import tsx --test src/frontmatter.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  makeFrontmatter,
  serializeNote,
  parseNote,
  validateFrontmatter,
  NOTE_TYPES,
} from './frontmatter.js';

test('makeFrontmatter mints a ULID + now timestamps + defaults', () => {
  const fm = makeFrontmatter({
    title: 'Test note',
    type: 'concept',
    authored_by: 'human',
  });
  assert.match(fm.id, /^[0-9A-Za-z]{26}$/);
  assert.equal(fm.title, 'Test note');
  assert.equal(fm.type, 'concept');
  assert.equal(fm.confidence, 0.5);
  assert.deepEqual(fm.tags, []);
  assert.deepEqual(fm.distilled_from, []);
  assert.equal(fm.supersedes, null);
  assert.deepEqual(fm.contradicts, []);
  // sourceless → defaults to draft
  assert.equal(fm.status, 'draft');
});

test('serialize → parse → validate round-trips losslessly', () => {
  const fm = makeFrontmatter({
    title: 'Plasma confinement basics',
    type: 'atomic_fact',
    authored_by: 'research.distiller',
    source: '01HZX9K2P7M4QTYV3BRWC8XENF',
    status: 'distilled',
    confidence: 0.8,
    distilled_from: ['01HZX9K2P7M4QTYV3BRWC8XENF'],
    tags: ['plasma', 'fusion'],
  });
  const md = serializeNote(fm, 'A tokamak confines plasma with a toroidal field.');
  assert.match(md, /^---\n/);
  const { frontmatter, body } = parseNote(md);
  const v = validateFrontmatter(frontmatter);
  assert.ok(v.ok, v.ok ? '' : v.errors.join('; '));
  if (v.ok) {
    assert.equal(v.value.title, fm.title);
    assert.equal(v.value.type, 'atomic_fact');
    assert.equal(v.value.confidence, 0.8);
    assert.deepEqual(v.value.tags, ['plasma', 'fusion']);
    assert.deepEqual(v.value.distilled_from, ['01HZX9K2P7M4QTYV3BRWC8XENF']);
  }
  assert.match(body, /tokamak confines plasma/);
});

test('§8.10 guard: sourceless atomic_fact must be draft', () => {
  // non-draft sourceless atomic_fact → rejected
  const bad = validateFrontmatter({
    id: '01HZX9K2P7M4QTYV3BRWC8XENF',
    title: 'Unsourced claim',
    created_at: '2026-06-03T00:00:00Z',
    updated_at: '2026-06-03T00:00:00Z',
    type: 'atomic_fact',
    status: 'distilled',
    authored_by: 'research.distiller',
    source: null,
    confidence: 0.6,
  });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.ok(bad.errors.some((e) => e.startsWith('source')));

  // same but status draft → allowed
  const okDraft = validateFrontmatter({
    id: '01HZX9K2P7M4QTYV3BRWC8XENF',
    title: 'Unsourced claim',
    created_at: '2026-06-03T00:00:00Z',
    updated_at: '2026-06-03T00:00:00Z',
    type: 'atomic_fact',
    status: 'draft',
    authored_by: 'research.distiller',
    source: null,
    confidence: 0.6,
  });
  assert.equal(okDraft.ok, true);
});

test('unknown note type is rejected; all closed-set types accepted', () => {
  const bad = validateFrontmatter({
    id: '01HZX9K2P7M4QTYV3BRWC8XENF',
    title: 'x',
    created_at: '2026-06-03T00:00:00Z',
    updated_at: '2026-06-03T00:00:00Z',
    type: 'not_a_type',
    status: 'active',
    authored_by: 'human',
  });
  assert.equal(bad.ok, false);
  for (const t of NOTE_TYPES) {
    const fm = makeFrontmatter({ title: 't', type: t, authored_by: 'human', source: 'ref://x' });
    assert.equal(fm.type, t);
  }
});

test('passthrough preserves unknown keys through serialize/parse', () => {
  const fm = makeFrontmatter({
    title: 'Weekly rollup',
    type: 'weekly',
    authored_by: 'staff.memory_manager',
    source: 'gen://lint',
    extra: { rollup_of: ['2026-06-01', '2026-06-02'] },
  });
  const md = serializeNote(fm, 'weekly synthesis');
  const { frontmatter } = parseNote(md);
  assert.deepEqual((frontmatter as { rollup_of?: unknown }).rollup_of, [
    '2026-06-01',
    '2026-06-02',
  ]);
});
