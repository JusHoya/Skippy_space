// load-env.test.ts — lock in the dotenv loader contract: .env is a FALLBACK
// source (existing env always wins), parsing tolerates comments/quotes/export,
// and a missing file is a no-op. This is the gate that the
// "orchestrator-stuck-in-error" regression cannot silently come back through.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { loadDotenv } from './load-env.js';

function withEnvFile(contents: string, fn: () => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'skippy-env-'));
  const file = path.join(dir, '.env');
  writeFileSync(file, contents, 'utf8');
  const prev = process.env.SKIPPY_ENV_FILE;
  process.env.SKIPPY_ENV_FILE = file;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.SKIPPY_ENV_FILE;
    else process.env.SKIPPY_ENV_FILE = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('sets a previously-unset key from .env', () => {
  delete process.env.__SKIPPY_LE_A;
  withEnvFile('__SKIPPY_LE_A=hello\n', () => {
    const r = loadDotenv();
    assert.equal(process.env.__SKIPPY_LE_A, 'hello');
    assert.ok(r.loaded.includes('__SKIPPY_LE_A'));
  });
  delete process.env.__SKIPPY_LE_A;
});

test('does NOT override an already-set env var (existing wins)', () => {
  process.env.__SKIPPY_LE_B = 'from-shell';
  withEnvFile('__SKIPPY_LE_B=from-dotenv\n', () => {
    const r = loadDotenv();
    assert.equal(process.env.__SKIPPY_LE_B, 'from-shell');
    assert.ok(r.skipped.includes('__SKIPPY_LE_B'));
    assert.ok(!r.loaded.includes('__SKIPPY_LE_B'));
  });
  delete process.env.__SKIPPY_LE_B;
});

test('ignores comments/blank lines, strips quotes, tolerates `export `', () => {
  delete process.env.__SKIPPY_LE_C;
  delete process.env.__SKIPPY_LE_D;
  delete process.env.__SKIPPY_LE_E;
  withEnvFile(
    [
      '# a comment',
      '',
      '  __SKIPPY_LE_C = "quoted value" ',
      "export __SKIPPY_LE_D='single'",
      '__SKIPPY_LE_E=bare',
    ].join('\n'),
    () => {
      loadDotenv();
      assert.equal(process.env.__SKIPPY_LE_C, 'quoted value');
      assert.equal(process.env.__SKIPPY_LE_D, 'single');
      assert.equal(process.env.__SKIPPY_LE_E, 'bare');
    },
  );
  delete process.env.__SKIPPY_LE_C;
  delete process.env.__SKIPPY_LE_D;
  delete process.env.__SKIPPY_LE_E;
});

test('missing env file is a no-op (path null, nothing loaded)', () => {
  const prev = process.env.SKIPPY_ENV_FILE;
  process.env.SKIPPY_ENV_FILE = path.join(tmpdir(), 'definitely-not-here-12345', '.env');
  try {
    const r = loadDotenv();
    assert.equal(r.path, null);
    assert.equal(r.loaded.length, 0);
  } finally {
    if (prev === undefined) delete process.env.SKIPPY_ENV_FILE;
    else process.env.SKIPPY_ENV_FILE = prev;
  }
});
