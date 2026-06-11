//! Envelope — the event contract between the Node sidecar, the Rust shell, and the React renderer.
//!
//! Mirrors `packages/shared/src/envelope.ts` + `phase3prep.ts`. JSON
//! discriminant is `type` in `snake_case` (e.g. `user_prompt`, `agent_state`,
//! `agent_token`, `agent_complete`, `log`, `board_spawned`, `delegation`,
//! `set_model`, `claude_code_spawned`). Adapter properties on the wire use
//! camelCase (`promptId`, `agentId`, `totalTokens`) so the renderer can
//! consume the envelope verbatim without renaming.
//!
//! Coordinated with sibling agents (R/UI/Runtime). Do not change variant
//! names or field names without a synchronized update across
//! `packages/shared/`, `apps/agent-runtime/`, and `apps/ui/`.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Envelope {
    UserPrompt {
        #[serde(rename = "promptId")]
        prompt_id: String,
        text: String,
        ts: String,
    },
    AgentState {
        #[serde(rename = "agentId")]
        agent_id: String,
        state: String,
        #[serde(rename = "promptId", skip_serializing_if = "Option::is_none")]
        prompt_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        task: Option<String>,
        ts: String,
    },
    AgentToken {
        #[serde(rename = "agentId")]
        agent_id: String,
        #[serde(rename = "promptId")]
        prompt_id: String,
        text: String,
        ts: String,
    },
    AgentComplete {
        #[serde(rename = "agentId")]
        agent_id: String,
        #[serde(rename = "promptId")]
        prompt_id: String,
        #[serde(rename = "totalTokens", skip_serializing_if = "Option::is_none")]
        total_tokens: Option<u32>,
        ts: String,
    },
    Log {
        level: String,
        source: String,
        message: String,
        ts: String,
    },

    /// Shell → renderer: agent-runtime child-process lifecycle, emitted by the
    /// sidecar supervisor in `sidecar.rs`. `event` is one of `crashed` (child
    /// exited), `restarted` (a fresh child is up + boards re-announced), or
    /// `ready` (clean cold boot). The renderer releases agents stuck in
    /// `thinking`/`speaking` on `crashed`/`restarted` so Skippy doesn't hang
    /// forever on a turn the dead child can never finish (REVIEW §5 critic).
    SidecarStatus {
        event: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
        ts: String,
    },

    // ── Phase 1: Board lifecycle ───────────────────────────────────────────
    BoardSpawned {
        #[serde(rename = "boardId")]
        board_id: String,
        #[serde(rename = "agentId")]
        agent_id: String,
        model: String,
        ts: String,
    },
    BoardReady {
        #[serde(rename = "boardId")]
        board_id: String,
        #[serde(rename = "agentId")]
        agent_id: String,
        ts: String,
    },
    BoardState {
        #[serde(rename = "boardId")]
        board_id: String,
        #[serde(rename = "agentId")]
        agent_id: String,
        state: String,
        #[serde(rename = "currentTaskId", skip_serializing_if = "Option::is_none")]
        current_task_id: Option<String>,
        ts: String,
    },

    // ── Phase 1: Delegation ────────────────────────────────────────────────
    Delegation {
        #[serde(rename = "delegationId")]
        delegation_id: String,
        #[serde(rename = "fromAgentId")]
        from_agent_id: String,
        #[serde(rename = "toBoardId")]
        to_board_id: String,
        #[serde(rename = "missionBrief")]
        mission_brief: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        constraints: Option<Vec<String>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        deadline: Option<String>,
        ts: String,
    },
    DelegationAck {
        #[serde(rename = "delegationId")]
        delegation_id: String,
        #[serde(rename = "fromBoardId")]
        from_board_id: String,
        decision: String,
        #[serde(rename = "counterText", skip_serializing_if = "Option::is_none")]
        counter_text: Option<String>,
        ts: String,
    },
    DelegationComplete {
        #[serde(rename = "delegationId")]
        delegation_id: String,
        #[serde(rename = "fromBoardId")]
        from_board_id: String,
        result: String,
        summary: String,
        ts: String,
    },

    // ── Phase 3-prep: Model picker ─────────────────────────────────────────
    /// Renderer → sidecar: rebind a scope to a specific model. Sidecar updates
    /// its in-process binding; in-flight calls retain their original model.
    SetModel {
        /// `"skippy"` or `"board.<id>"`.
        scope: String,
        #[serde(rename = "modelId")]
        model_id: String,
        ts: String,
    },

    // ── Phase 3-prep: Claude Code subprocess spawn ─────────────────────────
    /// Shell → renderer: a claude CLI PTY was opened on behalf of an agent.
    ClaudeCodeSpawned {
        #[serde(rename = "spawnId")]
        spawn_id: String,
        #[serde(rename = "ptyId")]
        pty_id: String,
        #[serde(rename = "parentAgentId")]
        parent_agent_id: String,
        model: String,
        cwd: String,
        ts: String,
    },
    /// Shell → renderer: a claude CLI PTY ended.
    ClaudeCodeExited {
        #[serde(rename = "spawnId")]
        spawn_id: String,
        #[serde(rename = "ptyId")]
        pty_id: String,
        #[serde(rename = "exitCode")]
        exit_code: Option<i32>,
        ts: String,
    },

    // ── Phase 3: Telemetry / memory / replay HUD ───────────────────────────
    // Hand-mirrored from `packages/shared/src/phase3.ts`. The shell only
    // forwards these to the renderer; the parity test below guards the tag +
    // field shape so a drift in the TS union can't silently demote them to Log.
    /// Sidecar → renderer: one billable LLM turn (tokens + cost + latency). [WS6/D5]
    TelemetrySpan {
        #[serde(rename = "spanId")]
        span_id: String,
        #[serde(rename = "traceId", skip_serializing_if = "Option::is_none")]
        trace_id: Option<String>,
        #[serde(rename = "agentId")]
        agent_id: String,
        #[serde(rename = "boardId", skip_serializing_if = "Option::is_none")]
        board_id: Option<String>,
        #[serde(rename = "promptId", skip_serializing_if = "Option::is_none")]
        prompt_id: Option<String>,
        model: String,
        #[serde(rename = "inputTokens")]
        input_tokens: u32,
        #[serde(rename = "outputTokens")]
        output_tokens: u32,
        #[serde(rename = "costUsd")]
        cost_usd: f64,
        #[serde(rename = "durationMs")]
        duration_ms: f64,
        ts: String,
    },
    /// Sidecar → renderer: per-agent context-window pressure snapshot. [WS6/D5]
    ContextWindow {
        #[serde(rename = "agentId")]
        agent_id: String,
        #[serde(rename = "boardId", skip_serializing_if = "Option::is_none")]
        board_id: Option<String>,
        model: String,
        #[serde(rename = "usedTokens")]
        used_tokens: u32,
        #[serde(rename = "limitTokens")]
        limit_tokens: u32,
        ts: String,
    },
    /// Sidecar → renderer: an errored span for the telemetry error feed. [WS6/D5]
    ErrorSpan {
        #[serde(rename = "spanId", skip_serializing_if = "Option::is_none")]
        span_id: Option<String>,
        #[serde(rename = "agentId")]
        agent_id: String,
        #[serde(rename = "boardId", skip_serializing_if = "Option::is_none")]
        board_id: Option<String>,
        #[serde(rename = "errorKind")]
        error_kind: String,
        message: String,
        ts: String,
    },
    /// Sidecar → renderer: ingest/distill/link/lint pipeline progress. [WS5/D3]
    MemoryJob {
        job: String,
        phase: String,
        #[serde(rename = "sourcePath", skip_serializing_if = "Option::is_none")]
        source_path: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        counts: Option<MemoryJobCounts>,
        ts: String,
    },
    /// Sidecar → renderer: a `.replay` file opened/closed. [WS8/D5]
    ReplaySession {
        #[serde(rename = "sessionId")]
        session_id: String,
        event: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        path: Option<String>,
        ts: String,
    },
}

