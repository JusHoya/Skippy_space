// charter.ts — load a Skippy / Board / Staff Officer charter from agent_space/.
//
// Charters are markdown files with YAML frontmatter. The schema lives in
// PRD §6.1 (board:, model:, costume:, tools:, mcp_servers:, memory:, etc.) and
// is mirrored in `agent_space/CLAUDE.md`. The body is the system prompt the
// charter's agent runs under.
//
// We deliberately keep this loader off a full YAML engine. The hand-rolled
// parser below handles the actual charter shape — nested block maps and
// list-valued keys (e.g. the `memory:` stanza's `core_memory_facts:` list two
// levels deep) — which the charters have used since Phase 1; it stays a small,
// indentation-driven walk (no block scalars / anchors / aliases) so there are
// no surprise YAML edge cases on the (author-controlled) charter text and no
// extra startup cost. `gray-matter` is a dependency used elsewhere in the
// runtime; if a charter ever needs full YAML we can route this through it, but
// that day has not come.
//
// Failure modes (per Agent F's tolerance contract):
//   - File missing -> return a placeholder Charter with a stub system prompt
//     that names the board and points at PRD §6.1, plus a `log` envelope so
//     the user sees that Agent A's charter is not yet on disk.
//   - YAML parse failure -> same placeholder behavior, but the body of the
//     markdown is preserved if any was readable.

import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { STAFF_OFFICERS, type BoardId, type StaffOfficerId } from '@skippy/shared';

import { logger } from './logger.js';
import { setBoardModelFromCharter } from './modelRegistry.js';
import { writeEnvelope } from './protocol.js';

/** Identifiers the loader can resolve to a file path on disk. */
export type CharterAgentId =
  | 'skippy'
  | `board.${BoardId}`
  | `staff.${StaffOfficerId}`;

