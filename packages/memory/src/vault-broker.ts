// vault-broker.ts — the single vault write broker (FR-WIKI-02, FR-SEC-02; A03).
//
// Every write into the vault converges here: MCP tools, the memory jobs, the
// daily-note generator and the Letta archival mirror. Three operations:
//
//   createNote(path, frontmatter, body)
//     New notes only; never overwrites. §8.3 frontmatter is validated and the
//     wikilink-only guard runs before any I/O.
//
//   updateNote(path, expectedHash, mutate)
//     Lock -> recheck containment -> read -> compare sha256(current bytes) with
//     `expectedHash` -> on mismatch return a `conflict` carrying the current
//     content and hash so the caller can rebase -> apply the mutator's patch ->
//     preserve `id`, `created_at`, unknown frontmatter keys and the body unless
//     the patch replaces it -> stamp `updated_at` -> recheck containment and
//     re-hash immediately before the atomic replace (write-file-atomic).
//     `agent_log` and `daily` notes are append-only; updating them, or changing
//     a note's type to or from those types, throws `AppendOnlyViolationError`.
//
//   appendNote(path, text, { init })
//     Only for `agent_log` / `daily`. Appends through an O_APPEND handle; the
//     handle is checked to be a regular file with a single link, so a hardlink
//     cannot redirect the append outside the vault. With `init`, a missing note
//     is created with its header and the first section under the same lock.
//
// Operational outcomes (`locked`, `exists`, `not_found`, `conflict`) are
// returned, matching the non-throwing WriteResult style of atomic.ts. Security
// and contract violations (path escape, append-only bypass, identity change,
// invalid frontmatter, relative .md links) throw.
//
// Residual TOCTOU: containment is proven, then re-proven under the lock just
// before the write. A local process that can swap a directory for a junction in
// the microseconds between that recheck and write-file-atomic's rename could
// still redirect it. Closing that fully needs handle-relative (openat-style)
// I/O, which Node does not expose on Windows. Obsidian does not honor our lock,
// so an external edit landing between the final re-hash and the rename is not
// detected either; the window is a few milliseconds.

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import writeFileAtomic from 'write-file-atomic';
import { lock } from 'proper-lockfile';

import { assertNoRelativeMdLinks } from './atomic.js';
import { parseNote, serializeNote, type NoteFrontmatterInput } from './frontmatter.js';
import {
  recheckContained,
  resolveContained,
  type ContainedPath,
  type VaultPathOptions,
} from './vault-path.js';

/** Note types that only accept dedicated append operations (FR-WIKI-02). */
export const APPEND_ONLY_TYPES: readonly string[] = ['agent_log', 'daily'];

export function isAppendOnlyType(type: unknown): boolean {
  return typeof type === 'string' && APPEND_ONLY_TYPES.includes(type);
}

/** Frontmatter keys that define a note's identity and may never change. */
const IDENTITY_KEYS = ['id', 'created_at'] as const;

