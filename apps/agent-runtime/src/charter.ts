// charter.ts — load a Skippy / Board / Staff Officer charter from agent_space/.
//
// Charters are markdown files with YAML frontmatter. The schema lives in
// PRD §6.1 (board:, model:, costume:, tools:, mcp_servers:, memory:, etc.) and
// is mirrored in `agent_space/CLAUDE.md`. The body is the system prompt the
// charter's agent runs under.
//
// Frontmatter is parsed with a real YAML parser (js-yaml 4, the version already
// pinned by @skippy/memory) so that every key the author wrote reaches the
// tool-policy layer (FR-BOARD-01 "never silently broaden authority"). The
// previous hand-rolled parser only recognised `^[A-Za-z0-9_]+:` keys, so a
// hyphenated, quoted or indented authority key (`disallowed-tools`,
// `"disallowed_tools"`, `  disallowed_tools`) was dropped before
// `derivePolicy` could refuse it (red-team N4), and a duplicated key silently
// took the last value (N5). Now:
//
//   - duplicate keys are a parse error (js-yaml default);
//   - a mis-indented top-level key is a parse error (js-yaml default);
//   - YAML anchors, aliases and merge keys are refused anywhere in the
//     frontmatter (they can rewrite authority fields out of sight);
//   - the document must be a mapping;
//   - any parse error makes the charter *unloaded*: `loaded: false`, so
//     `derivePolicy` fails closed (`charter_not_loaded`) while the markdown
//     body is still preserved for diagnostics.
//
// Key spelling (case, `-` vs `_`, nesting) is judged by `derivePolicy` in
// tool-policy.ts, which sees the exact keys this parser produced.
//
// Failure modes:
//   - File missing -> return a placeholder Charter with a stub system prompt
//     that names the board and points at PRD §6.1, plus a `log` envelope so
//     the user sees that the charter is not yet on disk.
//   - YAML parse failure -> same placeholder behavior, but the body of the
//     markdown is preserved if any was readable.

import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import yaml from 'js-yaml';

import type { BoardId, StaffOfficerId } from '@skippy/shared';

import { logger } from './logger.js';
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
  /** Parsed YAML frontmatter, keys exactly as written. */
  readonly frontmatter: Record<string, unknown>;
  /** Markdown body, with frontmatter fence removed. Used as the system prompt. */
  readonly body: string;
  /** True if the file was found on disk AND its frontmatter parsed; false if
   * we returned a placeholder (missing file or invalid frontmatter). */
  readonly loaded: boolean;
  /** Resolved file path (informational, even if `loaded` is false). */
  readonly path: string;
}

/** Thrown by `parseCharterText` when the frontmatter cannot be trusted. */
export class CharterParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CharterParseError';
  }
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

/** Frontmatter fence: `---` on its own line at the very top (after an optional
 * BOM), closed by another `---` line. CRLF tolerant. */
const FENCE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/;

/**
 * Remove YAML quoted scalars and `#` comments so the anchor/alias/merge scan
 * below only sees structural text. Quoted strings may legitimately contain
 * `&`, `*` or `<<` (e.g. a core-memory fact); structural ones may not.
 */
