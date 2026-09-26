# M0 Baseline — WS-A (T00: Baseline and CI)

Recorded 2026-09-26 while refreshing M0 baseline on branch `m0/foundation`.

## Branch / commit

- Current branch: `m0/foundation` @ commit `565e4ab` ("fix(memory): close M0 red-team E3-2/E4-1..8 in the ingest pipeline (FR-WIKI-03, FR-SEC-02, G0)")
- All recorded tests executed on this branch with node_modules installed.

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

## Baseline command results (this worktree, recorded 2026-09-26)

All commands were actually executed; none are assumed.

| Command | Result | Exit code |
|---|---|---|
| `pnpm typecheck` | Pass — 7/7 packages (`tsc -b`/`tsc --noEmit`), 0 errors | 0 |
| `pnpm lint` | Pass — exit 0. ESLint run per-package: 1 warning (unused import `BoardIdSchema`), 17 stale `eslint-disable` directive warnings, 0 errors. `apps/shell` excluded (no TS src). Verified lint flags injected errors correctly. | 0 |
| `pnpm -r test` | Pass — `packages/memory` 124 tests: 122 pass, 2 skipped (symlink creation needs Developer Mode; junctions cover the reparse escape); `apps/agent-runtime` 73 tests: 73 pass, 0 skipped. Total: 195 pass, 2 skipped, 0 fail. | 0 |
| `pnpm run test:scripts` | Pass — 17/17 tests (git-autocommit.mjs coverage), all pass, 0 fail, 0 skipped. | 0 |
| `pnpm build:runtime` | Pass — tsup ESM build to `apps/agent-runtime/dist/index.js` (117.69 KB), done in 22ms. | 0 |
| `pnpm --filter @skippy/ui build` | Pass — `tsc --noEmit && vite build`; 835 modules transformed; output to `apps/ui/dist/`. Chunk size warning on `index-CJafzSzb.js` (877.32 kB gzip 251.40 kB, >500 kB threshold); non-fatal, noted in vite output. | 0 |
| `cargo check --manifest-path apps/shell/src-tauri/Cargo.toml` | Pass — `Finished `dev` profile [unoptimized + debuginfo] target(s) in 3.54s`. Requires `pnpm build:runtime` to run first (tauri.conf.json resource glob). | 0 |
| `cargo test --manifest-path apps/shell/src-tauri/Cargo.toml` | Pass — `lib.rs` 19 pass/0 fail; `main.rs` 0 tests; doc-tests 0 tests. Total cargo test: 19 pass, 0 fail, 0 ignored, duration 2.05s. | 0 |

### Lint findings (18 warnings total, 0 errors; exit 0)

- `packages/shared/src/phase3prep.ts:15` — 1 warning: unused import `BoardIdSchema` (@typescript-eslint/no-unused-vars).
- `packages/memory/src/vault-watcher.ts` — 7 warnings: stale `eslint-disable-next-line` directives for `no-console` (lines 128, 133, 142, 152, 169, 195, 200). Rules no longer fire under the flat config.
- `apps/agent-runtime/src/board.ts` — 2 warnings: stale directives for `@typescript-eslint/require-await` (lines 213, 480).
- `apps/agent-runtime/src/warmpool.ts` — 3 warnings: stale directives for `@typescript-eslint/require-await` (lines 27, 35, 48).
- `apps/ui/src/gallery/GalleryTile.tsx` — 1 warning: stale directive for `no-console` (line 74).
- `apps/ui/src/scene/SceneRoot.tsx` — 2 warnings: stale directives for `no-console` (lines 170, 568).
- `apps/ui/src/scene/projectTree.ts` — 1 warning: stale directive for `no-console` (line 242).

All are stale `eslint-disable` comments for rules that no longer fire. `@typescript-eslint/no-unused-vars` is configured `warn` (not `error`) repo-wide; this is why the unused-import finding does not fail the build. ESLint verification (injected test file with real error) confirmed lint is working correctly.

### Lint rule note (why some intentional "errors" didn't fire)

Injected test cases for `no-const-assign` and `no-unreachable` did **not** get flagged, because `typescript-eslint`'s recommended config disables core ESLint rules that the TypeScript compiler itself already reports as compile errors (confirmed via `eslint --print-config`, which shows `no-const-assign: [0]` and `no-unreachable: [0]`). This is expected typescript-eslint behavior, not a gap in the lint config — those errors would surface via `tsc`/`pnpm typecheck` instead.

