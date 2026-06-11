// sdk-board.test.ts — charter-driven permission mapping for the gated SDK board.
//
// Proves the safety contract: the charter's `permission_mode` drives the SDK
// permissionMode, `ask` never silently becomes `bypassPermissions`, and bypass
// is only ever reached through the explicit SKIPPY_BYPASS_PERMISSIONS opt-in.
// Also proves MCP tools stay auto-approved via the allowedTools list.
//
// Run: node --import tsx --test src/sdk-board.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolvePermissionMode, buildAllowedTools } from './sdk-board.js';

function withBypassEnv<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env.SKIPPY_BYPASS_PERMISSIONS;
  if (value === undefined) delete process.env.SKIPPY_BYPASS_PERMISSIONS;
  else process.env.SKIPPY_BYPASS_PERMISSIONS = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.SKIPPY_BYPASS_PERMISSIONS;
    else process.env.SKIPPY_BYPASS_PERMISSIONS = prev;
  }
}

test('charter "ask" maps to acceptEdits (never bypass) in a headless run', () => {
  withBypassEnv(undefined, () => {
    assert.equal(resolvePermissionMode('research', 'ask'), 'acceptEdits');
  });
  // Even with the bypass opt-in set, an `ask` charter does NOT escalate.
  withBypassEnv('1', () => {
    assert.equal(resolvePermissionMode('research', 'ask'), 'acceptEdits');
  });
});

test('charter "acceptEdits"/"plan" pass through verbatim', () => {
  withBypassEnv(undefined, () => {
    assert.equal(resolvePermissionMode('coding', 'acceptEdits'), 'acceptEdits');
    assert.equal(resolvePermissionMode('coding', 'plan'), 'plan');
  });
});

test('charter "bypassPermissions" requires the SKIPPY_BYPASS_PERMISSIONS opt-in', () => {
  // Without the opt-in: refuse to widen, fall back to acceptEdits.
  withBypassEnv(undefined, () => {
    assert.equal(resolvePermissionMode('devops', 'bypassPermissions'), 'acceptEdits');
  });
  withBypassEnv('0', () => {
    assert.equal(resolvePermissionMode('devops', 'bypassPermissions'), 'acceptEdits');
  });
  // With the explicit opt-in: honored.
  withBypassEnv('1', () => {
    assert.equal(resolvePermissionMode('devops', 'bypassPermissions'), 'bypassPermissions');
  });
});

test('buildAllowedTools keeps MCP tools available alongside charter tools', () => {
  const allowed = buildAllowedTools(['Read', 'Edit'], ['obsidian', 'letta']);
  assert.deepEqual(allowed, ['Read', 'Edit', 'mcp__obsidian', 'mcp__letta']);
});

test('buildAllowedTools auto-approves MCP tools even when the charter lists none', () => {
  const allowed = buildAllowedTools(undefined, ['obsidian']);
  assert.deepEqual(allowed, ['mcp__obsidian']);
});

test('buildAllowedTools returns undefined when there is nothing to allow', () => {
  assert.equal(buildAllowedTools(undefined, []), undefined);
  assert.equal(buildAllowedTools([], []), undefined);
});
