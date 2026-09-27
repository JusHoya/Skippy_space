// vault-broker.ts — the single vault write broker (FR-WIKI-02, FR-SEC-02; A03).
//
// Every agent-originated NOTE write converges here: the MCP vault tools
// (obsidian_write_note, obsidian_patch_frontmatter, obsidian_append_block —
// the last two no longer go to the Obsidian REST API, which is read-only for
// us), the memory jobs (distill/link/lint), ingest's source note, the
// daily-note generator and the Letta archival mirror.
//
// Remaining writers into the vault tree that do NOT go through the broker
// (the "exempt-writer list"; each one still proves real containment):
//   - ingest's content-addressed originals store and its `.note.json` commit
//     markers under `60_Sources/originals/` (ingest/originals.ts), and the
//     `*.ingest-error.json` sidecars inside the real `00_Inbox/`
//     (ingest/errors.ts): binary/JSON payloads, not notes. Written with
//     `atomicWriteContained` (safe-write.ts) after `resolveContained`.
//   - ingest's removal of a fully preserved inbox drop (jobs/ingest.ts), only
//     for single-link regular files whose real path is inside the real
//     `00_Inbox/` with no reparse point in between (ingest/containment.ts),
//     and the never-clobbering restore of a frozen drop / startup recovery of
//     a leftover `.ingest-tmp` inside that same real inbox directory
//     (ingest/recovery.ts: hard link or COPYFILE_EXCL, never a replacing rename).
//   - the per-session replay stream `.skippy/replays/<ulid>.jsonl`
//     (apps/agent-runtime/src/replay-writer.ts): an append-only JSONL log, not
//     a note, so it has no §8.3 frontmatter and needs a long-lived O_APPEND fd
//     the broker's per-call lock/replace model cannot provide. It is resolved
//     with `resolveContained` allowing ONLY the `.skippy` hidden segment (never
//     `.git`/`.obsidian`, also on the real path), its directories are created
//     with `ensureContainedParentDir`, and the file is created with O_EXCL and
//     must be a single-link regular file; if containment fails the replay
//     writer disables itself with a logged error instead of writing elsewhere.
//   - `realVaultRoot` creating the configured vault root directory itself;
//   - the legacy absolute-path writers in atomic.ts (no production callers, no
//     longer exported from the package index; kept for atomic.test.ts);
//   - git autocommit (scripts/git-autocommit.mjs, shell git_autocommit.rs)
//     writes only repository metadata, never note content;
//   - humans and the Obsidian app itself (external; detected via the hash
//     compare below, never locked out).
//
// Four operations:
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
//     re-hash immediately before the atomic replace (`atomicWriteContained`,
//     safe-write.ts: random O_EXCL temp file, fsync, rename, single-link check;
//     write-file-atomic's predictable temp name followed planted hardlinks, N3).
//     `agent_log` and `daily` notes are append-only; updating them, or changing
//     a note's type to or from those types, throws `AppendOnlyViolationError`.
//
//   Reserved append-only paths (N4): every `.md` under `40_Daily/` is reserved
//   for `daily` notes and `50_Agents/<board>/agent_log.md` for `agent_log`
//   notes (the paths daily.ts and jobs/archival-mirror.ts write). createNote
//   refuses any other type there, updateNote/patchFrontmatter refuse those
//   paths outright, and appendNote's `init` must carry the reserved type. The
//   check runs on the lexical path and again on the REAL path under the lock,
//   so case and junction aliases cannot squat a reserved path either.
//     YAML is parsed without the timestamp type, so unknown dates keep their
//     type and spelling, and only the frontmatter lines of changed keys are
//     rewritten (comments, untouched values and their own line endings, a
//     leading BOM and the body bytes survive; M0 final #4). Known limitation:
//     when that surgical edit cannot be proven equivalent by re-parsing
//     (anchors, multi-line flow collections, ...), the frontmatter block is
//     re-serialized canonically and YAML comments in it are dropped.
//
//   Reserved ingest subtree and provenance keys (M0 final #1; see
//   ingest/provenance.ts): every note under `60_Sources/` (lexical or real
//   path) and the keys in PROVENANCE_KEYS belong to the ingest pipeline. A
//   broker constructed without the ingest capability refuses to create,
//   update, patch or append there, and refuses to set or change a provenance
//   key anywhere (`ProvenanceViolationError`), so an agent's vault tools cannot
//   plant or edit a source note that a later ingest would adopt.
//
//   Encoding (M0 final #4): notes are decoded with a FATAL UTF-8 decoder that
//   keeps a BOM; a note that is not valid UTF-8 is refused with
//   `NoteEncodingError`, never decoded lossily and rewritten.
//
//   Locks (M0 final #3): `<note>.md.lock` is proper-lockfile's directory. The
//   path rules reject `.lock` segments, and a squatted lock path (non-empty
//   directory, file, link) is an explicit `VaultLockPathError` (vault-lock.ts).
//
//   Unicode names (vault-path.ts "Unicode normalization policy"): every
//   operation acts on the note spelled EXACTLY as named (NFC `café.md` and NFD
//   `café.md` are different NTFS files, and either can be read, updated
//   or appended to by its own name); reserved-path rules compare NFC forms.
//   createNote / appendNote-with-init refuse, with
//   VaultPathError('normalization_collision'), to create a note (or directory)
//   whose NFC (case-folded on win32) name equals an existing sibling's with
//   different bytes; creates are additionally serialized in-process by that
//   folded name so two differently-encoded concurrent creates cannot both pass.
//
//   patchFrontmatter(path, expectedHash, key, value)
//     `updateNote` for one key. The key must be a plain lowercase snake_case
//     name and never `id`/`created_at`/`updated_at`/`type` (so no encoded or
//     case-folded alias of a protected key can slip through).
//
//   appendNote(path, text, { init })
//     Only for `agent_log` / `daily` notes with valid §8.3 frontmatter. Appends
//     through an O_APPEND handle; the handle is checked to be a regular file
//     with a single link, so a hardlink cannot redirect the append outside the
//     vault. With `init`, a missing note is created with its header and the
//     first section under the same lock; without it a missing note is
//     `not_found` (an append never creates a frontmatter-less note).
//
// Reads (readNote and the reads inside every operation) go through a handle
// that must be a single-link regular file: a hardlink to a file outside the
// vault is rejected with VaultPathError('hardlinked_target'), never read.
// Missing parent directories are created one level at a time with a real-path
// containment check per level (ensureContainedParentDir), and the lock is keyed
// on the canonical real path, so aliases of one note share one lock.
//
// Operational outcomes (`locked`, `exists`, `not_found`, `conflict`) are
// returned, matching the non-throwing WriteResult style of atomic.ts. Security
// and contract violations (path escape, append-only bypass, identity change,
// invalid frontmatter, relative .md links) throw.
//
// Residual TOCTOU: containment is proven, then re-proven under the lock just
// before the write. A local process that can swap a directory for a junction in
// the microseconds between that recheck and the atomic writer's rename could
// still redirect it. Closing that fully needs handle-relative (openat-style)
// I/O, which Node does not expose on Windows. Obsidian does not honor our lock,
// so an external edit landing between the final re-hash and the rename is not
// detected either; the window is a few milliseconds.

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { assertNoRelativeMdLinks } from './atomic.js';
import { INGEST_WRITER, SOURCES_DIR } from './ingest/provenance.js';
import { acquireVaultLock } from './vault-lock.js';
import {
  parseNote,
  serializeNote,
  serializeNotePreserving,
  validateFrontmatter,
  type NoteFrontmatterInput,
} from './frontmatter.js';
import { TargetExistsError, atomicWriteContained } from './safe-write.js';
import {
  VaultPathError,
  assertNoNormalizationSibling,
  cmpKey,
  ensureContainedParentDir,
  foldKey,
  recheckContained,
  resolveContained,
  ruleKey,
  type ContainedPath,
  type VaultPathOptions,
} from './vault-path.js';

