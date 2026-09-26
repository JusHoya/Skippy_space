// mcp-handlers.ts — the tool-handler logic for the agent MCP servers (D1/D4).
//
// Phase 3.5. These are plain async functions returning a CallToolResult-shaped
// object, deliberately split out of `mcp-registry.ts` so they are unit-testable
// WITHOUT constructing an SDK server or importing zod. Each handler wraps a
// WS2/WS-C client call (whose result is already {ok}-discriminated and never
// throws) and degrades to `isError` text when the backing service is offline —
// the board mission continues with reduced capability, it never crashes.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import {
  ObsidianRestClient,
  LettaClient,
  VaultBroker,
  isAppendOnlyType,
  mirrorArchivalToVault,
  makeFrontmatter,
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
 * Create or edit a vault note via the filesystem (works even when the Obsidian
 * app is closed — the fs is the source of truth, PRD §8.9). Every write goes
 * through the `VaultBroker` (M0 WS-D; FR-SEC-02, FR-WIKI-02, assessment A03):
 *
 * - `path` is untrusted. Absolute, drive-relative, UNC/device, `..`, ADS,
 *   reserved-name and dot-directory paths, and junction/symlink escapes, are
 *   rejected as isError text before any I/O.
 * - Without `expected_hash` the note is created and never overwrites. If it
 *   exists, the error carries its current sha256.
 * - With `expected_hash` the note is edited compare-and-swap: a hash mismatch is
 *   a conflict (re-read and retry); `id`, `created_at` and unknown frontmatter
 *   keys are preserved; `title`/`type`/`source` and the body are replaced.
 * - `agent_log`/`daily` notes are append-only and cannot be written here.
 *
 * §8.3 frontmatter is validated and the wikilink-only guard runs in the broker,
 * so a relative `.md` link in the body is rejected.
 */
export async function handleObsidianWriteNote(
  vaultRoot: string,
  args: {
    path: string;
    title: string;
    body: string;
    type?: string | undefined;
    source?: string | undefined;
    expected_hash?: string | undefined;
  },
): Promise<McpToolResult> {
  try {
    const type = args.type ?? 'concept';
    if (isAppendOnlyType(type)) {
      return fail(
        `obsidian_write_note cannot write "${type}" notes: agent_log/daily notes are append-only.`,
      );
    }
    const broker = new VaultBroker(vaultRoot);

    if (args.expected_hash === undefined) {
      const fm = makeFrontmatter({
        title: args.title,
        type: type as NoteType,
        authored_by: 'board.sdk',
        source: args.source ?? null,
      });
      const r = await broker.createNote(args.path, fm, args.body);
      if (r.ok) return ok(`Wrote ${r.path} (sha256 ${r.hash}).`);
      if (r.reason === 'exists') {
        return fail(
          `obsidian_write_note: ${r.path} already exists (sha256 ${r.currentHash ?? 'unknown'}). ` +
            'To edit it, resend with expected_hash set to the hash of the version you read; id and created_at are preserved.',
        );
      }
      return fail(`obsidian_write_note not completed (${r.reason}).`);
    }

    const r = await broker.updateNote(args.path, args.expected_hash, () => ({
      frontmatter: {
        title: args.title,
        ...(args.type !== undefined ? { type: args.type } : {}),
        ...(args.source !== undefined ? { source: args.source } : {}),
      },
      body: args.body,
    }));
    if (r.ok) return ok(`Updated ${r.path} (sha256 ${r.hash}).`);
    if (r.reason === 'conflict') {
      return fail(
        `obsidian_write_note conflict: ${r.path} changed since the expected hash (current sha256 ${r.currentHash ?? 'unknown'}). Re-read, merge, and retry.`,
      );
    }
    return fail(`obsidian_write_note not completed (${r.reason}).`);
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
