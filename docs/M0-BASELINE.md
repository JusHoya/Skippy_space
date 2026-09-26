# M0 Baseline — WS-A (T00: Baseline and CI)

Recorded 2026-09-26 while implementing WS-A in worktree
`agent-a096b7ea8659058a4`.

## Branch / commit

- This worktree's branch (`worktree-agent-a096b7ea8659058a4`) was created from
  `main` at commit `7b17b70` ("feat(phase3.5-D1+D4): wire Obsidian + Letta MCP
  tools into the gated SDK boards"), **not** from `m0/foundation`.
- The integration target for M0 is `m0/foundation` @ `239aea7` ("ops:
  read-only Alcyone inventory checklist and script (OQ-01)").
- `git diff 7b17b70..239aea7` is **docs-only** (PRD v0.2, assessment,
  handoff, `ops/`) — no application/package/CI code differs between the two.
  The code baseline recorded below is therefore representative of both
  commits; the CI/test/lint infrastructure added by this ticket applies
  unchanged once this worktree merges onto `m0/foundation`.

## Environment

| Tool | Version |
|---|---|
| OS | Windows 11 Home 10.0.26200 |
| Node | v24.18.0 |
| pnpm | 9.15.0 (via corepack) |
| rustc | 1.98.1 (48a229cea, 2026-09-01), stable-msvc |
| cargo | 1.98.1 (797e8a9bc, 2026-08-05) |
| tauri-cli | 2.11.1 |
| `%USERPROFILE%\.cargo\bin` | not on PATH by default in this shell; prepended manually for `cargo`/`rustc` invocations |

## Baseline command results (this worktree, after WS-A changes)

All commands were actually executed here; none are assumed.

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | Pass — 517 packages, lockfile respected, no resolution changes |
| `pnpm typecheck` | Pass — 7/7 packages (`tsc -b`/`tsc --noEmit`), 0 errors |
| `pnpm lint` | Pass (exit 0) — flat ESLint config (`eslint.config.mjs`) run per-package via new `lint` scripts in `packages/{memory,otel,shared,sprite-kit}` and `apps/{agent-runtime,ui}`. `apps/shell` has no TS `src/` and is intentionally excluded. Only warnings surfaced (unused vars prefixed-underscore rule, a few stale `eslint-disable` comments) — 0 errors. See "Lint findings" below. |
| `pnpm --filter @skippy/memory test` | Pass — 27/27 (glob `src/**/*.test.ts` via Node's `--test`) |
| `pnpm --filter @skippy/agent-runtime test` | Pass — 4/4 (glob `src/**/*.test.ts`) |
| `pnpm -r test` (new root aggregate, `pnpm -r --if-present test`) | Pass — runs both suites above (31/31 total) |
| `pnpm build:runtime` | Pass — tsup ESM build, `apps/agent-runtime/dist/index.js` (66.04 KB) |
| `pnpm --filter @skippy/ui build` | Pass — `tsc --noEmit && vite build`, output in `apps/ui/dist/` (one >500 kB chunk warning, non-fatal) |
| `cargo check --manifest-path apps/shell/src-tauri/Cargo.toml` | Pass — but **only after** `pnpm build:runtime` is run first. `tauri.conf.json`'s `resources` glob (`../../agent-runtime/dist/**/*`) is evaluated by `tauri-build`'s build script; with no `dist/` present the build script exits 1 ("glob pattern ... path not found or didn't match any files"), which fails `cargo check` for the whole workspace. CI orders `build:runtime` before any cargo step for this reason. |

### Lint findings (all warnings, 0 errors)

- `packages/shared/src/phase3prep.ts:15` — unused import `BoardIdSchema`.
- `packages/memory/src/vault-watcher.ts` (4 lines), `apps/agent-runtime/src/{board,warmpool}.ts` (5 lines), `apps/ui/src/{gallery/GalleryTile,scene/SceneRoot,scene/projectTree}.tsx|ts` (4 lines) — stale `eslint-disable-next-line` comments for rules that no longer fire under the new flat config (`no-console`, `@typescript-eslint/require-await`); ESLint reports these as "unused eslint-disable directive" warnings. Left as warnings rather than mass-edited per scope (avoid touching files outside WS-A octuple-checked for merge conflicts with concurrent agents; `board.ts`/`warmpool.ts` are in `apps/agent-runtime/src`, which is explicitly out of scope for this ticket).
- One real ESLint **error** was fixed as part of getting `pnpm lint` to exit 0 honestly: `apps/ui/src/hud/CommandBar.tsx:40` had `// eslint-disable-next-line react-hooks/exhaustive-deps`, but `eslint-plugin-react-hooks` is not installed/configured in the flat config, so ESLint reported "Definition for rule 'react-hooks/exhaustive-deps' was not found" (a hard error, not a warning). Removed the stale disable comment (no `eslint-plugin-react-hooks` rule is active, so nothing is actually suppressed) rather than adding a new dependency outside the pinned lockfile. This is a one-line comment removal in `apps/ui`, which is inside WS-A's scope (not runtime/memory/autocommit source logic).
- `@typescript-eslint/no-unused-vars` is configured at `warn` (not `error`) repo-wide in `eslint.config.mjs` (pre-existing, not changed by WS-A) — this is why the unused-import finding above didn't fail the build. Verified lint actually inspects source by injecting a deliberately-bad temp file (`unused` local var, `x = 2` reassignment of a `const`) into `packages/shared/src`, confirming ESLint flags it, then reverting (temp file removed; `git status` clean of that change).

### Lint rule note (why some intentional "errors" didn't fire)

Injected test cases for `no-const-assign` and `no-unreachable` did **not** get flagged, because `typescript-eslint`'s recommended config disables core ESLint rules that the TypeScript compiler itself already reports as compile errors (confirmed via `eslint --print-config`, which shows `no-const-assign: [0]` and `no-unreachable: [0]`). This is expected typescript-eslint behavior, not a gap in the lint config — those errors would surface via `tsc`/`pnpm typecheck` instead.

## CI (`.github/workflows/ci.yml`)

- `ts` job (ubuntu-latest): install → `pnpm typecheck` → `pnpm lint` → `pnpm -r test` → `pnpm run --if-present test:scripts` → `pnpm build:runtime` → `pnpm --filter @skippy/ui build`.
- `windows` job (windows-latest): install → `pnpm typecheck` → `pnpm -r test` → `pnpm run --if-present test:scripts` → `pnpm build:runtime` (must precede cargo, see above) → Rust toolchain + `Swatinem/rust-cache` → `cargo check --manifest-path apps/shell/src-tauri/Cargo.toml` → `cargo test --manifest-path apps/shell/src-tauri/Cargo.toml`.
- The previous Linux `cargo check` job (gated `if: false`, since Tauri 2's native deps — webkit2gtk etc. — aren't installed on plain `ubuntu-latest`) has been **removed** in favor of the Windows cargo job, which matches the desktop target platform and actually runs.
- `pnpm run --if-present test:scripts` targets the `test:scripts` root script added by WS-F (`node --test scripts/*.test.mjs`, covering `git-autocommit.mjs`-adjacent regression tests); it does not exist yet in this worktree (branched before that change landed), so `--if-present` makes the step a no-op locally until WS-F merges, and a real check once it does. `apps/shell/src-tauri` currently has no `#[test]`/`#[cfg(test)]` items in this worktree either (also pending a concurrent agent's work per the orchestrator note); `cargo test` against 0 tests exits 0 and will pick up new tests automatically once added.
- Mocked vs. live: every test/build step above runs entirely offline against mocked/degraded clients (Letta disabled, Obsidian unbound, no OTel exporter) — see the `packages/memory` and `apps/agent-runtime` suites already passing above. No live provider credentials are used or required anywhere in this workflow. Live provider qualification tests are opt-in only and intentionally never invoked by CI.
- YAML validity: parsed with `js-yaml` (already present under `node_modules/.pnpm`) via a throwaway Node script; both jobs (`ts`, `windows`) parsed correctly with the expected step counts and `windows-latest` runner.

## Unrun checks

The following were **not** run (or attempted and failed for environmental reasons) as part of this ticket, and no claim of pass/fail beyond what's stated is made:

- **Playwright visual tests (`pnpm test:visual`)** — attempted, since `~/AppData/Local/ms-playwright` did contain `chromium-1228`/`chromium-1234` browser installs. Result: **4 failed** (`diagnostic.spec.ts`, 3× `gallery.spec.ts`). Failure cause: `browserType.launch: Executable doesn't exist at ...chromium_headless_shell-1223\chrome-headless-shell.exe` — the installed browser cache is a different/stale Playwright build (1223) than what `@playwright/test@1.60.0` expects, i.e. a local environment/install mismatch, not a code regression. Fix would be `pnpm exec playwright install`, which downloads new browser binaries; left undone as out of WS-A's build/lint/CI-infra scope and to avoid an unrequested large network operation. Recorded here as attempted-but-environmentally-blocked rather than silently skipped.
- **Native PTY/sidecar/IPC integration** (actually spawning the Tauri shell + agent-runtime sidecar and exercising `portable-pty`) — unrun; requires a running Tauri app, not exercised by `cargo check`/`cargo test` alone.
- **Tauri app startup** (`pnpm tauri dev` / a packaged build actually launching a window) — unrun.
- **Installer / clean-install verification** — unrun; no installer was built or run.
- **CI on GitHub itself** — the workflow YAML was validated locally (parse + step review) but has not executed on `github-actions` runners; that only happens once this branch/PR is pushed.
- **Live provider qualification tests** (real Letta server, real Obsidian REST endpoint, real OTel/Langfuse exporter, live LLM API calls) — intentionally never run in CI or locally here; all suites above exercise degraded/mocked paths only.

## Scope note

Per the WS-A brief, no changes were made to `apps/agent-runtime/src`, `packages/memory/src`, or git-autocommit source logic (`scripts/git-autocommit.mjs`, `apps/shell/src-tauri/src/git_autocommit.rs`) beyond adding/adjusting `test`/`lint` **scripts** in the relevant `package.json` files and the one-line stale-comment removal in `apps/ui/src/hud/CommandBar.tsx` noted above. Root `test:scripts` script and any `git-autocommit.mjs`/Rust autocommit test changes are explicitly left to WS-F per orchestrator direction.
