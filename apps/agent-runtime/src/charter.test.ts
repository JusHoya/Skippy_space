// charter.test.ts — lock-in tests for the hand-rolled frontmatter parser and
// the charter → model-registry binding (review §6/§7).
//
// These run against the REAL on-disk charters in `agent_space/` (the loader
// resolves the project root by walking up from this module, so a synthetic temp
// root would be ignored — testing the shipped data is the stronger lock-in).
//
// Proves: (a) nested block maps with a list-valued key parse — the `memory:`
// stanza's `core_memory_facts:` list, which the old parser truncated at its
// first `- ` item in all 13 charters; (b) trailing inline `# comments` strip
// from scalars while `#` inside a token (hex colors) survives;
// (c) `charterPermissions()` still reads its fields off the richer frontmatter;
// (d) a board's charter `model:` is honored by the model registry, with
// BOARD_META as the fallback and unknown ids warned-and-ignored;
// (e) the four Staff Officer charters are loadable/referenceable.
//
// Run: node --import tsx --test src/charter.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BOARD_META, AVAILABLE_MODELS } from '@skippy/shared';

import {
  loadCharter,
  loadStaffCharters,
  charterPermissions,
  clearCharterCache,
  type Charter,
} from './charter.js';
import { getModelFor, setBoardModelFromCharter, setModelFor } from './modelRegistry.js';

const KNOWN_MODELS = new Set<string>(AVAILABLE_MODELS.map((m) => m.id));

test('nested block map with a list-valued key (core_memory_facts) parses in full', async () => {
  clearCharterCache();
  const charter = await loadCharter('board.engineering');
  assert.equal(charter.loaded, true, 'the real engineering charter is on disk');

  const memory = charter.frontmatter['memory'] as Record<string, unknown>;
  assert.equal(typeof memory, 'object', 'memory: parses as a nested map');
  assert.equal(memory['letta_agent_id'], 'bd_engineering_v1');
  assert.equal(memory['vault_subdir'], '50_Agents/engineering/');

  const facts = memory['core_memory_facts'];
  assert.ok(Array.isArray(facts), 'core_memory_facts must parse as an array');
  // The old parser bailed at the first `- ` and produced an empty map → 0 facts.
  assert.equal(facts.length, 3, 'all three nested-list facts survive');
  assert.equal(facts[0], 'I am the Engineering Captain. I report to Skippy.');
  assert.ok(
    typeof facts[2] === 'string' && facts[2].startsWith('I am one of eight Captains'),
    'the trailing fact is present and intact',
  );

  // A sibling block-sequence key parses too.
  assert.deepEqual(charter.frontmatter['spawnable_task_agents'], [
    'code_architect',
    'aerospace_engineer',
    'fusion_physicist',
    'optimization_specialist',
    'simulation_specialist',
  ]);
});

test('trailing inline comments strip from scalars but hex tokens survive', async () => {
  clearCharterCache();
  const charter = await loadCharter('board.engineering');
  const costume = charter.frontmatter['costume'] as Record<string, unknown>;
  // Quoted hex color — the `#66FCF1` must NOT be mistaken for a comment.
  assert.equal(costume['accent_color'], '#66FCF1');
  assert.equal(costume['insignia'], 'gear_circuit');
  assert.equal(costume['base'], 'beercan_v1');
});

test('the model registry validates rather than blindly trusting a charter value', () => {
  // Defense in depth: even if a comment ever slipped past the parser, the
  // registry treats an unrecognized model string as unknown and falls back to
  // BOARD_META rather than mis-binding (the old `as ModelId` cast did the
  // opposite — silently routed to Sonnet pricing).
  setBoardModelFromCharter('devops', 'claude-haiku-4-5-20251001  # volume tier');
  assert.equal(getModelFor('board.devops'), BOARD_META.devops.defaultModel);
});

test('charterPermissions reads permission_mode / tools off the richer frontmatter', async () => {
  clearCharterCache();
  const charter = await loadCharter('board.engineering');
  const perms = charterPermissions(charter);
  assert.equal(perms.permissionMode, 'ask');
  assert.deepEqual(perms.allowedTools, ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob', 'Agent']);
  // `disallowed_tools: []` → undefined (no denylist declared).
  assert.equal(perms.disallowedTools, undefined);
});

test('every board charter declares a known model honored by the registry', async () => {
  clearCharterCache();
  for (const id of ['engineering', 'coding', 'design', 'finance'] as const) {
    const charter = await loadCharter(`board.${id}`);
    const declared = charter.frontmatter['model'];
    assert.equal(typeof declared, 'string', `${id} declares a model`);
    assert.ok(KNOWN_MODELS.has(String(declared)), `${id} model ${String(declared)} is known`);
    // Loading the charter seeds the registry to the charter's model.
    assert.equal(
      getModelFor(`board.${id}`),
      declared,
      `${id} registry binding honors its charter model`,
    );
  }
});

test('a board with no user override picks up its charter model over BOARD_META', () => {
  // marketing's BOARD_META default is haiku; force a known *different* model
  // through the charter-seeding path and confirm it wins (no user override set).
  const other = AVAILABLE_MODELS.find((m) => m.id !== BOARD_META.marketing.defaultModel);
  assert.ok(other, 'fixture: a second known model exists');
  setBoardModelFromCharter('marketing', other.id);
  assert.equal(getModelFor('board.marketing'), other.id);
});

test('a user rebind wins over a later charter seed', () => {
  setModelFor('board.publishing', 'claude-opus-4-7');
  // A charter that loads afterward must not stomp the live user choice.
  setBoardModelFromCharter('publishing', 'claude-haiku-4-5-20251001');
  assert.equal(getModelFor('board.publishing'), 'claude-opus-4-7');
});

test('an unknown charter model leaves the existing binding intact', () => {
  const before = getModelFor('board.research');
  setBoardModelFromCharter('research', 'claude-gpt-9000');
  assert.equal(getModelFor('board.research'), before, 'a typo falls back, never mis-binds');
});

test('staff charters are loadable so Skippy can reference them', async () => {
  clearCharterCache();
  const staff = await loadStaffCharters();
  assert.equal(staff.size, 4);
  for (const id of ['agent-creator', 'skill-auditor', 'memory-manager', 'psych-monitor'] as const) {
    const charter = staff.get(id) as Charter;
    assert.ok(charter, `staff.${id} resolved`);
    assert.equal(charter.agentId, `staff.${id}`);
    assert.ok(charter.body.length > 0, `staff.${id} has a body`);
  }
});