/** Note types that only accept dedicated append operations (FR-WIKI-02). */
export const APPEND_ONLY_TYPES: readonly string[] = ['agent_log', 'daily'];

export function isAppendOnlyType(type: unknown): boolean {
  return typeof type === 'string' && APPEND_ONLY_TYPES.includes(type);
}

/**
 * The append-only type a vault-relative path is reserved for, or null (N4).
 * Any `.md` under `40_Daily/` -> `daily` (daily.ts writes `40_Daily/YYYY-MM-DD.md`;
 * the folder's `_template.md` is itself `type: daily`), and
 * `50_Agents/<board>/agent_log.md` -> `agent_log` (jobs/archival-mirror.ts).
 * Case-insensitive, since NTFS is.
 */
export function reservedAppendOnlyType(relPath: string): 'daily' | 'agent_log' | null {
  const segs = relPath.split(/[\\/]+/).filter((x) => x !== '' && x !== '.');
  if (segs.length === 0) return null;
  // Rule comparison only (NFC + case-insensitive); the path is never rewritten.
  const first = ruleKey(segs[0]!);
  const last = ruleKey(segs[segs.length - 1]!);
  if (first === '40_daily' && segs.length >= 2 && last.endsWith('.md')) return 'daily';
  if (first === '50_agents' && segs.length === 3 && last === 'agent_log.md') return 'agent_log';
  return null;
}

