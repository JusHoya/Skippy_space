# Appendix 07 — Skippy_space Technical Stack: Opinionated Recommendations

> Captured verbatim from the tech-stack research agent on 2026-04-29.

Below: per-decision recommendation, runner-up, one-line risk. Then the consolidated table, install order, and the single biggest risk.

---

## 1. Shell — **Tauri 2**

Tauri 2 ships an 8–10 MB installer vs Electron's 80–200 MB and idles at ~30–40 MB RAM vs Electron's 200–300 MB — material on Windows 11 where this app must coexist with a JetBrains/VS Code editor, Obsidian, a browser, and 4–8 spawned Claude Code subprocesses. Tauri 2 has stable native menus, tray, multi-window, and a first-party updater plugin. WebView2 is preinstalled on every modern Windows 11 box, so cold-start is sub-500 ms. The shell is Rust, which gives you a real way to spawn PTYs, watch the Obsidian vault with `notify`, and proxy OTLP without burning a Node process. Multi-window is critical — one window for the RTS scene, one for the terminal cluster — and Tauri handles that natively. **Runner-up:** Electron (only if a Node-only library blocks you, e.g., a native module without Rust equivalent). **Risk:** Rust learning curve when wiring custom plugins (PTY, file watcher, OTel collector) — budget a week for the first plugin.

## 2. Frontend — **Vite + React 19 + react-router**

