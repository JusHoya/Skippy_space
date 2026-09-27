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
//
// TOOL AUTHORITY (T02, FR-SEC-01): every tool handler dispatches through the
// policy broker (`authorizeMcpDispatch`) BEFORE the handler runs, and only the
// servers on the charter-derived policy allowlist are built. A denied dispatch
// returns isError text and the handler is never invoked. The broker is
// mandatory — there is no unbrokered constructor.

import { z } from 'zod';
import { createSdkMcpServer, tool, type McpServerConfig } from '@anthropic-ai/claude-agent-sdk';

import { ObsidianRestClient, LettaClient } from '@skippy/memory';

import type { Charter } from './charter.js';
import { logger } from './logger.js';
import {
  ToolPolicyError,
  authorizeMcpDispatch,
  derivePolicy,
  type ExecutionPolicy,
  type SdkEnforcementHooks,
} from './tool-policy.js';
import {
  handleLettaAppend,
  handleLettaEditCore,
  handleLettaSearch,
  handleObsidianAppendBlock,
  handleObsidianPatchFrontmatter,
  handleObsidianRead,
  handleObsidianSearch,
  handleObsidianWriteNote,
  type McpToolResult,
} from './mcp-handlers.js';

/** The policy + enforcement hooks every MCP dispatch is checked against. */
export interface McpBroker {
  readonly policy: ExecutionPolicy;
  readonly hooks?: SdkEnforcementHooks;
}

/**
 * Wrap a tool handler so the broker authorizes the dispatch first. Exported for
 * the regression tests; mcp-registry builds every tool through it.
 */
export function brokered<A extends Record<string, unknown>>(
  broker: McpBroker,
  server: string,
  tool: string,
  run: (args: A) => Promise<McpToolResult>,
): (args: A) => Promise<McpToolResult> {
  return async (args: A) => {
    const decision = await authorizeMcpDispatch(broker.policy, server, tool, args, broker.hooks ?? {});
    if (!decision.allow) {
      logger.warn({
        msg: 'MCP dispatch denied by tool policy',
        agent: broker.policy.agentId,
        tool: `${server}.${tool}`,
        code: decision.code,
      });
      return {
        content: [{ type: 'text', text: `Denied by Skippy tool policy (${decision.code}): ${decision.reason}` }],
        isError: true,
      };
    }
    return run(args);
  };
}

