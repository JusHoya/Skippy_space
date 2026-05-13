# apps/

Three application processes that compose Skippy_space:

- **`shell/`** — Tauri 2 Rust shell. Hosts WebView2, spawns the Node sidecar, owns PTYs (via `portable-pty`), runs the local OTel collector that fans spans to Langfuse + the renderer.
- **`ui/`** — Vite + React 19 renderer. PixiJS scene + side panels + xterm terminal cluster. Subscribes to Tauri Channels for real-time agent events.
- **`agent-runtime/`** — Node 22 LTS sidecar. Hosts Skippy + the 8 Board `query()` processes via `@anthropic-ai/claude-agent-sdk`. Maintains a warm pool of pre-initialized SDK contexts (mitigates R-01).

**Status:** stubs only. Implementation begins Phase 0 of the roadmap (PRD §14.1).

See PRD §11 for the consolidated stack and §11.3 for the full repo layout target.
