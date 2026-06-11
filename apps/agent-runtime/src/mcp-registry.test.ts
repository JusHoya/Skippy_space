// mcp-registry.test.ts — headless degradation tests for the D1+D4 MCP layer.
//
// Proves: (a) Obsidian + Letta tool handlers degrade to isError text when their
// service is offline (never throw); (b) the fs-backed obsidian_write_note works
// + enforces wikilinks; (c) letta_append_archival still mirrors to the board's
// agent_log.md even with Letta disabled (the durable D4 fallback); (d)
// buildMcpServers assembles the right servers from a charter and skips
// unimplemented ones. No live Obsidian/Letta/API key required.
//
// Run: node --import tsx --test src/mcp-registry.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ObsidianRestClient, LettaClient } from '@skippy/memory';

import {
  handleObsidianRead,
  handleObsidianSearch,
  handleObsidianWriteNote,
  handleLettaSearch,
  handleLettaAppend,
} from './mcp-handlers.js';
import { buildMcpServers } from './mcp-registry.js';
import type { Charter } from './charter.js';

// Force every backing service offline for the whole suite.
delete process.env.OBSIDIAN_API_KEY;
process.env.OBSIDIAN_API_URL = 'http://127.0.0.1:55555';
process.env.LETTA_DISABLED = '1';

function textOf(r: { content: { type: string; text?: string }[] }): string {
  return r.content.map((c) => c.text ?? '').join('');
}

async function tmpVault(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'skippy-mcp-'));
}

function mockCharter(mcpServers: string[]): Charter {
  return {
    agentId: 'board.research',
    frontmatter: {
      mcp_servers: mcpServers,
      memory: { letta_agent_id: 'bd_test_v1', vault_subdir: '50_Agents/research/' },
    },
    body: '# Research Captain\nTest charter.',
    loaded: true,
    path: '(mock)',
  };
}

test('obsidian tools degrade to isError when the vault is offline', async () => {
  const client = new ObsidianRestClient();
  const read = await handleObsidianRead(client, { path: '10_Atomic/x.md' });
  assert.equal(read.isError, true);
  const search = await handleObsidianSearch(client, { query: 'plasma' });
  assert.equal(search.isError, true);
});

test('obsidian_write_note writes via fs + enforces wikilinks', async () => {
  const vault = await tmpVault();
  const good = await handleObsidianWriteNote(vault, 'research', {
    path: '20_Topics/alpha.md',
    title: 'Alpha',
    body: 'A concept linking to [[beta]].',
    source: 'ref://test',
  });
  assert.notEqual(good.isError, true, textOf(good));
  assert.ok(
    await fs
      .access(path.join(vault, '20_Topics/alpha.md'))
      .then(() => true)
      .catch(() => false),
  );
  // Provenance: the note must be stamped with the real board id, not 'board.sdk'.
  const written = await fs.readFile(path.join(vault, '20_Topics/alpha.md'), 'utf8');
  assert.match(written, /authored_by:\s*board\.research/);
  // Relative .md link is rejected by the wikilink guard -> isError, no throw.
  const bad = await handleObsidianWriteNote(vault, 'research', {
    path: '20_Topics/bad.md',
    title: 'Bad',
    body: 'links to [other](./other.md)',
    source: 'ref://test',
  });
  assert.equal(bad.isError, true);
});

test('obsidian_write_note rejects path traversal + absolute paths + append-only targets', async () => {
  const vault = await tmpVault();
  // (1) Traversal escape — must be refused, nothing written outside the vault.
  const traversal = await handleObsidianWriteNote(vault, 'research', {
    path: '../escape.md',
    title: 'Escape',
    body: 'pwned',
    source: 'ref://test',
  });
  assert.equal(traversal.isError, true);
  assert.match(textOf(traversal), /escapes the vault/);
  assert.equal(
    await fs
      .access(path.join(vault, '..', 'escape.md'))
      .then(() => true)
      .catch(() => false),
    false,
    'no file should have escaped the vault',
  );

  // (2) Absolute path — also refused (path.resolve would otherwise discard root).
  const abs = await handleObsidianWriteNote(vault, 'research', {
    path: path.join(os.tmpdir(), 'skippy-abs-escape.md'),
    title: 'Abs',
    body: 'pwned',
    source: 'ref://test',
  });
  assert.equal(abs.isError, true);
  assert.match(textOf(abs), /escapes the vault/);

  // (3) Append-only agent_log.md — refused, directed to the append tools.
  const log = await handleObsidianWriteNote(vault, 'research', {
    path: '50_Agents/research/agent_log.md',
    title: 'Clobber',
    body: 'overwrite the audit log',
    source: 'ref://test',
  });
  assert.equal(log.isError, true);
  assert.match(textOf(log), /append-only/);

  // (4) Append-only 40_Daily/ tree — refused.
  const daily = await handleObsidianWriteNote(vault, 'research', {
    path: '40_Daily/2026-06-10.md',
    title: 'Daily',
    body: 'clobber the daily note',
    source: 'ref://test',
  });
  assert.equal(daily.isError, true);
  assert.match(textOf(daily), /append-only/);

  // (5) Append-only guard must check the RESOLVED path, not the raw arg — a
  // traversal-laced target like `x/../40_Daily/note.md` passes containment
  // (resolves inside the vault) and must STILL be refused as append-only.
  const sneaky = await handleObsidianWriteNote(vault, 'research', {
    path: 'x/../40_Daily/2026-06-10.md',
    title: 'Sneaky daily clobber',
    body: 'evade the append-only guard via traversal',
    source: 'ref://test',
  });
  assert.equal(sneaky.isError, true);
  assert.match(textOf(sneaky), /append-only/);

  // (6) A normal relative path under the vault is still accepted.
  const okWrite = await handleObsidianWriteNote(vault, 'research', {
    path: '10_Atomic/fact.md',
    title: 'Fact',
    body: 'A contained note with a [[link]].',
    source: 'ref://test',
  });
  assert.notEqual(okWrite.isError, true, textOf(okWrite));
});

test('letta tools degrade when Letta is disabled; append still mirrors to vault', async () => {
  const vault = await tmpVault();
  const client = new LettaClient();
  const search = await handleLettaSearch(client, 'bd_test_v1', { query: 'anything' });
  assert.equal(search.isError, true);

  // append: Letta is disabled, but the durable vault mirror must succeed.
  const appended = await handleLettaAppend(client, 'bd_test_v1', 'research', vault, {
    text: 'The exit-gate remembers this.',
  });
  assert.notEqual(appended.isError, true, textOf(appended));
  const logPath = path.join(vault, '50_Agents', 'research', 'agent_log.md');
  const log = await fs.readFile(logPath, 'utf8');
  assert.match(log, /The exit-gate remembers this\./);
  assert.match(log, /type:\s*agent_log/);
});

test('buildMcpServers assembles obsidian+letta and skips unimplemented servers', async () => {
  const vault = await tmpVault();
  const servers = await buildMcpServers(mockCharter(['obsidian', 'letta']), vault);
  assert.ok('obsidian' in servers, 'obsidian server present');
  assert.ok('letta' in servers, 'letta server present');
  // SDK in-process servers carry a live instance.
  assert.ok('instance' in (servers.obsidian as Record<string, unknown>));
  assert.ok('instance' in (servers.letta as Record<string, unknown>));

  const onlyKnown = await buildMcpServers(mockCharter(['obsidian', 'github', 'playwright']), vault);
  assert.deepEqual(Object.keys(onlyKnown), ['obsidian']);
});
