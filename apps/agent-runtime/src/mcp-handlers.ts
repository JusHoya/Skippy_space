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
  VaultPathError,
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

/**
 * Read a note. With a `vaultRoot`, a `.md` note is read from the local vault
 * through the broker (containment, 8.3/hidden/hardlink rules) and the result
 * starts with a `sha256: <hash>` line — the `expected_hash` that
 * obsidian_write_note / obsidian_patch_frontmatter need. Non-markdown files,
 * or no vault root, fall back to the (read-only) REST client.
 */
export async function handleObsidianRead(
  client: ObsidianRestClient,
  args: { path: string },
  vaultRoot?: string,
): Promise<McpToolResult> {
  if (vaultRoot) {
    try {
      const snap = await new VaultBroker(vaultRoot).readNote(args.path);
      if (snap === null) return fail(`obsidian_read_note: ${args.path} does not exist.`);
      return ok(`sha256: ${snap.hash}\n\n${snap.raw}`);
    } catch (err) {
      if (!(err instanceof VaultPathError && err.violation === 'not_markdown')) {
        return fail(`obsidian_read_note refused: ${String(err)}`);
      }
    }
  }
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

// obsidian_patch_frontmatter / obsidian_append_block (M0 red-team E3-3):
// these used to send PATCH/POST to the Obsidian Local REST API, which bypassed
// every broker guarantee (lock, expected hash, append-only types, real-path
// containment incl. 8.3 short names, §8.3 validation) and a protected-key
// filter the plugin's URL-decoding defeated. They now write the local vault
// through the VaultBroker only; REST is read-only. No vault root -> refuse.

/** JSON when it parses (numbers, booleans, null, arrays), otherwise the raw string. */
function parseFrontmatterValue(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export async function handleObsidianPatchFrontmatter(
  vaultRoot: string,
  args: { path: string; key: string; value: string; expected_hash?: string | undefined },
): Promise<McpToolResult> {
  if (!vaultRoot) {
    return fail('obsidian_patch_frontmatter refused: no local vault root is configured to check the write.');
  }
  if (!args.expected_hash) {
    return fail(
      'obsidian_patch_frontmatter requires expected_hash: the sha256 of the version you read ' +
        '(obsidian_read_note prints it). A mismatch is a conflict.',
    );
  }
  try {
    const r = await new VaultBroker(vaultRoot).patchFrontmatter(
      args.path,
      args.expected_hash,
      args.key,
      parseFrontmatterValue(args.value),
    );
    if (r.ok) return ok(`Patched frontmatter "${args.key}" on ${r.path} (sha256 ${r.hash}).`);
    if (r.reason === 'conflict') {
      return fail(
        `obsidian_patch_frontmatter conflict: ${r.path} changed since the expected hash (current sha256 ${r.currentHash ?? 'unknown'}). Re-read, merge, and retry.`,
      );
    }
    return fail(`obsidian_patch_frontmatter not completed (${r.reason}).`);
  } catch (err) {
    return fail(`obsidian_patch_frontmatter failed: ${String(err)}`);
  }
}

export async function handleObsidianAppendBlock(
  vaultRoot: string,
  args: { path: string; markdown: string },
): Promise<McpToolResult> {
  if (!vaultRoot) {
    return fail('obsidian_append_block refused: no local vault root is configured to check the write.');
  }
  try {
    const r = await new VaultBroker(vaultRoot).appendNote(args.path, args.markdown);
    if (r.ok) return ok(`Appended a block to ${r.path} (sha256 ${r.hash}).`);
    if (r.reason === 'not_found') {
      return fail(
        `obsidian_append_block: ${r.path} does not exist. Appends only extend existing agent_log/daily notes; create notes with obsidian_write_note.`,
      );
    }
    return fail(`obsidian_append_block not completed (${r.reason}).`);
  } catch (err) {
    return fail(`obsidian_append_block failed: ${String(err)}`);
  }
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
