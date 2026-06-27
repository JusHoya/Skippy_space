// load-env.ts — load the repo-root .env into process.env for the sidecar.
//
// `.env.example` declares the contract: "Tauri dev/build, the Node sidecar,
// OTel, and the infra/ docker stacks all read these. Keep this file the SINGLE
// source of truth." Nothing actually honored it for the sidecar: the Rust shell
// only FORWARDS vars already present in its own environment (sidecar.rs:356-360
// via std::env::var) and agent-runtime had no dotenv. So a developer with a
// perfectly valid .env still launched into a dead orchestrator —
// ANTHROPIC_API_KEY was unset in the child, claude.ts:41-42 threw on the first
// prompt, and skippy.ts flipped Skippy to agent_state:'error' (the
// "orchestrator stuck in error" symptom).
//
// This module closes that gap with a dependency-free loader. Crucially, an
// already-set var WINS — a real shell `export` or a value the Rust shell
// forwarded is never overridden — so .env is a fallback source of truth, not an
// override. That matches standard dotenv semantics and keeps the existing
// forwarding path authoritative when both are present.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface DotenvResult {
  /** The .env file we loaded, or null if none was found. */
  path: string | null;
  /** Keys we set (were previously unset/empty in process.env). */
  loaded: string[];
  /** Keys present in .env but left untouched because env already had them. */
  skipped: string[];
}

// Walk up from this module (works for both `dist/index.js` and the
// `tsx watch src/index.ts` dev path) until a `.env` is found. Mirrors the
// climb in vault-root.ts so the two never drift. `SKIPPY_ENV_FILE` overrides.
function locateEnvFile(): string | null {
  const explicit = process.env.SKIPPY_ENV_FILE;
  if (explicit) return existsSync(explicit) ? explicit : null;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// Minimal .env parser: `KEY=VALUE` per line, `#` comments and blank lines
// ignored, optional surrounding single/double quotes stripped, a leading
// `export ` tolerated. No variable interpolation — the file is the single
// source of truth and we keep values literal.
function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const body = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = body.indexOf('=');
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = body.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

export function loadDotenv(): DotenvResult {
  const file = locateEnvFile();
  const result: DotenvResult = { path: file, loaded: [], skipped: [] };
  if (!file) return result;
  let parsed: Record<string, string>;
  try {
    parsed = parseEnv(readFileSync(file, 'utf8'));
  } catch {
    return result;
  }
  for (const [key, val] of Object.entries(parsed)) {
    const existing = process.env[key];
    if (existing !== undefined && existing !== '') {
      result.skipped.push(key);
      continue;
    }
    process.env[key] = val;
    result.loaded.push(key);
  }
  return result;
}

// Run once, eagerly, on first import. index.ts imports this module FIRST so the
// repo .env populates process.env before logger/otel/modelRegistry (or any
// lazily-built Anthropic client) reads it.
export const dotenvResult: DotenvResult = loadDotenv();
