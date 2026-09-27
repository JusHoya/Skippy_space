# M0 Baseline (T00: Baseline and CI)

Recorded 2026-09-26 after the M0 targeted fix round 3 on branch `m0/foundation`.

## Branch / commit

- Measured on `m0/foundation` @ `4dba546` ("fix(git-autocommit): replace the scratch-tree filter proof with a fail-closed rule"). The commit that adds this file changes documentation only.
- Code baseline before M0: `7b17b70` (`main`); integration base `239aea7` (docs-only delta over `7b17b70`).
- All results below are from Windows 11 with `node_modules` installed via `pnpm install --frozen-lockfile`.

## Environment

| Tool | Version |
|---|---|
| OS | Windows 11 Home 10.0.26200 |
| Node | v24.18.0 |
| pnpm | 9.15.0 |
| rustc | 1.98.1 (48a229cea 2026-09-01) |
| cargo | 1.98.1 (797e8a9bc 2026-08-05) |
| git | 2.45.2.windows.1 (system config sets `core.symlinks=false`, `core.autocrlf=true`) |
| git-lfs | 3.5.1 (used by the autocommit LFS tests; they skip if git-lfs is absent) |
| tauri-cli | 2.11.1 |
| Bundled Claude CLI (via `@anthropic-ai/claude-agent-sdk` 0.3.162) | 2.1.162 |

## Command results

Every command was executed; none are assumed.

| Command | Result | Exit |
|---|---|---|
| `pnpm install --frozen-lockfile` | Pass; lockfile unchanged | 0 |
| `pnpm typecheck` | Pass. 6 packages have a `typecheck` script (otel, memory, shared, sprite-kit, ui, agent-runtime); pnpm reports "Scope: 7 of 8" because `apps/shell` is in scope but has no script | 0 |
| `pnpm lint` | Pass. 0 errors, 10 warnings (see below) | 0 |
| `pnpm -r test` | Pass. `packages/memory`: 189 tests, 187 pass, 2 skipped, 0 fail. `apps/agent-runtime`: 194 tests, 169 pass, 25 skipped, 0 fail | 0 |
| `SKIPPY_LIVE_CLI_MOCK=1 pnpm --filter @skippy/agent-runtime test` | Pass. 194 tests, 193 pass, 1 skipped (file-symlink case, EPERM). Runs the real bundled Claude CLI 2.1.162 against a local mock Anthropic API | 0 |
| `pnpm run test:scripts` | Pass. 66 tests, 65 pass, 1 skipped (`scripts/git-autocommit.test.mjs`) | 0 |
| `pnpm build:runtime` | Pass (tsup ESM, `apps/agent-runtime/dist/index.js`) | 0 |
| `pnpm --filter @skippy/ui build` | Pass (`tsc --noEmit && vite build`); existing >500 kB chunk-size warning, non-fatal | 0 |
| `cargo check --manifest-path apps/shell/src-tauri/Cargo.toml` | Pass, no warnings. Requires `pnpm build:runtime` first (tauri.conf.json resources glob on `agent-runtime/dist`) | 0 |
| `cargo test --manifest-path apps/shell/src-tauri/Cargo.toml` | Pass. 81 passed, 0 failed (git_autocommit, envelope, claude_spawn) | 0 |

Skipped tests:
- 2 in `packages/memory`: real file/dir symlink creation needs Developer Mode or SeCreateSymbolicLinkPrivilege. Junction tests cover the same reparse-point escape and pass.
- 25 in `apps/agent-runtime` without the flag: 24 opt-in live-CLI tests (`*.live-cli.test.ts`, enabled by `SKIPPY_LIVE_CLI_MOCK=1`; measured above, all passing) and 1 file-symlink test that needs Developer Mode.
- 1 in `scripts/git-autocommit.test.mjs`: the filtered real-symlink case needs symlink creation (Developer Mode); the Rust twin also skips here.

Test discovery: `packages/memory` and `apps/agent-runtime` glob `src/**/*.test.ts`, so new tests there are picked up automatically; `scripts/*.test.mjs` run via `test:scripts`. `apps/ui`, `packages/shared`, `packages/otel` and `packages/sprite-kit` have no `test` script, so tests added there would not run. The autocommit long-path and LFS tests skip themselves when the temp path is too long or git-lfs is missing; neither skipped here.

### Lint warnings (10, all pre-existing, 0 errors)