/** Loaded charter: parsed frontmatter + raw markdown body. */
export interface Charter {
  /** The agent id this charter was loaded for. */
  readonly agentId: CharterAgentId;
  /** Parsed YAML frontmatter (nested maps + lists; PRD §6.1). Values the
   * parser cannot coerce are kept as their raw string. */
  readonly frontmatter: Record<string, unknown>;
  /** Markdown body, with frontmatter fence removed. Used as the system prompt. */
  readonly body: string;
  /** True if the file was found on disk; false if we returned a placeholder. */
  readonly loaded: boolean;
  /** Resolved file path (informational, even if `loaded` is false). */
  readonly path: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Path resolution
// ──────────────────────────────────────────────────────────────────────────────

/** Find the project root by walking up from this module until we see a
 * `pnpm-workspace.yaml`. The compiled output lives in
 * `apps/agent-runtime/dist/`, so the walk is short either way. */
function projectRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  let dir = here;
  // Cap the walk at 8 levels — generous; we expect 3–4 in practice.
  for (let i = 0; i < 8; i++) {
    if (
      pathExistsSync(path.join(dir, 'pnpm-workspace.yaml')) ||
      pathExistsSync(path.join(dir, 'agent_space'))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: assume we're at the agent-runtime src/ already.
  return path.resolve(here, '../../..');
}

function pathExistsSync(p: string): boolean {
  // Sync API is fine here — called once at startup on a 4–8 path walk.
  return existsSync(p);
}

function resolveCharterPath(agentId: CharterAgentId): string {
  const root = projectRoot();
  if (agentId === 'skippy') {
    return path.join(root, 'agent_space', 'skippy.md');
  }
  if (agentId.startsWith('board.')) {
    const board = agentId.slice('board.'.length);
    return path.join(root, 'agent_space', 'boards', `${board}.md`);
  }
  // staff.*
  const staff = agentId.slice('staff.'.length);
  return path.join(root, 'agent_space', 'staff', `${staff}.md`);
}

// ──────────────────────────────────────────────────────────────────────────────
// Frontmatter parsing
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Tiny YAML-ish frontmatter parser. Handles:
 *   key: scalar          -> string|number|bool|null
 *   key: [a, b, c]       -> string[]
 *   key:                 -> begins a nested mapping
 *     subkey: value
 *     subkey:            -> which may ITSELF nest a map or a list
 *       - item
 *   key:                 -> begins a sequence
 *     - item
 *
 * Nesting is indentation-driven and recurses to arbitrary depth, so a block map
 * whose own keys carry list values parses correctly — e.g. the `memory:` stanza
 * in every charter, where `core_memory_facts:` is a list nested two levels down
 * (PRD §6.1). The earlier hand-rolled pass flattened one level only and bailed
 * at the first `- ` item, which silently dropped `core_memory_facts` in all 13
 * charters; the recursive walk below fixes that.
 *
 * We do NOT handle:
 *   - block scalars (>, |)
 *   - anchors / aliases
 *   - quoted multi-line strings
 *
 * Anything we cannot parse cleanly is kept as its raw string. This frontmatter
 * is NOT purely informational: `charterPermissions()` reads `permission_mode` /
 * `tools` / `disallowed_tools` off it to drive the gated SDK board's safety
 * rails (PRD §6.1), the model registry reads `model`, and the MCP registry reads
 * `mcp_servers` / `memory.letta_agent_id`. Parse fidelity here is load-bearing.
 */
function parseFrontmatter(raw: string): Record<string, unknown> {
  const lines = raw.split(/\r?\n/);
  const [value] = parseBlock(lines, 0, -1);
  return (value ?? {}) as Record<string, unknown>;
}

/** Leading-whitespace width of a line (tabs counted as one column each — the
 * charters indent with spaces, and we only compare relative depth). A blank or
 * comment-only line returns `Infinity` so it never closes an open block. */
function indentOf(line: string): number {
  if (line.trim() === '' || line.trim().startsWith('#')) return Infinity;
  return (/^(\s*)/.exec(line)?.[1] ?? '').length;
}

/**
 * Parse the block of lines starting at `start` whose indentation is strictly
 * greater than `parentIndent`. Returns the parsed value (a map, a string[], or
 * an empty object for an empty block) and the index of the first line that does
 * NOT belong to the block, so the caller can resume.
 *
 * The block is a sequence when its first significant line begins with `- `,
 * otherwise a mapping. A mapping key whose inline value is empty opens a deeper
 * block, parsed by recursing — which is what makes `core_memory_facts:` (a list
 * two levels under `memory:`) round-trip.
 */
function parseBlock(
  lines: string[],
  start: number,
  parentIndent: number,
): [unknown, number] {
  // Find the first significant line of this block to fix its indentation.
  let i = start;
  while (i < lines.length && indentOf(lines[i] ?? '') === Infinity) i++;
  if (i >= lines.length) return [{}, i];
  const blockIndent = indentOf(lines[i] ?? '');
  if (blockIndent <= parentIndent) return [{}, start];

  const firstTrimmed = (lines[i] ?? '').trim();
  if (firstTrimmed.startsWith('- ') || firstTrimmed === '-') {
    return parseSequence(lines, i, blockIndent);
  }
  return parseMapping(lines, i, blockIndent);
}

function parseSequence(
  lines: string[],
  start: number,
  blockIndent: number,
): [string[], number] {
  const list: string[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const indent = indentOf(line);
    if (indent === Infinity) {
      i++;
      continue;
    }
    if (indent < blockIndent) break;
    const trimmed = line.trim();
    if (!trimmed.startsWith('-')) break; // a map key at this depth ends the list
    const item = coerceScalar(stripComment(trimmed.replace(/^-\s*/, '')));
    list.push(typeof item === 'string' ? item : String(item ?? ''));
    i++;
  }
  return [list, i];
}

function parseMapping(
  lines: string[],
  start: number,
  blockIndent: number,
): [Record<string, unknown>, number] {
  const map: Record<string, unknown> = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const indent = indentOf(line);
    if (indent === Infinity) {
      i++;
      continue;
    }
    if (indent < blockIndent) break;
    if (indent > blockIndent) {
      // Stray deeper line with no opener — skip rather than mis-attribute it.
      i++;
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.startsWith('-')) break; // a list item at this depth ends the map
    const m = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(trimmed);
    if (!m || m[1] === undefined) {
      i++;
      continue;
    }
    const key = m[1];
    const rest = stripComment(m[2] ?? '').trim();
    if (rest === '') {
      // Empty inline value — the value is whatever block follows, if it is
      // indented deeper than this key; otherwise it is an explicit null.
      const nextSignificant = nextSignificantIndent(lines, i + 1);
      if (nextSignificant > blockIndent) {
        const [value, next] = parseBlock(lines, i + 1, blockIndent);
        map[key] = value;
        i = next;
        continue;
      }
      map[key] = null;
      i++;
      continue;
    }
    map[key] = coerceScalar(rest);
    i++;
  }
  return [map, i];
}

/** Indentation of the next significant (non-blank, non-comment) line, or
 * `-Infinity` when none remains — used to decide whether an empty `key:` opens
 * a nested block or is a bare null. */
function nextSignificantIndent(lines: string[], start: number): number {
  for (let i = start; i < lines.length; i++) {
    const indent = indentOf(lines[i] ?? '');
    if (indent !== Infinity) return indent;
  }
  return -Infinity;
}

/**
 * Strip a trailing ` # comment` from a scalar value. A `#` only starts a comment
 * when it is preceded by whitespace (or starts the value); a `#` inside a token
 * — notably hex colors like `#66FCF1` — is preserved. Comments are not stripped
 * inside quotes.
 */
function stripComment(value: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble) {
      const prev = value[i - 1];
      if (i === 0 || prev === ' ' || prev === '\t') {
        return value.slice(0, i).replace(/\s+$/, '');
      }
    }
  }
  return value;
}

