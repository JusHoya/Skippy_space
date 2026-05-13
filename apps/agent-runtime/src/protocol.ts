// protocol.ts — JSONL envelope framing.
//
// The agent-runtime speaks JSONL to/from the Rust shell. Every line of stdin
// is one Envelope; every line of stdout is one Envelope. Schemas live in
// `@skippy/shared` (Zod) and are mirrored by `apps/shell/src-tauri/src/envelope.rs`.
// See PRD §5.2 for the agent ↔ shell ↔ renderer communication contract.

import { Envelope, type EnvelopeT } from '@skippy/shared';

/** Parse one stdin line into a validated Envelope. Throws on malformed input. */
export function parseEnvelope(line: string): EnvelopeT {
  const json: unknown = JSON.parse(line);
  return Envelope.parse(json);
}

/**
 * Write one Envelope to stdout as a JSON line (newline-delimited).
 *
 * Note: We deliberately use `process.stdout.write` with a trailing `\n` instead
 * of `console.log` because (a) console.log may buffer or re-encode and
 * (b) some console transports could be patched by future logging libs. The
 * Rust shell expects strict JSONL: one envelope per line.
 */
export function writeEnvelope(env: EnvelopeT): void {
  process.stdout.write(JSON.stringify(env) + '\n');
}