/** Throw unless a note of `type` may be created at `checkedRel` (lexical or real). */
function assertReservedCreate(notePath: string, checkedRel: string, type: unknown): void {
  const reserved = reservedAppendOnlyType(checkedRel);
  if (reserved !== null && type !== reserved) {
    throw new AppendOnlyViolationError(
      notePath,
      `"${checkedRel}" is reserved for append-only "${reserved}" notes (got type "${String(type ?? 'none')}")`,
    );
  }
}

/** Throw if `checkedRel` is a reserved append-only path (general edits never apply there). */
function assertNotReservedForEdit(notePath: string, checkedRel: string): void {
  const reserved = reservedAppendOnlyType(checkedRel);
  if (reserved !== null) {
    throw new AppendOnlyViolationError(
      notePath,
      `"${checkedRel}" is reserved for append-only "${reserved}" notes; use appendNote`,
    );
  }
}

/**
 * Frontmatter keys that record ingest provenance (FR-WIKI-03). Only the ingest
 * pipeline may set them (M0 final #1; ingest/provenance.ts).
 */
export const PROVENANCE_KEYS: readonly string[] = [
  'source_sha256',
  'original_path',
  'extractor_name',
  'extractor_version',
  'source_encoding',
  'source_bom_stripped',
];

/** True if a vault-relative path (lexical or real) lies under `60_Sources/`. */
export function isSourcesPath(relPath: string): boolean {
  const first = relPath.split(/[\\/]+/).find((x) => x !== '' && x !== '.');
  return first !== undefined && ruleKey(first) === ruleKey(SOURCES_DIR);
}

/** A non-ingest writer touched the reserved ingest subtree or a provenance key. */
export class ProvenanceViolationError extends Error {
  readonly code = 'VAULT_PROVENANCE_RESERVED';
  constructor(readonly notePath: string, detail: string) {
    super(`Provenance violation on "${notePath}": ${detail}`);
    this.name = 'ProvenanceViolationError';
  }
}

/** A note whose bytes are not valid UTF-8 (never decoded lossily, never rewritten). */
export class NoteEncodingError extends Error {
  readonly code = 'VAULT_NOTE_ENCODING';
  constructor(readonly notePath: string, detail: string) {
    super(
      `Note "${notePath}" is not valid UTF-8 (${detail}); refusing to read or edit it lossily. ` +
        'Re-save it as UTF-8 first.',
    );
    this.name = 'NoteEncodingError';
  }
}

