// @skippy/otel — Phase 0 stub.
//
// PRD §9.2: the actual OTel collector runs in the Rust shell process, not here.
// Phase 1 will populate this package with:
//   - Custom exporter that fans spans to (a) Langfuse OTLP and (b) a Tauri Channel.
//   - GenAI semconv attribute helpers for `gen_ai.*` instrumentation in the sidecar.
//   - Hook adapter for Claude Agent SDK PreToolUse/PostToolUse/SessionStart/SessionEnd.
//
// For now we expose a single placeholder so downstream packages can import the
// surface without breaking typecheck.

export interface CollectorConfig {
  /** Marker so callers know they got the stub. Remove in Phase 1. */
  readonly _todo: true;
  /** Where the Rust collector will forward OTLP/HTTP traffic (Langfuse). */
  readonly otlpEndpoint: string;
}

/**
 * Returns a placeholder collector config. The real collector lives in the Rust
 * shell and is wired in Phase 1; see PRD §9.2.
 */
export function createCollectorConfig(): CollectorConfig {
  return {
    _todo: true,
    otlpEndpoint: 'http://localhost:4318/v1/traces',
  };
}