function coerceScalar(raw: string): unknown {
  const s = raw.trim();
  if (s === '' || s === 'null' || s === '~') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  // Inline list  [a, b, c]
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map((p) => coerceScalar(p));
  }
  // Quoted string
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  // Number
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

// ──────────────────────────────────────────────────────────────────────────────
// Charter cache
// ──────────────────────────────────────────────────────────────────────────────

const cache = new Map<CharterAgentId, Charter>();

/**
 * Load a charter by agent id. Cached for the sidecar lifetime. Returns a
 * placeholder Charter (with a stub system prompt) if the file is missing —
 * this is intentional so Agent A can land their charters in parallel without
 * blocking the runtime.
 */
export async function loadCharter(agentId: CharterAgentId): Promise<Charter> {
  const cached = cache.get(agentId);
  if (cached) return cached;
  const filePath = resolveCharterPath(agentId);
  try {
    const text = await fs.readFile(filePath, 'utf8');
    const parsed = splitFrontmatter(text);
    const charter: Charter = {
      agentId,
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      loaded: true,
      path: filePath,
    };
    cache.set(agentId, charter);
    // A board's charter `model:` is an honored contract: seed the model registry
    // so `getModelFor('board.<id>')` resolves to the charter's declared model
    // (PRD §6.1), with BOARD_META as the fallback. No-ops if the user already
    // rebound the board. (Skippy's model is seeded from SKIPPY_MODEL / Opus in
    // the registry itself; staff have no registry scope yet — see loadStaffCharters.)
    if (agentId.startsWith('board.')) {
      const boardId = agentId.slice('board.'.length) as BoardId;
      setBoardModelFromCharter(boardId, charter.frontmatter['model']);
    }
    return charter;
  } catch (err) {
    logger.warn({
      msg: 'charter file missing, using placeholder',
      agentId,
      path: filePath,
      err: String(err),
    });
    writeEnvelope({
      type: 'log',
      level: 'warn',
      source: 'agent-runtime',
      message: `Charter file not yet present for ${agentId}; running on minimal stub. (PRD §6.1 — file expected at ${filePath})`,
      ts: new Date().toISOString(),
    });
    const placeholder = makePlaceholder(agentId, filePath);
    cache.set(agentId, placeholder);
    return placeholder;
  }
}

function splitFrontmatter(text: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  // Frontmatter fence is `---` on its own line.
  const m = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n([\s\S]*)$/.exec(text);
  if (!m) {
    return { frontmatter: {}, body: text };
  }
  const fmText = m[1] ?? '';
  const body = m[2] ?? '';
  return { frontmatter: parseFrontmatter(fmText), body };
}

function makePlaceholder(agentId: CharterAgentId, filePath: string): Charter {
  const niceName = friendlyName(agentId);
  const body = `# ${niceName} — Placeholder Charter

Charter file not yet present at \`${filePath}\` — running on a minimal stub per
PRD §6.1 schema. Inform the user that this agent's full identity has not yet
been ported from Hoya_Box.

You are ${niceName}. You report up the chain (Boards report to Skippy; Staff
Officers report to Skippy). You acknowledge delegated missions, you do not
implement them directly without explicit authorization, and you keep your
responses concise until your real charter lands.`;
  return {
    agentId,
    frontmatter: {
      placeholder: true,
      reason: 'file_missing',
    },
    body,
    loaded: false,
    path: filePath,
  };
}

