// ingest/containment.ts — real containment for ingest's non-note vault writes
// (E3-2, FR-SEC-02).
//
// `vault-broker.ts` proves every NOTE write lies inside the real vault via
// `resolveContained`/`recheckContained` (vault-path.ts). Ingest also writes
// non-note payloads — content-addressed originals, completion markers, and
// `.ingest-error.json` sidecars — and deletes the inbox drop once it is fully
// preserved. None of those go through the note broker (they aren't `.md`
// notes with §8.3 frontmatter), but they must be proven contained exactly the
// same way: lexically, then by the real (junction/symlink-resolved) nearest
// existing ancestor, rechecked immediately before the write or delete.
//
// This module adapts `resolveContained` (which takes an untrusted
// VAULT-RELATIVE path) to ingest's ABSOLUTE paths (the inbox drop's path, the
// hash-derived store/marker/sidecar paths) by computing the relative path
// first. A path that does not lexically reduce to something under `vaultRoot`
// (e.g. an attacker-influenced absolute path elsewhere on disk) hits the
// lexical `..`/`traversal` gate inside `resolveContained` and is rejected
// before any I/O, exactly like a malicious vault-relative path would be.

import * as path from 'node:path';

import { resolveContained, type ContainedPath, type VaultPathOptions } from '../vault-path.js';

/**
 * Prove an absolute path that is expected to already live under `vaultRoot`
 * actually does, using the same real containment proof the note broker uses
 * (`resolveContained`). Throws `VaultPathError` if it does not — including if
 * a junction/symlink anywhere on the path (or on the vault root itself)
 * resolves outside.
 */
export async function resolveInsideVault(
  vaultRoot: string,
  absPath: string,
  opts: VaultPathOptions = {},
): Promise<ContainedPath> {
  const rel = path.relative(path.resolve(vaultRoot), path.resolve(absPath));
  const relPosix = rel.split(path.sep).join('/');
  return resolveContained(vaultRoot, relPosix, { allowHidden: true, ...opts });
}

export { recheckContained } from '../vault-path.js';