const UTF8_FATAL = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Decode note bytes strictly; a leading BOM is kept as U+FEFF. */
function decodeNote(bytes: Buffer, rel: string): string {
  try {
    return UTF8_FATAL.decode(bytes);
  } catch (err) {
    throw new NoteEncodingError(rel, err instanceof Error ? err.message : String(err));
  }
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

/** A frontmatter key that `patchFrontmatter` may never set (identity, type, stamps). */
export class ProtectedFrontmatterKeyError extends Error {
  readonly code = 'VAULT_PROTECTED_KEY';
  constructor(readonly notePath: string, readonly key: string) {
    super(
      `Frontmatter key ${JSON.stringify(key)} on "${notePath}" cannot be patched: keys must be ` +
        `lowercase snake_case and not one of ${PROTECTED_PATCH_KEYS.join('/')}`,
    );
    this.name = 'ProtectedFrontmatterKeyError';
  }
}

/** An existing note whose frontmatter is not valid §8.3 (e.g. an append target). */
export class NoteFrontmatterError extends Error {
  readonly code = 'VAULT_INVALID_FRONTMATTER';
  constructor(readonly notePath: string, detail: string) {
    super(`Note "${notePath}" does not carry valid §8.3 frontmatter: ${detail}`);
    this.name = 'NoteFrontmatterError';
  }
}

const PROTECTED_PATCH_KEYS: readonly string[] = ['id', 'created_at', 'updated_at', 'type'];
const PATCH_KEY_RE = /^[a-z][a-z0-9_]*$/;

/**
 * Throw unless `key` is a plain lowercase snake_case name outside the protected
 * set. Fail closed: `%`-encoded, case-folded (`ID`), dotted or prototype keys
 * never reach the merge, whatever a downstream decoder would make of them.
 */
export function assertPatchableFrontmatterKey(notePath: string, key: unknown): asserts key is string {
  if (typeof key !== 'string' || !PATCH_KEY_RE.test(key) || PROTECTED_PATCH_KEYS.includes(key)) {
    throw new ProtectedFrontmatterKeyError(notePath, String(key));
  }
}

/**
 * Read a note through a handle that must be a single-link regular file, so a
 * hardlink (or a file swapped for one after the path check) can never make us
 * read, hash or return the bytes of a file outside the vault.
 */
async function readRegularFile(target: string, rel: string): Promise<Buffer> {
  const handle = await fs.open(target, 'r');
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new VaultPathError('target_not_file', rel);
    if (st.nlink > 1) {
      throw new VaultPathError(
        'hardlinked_target',
        rel,
        `the note has ${st.nlink} hard links and may alias a file outside the vault`,
      );
    }
    return await handle.readFile();
  } finally {
    await handle.close();
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
  /** Parsed frontmatter (a private copy; YAML timestamps stay the strings as written). */
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
  /**
   * The ingest capability (ingest/provenance.ts). Only `runIngest` holds it;
   * without it `60_Sources/` and PROVENANCE_KEYS are refused.
   */
  ingestWriter?: symbol;
}

const NOTE_PATH_OPTS: VaultPathOptions = { requireMarkdown: true };

/**
 * In-process serialization of note CREATES by `foldKey` (NFC, case-folded on
 * win32), so two concurrent creates of differently-encoded spellings of one
 * new name (NFC `café.md` and NFD `café.md`) cannot both pass the
 * normalization-sibling check. This is NOT the note lock: the lock stays keyed
 * on the real path of the actual file (distinct NTFS names never share one);
 * this only orders creates. Acquired before the note lock, never inside it.
 */
const createGuards = new Map<string, Promise<unknown>>();

async function withCreateGuard<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = createGuards.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  createGuards.set(key, tail);
  try {
    return await run;
  } finally {
    if (createGuards.get(key) === tail) createGuards.delete(key);
  }
}

function createGuardKey(cp: ContainedPath): string {
  return `${cmpKey(cp.realRoot)}\u0000${foldKey(cp.rel)}`;
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
  if (JSON.stringify(norm(a)) === JSON.stringify(norm(b))) return true;
  // The same instant spelled differently (`...00Z` vs `...00.000Z`) is no change.
  if (typeof norm(a) === 'string' && typeof norm(b) === 'string') {
    const ta = Date.parse(norm(a) as string);
    const tb = Date.parse(norm(b) as string);
    return !Number.isNaN(ta) && ta === tb;
  }
  return false;
}

/**
 * The vault write broker. Stateless apart from its root and options; construct
 * one per vault root and share it freely. All paths are untrusted and
 * vault-relative (`/` or `\` separators).
 */
export class VaultBroker {
  private readonly now: () => Date;
  private readonly lockRetries: number;
  private readonly ingestPrivileged: boolean;

  constructor(
    readonly vaultRoot: string,
    opts: VaultBrokerOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.lockRetries = opts.lockRetries ?? 5;
    this.ingestPrivileged = opts.ingestWriter === INGEST_WRITER;
  }

  /** Refuse the reserved ingest subtree to a non-ingest broker (lexical or real path). */
  private assertSourcesWritable(notePath: string, checkedRel: string): void {
    if (!this.ingestPrivileged && isSourcesPath(checkedRel)) {
      throw new ProvenanceViolationError(
        notePath,
        `"${checkedRel}" is under ${SOURCES_DIR}/, which only the ingest pipeline writes`,
      );
    }
  }

  /** Refuse setting or changing a provenance key to a non-ingest broker. */
  private assertProvenanceUnchanged(
    notePath: string,
    patch: Record<string, unknown>,
    current: Record<string, unknown> = {},
  ): void {
    if (this.ingestPrivileged) return;
    for (const key of PROVENANCE_KEYS) {
      if (patch[key] === undefined) continue;
      if (key in current && sameValue(patch[key], current[key])) continue;
      throw new ProvenanceViolationError(
        notePath,
        `frontmatter key "${key}" records ingest provenance and only the ingest pipeline may set it`,
      );
    }
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
    const raw = await readRegularFile(cp.abs, cp.rel);
    return this.snapshot(cp, raw);
  }