/** sha256 hex of a note's exact bytes (strings are hashed as UTF-8). */
export function hashContent(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

export class AppendOnlyViolationError extends Error {
  readonly code = 'VAULT_APPEND_ONLY';
  constructor(readonly notePath: string, detail: string) {
    super(`Append-only violation on "${notePath}": ${detail}`);
    this.name = 'AppendOnlyViolationError';
  }
}

export class NoteIdentityError extends Error {
  readonly code = 'VAULT_NOTE_IDENTITY';
  constructor(readonly notePath: string, detail: string) {
    super(`Note identity violation on "${notePath}": ${detail}`);
    this.name = 'NoteIdentityError';
  }
}

export class VaultLockCompromisedError extends Error {
  readonly code = 'VAULT_LOCK_COMPROMISED';
  constructor(readonly notePath: string, cause: unknown) {
    super(`Lock on "${notePath}" was compromised before the write: ${String(cause)}`);
    this.name = 'VaultLockCompromisedError';
  }
}

export type BrokerFailureReason = 'locked' | 'exists' | 'not_found' | 'conflict';

export type BrokerResult =
  | {
      ok: true;
      /** Canonical POSIX vault-relative path. */
      path: string;
      /** Absolute path beneath the caller's vault root (for reporting). */
      absPath: string;
      /** sha256 of the note after this operation. */
      hash: string;
      /** True if this call created the file. */
      created: boolean;
      /** False if an update's mutator returned no patch (nothing written). */
      changed: boolean;
    }
  | {
      ok: false;
      path: string;
      absPath: string;
      reason: BrokerFailureReason;
      /** Present for `exists` and `conflict`: the on-disk hash. */
      currentHash?: string;
      /** Present for `conflict`: the on-disk content, for a rebase. */
      current?: string;
    };

export interface NoteSnapshot {
  path: string;
  absPath: string;
  raw: string;
  hash: string;
  /** Parsed frontmatter (a private copy; YAML timestamps normalized to ISO strings). */
  frontmatter: Record<string, unknown>;
  /** Body exactly as parsed (fence stripped). */
  body: string;
}

/** What a mutator may change. Omitted fields are preserved. */
export interface NotePatch {
  /** Keys to set. `id`/`created_at` must be absent or unchanged; `undefined` values are ignored. */
  frontmatter?: Record<string, unknown>;
  /** Replacement body. Omit to keep the authored body verbatim. */
  body?: string;
}

export type NoteMutator = (
  current: NoteSnapshot,
) => NotePatch | null | undefined | Promise<NotePatch | null | undefined>;

export interface AppendInit {
  frontmatter: NoteFrontmatterInput;
  body: string;
}

export interface VaultBrokerOptions {
  /** Clock for `updated_at` (tests). */
  now?: () => Date;
  /** proper-lockfile retry count. Default 5. */
  lockRetries?: number;
}

const NOTE_PATH_OPTS: VaultPathOptions = { requireMarkdown: true };

function isLockedErr(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'ELOCKED';
}

/** Copy frontmatter and normalize YAML timestamps (parsed as Date) to ISO strings. */
function normalizeFrontmatter(fm: Record<string, unknown>): Record<string, unknown> {
  const out = structuredClone(fm) as Record<string, unknown>;
  for (const k of ['created_at', 'updated_at']) {
    const v = out[k];
    if (v instanceof Date && !Number.isNaN(v.getTime())) out[k] = v.toISOString();
  }
  return out;
}

function sameValue(a: unknown, b: unknown): boolean {
  const norm = (v: unknown) => (v instanceof Date ? v.toISOString() : v);
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

/**
 * The vault write broker. Stateless apart from its root and options; construct
 * one per vault root and share it freely. All paths are untrusted and
 * vault-relative (`/` or `\` separators).
 */
export class VaultBroker {
  private readonly now: () => Date;
  private readonly lockRetries: number;

  constructor(
    readonly vaultRoot: string,
    opts: VaultBrokerOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.lockRetries = opts.lockRetries ?? 5;
  }

  /** Resolve an untrusted note path to a contained target (throws VaultPathError). */
  resolve(relPath: string): Promise<ContainedPath> {
    return resolveContained(this.vaultRoot, relPath, NOTE_PATH_OPTS);
  }

  private reportPath(cp: ContainedPath): string {
    return path.join(this.vaultRoot, ...cp.rel.split('/'));
  }

  /** Read a note with its hash. Returns null when it does not exist. */
  async readNote(relPath: string): Promise<NoteSnapshot | null> {
    const cp = await this.resolve(relPath);
    if (!cp.exists) return null;
    const raw = await fs.readFile(cp.abs);
    return this.snapshot(cp, raw);
  }

  private snapshot(cp: ContainedPath, bytes: Buffer): NoteSnapshot {
    const raw = bytes.toString('utf8');
    const parsed = parseNote(raw);
    return {
      path: cp.rel,
      absPath: this.reportPath(cp),
      raw,
      hash: hashContent(bytes),
      frontmatter: normalizeFrontmatter(parsed.frontmatter),
      body: parsed.body,
    };
  }

  /**
   * Create the target's parent directories (proven contained first), then run
   * `fn` under an exclusive lock keyed on the REAL parent directory, so two
   * lexical aliases of one file share a lock. `fn` receives the real target.
   */
  private async withLock<T>(
    cp: ContainedPath,
    fn: (target: string, assertLockHeld: () => void) => Promise<T>,
  ): Promise<T | { lockedOut: true }> {
    await fs.mkdir(path.dirname(cp.abs), { recursive: true });
    // Re-prove containment now that any missing directories exist.
    await recheckContained(cp);
    const realParent = await fs.realpath(path.dirname(cp.abs));
    const target = path.join(realParent, path.basename(cp.abs));

    let compromised: unknown = null;
    let release: () => Promise<void>;
    try {
      release = await lock(target, {
        realpath: false,
        stale: 30_000,
        retries: { retries: this.lockRetries, factor: 2, minTimeout: 50, maxTimeout: 1000 },
        onCompromised: (err) => {
          compromised = err;
        },
      });
    } catch (err) {
      if (isLockedErr(err)) return { lockedOut: true };
      throw err;
    }
    const assertLockHeld = () => {
      if (compromised !== null) throw new VaultLockCompromisedError(cp.rel, compromised);
    };
    try {
      return await fn(target, assertLockHeld);
    } finally {
      await release().catch(() => {
        /* a compromised lock may already be gone */
      });
    }
  }

  private locked(cp: ContainedPath): BrokerResult {
    return { ok: false, path: cp.rel, absPath: this.reportPath(cp), reason: 'locked' };
  }

  /** Create a new note. Never overwrites: an existing note yields `exists`. */
  async createNote(
    relPath: string,
    frontmatter: NoteFrontmatterInput,
    body: string,
  ): Promise<BrokerResult> {
    const cp = await this.resolve(relPath);
    assertNoRelativeMdLinks(body, cp.rel);
    const contents = serializeNote(frontmatter, body); // throws on invalid §8.3
    const absPath = this.reportPath(cp);

    const out = await this.withLock(cp, async (target, assertLockHeld) => {
      if (await recheckContained(cp, target)) {
        const current = await fs.readFile(target);
        return {
          ok: false as const,
          path: cp.rel,
          absPath,
          reason: 'exists' as const,
          currentHash: hashContent(current),
        };
      }
      assertLockHeld();
      await writeFileAtomic(target, contents);
      return {
        ok: true as const,
        path: cp.rel,
        absPath,
        hash: hashContent(contents),
        created: true,
        changed: true,
      };
    });
    return 'lockedOut' in out ? this.locked(cp) : out;
  }

  /**
   * Compare-and-swap update. `expectedHash` is the sha256 the caller last read
   * (see `readNote`). Returns `conflict` with the current content when the note
   * changed since; the caller rebases and retries.
   */
  async updateNote(
    relPath: string,
    expectedHash: string,
    mutate: NoteMutator,
  ): Promise<BrokerResult> {
    const cp = await this.resolve(relPath);
    const absPath = this.reportPath(cp);
    if (!cp.exists) return { ok: false, path: cp.rel, absPath, reason: 'not_found' };

    const out = await this.withLock(cp, async (target, assertLockHeld): Promise<BrokerResult> => {
      if (!(await recheckContained(cp, target))) {
        return { ok: false, path: cp.rel, absPath, reason: 'not_found' };
      }
      const bytes = await fs.readFile(target);
      const snap = this.snapshot(cp, bytes);
      if (snap.hash !== expectedHash) {
        return {
          ok: false,
          path: cp.rel,
          absPath,
          reason: 'conflict',
          currentHash: snap.hash,
          current: snap.raw,
        };
      }

      const curFm = snap.frontmatter;
      if (isAppendOnlyType(curFm['type'])) {
        throw new AppendOnlyViolationError(
          cp.rel,
          `type "${String(curFm['type'])}" is append-only; use appendNote`,
        );
      }

      const patch = await mutate({ ...snap, frontmatter: structuredClone(curFm) });
      if (!patch || (patch.frontmatter === undefined && patch.body === undefined)) {
        return { ok: true, path: cp.rel, absPath, hash: snap.hash, created: false, changed: false };
      }

      const patchFm = patch.frontmatter ?? {};
      for (const key of IDENTITY_KEYS) {
        if (patchFm[key] !== undefined && !sameValue(patchFm[key], curFm[key])) {
          throw new NoteIdentityError(cp.rel, `"${key}" cannot change on edit`);
        }
      }
      if (patchFm['type'] !== undefined && isAppendOnlyType(patchFm['type'])) {
        throw new AppendOnlyViolationError(
          cp.rel,
          `cannot convert a note to append-only type "${String(patchFm['type'])}"`,
        );
      }

      const merged: Record<string, unknown> = { ...curFm };
      for (const [k, v] of Object.entries(patchFm)) {
        if (v !== undefined) merged[k] = v;
      }
      for (const key of IDENTITY_KEYS) {
        if (key in curFm) merged[key] = curFm[key];
      }
      merged['updated_at'] = this.now().toISOString();

      const body = patch.body ?? snap.body;
      if (patch.body !== undefined) assertNoRelativeMdLinks(body, cp.rel);
      const contents = serializeNote(merged, body); // validates §8.3 (id must exist)

      // Immediately before the replace: re-prove containment, make sure the lock
      // is still ours, and re-hash to catch an external writer that ignores it.
      await recheckContained(cp, target);
      assertLockHeld();
      const latest = hashContent(await fs.readFile(target));
      if (latest !== snap.hash) {
        const raw = await fs.readFile(target, 'utf8');
        return { ok: false, path: cp.rel, absPath, reason: 'conflict', currentHash: latest, current: raw };
      }
      await writeFileAtomic(target, contents);
      return {
        ok: true,
        path: cp.rel,
        absPath,
        hash: hashContent(contents),
        created: false,
        changed: true,
      };
    });
    return 'lockedOut' in out ? this.locked(cp) : out;
  }

  /**
   * Append a section to an `agent_log` or `daily` note. Existing bytes are never
   * rewritten. With `init`, a missing note is created with that header first
   * (the header's type must itself be append-only).
   */
  async appendNote(
    relPath: string,
    text: string,
    opts: { init?: AppendInit } = {},
  ): Promise<BrokerResult> {
    const cp = await this.resolve(relPath);
    const absPath = this.reportPath(cp);
    assertNoRelativeMdLinks(text, cp.rel);
    const chunk = `\n${text.replace(/\s+$/, '')}\n`;

    let initContents: string | null = null;
    if (opts.init) {
      if (!isAppendOnlyType(opts.init.frontmatter['type'])) {
        throw new AppendOnlyViolationError(
          cp.rel,
          `appendNote init must be one of ${APPEND_ONLY_TYPES.join('/')}`,
        );
      }
      assertNoRelativeMdLinks(opts.init.body, cp.rel);
      initContents = serializeNote(opts.init.frontmatter, opts.init.body);
    }

    const out = await this.withLock(cp, async (target, assertLockHeld): Promise<BrokerResult> => {
      const exists = await recheckContained(cp, target);
      if (!exists) {
        if (initContents === null) return { ok: false, path: cp.rel, absPath, reason: 'not_found' };
        const contents = initContents + chunk;
        assertLockHeld();
        await writeFileAtomic(target, contents);
        return { ok: true, path: cp.rel, absPath, hash: hashContent(contents), created: true, changed: true };
      }

      const snap = this.snapshot(cp, await fs.readFile(target));
      if (!isAppendOnlyType(snap.frontmatter['type'])) {
        throw new AppendOnlyViolationError(
          cp.rel,
          `appendNote is only for ${APPEND_ONLY_TYPES.join('/')} notes (found type "${String(snap.frontmatter['type'] ?? 'none')}")`,
        );
      }

      await recheckContained(cp, target);
      assertLockHeld();
      const handle = await fs.open(target, 'a');
      try {
        const st = await handle.stat();
        if (!st.isFile() || st.nlink !== 1) {
          throw new AppendOnlyViolationError(
            cp.rel,
            'target is not a single-link regular file (hardlink or special file)',
          );
        }
        await handle.appendFile(chunk, { encoding: 'utf8' });
        await handle.sync();
      } finally {
        await handle.close();
      }
      const after = await fs.readFile(target);
      return { ok: true, path: cp.rel, absPath, hash: hashContent(after), created: false, changed: true };
    });
    return 'lockedOut' in out ? this.locked(cp) : out;
  }
}

/** Convenience factory. */
export function createVaultBroker(vaultRoot: string, opts?: VaultBrokerOptions): VaultBroker {
  return new VaultBroker(vaultRoot, opts);
}