In a Tauri shell there is no server, so Next.js's app router contributes only ceremony — its SSR/RSC primitives are inert, and `next export` is a known annoyance with Tauri. Vite gives sub-100 ms HMR which matters when iterating on the canvas and on dense telemetry panels. React 19 is the gating dependency for `@pixi/react` v8's new pragma (see #3) and for the React Compiler, which auto-memoizes side panels reading high-frequency Zustand slices. Stick with React not Solid/Svelte because the Pixi, xterm, OTel-instrumentation, and shadcn ecosystems are React-first. **Runner-up:** SolidStart (faster reactivity, but you lose `@pixi/react` and shadcn). **Risk:** React 19 + react-reconciler v0.32 churn — pin versions tightly.

## 3. Game/Scene Rendering — **PixiJS v8 via `@pixi/react` v8**

For an RTS view of dozens-to-hundreds of agent sprites with health bars, paths, and selection rectangles, PixiJS is 2–3× faster than Phaser at pure sprite throughput, has WebGPU + WebGL fallback, and `@pixi/react` v8 was rewritten on a JSX pragma inspired by react-three/fiber. The integration pattern that avoids re-render thrash: **mount Pixi once**, treat the scene root as imperative, drive sprite positions/animations from a Zustand store via `useTick` + refs (never `setState` per-frame), and only let the React tree own *structural* changes (sprite added/removed, selection mode toggled). HTML overlays (tooltips, context menus) layer above the canvas with portals or `pixi-react`'s tunnel pattern. **Runner-up:** Phaser 3 (more batteries — physics, tilemap, scene manager — but heavier and not React-native). **Risk:** WebGPU still gated behind a flag in some WebView2 builds; ship with WebGL fallback explicitly enabled.

## 4. Embedded Terminal — **`@xterm/xterm` v5.5+ + `portable-pty` (Rust) via a Tauri plugin**

xterm.js is `@xterm/xterm` (the v5.x line under the new scoped name; `xterm` v4 is unmaintained). The PTY layer is the load-bearing decision on Windows: do **not** ship `node-pty` from the renderer — it requires a Node runtime, prebuilt binaries that drift on Node major-version bumps, and electron-rebuild ceremony. Instead, use Rust's `portable-pty` crate inside a Tauri plugin, which talks directly to **ConPTY** (Win10 1809+, mandatory in 2026 since `winpty` was dropped from node-pty). One PTY per spawned Claude Code subagent + one PTY for the user's interactive shell. For multi-pane Warp-style UX, do **not** embed tmux/zellij — render multiple xterm instances in a CSS-grid and back each with its own PTY (you already have agent-per-PTY). **Runner-up:** node-pty in a sidecar Node process (more familiar but doubles install pain). **Risk:** ConPTY's 24-bit color and resize semantics are slightly off-spec — test `claude-code` TUI output explicitly.

## 5. Real-Time Event Bus — **Tauri channels (`tauri::ipc::Channel`) + a typed event envelope**

Tauri 2's `Channel` API is purpose-built for streaming (it bypasses the JSON-blocking command path that has a known ~200 ms ceiling on Windows for 10 MB payloads). Each agent gets a Channel that emits `{type, agentId, ts, payload}` events; the frontend deserializes once into a discriminated union and fans out to (a) the Pixi scene (movement, action), (b) the telemetry panel (LLM call, tool call), (c) the terminal (stdout chunk). Avoid WebSockets unless you need network transparency — they add a port, a TLS hassle, and a serialization round-trip you don't need on a single host. **Runner-up:** Local WebSocket on `127.0.0.1` (only if you ever want to attach a browser-based debugger on another machine). **Risk:** Channels are typed-by-convention; write a Zod schema for the envelope and validate at the boundary.

## 6. State Management — **Zustand (with selectors) + a transient ref-store for per-frame data**

Zustand wins for this shape: a few large stores (agents, tasks, telemetry-buffer, terminal-sessions) updated 10–100 times/sec, read by selector-scoped components. It's 3 KB, has middleware (persist, devtools, subscribeWithSelector), and integrates with React 19's compiler cleanly. The trick for sustained 60 fps: keep per-frame numeric data (sprite x/y, animation phase) in a plain JS object (a "ref store") that the Pixi tick loop reads directly, and use Zustand only for state that has a UI-visible change. **Runner-up:** Jotai (atomic = great for fine-grained telemetry cells, but the cognitive load of atom-graphs at this scale isn't worth it). **Risk:** Easy to over-subscribe and re-render the world — enforce a lint rule that bare `useStore()` is forbidden; selectors only.

## 7. Agent Runtime — **TypeScript (Claude Agent SDK for TS) running in a sidecar Node 22 LTS process**

Pick TS, despite Python's slightly larger orchestration ecosystem. Reasons: (a) you share types end-to-end with the Tauri renderer — the agent state, tool schemas, and event envelope are one `packages/shared` workspace; (b) the Claude Agent SDK reached parity for hooks, MCP, and subagents on TS in late 2025 and is what Claude Code itself uses; (c) Node + Bun handle subprocess streaming better than Python's asyncio when fanning out to 4–8 PTYs. Run it as a Tauri **sidecar** binary (`tauri.conf.json > bundle.externalBin`), not as a child process of the renderer — this gives you crash isolation. **Runner-up:** Python claude-agent-sdk (only if you need LangGraph's checkpointer or a Python-only tool like a specific scientific lib). **Risk:** Issue #34 on the TS SDK — `query()` had ~12 s startup overhead and no hot-process reuse; verify it's resolved on the version you pin or implement your own pool.

## 8. Telemetry — **Backend: self-hosted Langfuse (Docker Compose). Frontend: custom React panel subscribing to OTLP via a thin Rust proxy.**

Standardize on **OpenTelemetry GenAI Semantic Conventions** (stable as of early 2026) for spans — this gives you vendor portability. The Claude Agent SDK has first-class OTel hooks; Langfuse exposes `/api/public/otel` as an OTLP endpoint and accepts those spans natively. Self-host Langfuse via `docker compose up` for offline-first, no-egress dev. For the in-app live view, do *not* embed the Langfuse iframe — instead, run a tiny OTel collector in the Tauri Rust shell that fans spans both to (a) Langfuse over HTTP and (b) the renderer over a Tauri Channel, where your custom panel renders cost / latency / context-window % in real time. Logs use `pino` (TS) with `pino-pretty` in dev. **Runner-up:** Arize Phoenix (great built-in UI, but heavier; pick it only if you offload the live UI to its embedded view). **Risk:** OTel GenAI conventions are still evolving (e.g., `gen_ai.usage.input_tokens` rename in March 2026) — wrap the schema in your own DTO.

## 9. Subprocess Management — **Tauri-spawned sidecar Node process running the Agent SDK; `execa` inside that process for ad-hoc shell tools; one `portable-pty` per Claude Code instance.**

Pattern: the Tauri shell spawns one **long-lived** Node sidecar (the orchestrator) at app start. The orchestrator uses `@anthropic-ai/claude-agent-sdk` directly in-process (not as a CLI subprocess) for the main agents — this avoids the documented bug where `claude-code` fails to spawn under Node `child_process`. When you *need* a fresh `claude-code` CLI instance (for the headless interactive panes), spawn it under `portable-pty` from the Rust side, not from Node — bypassing the Node spawn bug entirely. Use `execa` only for incidental tools (git, ripgrep, pnpm). **Runner-up:** Bun's `Bun.spawn` (faster, but adds a second runtime). **Risk:** Sidecar crash cascades — wire a supervisor that restarts the Node process and rehydrates active agents from a SQLite checkpoint.

## 10. Packaging & Install — **Tauri bundler → MSI + NSIS, signed with an Azure Key Vault EV certificate, auto-update via Tauri Updater plugin against a static `latest.json` on R2/S3.**

Since June 2023, OV certs require HSM storage; in 2026 the only practical path for a personal/small-team app is Azure Key Vault + a `signtool`-compatible plugin (Tauri's `customSignCommand` supports this). EV certs cost more (~$300–500/yr) but eliminate SmartScreen warnings on first install — worth it for a tool you'll run daily. Auto-update uses Tauri Updater's separate signing keypair (independent of OS code signing). Do **not** ship Node or Python — require the user to install Node 22 LTS once (the agent SDK runs inside the sidecar binary, but `npx`-able tools the agents call need a system Node). Do **not** ship Obsidian — require it as a peer install and document the Local REST API plugin setup. **Runner-up:** unsigned + manual updates (only for personal-use builds). **Risk:** EV cert reissue (HSM hardware loss) — keep the cert metadata in a password manager and document the renewal runbook.

---

## A. Consolidated Stack Table

| # | Layer | Choice |
|---|---|---|
| 1 | Shell | **Tauri 2** (Rust core, WebView2) |
| 2 | Frontend | **Vite 6 + React 19 + react-router 7** |
| 3 | Rendering | **PixiJS v8 + `@pixi/react` v8** |
| 4 | Terminal | **`@xterm/xterm` v5.5 + Rust `portable-pty` (ConPTY)** |
| 5 | Event Bus | **Tauri Channels** w/ Zod-validated envelope |
| 6 | State | **Zustand** + transient ref-store for per-frame data |
| 7 | Runtime | **TypeScript / Node 22 LTS sidecar** w/ `@anthropic-ai/claude-agent-sdk` |
| 8 | Telemetry | **OTel GenAI conventions → self-hosted Langfuse + custom React panel** |
| 9 | Subprocess | **Rust-spawned sidecar Node + `portable-pty` per Claude Code; `execa` for shell tools** |
| 10 | Packaging | **Tauri MSI/NSIS + Azure KV EV cert + Tauri Updater** |

## B. Day-1 Install List (in order)

1. **Node 22 LTS** — `winget install OpenJS.NodeJS.LTS`
2. **pnpm 9** — `corepack enable && corepack prepare pnpm@latest --activate`
3. **Rust stable + MSVC** — `winget install Rustlang.Rustup` then `rustup default stable-x86_64-pc-windows-msvc`
4. **Tauri prereqs** — `winget install Microsoft.EdgeWebView2Runtime` (usually present); install VS 2022 Build Tools (Desktop C++)
5. **Tauri CLI** — `pnpm add -g @tauri-apps/cli@^2`
6. **Docker Desktop** (for Langfuse) — `winget install Docker.DockerDesktop`
7. **Obsidian** — `winget install Obsidian.Obsidian`, then install **Local REST API** plugin in-app, copy API key
8. **Repo init** — `pnpm create tauri-app skippy-space --template react-ts --manager pnpm`
9. **App deps** — `pnpm add zustand @xterm/xterm @xterm/addon-fit pixi.js @pixi/react react-router-dom zod`
10. **Agent SDK** (in `apps/agent-runtime`) — `pnpm add @anthropic-ai/claude-agent-sdk @anthropic-ai/sdk pino execa`
11. **Tauri Rust crates** (in `Cargo.toml`) — `tauri`, `tauri-plugin-updater`, `tauri-plugin-fs`, `portable-pty`, `notify`, `opentelemetry`, `opentelemetry-otlp`
12. **Langfuse** — `git clone https://github.com/langfuse/langfuse && cd langfuse && docker compose up -d`
13. **Code-signing cert** — provision Azure Key Vault, generate EV CSR, submit to Sectigo/DigiCert (1–5 day issue)
14. **Tauri updater keypair** — `pnpm tauri signer generate -w ~/.tauri/skippy.key`
15. **Claude Code CLI** (used by some agents as a subprocess) — `pnpm add -g @anthropic-ai/claude-code`

## C. Single Biggest Technical Risk + Mitigation

**Risk:** The **Node-spawning-Claude-Code subprocess bug** combined with the Claude Agent SDK TS `query()` ~12 s cold-start overhead. Together these mean naïve "spawn one Claude per agent" patterns will either fail outright (when Node spawns the CLI) or feel sluggish (when the SDK starts cold per query). For a "snappy and game-like" RTS dashboard, a 12 s pause when an agent spawns is fatal to the UX premise.

**Mitigation (three-layer):**

1. **Use the SDK in-process inside the Node sidecar** — don't shell out to the `claude-code` CLI from Node; call `query()` directly. This sidesteps the spawn bug.
2. **When you must run the CLI** (e.g., headless terminal panes), spawn it from **Rust** via `portable-pty`, not from Node. Rust → ConPTY → claude-code works; Node → child_process → claude-code is the broken path.
3. **Build a warm-pool** of pre-initialized SDK contexts in the sidecar — keep 2–3 hot, draw from the pool on agent spawn (sub-second), backfill in the background. Track issue [anthropics/claude-agent-sdk-typescript#34](https://github.com/anthropics/claude-agent-sdk-typescript/issues/34) and remove the pool when fixed upstream.

---

## Sources

- [Tauri vs Electron 2026: Bundle, RAM and Benchmarks — PkgPulse](https://www.pkgpulse.com/blog/best-desktop-app-frameworks-2026)
- [Tauri vs. Electron: performance, bundle size, and the real trade-offs — gethopp](https://www.gethopp.app/blog/tauri-vs-electron)
- [Tauri 2.0 Stable Release](https://v2.tauri.app/blog/tauri-20/)
- [Windows Code Signing | Tauri](https://v2.tauri.app/distribute/sign/windows/)
- [Updater | Tauri](https://v2.tauri.app/plugin/updater/)
- [Tauri IPC Improvements Discussion #5690](https://github.com/tauri-apps/tauri/discussions/5690)
- [Next.js vs Vite for Tauri Discussion #6083](https://github.com/tauri-apps/tauri/discussions/6083)
- [Vite vs Next.js 2026 — DesignRevision](https://designrevision.com/blog/vite-vs-nextjs)
- [Introducing PixiJS React v8](https://pixijs.com/blog/pixi-react-v8-live)
- [PixiJS v8 Launch](https://pixijs.com/blog/pixi-v8-launches)
- [JS game rendering benchmark — Shirajuki](https://github.com/Shirajuki/js-game-rendering-benchmark)
- [@xterm/xterm npm](https://www.npmjs.com/package/@xterm/xterm)
- [microsoft/node-pty (ConPTY, winpty removal)](https://github.com/microsoft/node-pty)
- [tauri-plugin-pty — crates.io](https://crates.io/crates/tauri-plugin-pty)
- [Claude Agent SDK overview — Anthropic Docs](https://docs.anthropic.com/en/docs/claude-code/sdk)
- [@anthropic-ai/claude-agent-sdk — npm](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
- [Issue #34: query() has ~12s overhead per call — claude-agent-sdk-typescript](https://github.com/anthropics/claude-agent-sdk-typescript/issues/34)
- [Issue #771: Claude Code can't be spawned from node.js](https://github.com/anthropics/claude-code/issues/771)
- [2026 AI Agent Framework Showdown — QubitTool](https://qubittool.com/blog/ai-agent-framework-comparison-2026)
- [OpenTelemetry GenAI Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
- [Observability with OpenTelemetry — Claude Code Docs](https://code.claude.com/docs/en/agent-sdk/observability)
- [Observability for Claude Agent SDK with Langfuse](https://langfuse.com/integrations/frameworks/claude-agent-sdk)
- [langfuse/langfuse — GitHub](https://github.com/langfuse/langfuse)
- [State Management 2026: Zustand vs Jotai vs Redux Toolkit vs Signals — DEV](https://dev.to/jsgurujobs/state-management-in-2026-zustand-vs-jotai-vs-redux-toolkit-vs-signals-2gge)
- [Zustand vs Jotai vs Valtio Performance Guide — React Libraries](https://www.reactlibraries.com/blog/zustand-vs-jotai-vs-valtio-performance-guide-2025)
- [obsidian-local-rest-api — coddingtonbear](https://github.com/coddingtonbear/obsidian-local-rest-api)
