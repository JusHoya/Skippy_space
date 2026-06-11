// supervisor.test.ts — lock-in for delegation-deadline normalization.
//
// Regression guard for docs/REVIEW-2026-06-10.md §6 (`supervisor.ts:138`): a
// model-supplied `deadline` flowed unvalidated onto the `delegation` wire envelope,
// whose renderer schema is `deadline: z.string().datetime({ offset: true })`. A
// bad value (a bare date, "tomorrow", junk) made the renderer reject the ENTIRE
// envelope, so the delegation silently vanished from the UI. `normalizeDeadline`
// must coerce-or-drop so the envelope always validates.
//
// The strongest assertion is the round-trip: feed the normalized value back into
// the REAL renderer schema (`DelegationEnvelope` from @skippy/shared) and prove it
// parses. No SDK / network / Docker needed.
//
// Run: node --import tsx --test src/supervisor.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DelegationEnvelope } from '@skippy/shared';

import { normalizeDeadline } from './supervisor.js';

/** Build the same `delegation` envelope the supervisor writes, with the given
 * (already-normalized) deadline spread in exactly as the supervisor spreads it. */
function envelopeWith(deadline: string | undefined) {
  return {
    type: 'delegation' as const,
    delegationId: '01J0000000000000000000000A',
    fromAgentId: 'skippy' as const,
    toBoardId: 'engineering' as const,
    missionBrief: 'do the thing',
    ...(deadline ? { deadline } : {}),
    ts: new Date().toISOString(),
  };
}

test('valid offset datetimes pass through unchanged', () => {
  for (const d of [
    '2026-06-10T12:00:00Z',
    '2026-06-10T12:00:00+02:00',
    '2026-06-10T12:00:00.123Z',
    '2026-06-10T12:00:00.000-05:00',
  ]) {
    assert.equal(normalizeDeadline(d), d, `${d} should be untouched`);
  }
});

test('date-only / offset-less but Date-parseable values are coerced to a schema-valid ...Z string', () => {
  // The renderer's schema REJECTS these as-is (no offset) but they are Date-parseable,
  // so the supervisor must coerce rather than drop.
  for (const d of ['2026-06-10', '2026-06-10T12:00:00']) {
    const out = normalizeDeadline(d);
    assert.ok(out, `${d} should coerce to something`);
    // Coerced result must satisfy the real renderer schema.
    assert.ok(
      DelegationEnvelope.safeParse(envelopeWith(out)).success,
      `coerced ${d} -> ${out} must pass DelegationEnvelope`,
    );
  }
});

test('unparseable garbage is dropped (returns undefined), not forwarded', () => {
  for (const d of ['tomorrow', 'eod', 'whenever', 'next sprint', '', '   ']) {
    assert.equal(normalizeDeadline(d), undefined, `${JSON.stringify(d)} should drop`);
  }
});

test('undefined in -> undefined out (no deadline given)', () => {
  assert.equal(normalizeDeadline(undefined), undefined);
});

test('the resulting envelope ALWAYS validates regardless of the model deadline', () => {
  // The core invariant: whatever the model hands us, the delegation envelope the
  // supervisor writes parses against the renderer schema — the delegation can never
  // silently vanish from the UI because of a bad deadline.
  const modelDeadlines = [
    '2026-06-10T12:00:00Z', // already valid
    '2026-06-10', // date-only -> coerced
    '2026-06-10T12:00:00', // offset-less -> coerced
    'tomorrow', // junk -> dropped
    'do it by friday', // junk -> dropped
    undefined, // none
  ];
  for (const md of modelDeadlines) {
    const normalized = normalizeDeadline(md);
    const result = DelegationEnvelope.safeParse(envelopeWith(normalized));
    assert.ok(
      result.success,
      `envelope for model deadline ${JSON.stringify(md)} must validate (got ${JSON.stringify(normalized)})`,
    );
  }
});