  private snapshot(cp: ContainedPath, bytes: Buffer): NoteSnapshot {
    const raw = decodeNote(bytes, cp.rel);
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
   * Create the target's missing parent directories one contained level at a
   * time, then run `fn` under an exclusive lock keyed on the canonical REAL
   * path (real parent + the file's on-disk name when it exists), so lexical,
   * case and junction aliases of one note share one lock. `fn` receives it.
   */
  private async withLock<T>(
    cp: ContainedPath,
    fn: (target: string, assertLockHeld: () => void, realRel: string) => Promise<T>,
  ): Promise<T | { lockedOut: true }> {
    const realParent = await ensureContainedParentDir(cp);
    // Re-prove containment now that any missing directories exist.
    await recheckContained(cp);
    let target = path.join(realParent, path.basename(cp.abs));
    if (await recheckContained(cp, target)) {
      // Existing regular file (not a link, single link): use its native real
      // path, which carries the on-disk long name and case.
      target = await fs.realpath(target);
    }

    let compromised: unknown = null;
    // A squatted lock path (non-empty dir, file, link) throws VaultLockPathError
    // instead of reading as "locked" forever (M0 final #3).
    const release = await acquireVaultLock(target, {
      stale: 30_000,
      retries: { retries: this.lockRetries, factor: 2, minTimeout: 50, maxTimeout: 1000 },
      onCompromised: (err) => {
        compromised = err;
      },
    });
    if (release === null) return { lockedOut: true };
    const assertLockHeld = () => {
      if (compromised !== null) throw new VaultLockCompromisedError(cp.rel, compromised);
    };
    // The REAL vault-relative path (on-disk case, junctions resolved), for the
    // reserved append-only path check (N4).
    const realRel = path.relative(cp.realRoot, target).split(path.sep).join('/');
    try {
      return await fn(target, assertLockHeld, realRel);
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
    assertReservedCreate(cp.rel, cp.rel, frontmatter['type']);
    this.assertSourcesWritable(cp.rel, cp.rel);
    this.assertProvenanceUnchanged(cp.rel, frontmatter);
    assertNoRelativeMdLinks(body, cp.rel);
    const contents = serializeNote(frontmatter, body); // throws on invalid §8.3
    const absPath = this.reportPath(cp);

    const out = await withCreateGuard(createGuardKey(cp), () => this.withLock(cp, async (target, assertLockHeld, realRel) => {
      assertReservedCreate(cp.rel, realRel, frontmatter['type']);
      this.assertSourcesWritable(cp.rel, realRel);
      const existsResult = async () => {
        const current = await readRegularFile(target, cp.rel);
        return {
          ok: false as const,
          path: cp.rel,
          absPath,
          reason: 'exists' as const,
          currentHash: hashContent(current),
        };
      };
      if (await recheckContained(cp, target)) return existsResult();
      // Normalization policy (vault-path.ts header): never mint a visually
      // identical duplicate of an existing note spelled with different bytes.
      await assertNoNormalizationSibling(path.dirname(target), path.basename(target), cp.rel);
      try {
        await atomicWriteContained(cp, contents, {
          target,
          exclusive: true,
          beforeCommit: assertLockHeld,
        });
      } catch (err) {
        // An external writer (Obsidian ignores our lock) created it meanwhile.
        if (err instanceof TargetExistsError) return existsResult();
        throw err;
      }
      return {
        ok: true as const,
        path: cp.rel,
        absPath,
        hash: hashContent(contents),
        created: true,
        changed: true,
      };
    }));
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
    assertNotReservedForEdit(cp.rel, cp.rel);
    this.assertSourcesWritable(cp.rel, cp.rel);
    const absPath = this.reportPath(cp);
    if (!cp.exists) return { ok: false, path: cp.rel, absPath, reason: 'not_found' };

    const out = await this.withLock(cp, async (target, assertLockHeld, realRel): Promise<BrokerResult> => {
      assertNotReservedForEdit(cp.rel, realRel);
      this.assertSourcesWritable(cp.rel, realRel);
      if (!(await recheckContained(cp, target))) {
        return { ok: false, path: cp.rel, absPath, reason: 'not_found' };
      }
      const bytes = await readRegularFile(target, cp.rel);
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
      this.assertProvenanceUnchanged(cp.rel, patchFm, curFm);

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
      // Validates §8.3 (id must exist); keeps the authored frontmatter text
      // (comments, quoting, untouched values) wherever that is provably exact.
      const contents = serializeNotePreserving(snap.raw, merged, body);

      // Immediately before the replace: re-prove containment, make sure the lock
      // is still ours, and re-hash to catch an external writer that ignores it.
      // (atomicWriteContained rechecks containment and the lock once more.)
      await recheckContained(cp, target);
      assertLockHeld();
      const latestBytes = await readRegularFile(target, cp.rel);
      const latest = hashContent(latestBytes);
      if (latest !== snap.hash) {
        const raw = latestBytes.toString('utf8'); // informational conflict copy only; never written back
        return { ok: false, path: cp.rel, absPath, reason: 'conflict', currentHash: latest, current: raw };
      }
      await atomicWriteContained(cp, contents, { target, beforeCommit: assertLockHeld });
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
   * Compare-and-swap edit of ONE frontmatter key (the local replacement for the
   * Obsidian REST frontmatter PATCH; red-team E3-3). The key must pass
   * `assertPatchableFrontmatterKey`; append-only notes throw
   * `AppendOnlyViolationError`; the merged frontmatter must validate as §8.3.
   */
  async patchFrontmatter(
    relPath: string,
    expectedHash: string,
    key: string,
    value: unknown,
  ): Promise<BrokerResult> {
    assertPatchableFrontmatterKey(relPath, key);
    if (value === undefined) throw new NoteFrontmatterError(relPath, `no value given for "${key}"`);
    if (!this.ingestPrivileged && PROVENANCE_KEYS.includes(key)) {
      throw new ProvenanceViolationError(
        relPath,
        `frontmatter key "${key}" records ingest provenance and only the ingest pipeline may set it`,
      );
    }
    return this.updateNote(relPath, expectedHash, () => ({ frontmatter: { [key]: value } }));
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
    this.assertSourcesWritable(cp.rel, cp.rel);
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
      assertReservedCreate(cp.rel, cp.rel, opts.init.frontmatter['type']);
      assertNoRelativeMdLinks(opts.init.body, cp.rel);
      initContents = serializeNote(opts.init.frontmatter, opts.init.body);
    }

    const run = () => this.withLock(cp, async (target, assertLockHeld, realRel): Promise<BrokerResult> => {
      this.assertSourcesWritable(cp.rel, realRel);
      const reserved = reservedAppendOnlyType(realRel);
      const exists = await recheckContained(cp, target);
      if (!exists) {
        if (initContents === null) return { ok: false, path: cp.rel, absPath, reason: 'not_found' };
        assertReservedCreate(cp.rel, realRel, opts.init?.frontmatter['type']);
        await assertNoNormalizationSibling(path.dirname(target), path.basename(target), cp.rel);
        const contents = initContents + chunk;
        try {
          await atomicWriteContained(cp, contents, {
            target,
            exclusive: true,
            beforeCommit: assertLockHeld,
          });
        } catch (err) {
          // Created externally meanwhile: never clobber it; the caller retries.
          if (err instanceof TargetExistsError) return { ok: false, path: cp.rel, absPath, reason: 'exists' };
          throw err;
        }
        return { ok: true, path: cp.rel, absPath, hash: hashContent(contents), created: true, changed: true };
      }

      const snap = this.snapshot(cp, await readRegularFile(target, cp.rel));
      if (!isAppendOnlyType(snap.frontmatter['type'])) {
        throw new AppendOnlyViolationError(
          cp.rel,
          `appendNote is only for ${APPEND_ONLY_TYPES.join('/')} notes (found type "${String(snap.frontmatter['type'] ?? 'none')}")`,
        );
      }
      if (reserved !== null && snap.frontmatter['type'] !== reserved) {
        throw new AppendOnlyViolationError(
          cp.rel,
          `"${realRel}" is reserved for "${reserved}" notes (found type "${String(snap.frontmatter['type'])}")`,
        );
      }
      const valid = validateFrontmatter(snap.frontmatter);
      if (!valid.ok) throw new NoteFrontmatterError(cp.rel, valid.errors.join('; '));

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
      const after = await readRegularFile(target, cp.rel);
      return { ok: true, path: cp.rel, absPath, hash: hashContent(after), created: false, changed: true };
    });
    // Only an `init` append can create the note, so only it joins the create guard.
    const out = initContents !== null ? await withCreateGuard(createGuardKey(cp), run) : await run();
    return 'lockedOut' in out ? this.locked(cp) : out;
  }
}

/** Convenience factory. */
export function createVaultBroker(vaultRoot: string, opts?: VaultBrokerOptions): VaultBroker {
  return new VaultBroker(vaultRoot, opts);
}
