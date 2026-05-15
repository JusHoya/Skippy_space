// charter.ts — load a Skippy / Board / Staff Officer charter from agent_space/.
//
// Charters are markdown files with YAML frontmatter. The schema lives in
// PRD §6.1 (board:, model:, costume:, tools:, mcp_servers:, memory:, etc.) and
// is mirrored in `agent_space/CLAUDE.md`. The body is the system prompt the
// charter's agent runs under.
//
// We deliberately avoid adding `gray-matter` / `js-yaml` as dependencies for
// Phase 1 — neither is in `apps/agent-runtime/package.json` yet (only the
// workspace has a transitive `js-yaml` via some other package, which we are
// not supposed to rely on). The frontmatter shape we need is shallow enough
// that a tiny hand-rolled parser is both safer (no surprise YAML edge cases on
// untrusted text) and faster (no extra startup cost). If a future charter
// needs nested structures we cannot handle, we can drop `gray-matter` in then.
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
  /** Parsed (shallow) YAML frontmatter. Unknown keys are kept as strings. */
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
 *   key:                 -> begins a sequence
 *     - item
 *
 * We do NOT handle:
 *   - block scalars (>, |)
 *   - anchors / aliases
 *   - quoted multi-line strings
 *
 * Anything we cannot parse cleanly is kept as its raw string. The frontmatter
 * is informational at this layer; the *body* is what feeds the LLM, so loss-of-
 * fidelity in frontmatter never affects agent behavior — just metadata.
 */
function parseFrontmatter(raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = raw.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trim() === '' || line.trim().startsWith('#')) {
      i++;
      continue;
    }
    const m = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (!m) {
      i++;
      continue;
    }
    const key = m[1] as string;
    const rest = (m[2] ?? '').trim();
    if (rest === '') {
      // Nested block — peek the next line's indent.
      const block: Record<string, unknown> = {};
      const list: string[] = [];
      let j = i + 1;
      let mode: 'map' | 'list' | null = null;
      while (j < lines.length) {
        const sub = lines[j] ?? '';
        if (sub.trim() === '') {
          j++;
          continue;
        }
        const indent = /^(\s+)/.exec(sub);
        if (!indent) break;
        const trimmed = sub.trim();
        if (trimmed.startsWith('- ')) {
          mode ??= 'list';
          if (mode !== 'list') break;
          list.push(trimmed.slice(2).trim().replace(/^['"]|['"]$/g, ''));
        } else if (/^[A-Za-z0-9_]+:/.test(trimmed)) {
          mode ??= 'map';
          if (mode !== 'map') break;
          const sm = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(trimmed);
          if (sm && sm[1] !== undefined) {
            block[sm[1]] = coerceScalar(sm[2] ?? '');
          }
        } else {
          break;
        }
        j++;
      }
      out[key] = mode === 'list' ? list : block;
      i = j;
      continue;
    }
    out[key] = coerceScalar(rest);
    i++;
  }
  return out;
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
