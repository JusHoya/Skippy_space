#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const sh = (cmd) => execSync(cmd, { cwd: repoRoot, encoding: 'utf8' });

function hasVaultChanges() {
  return sh('git status --porcelain vault/').trim().length > 0;
}
function commitOnce() {
  if (!hasVaultChanges()) return false;
  sh('git add vault/');
  const ts = new Date().toISOString();
  sh(`git commit -m "chore(vault): auto-commit ${ts}"`);
  return true;
}

const arg = process.argv[2] ?? '--once';
if (arg === '--once') {
  try { commitOnce(); } catch (e) { console.error(e.message); }
} else {
  const ms = (parseInt((arg.match(/--interval=(\d+)/)?.[1] ?? '300'), 10)) * 1000;
  setInterval(() => { try { commitOnce(); } catch (e) { console.error(e.message); } }, ms);
  console.error(`auto-commit running every ${ms/1000}s`);
}