/** Read the charter's `mcp_servers:` array (kept as raw strings by charter.ts). */
export function requestedMcpServers(charter: Charter): string[] {
  const raw = charter.frontmatter['mcp_servers'];
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * Build the in-process Obsidian MCP server. Reads/search may use the WS2
 * ObsidianRestClient (live index, read-only); EVERY write tool (write_note,
 * patch_frontmatter, append_block) goes through the local VaultBroker, never
 * REST (M0 red-team E3-3). Every tool degrades to isError text when
 * Obsidian/the vault is offline or a write is refused.
 */
export function buildObsidianServer(vaultRoot: string, broker: McpBroker): McpServerConfig {
  const client = new ObsidianRestClient();
  const b = <A extends Record<string, unknown>>(name: string, run: (args: A) => Promise<McpToolResult>) =>
    brokered<A>(broker, 'obsidian', name, run);
  return createSdkMcpServer({
    name: 'obsidian',
    version: '0.1.0',
    tools: [
      tool(
        'obsidian_read_note',
        'Read a vault note (raw markdown incl. frontmatter) by its vault-relative path, e.g. "10_Atomic/x.md". For .md notes the first line is "sha256: <hash>" — pass it as expected_hash when editing.',
        { path: z.string() },
        b('obsidian_read_note', (args) => handleObsidianRead(client, args, vaultRoot)),
      ),
      tool(
        'obsidian_search',
        'Search the vault for notes matching a query (uses the live Obsidian index / Smart Connections). Returns matched paths with scores.',
        { query: z.string(), limit: z.number().int().positive().optional() },
        b('obsidian_search', (args) => handleObsidianSearch(client, args)),
      ),
      tool(
        'obsidian_patch_frontmatter',
        'Replace a single frontmatter field on an existing (non agent_log/daily) note, compare-and-swap: expected_hash is the sha256 from obsidian_read_note; a mismatch is a conflict. key must be lowercase snake_case and not id/created_at/updated_at/type. value is parsed as JSON when valid (numbers, booleans, null, arrays), otherwise used as a string.',
        { path: z.string(), key: z.string(), value: z.string(), expected_hash: z.string() },
        b('obsidian_patch_frontmatter', (args) => handleObsidianPatchFrontmatter(vaultRoot, args)),
      ),
      tool(
        'obsidian_append_block',
        'Append a markdown block to the end of an EXISTING agent_log or daily note (append-only; never creates a note — use obsidian_write_note).',
        { path: z.string(), markdown: z.string() },
        b('obsidian_append_block', (args) => handleObsidianAppendBlock(vaultRoot, args)),
      ),
      tool(
        'obsidian_write_note',
        'Create a vault note atomically (frontmatter + body) at a vault-relative .md path. To edit an existing note, pass expected_hash (the sha256 of the version you read); a mismatch is a conflict. id/created_at are preserved; agent_log/daily notes are append-only. Wikilinks only — relative .md links are rejected.',
        {
          path: z.string(),
          title: z.string(),
          body: z.string(),
          type: z.string().optional(),
          source: z.string().optional(),
          expected_hash: z.string().optional(),
        },
        b('obsidian_write_note', (args) => handleObsidianWriteNote(vaultRoot, args)),
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
export function buildLettaServer(
  charter: Charter,
  vaultRoot: string,
  broker: McpBroker,
): McpServerConfig | null {
  const b = lettaBindings(charter);
  const g = <A extends Record<string, unknown>>(name: string, run: (args: A) => Promise<McpToolResult>) =>
    brokered<A>(broker, 'letta', name, run);
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
        g('letta_search_archival', (args) => handleLettaSearch(client, b.agentId, args)),
      ),
      tool(
        'letta_append_archival',
        'Append a durable memory to this board\'s archival store (also mirrored to its vault agent log).',
        { text: z.string() },
        g('letta_append_archival', (args) => handleLettaAppend(client, b.agentId, b.board, vaultRoot, args)),
      ),
      tool(
        'letta_edit_core',
        'Edit a core-memory block (e.g. persona/human) for this board.',
        { block: z.string(), value: z.string() },
        g('letta_edit_core', (args) => handleLettaEditCore(client, b.agentId, args)),
      ),
    ],
  });
}

/**
 * Assemble the MCP servers a board should run, per its charter `mcp_servers:`.
 * Implemented: `obsidian` (D1) + `letta` (D4). Unimplemented names (github,
 * playwright, …) are skipped with a warn so a charter listing them can never
 * wedge a mission.
 *
 * Authority: servers are built only from the charter-derived policy allowlist,
 * and every tool dispatches through the broker. When no policy is passed it is
 * derived from the charter with NO filesystem roots (MCP tools are vault-scoped
 * by the broker; the sidecar's ambient cwd is never a root — red-team N2). A
 * charter whose policy cannot be derived (invalid/unknown authority field,
 * bypass request, placeholder) gets NO servers — fail closed.
 */
export async function buildMcpServers(
  charter: Charter,
  vaultRoot: string,
  broker?: McpBroker,
): Promise<Record<string, McpServerConfig>> {
  let effective: McpBroker;
  if (broker) {
    effective = broker;
  } else {
    try {
      effective = { policy: derivePolicy(charter, {}) };
    } catch (err) {
      logger.warn({
        msg: 'tool policy could not be derived; building no MCP servers (fail closed)',
        agent: charter.agentId,
        code: err instanceof ToolPolicyError ? err.code : 'unknown',
        err: String(err),
      });
      return {};
    }
  }
  const requested = requestedMcpServers(charter).filter((name) => effective.policy.mcpServers.includes(name));
  const servers: Record<string, McpServerConfig> = {};

  for (const name of requested) {
    switch (name) {
      case 'obsidian':
        servers.obsidian = buildObsidianServer(vaultRoot, effective);
        break;
      case 'letta': {
        const letta = buildLettaServer(charter, vaultRoot, effective);
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