- `packages/shared/src/phase3prep.ts`: 1 unused import (`BoardIdSchema`); `@typescript-eslint/no-unused-vars` is `warn` repo-wide.
- `apps/ui` (GalleryTile.tsx, SceneRoot.tsx x2, projectTree.ts): 4 stale `no-console` disable directives.
- `apps/agent-runtime` (board.ts x2, warmpool.ts x3): 5 stale `require-await` disable directives.

typescript-eslint's recommended config deliberately disables core rules that `tsc` already reports (for example `no-const-assign`, `no-unreachable`); those surface through `pnpm typecheck`.

## CI (`.github/workflows/ci.yml`)

- Earlier runs failed at `pnpm/action-setup@v4` with "Multiple versions of pnpm specified" because the step set `version: 9` while `package.json` declares `packageManager: pnpm@9.15.0`. `gh run list` showed no successful run. The old ubuntu `rust` job had also failed, at `cargo test` with exit 101 (run 28278478351; its log has since expired). The explicit version is removed; the action now reads `packageManager`.
- `ts` job (ubuntu-latest): install → typecheck → lint → `pnpm -r test` → `test:scripts` → `build:runtime` → UI build.
- `windows` job (windows-latest): install → typecheck → lint → `pnpm -r test` → `test:scripts` → `build:runtime` → UI build → Rust toolchain + cache → `cargo check` → `cargo test`.
- Triggers: `push` to `main` and to `m0/foundation` (the pivot trunk), and `pull_request`.
- **First green run:** commit `3f70549`, 2026-09-27. Both the push run (36331998837) and the PR #1 run (36332001896) passed on both jobs: ubuntu-latest `ts` and windows-latest `windows`, Node 22. That run covered install, typecheck, lint, `pnpm -r test`, `test:scripts`, the runtime and UI builds, and `cargo check`/`cargo test` (81 passed). The Windows runner has symlink privilege, so the real-symlink tests that skip locally ran there.
- Getting there needed test-portability fixes: the runner's temp dir is an 8.3 short path (`RUNNER~1`), and some fixtures assumed Windows path semantics. No product behavior changed.
- Everything in CI is offline and mocked (Letta disabled, Obsidian unbound, no OTel exporter, no provider credentials). Live provider tests are opt-in and never part of CI.
- YAML parsed with `js-yaml`.

## Unrun checks

The following were **not** run. No claim is made beyond what is stated.

- **Local measurements are Windows 11 / Node 24.18.0 only.** Linux and Node 22 are covered by CI (see above), not by the local table.
- **Rust on Linux**: CI runs `cargo check`/`cargo test` only in the Windows job.
- **Lint coverage outside `src/`**: `pnpm lint` runs `eslint src` per package, so `scripts/*.mjs` (including the Node autocommit engine) and `tests/visual` are neither linted nor typechecked.
- **Playwright visual tests (`pnpm test:visual`)**: the last attempt failed 4/4 because the local browser cache was stale (`chromium_headless_shell-1223` missing). `pnpm exec playwright install` was not run (network download, out of scope).
- **Native PTY/sidecar/IPC/Channels tests**: need a running Tauri app. `cargo test` covers Rust unit tests only (git_autocommit, envelope, claude_spawn). Native desktop-boundary tests belong to T07/T17 (FR-OPS-03).
- **Tauri app startup, `tauri build`, installer and clean-install**: not run.
- **Rust clippy/rustfmt and a Prettier check**: not configured or run.
- **Live provider/API execution**: no credentials used. Tool-policy enforcement is proven with a mocked SDK, and, for the denial/credential cases, with the real bundled Claude CLI 2.1.162 against a local mock Anthropic API. There is no live Anthropic API run; PRD §6.2 still requires a live denied-write proof before an executor is qualified.
- **Live Letta, Obsidian REST, OTel/Langfuse**: exercised only through mocked or degraded paths.
- **UI behavior** (outcome tones, walker despawn on non-success outcomes, disabled Claude spawn slot): typecheck and build only; there is no UI test runner.
- **`memory-jobs.ts` wiring** of unsupported/rejected inbox drops to sidecars and `memory_job` events: typechecked and code-reviewed; the underlying primitives are unit-tested, the wiring itself is not.
- **`scripts/phase*-validate.mjs`**: fail with `pnpm.exe not found` (pre-existing environment issue).