function stripQuotedAndComments(fm: string): string {
  let out = '';
  let i = 0;
  while (i < fm.length) {
    const c = fm[i] as string;
    if (c === '"' || c === "'") {
      const q = c;
      let j = i + 1;
      while (j < fm.length) {
        const d = fm[j] as string;
        if (q === '"' && d === '\\') {
          j += 2;
          continue;
        }
        if (d === q) {
          // `''` inside a single-quoted scalar is an escaped quote.
          if (q === "'" && fm[j + 1] === "'") {
            j += 2;
            continue;
          }
          break;
        }
        if (d === '\n') break; // unterminated on this line; let js-yaml judge
        j++;
      }
      out += ' ';
      i = j + 1;
      continue;
    }
    if (c === '#' && (i === 0 || /\s/.test(fm[i - 1] as string))) {
      while (i < fm.length && fm[i] !== '\n') i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** `&anchor`, `*alias` (as a value or list item) or a `<<` merge key. */
const ANCHOR_OR_ALIAS = /(?:^|[\s[{,:])[&*][A-Za-z0-9_-]+/m;
const MERGE_KEY = /(?:^|[\s{,])<<\s*:/m;

/**
 * Parse a charter markdown document into frontmatter + body. Throws
 * CharterParseError when the frontmatter cannot be trusted (duplicate keys,
 * bad indentation, anchors/aliases/merge keys, non-mapping document, or any
 * other YAML error). A document without a frontmatter fence yields an empty
 * frontmatter and the whole text as body.
 */
export function parseCharterText(text: string): { frontmatter: Record<string, unknown>; body: string } {
  const src = text.startsWith('﻿') ? text.slice(1) : text;
  const m = FENCE.exec(src);
  if (!m) {
    return { frontmatter: {}, body: src };
  }
  const fmText = m[1] ?? '';
  const body = m[2] ?? '';

  const structural = stripQuotedAndComments(fmText);
  if (ANCHOR_OR_ALIAS.test(structural)) {
    throw new CharterParseError('YAML anchors/aliases are not permitted in charter frontmatter');
  }
  if (MERGE_KEY.test(structural)) {
    throw new CharterParseError('YAML merge keys (<<) are not permitted in charter frontmatter');
  }

  let doc: unknown;
  try {
    // js-yaml 4 default schema: no custom/function types; duplicate mapping
    // keys and bad indentation throw.
    doc = yaml.load(fmText, { json: false });
  } catch (err) {
    const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
    throw new CharterParseError(`frontmatter is not valid YAML: ${msg}`);
  }
  if (doc === undefined || doc === null) {
    return { frontmatter: {}, body };
  }
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    throw new CharterParseError('frontmatter must be a YAML mapping');
  }
  return { frontmatter: doc as Record<string, unknown>, body };
}

// ──────────────────────────────────────────────────────────────────────────────
// Charter cache
// ──────────────────────────────────────────────────────────────────────────────

const cache = new Map<CharterAgentId, Charter>();

/**
 * Load a charter by agent id. Cached for the sidecar lifetime. Returns a
 * placeholder Charter (with a stub system prompt) if the file is missing —
 * this is intentional so Agent A can land their charters in parallel without
 * blocking the runtime. A file whose frontmatter fails to parse is also
 * returned as `loaded: false` (its body preserved) so no authority is ever
 * derived from a half-read charter.
 */
export async function loadCharter(agentId: CharterAgentId): Promise<Charter> {
  const cached = cache.get(agentId);
  if (cached) return cached;
  const filePath = resolveCharterPath(agentId);
  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf8');
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
    const placeholder = makePlaceholder(agentId, filePath, 'file_missing');
    cache.set(agentId, placeholder);
    return placeholder;
  }

  try {
    const parsed = parseCharterText(text);
    const charter: Charter = {
      agentId,
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      loaded: true,
      path: filePath,
    };
    cache.set(agentId, charter);
    return charter;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn({ msg: 'charter frontmatter invalid; charter treated as not loaded', agentId, path: filePath, err: reason });
    writeEnvelope({
      type: 'log',
      level: 'warn',
      source: 'agent-runtime',
      message: `Charter frontmatter for ${agentId} is invalid and grants no authority: ${reason} (${filePath})`,
      ts: new Date().toISOString(),
    });
    // Preserve whatever body was readable (after the fence, if any) for
    // diagnostics, but the charter is NOT loaded: no policy derives from it.
    const bodyMatch = FENCE.exec(text.startsWith('﻿') ? text.slice(1) : text);
    const body = bodyMatch?.[2] ?? '';
    const invalid: Charter = {
      agentId,
      frontmatter: { placeholder: true, reason: 'frontmatter_invalid', error: reason },
      body: body.trim() === '' ? makePlaceholder(agentId, filePath, 'frontmatter_invalid').body : body,
      loaded: false,
      path: filePath,
    };
    cache.set(agentId, invalid);
    return invalid;
  }
}

function makePlaceholder(
  agentId: CharterAgentId,
  filePath: string,
  reason: 'file_missing' | 'frontmatter_invalid',
): Charter {
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
      reason,
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
