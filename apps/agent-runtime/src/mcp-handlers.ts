// mcp-handlers.ts — the tool-handler logic for the agent MCP servers (D1/D4).
//
// Phase 3.5. These are plain async functions returning a CallToolResult-shaped
// object, deliberately split out of `mcp-registry.ts` so they are unit-testable
// WITHOUT constructing an SDK server or importing zod. Each handler wraps a
// WS2/WS-C client call (whose result is already {ok}-discriminated and never
// throws) and degrades to `isError` text when the backing service is offline —
// the board mission continues with reduced capability, it never crashes.

import * as path from 'node:path';

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import {
  ObsidianRestClient,
  LettaClient,
  mirrorArchivalToVault,
  makeFrontmatter,
  writeNote,
  resolveInVault,
  PathEscapesVaultError,
  type NoteType,
} from '@skippy/memory';

/** The MCP tool-handler result type (what the SDK's `tool()` handler returns).
 * Aliased so the test suite can import it without depending on the SDK. */
export type McpToolResult = CallToolResult;

function ok(text: string): McpToolResult {
  return { content: [{ type: 'text', text }] };
}
function fail(text: string): McpToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

// ── Obsidian tools (D1) ───────────────────────────────────────────────────────

export async function handleObsidianRead(
  client: ObsidianRestClient,
  args: { path: string },
): Promise<McpToolResult> {
  const r = await client.readFile(args.path);
  return r.ok
    ? ok(r.data)
    : fail(`obsidian_read_note failed (vault offline?): ${r.error}`);
}

export async function handleObsidianSearch(
  client: ObsidianRestClient,
  args: { query: string; limit?: number | undefined },
): Promise<McpToolResult> {
  const r = await client.search(args.query);
  if (!r.ok) return fail(`obsidian_search unavailable (vault offline?): ${r.error}`);
  const limit = args.limit ?? 10;
  const lines = r.data.slice(0, limit).map((h) => `- ${h.path} (score ${h.score.toFixed(3)})`);
  return ok(lines.length > 0 ? lines.join('\n') : 'No matches.');
}

export async function handleObsidianPatchFrontmatter(
  client: ObsidianRestClient,
  args: { path: string; key: string; value: string },
): Promise<McpToolResult> {
  const r = await client.patchFrontmatter(args.path, args.key, args.value);
  return r.ok
    ? ok(`Patched frontmatter "${args.key}" on ${args.path}.`)
    : fail(`obsidian_patch_frontmatter failed: ${r.error}`);
}

export async function handleObsidianAppendBlock(
  client: ObsidianRestClient,
  args: { path: string; markdown: string },
): Promise<McpToolResult> {
  const r = await client.appendBlock(args.path, args.markdown);
  return r.ok
    ? ok(`Appended a block to ${args.path}.`)
    : fail(`obsidian_append_block failed: ${r.error}`);
}

/**
 * Append-only files this tool must never clobber (CLAUDE.md #5 / PRD §8.6):
 *   - any note named `agent_log.md` (board audit logs),
 *   - anything under the `40_Daily/` daily-notes tree.
 * Both have dedicated append paths (`obsidian_append_block` / `letta_append_archival`
 * for the agent log; the daily-note writer for 40_Daily). A normalized,
 * forward-slashed, vault-relative path is checked so `40_Daily\x` and
 * `./40_Daily/x` are both caught.
 */
function isAppendOnlyTarget(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  const base = norm.split('/').pop() ?? '';
  if (base === 'agent_log.md') return true;
  return norm === '40_Daily' || norm.startsWith('40_Daily/');
}

/**
 * Create/overwrite a vault note atomically via the filesystem (works even when
 * the Obsidian app is closed — the fs is the source of truth, PRD §8.9). The
 * §8.3 frontmatter is built + validated and the wikilink-only guard runs inside
 * `writeNote`, so a relative `.md` link in the body is rejected.
 *
 * Three safety rails wrap the write, since `args.path` is fully model-controlled:
 *   1. CONTAINMENT — the resolved target must stay inside `vaultRoot`; a `..`
 *      traversal or absolute path is rejected (no write-anywhere primitive).
 *   2. APPEND-ONLY — `agent_log.md` / `40_Daily/` targets are refused (those
 *      files are append-only; the model is pointed at the append tools).
 *   3. PROVENANCE — the note is stamped `authored_by: board.<boardId>` so the
 *      audit trail records which board wrote it, not a generic `board.sdk`.
 */
