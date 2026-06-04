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
 * Create/overwrite a vault note atomically via the filesystem (works even when
 * the Obsidian app is closed — the fs is the source of truth, PRD §8.9). The
 * §8.3 frontmatter is built + validated and the wikilink-only guard runs inside
 * `writeNote`, so a relative `.md` link in the body is rejected.
 */
export async function handleObsidianWriteNote(
  vaultRoot: string,
  args: {
    path: string;
    title: string;
    body: string;
    type?: string | undefined;
    source?: string | undefined;
  },
): Promise<McpToolResult> {
  try {
    const fm = makeFrontmatter({
      title: args.title,
      type: (args.type ?? 'concept') as NoteType,
      authored_by: 'board.sdk',
      source: args.source ?? null,
    });
    const target = path.join(vaultRoot, args.path);
    const r = await writeNote(target, fm, args.body);
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
