// Lock-in tests for the shared board invariants fixed in REVIEW-2026-06-10
// §6/§7:
//   • BOARD_META codenames must match the captain charters (Hammer/Scroll, not
//     the old Caret/Scribe drift).
//   • BOARD_META keys must stay in lockstep with the BOARDS source of truth.
//   • ModelScopeSchema's board scope must accept exactly the BOARDS roster and
//     reject anything else (the inline 8-board literal was replaced by BOARDS).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BOARD_META } from './boards.js';
import { BOARDS } from './agents.js';
import { ModelScopeSchema } from './phase3prep.js';

test('BOARD_META codenames match the captain charters (no Caret/Scribe drift)', () => {
  // Charter frontmatter (agent_space/boards/{id}.md) is the persona source of
  // truth. These two drifted in the original BOARD_META.
  assert.equal(BOARD_META.coding.codename, 'Hammer');
  assert.equal(BOARD_META.research.codename, 'Scroll');

  // The other six were already aligned; lock them so a future rename to the
  // charters forces a matching edit here.
  assert.equal(BOARD_META.engineering.codename, 'Wrench');
  assert.equal(BOARD_META.design.codename, 'Brush');
  assert.equal(BOARD_META.marketing.codename, 'Megaphone');
  assert.equal(BOARD_META.finance.codename, 'Ledger');
  assert.equal(BOARD_META.publishing.codename, 'Quill');
  assert.equal(BOARD_META.devops.codename, 'Pipe');
});

test('BOARD_META keys stay in lockstep with BOARDS (no silent roster drift)', () => {
  assert.deepEqual(Object.keys(BOARD_META).sort(), [...BOARDS].sort());
  // No stale Caret/Scribe codenames anywhere in the table.
  const codenames = Object.values(BOARD_META).map((m) => m.codename);
  assert.ok(!codenames.includes('Caret'), 'stale "Caret" codename present');
  assert.ok(!codenames.includes('Scribe'), 'stale "Scribe" codename present');
});

test('ModelScopeSchema board scope accepts exactly the BOARDS roster', () => {
  assert.ok(ModelScopeSchema.safeParse('skippy').success);
  for (const id of BOARDS) {
    assert.ok(
      ModelScopeSchema.safeParse(`board.${id}`).success,
      `board.${id} should be a valid model scope`,
    );
  }
  assert.ok(!ModelScopeSchema.safeParse('board.nope').success);
  assert.ok(!ModelScopeSchema.safeParse('board.').success);
});