/// Accumulated counts carried by a [`Envelope::MemoryJob`] pulse. Mirrors the
/// optional `counts` object in `phase3.ts`; every field is optional because a
/// job only reports what it produced.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryJobCounts {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sources: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub atomic: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub links: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proposals: Option<u32>,
}

impl Envelope {
    /// Convenience constructor for shell-originated log envelopes.
    pub fn log(level: impl Into<String>, source: impl Into<String>, message: impl Into<String>) -> Self {
        Envelope::Log {
            level: level.into(),
            source: source.into(),
            message: message.into(),
            ts: chrono::Utc::now().to_rfc3339(),
        }
    }

    /// Convenience constructor for a sidecar-lifecycle pulse. `event` is
    /// `crashed` | `restarted` | `ready`; `detail` carries the exit info /
    /// human-readable context (e.g. `"exit status ExitStatus(...)"`).
    pub fn sidecar_status(event: impl Into<String>, detail: Option<String>) -> Self {
        Envelope::SidecarStatus {
            event: event.into(),
            detail,
            ts: chrono::Utc::now().to_rfc3339(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Cross-language parity guard. This Rust enum is a hand-mirror of the Zod
    // discriminated union in `packages/shared/src/phase3.ts`; if the two drift,
    // `serde_json::from_str::<Envelope>` returns Err and `sidecar.rs` silently
    // demotes the Phase 3 line to a `debug` Log — killing the telemetry/memory/
    // replay HUD at the shell boundary. These samples assert each Phase 3
    // variant deserializes onto its *specific* arm, not the Err/Log path.

    /// Parse `json`, asserting it lands on the expected variant rather than
    /// falling through to a parse error (which the sidecar demotes to Log).
    fn assert_variant(json: &str, expect: &str) {
        let env: Envelope = serde_json::from_str(json)
            .unwrap_or_else(|e| panic!("Phase 3 sample failed to deserialize as Envelope ({e}): {json}"));
        let got = match &env {
            Envelope::TelemetrySpan { .. } => "telemetry_span",
            Envelope::ContextWindow { .. } => "context_window",
            Envelope::ErrorSpan { .. } => "error_span",
            Envelope::MemoryJob { .. } => "memory_job",
            Envelope::ReplaySession { .. } => "replay_session",
            Envelope::SidecarStatus { .. } => "sidecar_status",
            Envelope::Log { .. } => "log",
            _ => "other",
        };
        assert_eq!(got, expect, "sample landed on the wrong variant: {json}");
    }

    #[test]
    fn telemetry_span_round_trips_onto_its_variant() {
        // All fields populated, including the optional trace/board/prompt ids.
        assert_variant(
            r#"{"type":"telemetry_span","spanId":"sp-1","traceId":"tr-1","agentId":"research.distiller","boardId":"research","promptId":"p-1","model":"claude-sonnet-4-6","inputTokens":1200,"outputTokens":340,"costUsd":0.0123,"durationMs":842.5,"ts":"2026-06-10T12:00:00Z"}"#,
            "telemetry_span",
        );
        // Minimal: optional fields omitted entirely.
        assert_variant(
            r#"{"type":"telemetry_span","spanId":"sp-2","agentId":"skippy","model":"claude-opus-4-8","inputTokens":0,"outputTokens":0,"costUsd":0,"durationMs":0,"ts":"2026-06-10T12:00:01Z"}"#,
            "telemetry_span",
        );
    }

    #[test]
    fn context_window_round_trips_onto_its_variant() {
        assert_variant(
            r#"{"type":"context_window","agentId":"coding.captain","boardId":"coding","model":"claude-sonnet-4-6","usedTokens":98000,"limitTokens":200000,"ts":"2026-06-10T12:00:02Z"}"#,
            "context_window",
        );
    }

    #[test]
    fn error_span_round_trips_onto_its_variant() {
        assert_variant(
            r#"{"type":"error_span","spanId":"sp-3","agentId":"staff.lint","boardId":"engineering","errorKind":"RateLimit","message":"429 from provider","ts":"2026-06-10T12:00:03Z"}"#,
            "error_span",
        );
        // spanId + boardId omitted (both optional on the wire).
        assert_variant(
            r#"{"type":"error_span","agentId":"skippy","errorKind":"Timeout","message":"no response","ts":"2026-06-10T12:00:04Z"}"#,
            "error_span",
        );
    }

    #[test]
    fn memory_job_round_trips_onto_its_variant() {
        // With the nested counts object.
        assert_variant(
            r#"{"type":"memory_job","job":"distill","phase":"complete","sourcePath":"vault/inbox/x.md","detail":"3 atomic notes","counts":{"sources":1,"atomic":3,"links":5,"proposals":2},"ts":"2026-06-10T12:00:05Z"}"#,
            "memory_job",
        );
        // Bare pulse: only the required fields.
        assert_variant(
            r#"{"type":"memory_job","job":"ingest","phase":"start","ts":"2026-06-10T12:00:06Z"}"#,
            "memory_job",
        );
    }

    #[test]
    fn replay_session_round_trips_onto_its_variant() {
        assert_variant(
            r#"{"type":"replay_session","sessionId":"sess-1","event":"started","path":"replays/sess-1.replay","ts":"2026-06-10T12:00:07Z"}"#,
            "replay_session",
        );
        assert_variant(
            r#"{"type":"replay_session","sessionId":"sess-1","event":"ended","ts":"2026-06-10T12:00:08Z"}"#,
            "replay_session",
        );
    }

    #[test]
    fn sidecar_status_round_trips_onto_its_variant() {
        // crashed pulse with the exit detail attached.
        assert_variant(
            r#"{"type":"sidecar_status","event":"crashed","detail":"sidecar exited with status ExitStatus(unix_wait_status(139))","ts":"2026-06-10T12:00:10Z"}"#,
            "sidecar_status",
        );
        // restarted pulse, detail omitted (optional on the wire).
        assert_variant(
            r#"{"type":"sidecar_status","event":"restarted","ts":"2026-06-10T12:00:11Z"}"#,
            "sidecar_status",
        );
        // ready pulse on a clean cold boot.
        assert_variant(
            r#"{"type":"sidecar_status","event":"ready","ts":"2026-06-10T12:00:12Z"}"#,
            "sidecar_status",
        );
    }

    #[test]
    fn sidecar_status_serializes_with_camelcase_tag_and_drops_absent_detail() {
        // The renderer consumes the wire JSON verbatim: tag is snake_case
        // `sidecar_status`, `detail` is omitted entirely when None (matching the
        // Zod `.optional()` on the TS side), and present when Some.
        let crashed = Envelope::sidecar_status("crashed", Some("boom".into()));
        let json = serde_json::to_string(&crashed).unwrap();
        assert!(json.contains(r#""type":"sidecar_status""#), "tag must be snake_case: {json}");
        assert!(json.contains(r#""event":"crashed""#), "event field present: {json}");
        assert!(json.contains(r#""detail":"boom""#), "detail present when Some: {json}");

        let restarted = Envelope::sidecar_status("restarted", None);
        let json = serde_json::to_string(&restarted).unwrap();
        assert!(
            !json.contains("detail"),
            "absent detail must be skipped, not emitted as null: {json}"
        );
    }

    #[test]
    fn unknown_type_does_not_silently_masquerade_as_a_phase3_variant() {
        // The enum has no `#[serde(other)]` catch-all, so an unknown tag must
        // fail to parse — this is exactly the path the sidecar demotes to a
        // debug Log. The guard above is meaningful precisely because a genuine
        // miss surfaces as Err, never as a wrong variant.
        let err = serde_json::from_str::<Envelope>(
            r#"{"type":"telemetry_spanX","spanId":"sp","agentId":"a","model":"m","inputTokens":0,"outputTokens":0,"costUsd":0,"durationMs":0,"ts":"2026-06-10T12:00:09Z"}"#,
        );
        assert!(err.is_err(), "unknown type should fail to parse, not map to a Phase 3 variant");
    }
}
