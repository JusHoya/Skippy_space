// mcp-registry.ts — builds the per-board MCP servers wired into the gated SDK
// board path (PRD §8.9 D1 + §5.2 D4). Phase 3.5.
//
// `buildMcpServers(charter, vaultRoot)` reads the board's `mcp_servers:`
// frontmatter array and constructs an in-process SDK MCP server for each one we
// implement (currently `obsidian`; `letta` is added in WS-E). The result drops
// straight into `query({ options: { mcpServers } })` in sdk-board.ts.
//
// ZOD SCOPING: this is the ONLY agent-runtime module that constructs zod schemas.
// It imports zod from agent-runtime's OWN zod@4 (`from 'zod'`) so the schemas
// match the SDK's bundled zod v4 raw-shape contract. @skippy/shared + @skippy/memory
// stay on zod@3; we never import or pass a zod schema object across that boundary
// (only data + the {ok}-result types). Two zod majors coexist under pnpm.

import { z } from 'zod';
import { createSdkMcpServer, tool, type McpServerConfig } from '@anthropic-ai/claude-agent-sdk';

import { ObsidianRestClient, LettaClient } from '@skippy/memory';

import type { Charter } from './charter.js';
import { logger } from './logger.js';
import {
  handleLettaAppend,
  handleLettaEditCore,
  handleLettaSearch,
  handleObsidianAppendBlock,
  handleObsidianPatchFrontmatter,
  handleObsidianRead,
  handleObsidianSearch,
  handleObsidianWriteNote,
} from './mcp-handlers.js';

/** Read the charter's `mcp_servers:` array (kept as raw strings by charter.ts). */
export function requestedMcpServers(charter: Charter): string[] {
  const raw = charter.frontmatter['mcp_servers'];
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
}

/** The short board id (e.g. `research`) used to stamp note provenance
 * (`authored_by: board.<id>`). Strips the `board.` / `staff.` agent-id prefix. */
function boardIdOf(charter: Charter): string {
  const id = charter.agentId;
  if (id.startsWith('board.')) return id.slice('board.'.length);
  if (id.startsWith('staff.')) return id.slice('staff.'.length);
  return id;
}

/**
 * Build the in-process Obsidian MCP server: surgical edits + search backed by the
 * WS2 ObsidianRestClient (live index) and atomic fs writes. Every tool degrades
 * to isError text when Obsidian/the vault is offline. `boardId` is threaded into
 * `obsidian_write_note` so notes are stamped `authored_by: board.<id>` (real
 * provenance, not a generic `board.sdk`).
 */
export function buildObsidianServer(vaultRoot: string, boardId: string): McpServerConfig {
  const client = new ObsidianRestClient();
  return createSdkMcpServer({
    name: 'obsidian',
    version: '0.1.0',
    tools: [
      tool(
        'obsidian_read_note',
        'Read a vault note (raw markdown incl. frontmatter) by its vault-relative path, e.g. "10_Atomic/x.md".',
        { path: z.string() },
        (args) => handleObsidianRead(client, args),
      ),
      tool(
        'obsidian_search',
        'Search the vault for notes matching a query (uses the live Obsidian index / Smart Connections). Returns matched paths with scores.',
        { query: z.string(), limit: z.number().int().positive().optional() },
        (args) => handleObsidianSearch(client, args),
      ),
      tool(
        'obsidian_patch_frontmatter',
        'Replace a single frontmatter field on an existing note in place.',
        { path: z.string(), key: z.string(), value: z.string() },
        (args) => handleObsidianPatchFrontmatter(client, args),
      ),
      tool(
        'obsidian_append_block',
        'Append a markdown block to the end of a note (append-only).',
        { path: z.string(), markdown: z.string() },
        (args) => handleObsidianAppendBlock(client, args),
      ),
      tool(
        'obsidian_write_note',
        'Create or overwrite a vault note atomically (frontmatter + body). Wikilinks only — relative .md links are rejected.',
        {
          path: z.string(),
          title: z.string(),
          body: z.string(),
          type: z.string().optional(),
          source: z.string().optional(),
        },
        (args) => handleObsidianWriteNote(vaultRoot, boardId, args),
      ),
    ],
  });
}

/** Pull the board's Letta binding (letta_agent_id) + short board id from the
 * charter's nested `memory:` stanza. Returns null when no agent id is declared. */
function lettaBindings(charter: Charter): { agentId: string; board: string } | null {
  const mem = charter.frontmatter['memory'];
  const agentId =
    mem && typeof mem === 'object' && 'letta_agent_id' in mem
      ? String((mem as Record<string, unknown>).letta_agent_id)
      : '';
  if (!agentId) return null;
  const board = charter.agentId.startsWith('board.')
    ? charter.agentId.slice('board.'.length)
    : charter.agentId;
  return { agentId, board };
}

/**
 * Build the in-process Letta MCP server (D4): archival search/append + core-memory
 * edit, each bound to this board's `letta_agent_id`. `letta_append_archival` also
 * mirrors to the board's vault agent_log.md (the durable record). Every tool
 * degrades to isError text when Letta is down/disabled.
 */
export function buildLettaServer(charter: Charter, vaultRoot: string): McpServerConfig | null {
  const b = lettaBindings(charter);
  if (!b) {
    logger.warn({ msg: 'charter requests letta but declares no letta_agent_id; skipping', agent: charter.agentId });
    return null;
  }
  const client = new LettaClient();
  return createSdkMcpServer({
    name: 'letta',
    version: '0.1.0',
    tools: [
      tool(
        'letta_search_archival',
        'Search this board\'s long-term archival memory for relevant past facts/decisions.',
        { query: z.string(), limit: z.number().int().positive().optional() },
        (args) => handleLettaSearch(client, b.agentId, args),
      ),
      tool(
        'letta_append_archival',
        'Append a durable memory to this board\'s archival store (also mirrored to its vault agent log).',
        { text: z.string() },
        (args) => handleLettaAppend(client, b.agentId, b.board, vaultRoot, args),
      ),
      tool(
        'letta_edit_core',
        'Edit a core-memory block (e.g. persona/human) for this board.',
        { block: z.string(), value: z.string() },
        (args) => handleLettaEditCore(client, b.agentId, args),
      ),
    ],
  });
}

/**
 * Assemble the MCP servers a board should run, per its charter `mcp_servers:`.
 * Implemented: `obsidian` (D1) + `letta` (D4). Unimplemented names (github,
 * playwright, …) are skipped with a warn so a charter listing them can never
 * wedge a mission.
 */
export async function buildMcpServers(
  charter: Charter,
  vaultRoot: string,
): Promise<Record<string, McpServerConfig>> {
  const requested = requestedMcpServers(charter);
  const servers: Record<string, McpServerConfig> = {};

  for (const name of requested) {
    switch (name) {
      case 'obsidian':
        servers.obsidian = buildObsidianServer(vaultRoot, boardIdOf(charter));
        break;
      case 'letta': {
        const letta = buildLettaServer(charter, vaultRoot);
        if (letta) servers.letta = letta;
        break;
      }
      default:
        logger.warn({
          msg: 'charter requests an MCP server that is not implemented; skipping',
          server: name,
          agent: charter.agentId,
        });
    }
  }

  return Promise.resolve(servers);
}
