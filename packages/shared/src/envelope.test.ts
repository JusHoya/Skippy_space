// Lock-in for the `sidecar_status` envelope added for sidecar-crash recovery
// (REVIEW §5 critic, sidecar.rs). The Rust mirror in
// `apps/shell/src-tauri/src/envelope.rs` has its own serde parity test; this
// guards the TS/Zod side of the same wire contract: the discriminated union
// must accept the camelCase wire shape, route it onto the SidecarStatus arm,
// and reject malformed events. If this and the Rust test drift, the shell
// silently demotes the crash pulse to a debug Log and Skippy hangs forever.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Envelope, SidecarStatusEnvelope } from './envelope.js';

const ISO = '2026-06-10T12:00:10Z';

test('sidecar_status parses onto its own variant in the discriminated union', () => {
  for (const event of ['crashed', 'restarted', 'ready'] as const) {
    const parsed = Envelope.safeParse({ type: 'sidecar_status', event, ts: ISO });
    assert.ok(parsed.success, `event "${event}" must parse`);
    // discriminatedUnion lands it on the right arm — `type` is preserved and
    // `event` survives as the literal we sent.
    assert.equal(parsed.success && parsed.data.type, 'sidecar_status');
    assert.equal(parsed.success && parsed.data.type === 'sidecar_status' && parsed.data.event, event);
  }
});

test('sidecar_status carries an optional detail (camelCase wire shape, no rename)', () => {
  const withDetail = SidecarStatusEnvelope.safeParse({
    type: 'sidecar_status',
    event: 'crashed',
    detail: 'sidecar exited with status ExitStatus(unix_wait_status(139))',
    ts: ISO,
  });
  assert.ok(withDetail.success);
  assert.equal(withDetail.success && withDetail.data.detail, 'sidecar exited with status ExitStatus(unix_wait_status(139))');

  // detail omitted is valid (matches the Rust `skip_serializing_if` + serde
  // Option, which never emits the key when None).
  const withoutDetail = SidecarStatusEnvelope.safeParse({
    type: 'sidecar_status',
    event: 'restarted',
    ts: ISO,
  });
  assert.ok(withoutDetail.success, 'detail must be optional');
  assert.equal(withoutDetail.success && withoutDetail.data.detail, undefined);
});

test('sidecar_status rejects an unknown event and a missing ts', () => {
  assert.ok(
    !SidecarStatusEnvelope.safeParse({ type: 'sidecar_status', event: 'exploded', ts: ISO }).success,
    'event must be one of crashed|restarted|ready',
  );
  assert.ok(
    !SidecarStatusEnvelope.safeParse({ type: 'sidecar_status', event: 'crashed' }).success,
    'ts is required',
  );
});
