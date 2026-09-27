// outcome-guard.test.ts — EC1 D3 (FR-RUN-01, G0 defense in depth): the
// renderer never displays a contract-violating terminal record as what it
// claims. `guardTerminalRecord` (@skippy/shared) is what apps/ui/src/lib/
// channel.ts applies to every `delegation_complete`; the reader-side schema
// below is the one channel.ts uses to accept a record the Rust shell already
// downgraded to `unverified` (see envelope.rs `TerminalRecord`).
//
// Run: node --import tsx --test src/outcome-guard.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DelegationCompleteEnvelope,
  Envelope,
  RecordedOutcomeSchema,
  guardTerminalRecord,
  readDelegationCompleteRecord,
  terminalRecordViolations,
  type ReceivedTerminalRecord,
  type TerminalRecord,
} from '@skippy/shared';

const base = { summary: 's' } as const;

test('D3: a live-channel succeeded record claiming demo mode is shown as unverified, not success', () => {
  const g = guardTerminalRecord({ ...base, outcome: 'succeeded', mode: 'demo', validation: 'not_defined' });
  assert.equal(g.outcome, 'unverified');
  assert.equal(g.validation, 'not_run');
  assert.equal(g.reason?.code, 'invalid_record');
  assert.match(g.reason?.detail ?? '', /claimed succeeded: .*demo mode cannot produce succeeded/);
  assert.ok(g.violations.includes('succeeded requires mode=live'));
});

test('D3: other invariant violators (reasonless failure, live simulated, failing validation) are unverified', () => {
  const cases: ReceivedTerminalRecord[] = [
    { ...base, outcome: 'failed', mode: 'live', validation: 'not_run' },
    { ...base, outcome: 'simulated', mode: 'live', validation: 'not_run', reason: { code: 'demo_mode', message: 'm' } },
    { ...base, outcome: 'succeeded', mode: 'live', validation: 'failed' },
  ];
  for (const c of cases) {
    const g = guardTerminalRecord(c);
    assert.equal(g.outcome, 'unverified', JSON.stringify(c));
    assert.ok(g.violations.length > 0);
  }
});

test('M0-G05: a succeeded record carrying a failure reason is a contract violation, shown as unverified', () => {
  const r: ReceivedTerminalRecord = {
    ...base,
    outcome: 'succeeded',
    mode: 'live',
    validation: 'not_defined',
    reason: { code: 'provider_error', message: 'm' },
  };
  assert.deepEqual(terminalRecordViolations(r as TerminalRecord), ['succeeded cannot carry a failure reason (provider_error)']);
  const g = guardTerminalRecord(r);
  assert.equal(g.outcome, 'unverified');
  assert.equal(g.reason?.code, 'invalid_record');
  assert.match(g.reason?.detail ?? '', /claimed succeeded\(provider_error\): succeeded cannot carry a failure reason/);
  // The persisted-record reader applies the same invariant.
  const rec = readDelegationCompleteRecord({ type: 'delegation_complete', delegationId: 'D1', fromBoardId: 'coding', ts: '2026-09-27T00:00:00.000Z', ...r });
  assert.notEqual(rec?.outcome, 'succeeded');
});

test('D3: conforming records pass through unchanged', () => {
  const ok = guardTerminalRecord({ ...base, outcome: 'succeeded', mode: 'live', validation: 'not_defined' });
  assert.deepEqual(ok, { outcome: 'succeeded', mode: 'live', validation: 'not_defined', violations: [] });
  const reason = { code: 'provider_error' as const, message: 'm', detail: '401' };
  const failed = guardTerminalRecord({ ...base, outcome: 'failed', mode: 'live', validation: 'not_run', reason });
  assert.equal(failed.outcome, 'failed');
  assert.deepEqual(failed.reason, reason);
  const sim = guardTerminalRecord({
    ...base,
    outcome: 'simulated',
    mode: 'demo',
    validation: 'not_run',
    reason: { code: 'demo_mode', message: 'demo' },
  });
  assert.equal(sim.outcome, 'simulated');
});

test('D3: a record the Rust shell downgraded to unverified is rejected by the writer schema but lands via the reader schema', () => {
  // Exactly what envelope.rs forwards for {"outcome":"succeeded","mode":"demo",...}.
  const fromShell = {
    type: 'delegation_complete',
    delegationId: 'D1',
    fromBoardId: 'coding',
    outcome: 'unverified',
    mode: 'demo',
    validation: 'not_run',
    reason: {
      code: 'invalid_record',
      message: 'Record violates the outcome contract; treated as unverified.',
      detail: 'claimed succeeded: succeeded requires mode=live; demo mode cannot produce succeeded',
    },
    summary: 's',
    ts: '2026-09-26T00:00:00.000Z',
  };
  assert.equal(Envelope.safeParse(fromShell).success, false, 'unverified is never a writer outcome');
  const forwarded = DelegationCompleteEnvelope.extend({ outcome: RecordedOutcomeSchema }).safeParse(fromShell);
  assert.ok(forwarded.success, forwarded.success ? '' : forwarded.error.message);
  const g = guardTerminalRecord(forwarded.data);
  assert.equal(g.outcome, 'unverified');
  assert.equal(g.reason?.code, 'invalid_record');
  assert.deepEqual(g.violations, []);
});
