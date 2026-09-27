# M0 Baseline (T00: Baseline and CI)

Recorded 2026-09-26 after the M0 targeted fix round 3 on branch `m0/foundation`.

## Branch / commit

- Measured on `m0/foundation` @ `1bcdc39` ("test(tool-authority): remove temp dirs reliably on Windows in the policy/rt4/rtf2 suites"). The commit that adds this file changes documentation only.
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
| git | 2.45.2.windows.1 |
| tauri-cli | 2.11.1 |
| Bundled Claude CLI (via `@anthropic-ai/claude-agent-sdk` 0.3.162) | 2.1.162 |

## Command results

Every command was executed; none are assumed.

| Command | Result | Exit |
|---|---|---|
| `pnpm install --frozen-lockfile` | Pass; lockfile unchanged | 0 |
| `pnpm typecheck` | Pass. 6 packages have a `typecheck` script (otel, memory, shared, sprite-kit, ui, agent-runtime); pnpm reports "Scope: 7 of 8" because `apps/shell` is in scope but has no script | 0 |
| `pnpm lint` | Pass. 0 errors, 10 warnings (see below) | 0 |
| `pnpm -r test` | Pass. `packages/memory`: 166 tests, 164 pass, 2 skipped, 0 fail. `apps/agent-runtime`: 141 tests, 131 pass, 10 skipped, 0 fail | 0 |
| `pnpm run test:scripts` | Pass. 50/50 (`scripts/git-autocommit.test.mjs`) | 0 |
| `pnpm build:runtime` | Pass (tsup ESM, `apps/agent-runtime/dist/index.js`) | 0 |
| `pnpm --filter @skippy/ui build` | Pass (`tsc --noEmit && vite build`); existing >500 kB chunk-size warning, non-fatal | 0 |
| `cargo check --manifest-path apps/shell/src-tauri/Cargo.toml` | Pass, no warnings. Requires `pnpm build:runtime` first (tauri.conf.json resources glob on `agent-runtime/dist`) | 0 |
| `cargo test --manifest-path apps/shell/src-tauri/Cargo.toml` | Pass. 65 passed, 0 failed (git_autocommit, envelope, claude_spawn) | 0 |

Skipped tests:
- 2 in `packages/memory`: real file/dir symlink creation needs Developer Mode or SeCreateSymbolicLinkPrivilege. Junction tests cover the same reparse-point escape and pass.
- 10 in `apps/agent-runtime` (`sdk-board.live-cli.test.ts`, `tool-authority-rtf2.live-cli.test.ts`): opt-in with `SKIPPY_LIVE_CLI_MOCK=1`. They run the real bundled Claude CLI against a local mock Anthropic API. The implementing agents ran them enabled, all passing; they were not enabled for this measurement.

Test discovery: package `test` scripts glob `src/**/*.test.ts`, so new tests are picked up automatically. `scripts/*.test.mjs` run via `test:scripts`.

### Lint warnings (10, all pre-existing, 0 errors)

- `packages/shared/src/phase3prep.ts`: 1 unused import (`BoardIdSchema`); `@typescript-eslint/no-unused-vars` is `warn` repo-wide.
- `apps/ui` (GalleryTile.tsx, SceneRoot.tsx x2, projectTree.ts): 4 stale `no-console` disable directives.
- `apps/agent-runtime` (board.ts x2, warmpool.ts x3): 5 stale `require-await` disable directives.

typescript-eslint's recommended config deliberately disables core rules that `tsc` already reports (for example `no-const-assign`, `no-unreachable`); those surface through `pnpm typecheck`.

## CI (`.github/workflows/ci.yml`)

- Earlier runs failed at `pnpm/action-setup@v4` with "Multiple versions of pnpm specified" because the step set `version: 9` while `package.json` declares `packageManager: pnpm@9.15.0`. `gh run list` showed no successful run. The explicit version is removed; the action now reads `packageManager`.
- `ts` job (ubuntu-latest): install → typecheck → lint → `pnpm -r test` → `test:scripts` → `build:runtime` → UI build.
- `windows` job (windows-latest): install → typecheck → lint → `pnpm -r test` → `test:scripts` → `build:runtime` → UI build → Rust toolchain + cache → `cargo check` → `cargo test`.
- Triggers: `push` to `main` and `pull_request`. The workflow does not run for a push to `m0/foundation` alone; it runs when a PR is opened.
- Everything in CI is offline and mocked (Letta disabled, Obsidian unbound, no OTel exporter, no provider credentials). Live provider tests are opt-in and never part of CI.
- YAML parsed with `js-yaml`.

## Unrun checks

The following were **not** run. No claim is made beyond what is stated.

- **GitHub CI for this branch**: not executed. The fixed workflow will first run when a PR is opened.
- **Linux execution**: the `ts` job targets ubuntu-latest; no Linux run has happened locally or on GitHub. All results above are Windows 11 only.
- **Playwright visual tests (`pnpm test:visual`)**: the last attempt failed 4/4 because the local browser cache was stale (`chromium_headless_shell-1223` missing). `pnpm exec playwright install` was not run (network download, out of scope).
- **Native PTY/sidecar/IPC/Channels tests**: need a running Tauri app. `cargo test` covers Rust unit tests only (git_autocommit, envelope, claude_spawn). Native desktop-boundary tests belong to T07/T17 (FR-OPS-03).
- **Tauri app startup, `tauri build`, installer and clean-install**: not run.
- **Rust clippy/rustfmt and a Prettier check**: not configured or run.
- **Live provider/API execution**: no credentials used. Tool-policy enforcement is proven with a mocked SDK, and, for the denial/credential cases, with the real bundled Claude CLI 2.1.162 against a local mock Anthropic API. There is no live Anthropic API run; PRD §6.2 still requires a live denied-write proof before an executor is qualified.
- **Live Letta, Obsidian REST, OTel/Langfuse**: exercised only through mocked or degraded paths.
- **UI behavior** (outcome tones, walker despawn on non-success outcomes, disabled Claude spawn slot): typecheck and build only; there is no UI test runner.
- **`memory-jobs.ts` wiring** of unsupported/rejected inbox drops to sidecars and `memory_job` events: typechecked and code-reviewed; the underlying primitives are unit-tested, the wiring itself is not.
- **`scripts/phase*-validate.mjs`**: fail with `pnpm.exe not found` (pre-existing environment issue).