export async function handleObsidianWriteNote(
  vaultRoot: string,
  boardId: string,
  args: {
    path: string;
    title: string;
    body: string;
    type?: string | undefined;
    source?: string | undefined;
  },
): Promise<McpToolResult> {
  // (1) Containment — reject traversal / absolute paths before anything else.
  let target: string;
  try {
    target = resolveInVault(vaultRoot, args.path);
  } catch (err) {
    if (err instanceof PathEscapesVaultError) {
      return fail(`obsidian_write_note rejected: path escapes the vault ("${args.path}").`);
    }
    return fail(`obsidian_write_note failed: ${String(err)}`);
  }

  // (2) Append-only guard — never overwrite agent_log.md or a 40_Daily/ note.
  // Check the RESOLVED, vault-relative target, not the raw arg: a model could
  // otherwise slip past with `x/../40_Daily/note.md`, which passes containment
  // (resolves inside the vault) yet evades a raw-string prefix check.
  const relTarget = path.relative(path.resolve(vaultRoot), target);
  if (isAppendOnlyTarget(relTarget)) {
    return fail(
      `obsidian_write_note rejected: "${args.path}" is append-only. ` +
        `Use obsidian_append_block (or letta_append_archival for the agent log) instead.`,
    );
  }

  try {
    // (3) Provenance — stamp the real board id, not a generic 'board.sdk'.
    const fm = makeFrontmatter({
      title: args.title,
      type: (args.type ?? 'concept') as NoteType,
      authored_by: `board.${boardId}`,
      source: args.source ?? null,
    });
    // Pass vaultRoot so the writer re-validates containment (defense-in-depth).
    const r = await writeNote(target, fm, args.body, { vaultRoot });
    return r.written
      ? ok(`Wrote ${args.path}.`)
      : fail(`obsidian_write_note not completed (${r.reason}).`);
  } catch (err) {
    return fail(`obsidian_write_note failed: ${String(err)}`);
  }
}

// ── Letta tools (D4) ──────────────────────────────────────────────────────────
//
// Each tool is bound by construction to ONE board's `letta_agent_id`, so a board
// can never read/write another board's memory (the cross-board guard is the
// binding itself). letta_append_archival ALSO mirrors the write to the board's
// vault agent_log.md — the durable record that survives Letta being down.

export async function handleLettaSearch(
  client: LettaClient,
  agentId: string,
  args: { query: string; limit?: number | undefined },
): Promise<McpToolResult> {
  const r = await client.searchArchival(agentId, args.query, args.limit);
  if (!r.ok) return fail(`letta_search_archival unavailable (Letta down/disabled?): ${r.error}`);
  const lines = r.data.results.map(
    (x, i) => `${i + 1}. ${x.text}${x.source ? ` [${x.source}]` : ''}`,
  );
  return ok(lines.length > 0 ? lines.join('\n') : 'No archival memories matched.');
}

export async function handleLettaAppend(
  client: LettaClient,
  agentId: string,
  board: string,
  vaultRoot: string,
  args: { text: string },
): Promise<McpToolResult> {
  // Attempt Letta, but the vault mirror is the durable record regardless.
  const letta = await client.appendArchival(agentId, args.text);
  const mirror = await mirrorArchivalToVault({ board, text: args.text, vaultRoot });
  const lettaMsg = letta.ok ? 'archived to Letta' : `Letta unavailable (${letta.error})`;
  const mirrorMsg = mirror.ok
    ? `mirrored to 50_Agents/${board}/agent_log.md`
    : `vault mirror failed (${mirror.error ?? 'unknown'})`;
  // Only a hard error if BOTH the archive and the durable mirror failed.
  return !letta.ok && !mirror.ok
    ? fail(`letta_append_archival: ${lettaMsg}; ${mirrorMsg}`)
    : ok(`${lettaMsg}; ${mirrorMsg}`);
}

export async function handleLettaEditCore(
  client: LettaClient,
  agentId: string,
  args: { block: string; value: string },
): Promise<McpToolResult> {
  const r = await client.editCore(agentId, args.block, args.value);
  return r.ok
    ? ok(`Updated core memory block "${args.block}".`)
    : fail(`letta_edit_core failed (Letta down/disabled?): ${r.error}`);
}
