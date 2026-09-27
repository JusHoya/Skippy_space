// ingest/sidecar-key.ts — per-vault secret that authenticates the ingest
// pipeline's own `.ingest-error.json` sidecars (FR-WIKI-03; M0 NFC/NFD round,
// D3).
//
// The inbox watcher stays silent about a `*.ingest-error.json` only when it is
// provably the pipeline's own record, and it skips a drop whose recorded
// `contentSha256` already failed. Content alone (the `kind` marker, a known
// reason, a matching location) is forgeable by anyone who can write to the
// inbox, so a hand-written sidecar could silence a real drop forever. Every
// record therefore carries `mac` = HMAC-SHA256(key, canonical fields + the
// sidecar's own inbox-relative location), keyed with a 256-bit random secret
// stored at `<vault>/.skippy/ingest-sidecar.key`:
//
//   - `.skippy/` is git-ignored (vault/.gitignore), and the vault path rules
//     reject hidden segments, so the broker's note tools can never read or
//     write it;
//   - the key file is resolved with `resolveContained` allowing ONLY the
//     `.skippy` hidden segment (also on the real path), created with an
//     exclusive contained atomic write, and read through a handle that must be
//     a single-link regular file of exactly 64 hex characters;
//   - writers create it on first use; verifiers never create it (no key means
//     no record can be ours);
//   - the loaded key is cached per canonical vault root, so concurrent first
//     uses in one process share one key. (Two PROCESSES creating the key for
//     the same vault at the same instant could each commit one; the loser's
//     already-written sidecars would then be reported once as `reserved-name`,
//     never silently trusted.)

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';

import { TargetExistsError, atomicWriteContained } from '../safe-write.js';
import { cmpKey, realVaultRoot, resolveContained, type VaultPathOptions } from '../vault-path.js';

/** Vault-relative location of the sidecar MAC key. */
export const SIDECAR_KEY_REL = '.skippy/ingest-sidecar.key';

const KEY_OPTS: VaultPathOptions = { allowHiddenNames: ['.skippy'] };
const KEY_RE = /^[0-9a-f]{64}$/;

/** The key file exists but is not a single-link regular file holding a 64-hex key. */
export class SidecarKeyError extends Error {
  readonly code = 'INGEST_SIDECAR_KEY_INVALID';
  constructor(detail: string) {
    super(`ingest sidecar key ${SIDECAR_KEY_REL} is unusable: ${detail}`);
    this.name = 'SidecarKeyError';
  }
}

const cache = new Map<string, Promise<Buffer>>();

async function readKeyFile(abs: string): Promise<Buffer> {
  const handle = await fs.open(abs, 'r');
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.nlink !== 1) throw new SidecarKeyError('not a single-link regular file');
    if (st.size > 1024) throw new SidecarKeyError(`${st.size} bytes`);
    const txt = (await handle.readFile('utf8')).trim();
    if (!KEY_RE.test(txt)) throw new SidecarKeyError('not a 64-hex-character key');
    return Buffer.from(txt, 'hex');
  } finally {
    await handle.close();
  }
}

async function loadKey(vaultRoot: string, create: boolean): Promise<Buffer | null> {
  const cp = await resolveContained(vaultRoot, SIDECAR_KEY_REL, KEY_OPTS);
  if (cp.exists) return readKeyFile(cp.abs);
  if (!create) return null;
  try {
    await atomicWriteContained(cp, `${randomBytes(32).toString('hex')}\n`, { exclusive: true });
  } catch (err) {
    if (!(err instanceof TargetExistsError)) throw err;
  }
  // Read back what is on disk (ours, or a concurrent creator's).
  const again = await resolveContained(vaultRoot, SIDECAR_KEY_REL, KEY_OPTS);
  if (!again.exists) throw new SidecarKeyError('it vanished right after it was created');
  return readKeyFile(again.abs);
}

/**
 * The vault's sidecar MAC key. With `create` (writers) a missing key is
 * generated; without it (verifiers) a missing key yields null. Throws
 * `VaultPathError`/`SidecarKeyError` when the key location is unsafe or the
 * file is malformed, so a writer fails closed instead of writing an
 * unauthenticated record.
 */
export async function sidecarKey(vaultRoot: string, create: boolean): Promise<Buffer | null> {
  const id = cmpKey(await realVaultRoot(vaultRoot));
  const hit = cache.get(id);
  if (hit) {
    try {
      return await hit;
    } catch {
      // a failed load is not cached for long; load again below
    }
  }
  if (!create) {
    // Verifiers cache only a key that exists.
    const k = await loadKey(vaultRoot, false);
    if (k !== null) cache.set(id, Promise.resolve(k));
    return k;
  }
  // Writers share one in-flight load/create per vault.
  const pending = loadKey(vaultRoot, true).then((k) => {
    if (k === null) throw new SidecarKeyError('it could not be created');
    return k;
  });
  cache.set(id, pending);
  pending.catch(() => {
    if (cache.get(id) === pending) cache.delete(id);
  });
  return pending;
}

/** HMAC-SHA256 (hex) of `input` under `key`. */
export function macHex(key: Buffer, input: string): string {
  return createHmac('sha256', key).update(input, 'utf8').digest('hex');
}

/** Constant-time comparison of two hex MACs. */
export function macEqual(a: string, b: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(a) || !/^[0-9a-f]{64}$/.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