function friendlyName(agentId: CharterAgentId): string {
  if (agentId === 'skippy') return 'Skippy the Magnificent';
  if (agentId.startsWith('board.')) {
    const id = agentId.slice('board.'.length);
    return `${id[0]?.toUpperCase() ?? ''}${id.slice(1)} Captain`;
  }
  const id = agentId.slice('staff.'.length);
  return `Staff Officer (${id})`;
}

/** Test-only / shutdown helper: clear the cache. */
export function clearCharterCache(): void {
  cache.clear();
}

// ──────────────────────────────────────────────────────────────────────────────
// Staff Officers (PRD §6.3)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Load all four Staff Officer charters (`agent-creator`, `skill-auditor`,
 * `memory-manager`, `psych-monitor`) so they are resolvable and referenceable.
 *
 * Why this exists: Skippy's charter body (his system prompt) directs him to use
 * the Staff Officers every turn — "validate via `psych-monitor`", "create types
 * via `agent-creator`" (PRD §6.3, `agent_space/skippy.md`). Until this loader
 * existed nothing read the `staff/*.md` files at all, so the prompt promised a
 * capability the runtime could not honor. This is the smaller, correct half of
 * that fix: the charters are now LOADABLE (same cache + placeholder-tolerant
 * path as boards), which is the prerequisite for referencing them.
 *
 * It is NOT yet full invocation: Skippy has no `delegate_to_staff` tool, and the
 * gated SDK board path does not spawn staff sessions. Wiring that tool + an
 * execution path lives in `skippy.ts` / the SDK board layer, outside this
 * module — tracked as a residual gap so the prompt/runtime mismatch is at least
 * visible and the charters are ready to be consumed when that lands.
 */
export async function loadStaffCharters(): Promise<Map<StaffOfficerId, Charter>> {
  const entries = await Promise.all(
    STAFF_OFFICERS.map(async (id) => {
      const charter = await loadCharter(`staff.${id}`);
      return [id, charter] as const;
    }),
  );
  return new Map(entries);
}

// ──────────────────────────────────────────────────────────────────────────────
// Charter-driven permissions (PRD §6.1 — permission_mode / tools / disallowed_tools)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * The charter `permission_mode:` values (PRD §6.1 / agent_space/CLAUDE.md). These
 * are the charter-author's vocabulary; `sdk-board.ts` maps them onto the SDK's
 * own `PermissionMode` (notably `ask` → the SDK's prompting mode). `ask` is the
 * default every board declares — the safety rail must survive even if the field
 * is missing or malformed.
 */
export const CHARTER_PERMISSION_MODES = ['ask', 'acceptEdits', 'bypassPermissions', 'plan'] as const;
export type CharterPermissionMode = (typeof CHARTER_PERMISSION_MODES)[number];

/** The charter's tool-permission surface, defaulted to the safe `ask` mode. */
export interface CharterPermissions {
  /** `permission_mode:` — defaults to `'ask'` when absent/unrecognized. */
  permissionMode: CharterPermissionMode;
  /** `tools:` allowlist — undefined when the charter declares none. */
  allowedTools?: string[];
  /** `disallowed_tools:` denylist — undefined when the charter declares none. */
  disallowedTools?: string[];
}

/** Coerce a frontmatter value to a string[] (filtering non-strings), or
 * undefined when the field is absent / not an array. */
function stringArrayField(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((x): x is string => typeof x === 'string');
  return out.length > 0 ? out : undefined;
}

/**
 * Read the charter's permission contract. The default is intentionally the
 * SAFEST option (`ask`): a missing or unrecognized `permission_mode` never
 * silently widens to a more permissive mode. Boards declare `permission_mode: ask`
 * in PRD §6.1, and the runtime must honor it rather than the old hardcoded
 * `bypassPermissions`.
 */
export function charterPermissions(charter: Charter): CharterPermissions {
  const raw = charter.frontmatter['permission_mode'];
  const permissionMode: CharterPermissionMode =
    typeof raw === 'string' && (CHARTER_PERMISSION_MODES as readonly string[]).includes(raw)
      ? (raw as CharterPermissionMode)
      : 'ask';
  const allowedTools = stringArrayField(charter.frontmatter['tools']);
  const disallowedTools = stringArrayField(charter.frontmatter['disallowed_tools']);
  const out: CharterPermissions = { permissionMode };
  if (allowedTools) out.allowedTools = allowedTools;
  if (disallowedTools) out.disallowedTools = disallowedTools;
  return out;
}