## CI (`.github/workflows/ci.yml`) — fixed 2026-09-26

**Fix:** Removed `with: { version: 9 }` from both `pnpm/action-setup@v4` steps (ts and windows jobs), since root `package.json` declares `"packageManager": "pnpm@9.15.0"` and the explicit version caused "Multiple versions of pnpm specified" error on GitHub Actions. Version now comes from `packageManager`. Added `pnpm lint` step to windows job (after typecheck, before test).

**Workflow structure:**
- `ts` job (ubuntu-latest): install → `pnpm typecheck` → `pnpm lint` → `pnpm -r test` → `pnpm run --if-present test:scripts` → `pnpm build:runtime` → `pnpm --filter @skippy/ui build`.
- `windows` job (windows-latest): install → `pnpm typecheck` → `pnpm lint` → `pnpm -r test` → `pnpm run --if-present test:scripts` → `pnpm build:runtime` → Rust toolchain + cache → `cargo check` → `cargo test`.

Mocked vs. live: every step above runs entirely offline (Letta disabled, Obsidian unbound, no OTel exporter). No live provider credentials required. Live provider tests are opt-in only and never invoked by CI.

YAML validity: parsed with `js-yaml` and both jobs validated with expected step counts.

## Unrun checks

The following were **not** run and no claim is made beyond what's stated:

- **Playwright visual tests (`pnpm test:visual`)** — Reason: stale local browser cache (Playwright 1223 vs. 1.60.0). Fix is `pnpm exec playwright install`; not run as out of scope (large network operation). Previously **4 failed** on this machine (diagnostic + gallery tests).
- **Native PTY/sidecar/IPC tests** — Reason: requires running Tauri app + sidecar; not exercised by `cargo check`/`cargo test` alone. `cargo test --lib` covers Rust unit tests (envelope, git_autocommit) only.
- **Tauri app startup** (`pnpm tauri dev` or packaged build launching a window) — Reason: requires display and native integration. Not run.
- **Installer / clean-install verification** — Reason: no installer built. Not run.
- **GitHub CI execution** — Reason: the fixed workflow has not yet run on `github-actions` runners. Earlier runs of the previous configuration failed at `pnpm/action-setup` ("Multiple versions of pnpm specified"); `gh run list` showed no successful run. YAML syntax validated locally; CI will execute once the branch is pushed.
- **Linux test execution** — Reason: the `ts` job targets `ubuntu-latest`, but no Linux run has happened locally or on GitHub. All results above are Windows 11 only.
- **Live SDK/CLI tool-policy enforcement** — Reason: no credentials used. Enforcement (no permission bypass, `canUseTool`/PreToolUse deny, path guard, MCP broker) is proven at hook, callback and broker level with a mocked SDK, not through a live Claude CLI subprocess. PRD §6.2 still requires a live denied-write proof before an executor is qualified.
- **Real symlink tests (2 skipped in `packages/memory`)** — Reason: creating file/dir symlinks needs Developer Mode or SeCreateSymbolicLinkPrivilege. Junction tests cover the same reparse-point escape and pass.
- **Live provider qualification** (real Letta, Obsidian REST, OTel/Langfuse, live LLM calls) — Reason: intentional; all test suites exercise mocked/degraded paths only. Live tests are opt-in and never part of CI.
- **UI behavior of outcome display and walker despawn** — Reason: no UI test runner in scope. Typecheck and build only; no interaction tests.
- **E4-5 unsupported-drop wiring in `apps/agent-runtime/src/memory-jobs.ts`** — Reason: verified by code reading only; functional tests would require live drop + ingest flow.
- **`scripts/phase*-validate.mjs` schema validation** — Reason: pre-existing failure (`pnpm.exe not found` in scripts environment); outside scope.

## Notes

This baseline was recorded after the CI workflow fix (removal of explicit pnpm version and addition of lint step to windows job). All test results reflect the current integrated state on `m0/foundation` @ `565e4ab`. No claims are made about historical accuracy before this point; this refresh is the current source of truth for M0 test execution.
