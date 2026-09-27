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
    /// Board -> Skippy non-terminal lifecycle pulse (`state`: accepted | running;
    /// `mode`: demo | live). PRD v0.2 FR-RUN-01.
    DelegationState {
        #[serde(rename = "delegationId")]
        delegation_id: String,
        #[serde(rename = "fromBoardId")]
        from_board_id: String,
        state: String,
        mode: String,
        ts: String,
    },
    /// Board -> Skippy terminal record (PRD v0.2 FR-RUN-01). `outcome` is one of
    /// succeeded | failed | cancelled | interrupted | blocked | simulated; the
    /// shell never infers success. The record is validated on deserialization
    /// (see [`TerminalRecord`]): a record violating the outcome contract is
    /// forwarded as `unverified` (EC1 D3). Mirrors `DelegationCompleteEnvelope`
    /// + `TerminalRecordShape` in @skippy/shared; the wire shape is unchanged.
    DelegationComplete {
        #[serde(rename = "delegationId")]
        delegation_id: String,
        #[serde(rename = "fromBoardId")]
        from_board_id: String,
        #[serde(flatten)]
        record: TerminalRecord,
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
}

/// Machine-readable reason attached to every non-succeeded outcome.
/// Mirrors `OutcomeReasonSchema` in `packages/shared/src/outcome.ts`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutcomeReason {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// Terminal outcomes a writer (the sidecar) may report. Mirrors `OUTCOMES`.
pub const OUTCOMES: [&str; 6] = ["succeeded", "failed", "cancelled", "interrupted", "blocked", "simulated"];
/// Execution modes. Mirrors `EXECUTION_MODES`.
pub const EXECUTION_MODES: [&str; 2] = ["demo", "live"];
/// Validation dispositions. Mirrors `VALIDATION_DISPOSITIONS`.
pub const VALIDATION_DISPOSITIONS: [&str; 4] = ["passed", "failed", "not_defined", "not_run"];
/// Reader-only outcome the shell substitutes for a contract-violating record.
pub const UNVERIFIED: &str = "unverified";

/// The terminal record fields of `delegation_complete` (mirrors
/// `TerminalRecordShape`). Deserialization validates the record against the
/// outcome contract — the known enums plus `terminalRecordViolations` in
/// `packages/shared/src/outcome.ts` — and maps any violator to `unverified`
/// (validation `not_run`, reason `invalid_record`) so a malformed or
/// dishonest record (e.g. `succeeded` + `mode: "demo"`) is never forwarded
/// as success (EC1 D3, FR-RUN-01, G0 defense in depth).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(from = "TerminalRecordWire")]
pub struct TerminalRecord {
    pub outcome: String,
    pub mode: String,
    pub validation: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<OutcomeReason>,
    pub summary: String,
    #[serde(rename = "costUsd", skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifacts: Option<Vec<ArtifactRef>>,
}

/// Unvalidated wire form of [`TerminalRecord`].
#[derive(Deserialize)]
struct TerminalRecordWire {
    outcome: String,
    mode: String,
    validation: String,
    reason: Option<OutcomeReason>,
    summary: String,
    #[serde(rename = "costUsd")]
    cost_usd: Option<f64>,
    artifacts: Option<Vec<ArtifactRef>>,
}

impl TerminalRecord {
    /// Contract violations of a received record; empty means it is honest by
    /// construction. Mirrors `terminalRecordViolations` plus enum membership
    /// (which zod enforces on the TypeScript side).
    pub fn violations(outcome: &str, mode: &str, validation: &str, has_reason: bool) -> Vec<String> {
        let mut v = Vec::new();
        if !OUTCOMES.contains(&outcome) {
            v.push(format!("unknown outcome {outcome:?}"));
        }
        if !EXECUTION_MODES.contains(&mode) {
            v.push(format!("unknown mode {mode:?}"));
        }
        if !VALIDATION_DISPOSITIONS.contains(&validation) {
            v.push(format!("unknown validation {validation:?}"));
        }
        if outcome == "succeeded" {
            if mode != "live" {
                v.push("succeeded requires mode=live".to_string());
            }
            if validation != "passed" && validation != "not_defined" {
                v.push(format!("succeeded requires validation passed|not_defined, got {validation}"));
            }
            // M0-G05: every reason code is a non-success reason.
            if has_reason {
                v.push("succeeded cannot carry a failure reason".to_string());
            }
        } else if !has_reason {
            v.push(format!("{outcome} requires a reason"));
        }
        if outcome == "simulated" && mode != "demo" {
            v.push("simulated requires mode=demo".to_string());
        }
        if mode == "demo" && !["simulated", "interrupted", "cancelled"].contains(&outcome) {
            v.push(format!("demo mode cannot produce {outcome}"));
        }
        v
    }
}

impl From<TerminalRecordWire> for TerminalRecord {
    fn from(w: TerminalRecordWire) -> Self {
        let violations = TerminalRecord::violations(&w.outcome, &w.mode, &w.validation, w.reason.is_some());
        if violations.is_empty() {
            return TerminalRecord {
                outcome: w.outcome,
                mode: w.mode,
                validation: w.validation,
                reason: w.reason,
                summary: w.summary,
                cost_usd: w.cost_usd,
                artifacts: w.artifacts,
            };
        }
        let claimed = match &w.reason {
            Some(r) => format!("{}({})", w.outcome, r.code),
            None => w.outcome.clone(),
        };
        TerminalRecord {
            outcome: UNVERIFIED.to_string(),
            // The renderer's schema needs a known mode; an unknown one is
            // reported in the detail and never makes the record succeed.
            mode: if EXECUTION_MODES.contains(&w.mode.as_str()) { w.mode } else { "live".to_string() },
            validation: "not_run".to_string(),
            reason: Some(OutcomeReason {
                code: "invalid_record".to_string(),
                message: "Record violates the outcome contract; treated as unverified.".to_string(),
                detail: Some(format!("claimed {claimed}: {}", violations.join("; "))),
            }),
            summary: w.summary,
            cost_usd: w.cost_usd,
            artifacts: w.artifacts,
        }
    }
}

/// Reference to an artifact produced by a unit of work. Mirrors `ArtifactRefSchema`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArtifactRef {
    pub kind: String,
    #[serde(rename = "ref")]
    pub reference: String,
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
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shell must forward the FR-RUN-01 outcome fields verbatim; dropping
    /// `outcome`/`reason` would leave the renderer with an ambiguous record.
    #[test]
    fn delegation_complete_round_trips_outcome_fields() {
        let line = r#"{"type":"delegation_complete","delegationId":"D1","fromBoardId":"coding","outcome":"blocked","mode":"live","validation":"not_run","reason":{"code":"execution_disabled","message":"disabled"},"summary":"did not run","ts":"2026-09-26T00:00:00.000Z"}"#;
        let env: Envelope = serde_json::from_str(line).expect("parses");
        let out = serde_json::to_value(&env).expect("serializes");
        assert_eq!(out["outcome"], "blocked");
        assert_eq!(out["mode"], "live");
        assert_eq!(out["validation"], "not_run");
        assert_eq!(out["reason"]["code"], "execution_disabled");
        assert!(out.get("result").is_none());
    }

    fn complete(fields: &str) -> serde_json::Value {
        let line = format!(
            r#"{{"type":"delegation_complete","delegationId":"D1","fromBoardId":"coding",{fields},"summary":"s","ts":"2026-09-26T00:00:00.000Z"}}"#
        );
        let env: Envelope = serde_json::from_str(&line).expect("parses");
        serde_json::to_value(&env).expect("serializes")
    }

    /// EC1 D3: a live-channel `succeeded` claiming demo mode must never be
    /// forwarded as success.
    #[test]
    fn delegation_complete_demo_succeeded_is_forwarded_as_unverified() {
        let out = complete(r#""outcome":"succeeded","mode":"demo","validation":"not_defined""#);
        assert_eq!(out["outcome"], "unverified");
        assert_eq!(out["validation"], "not_run");
        assert_eq!(out["mode"], "demo");
        assert_eq!(out["reason"]["code"], "invalid_record");
        let detail = out["reason"]["detail"].as_str().unwrap();
        assert!(detail.contains("claimed succeeded"), "{detail}");
        assert!(detail.contains("succeeded requires mode=live"), "{detail}");
        assert_eq!(out["type"], "delegation_complete");
        assert_eq!(out["delegationId"], "D1");
    }

    #[test]
    fn delegation_complete_unknown_outcome_mode_or_validation_is_unverified() {
        for fields in [
            r#""outcome":"success","mode":"live","validation":"not_defined""#,
            r#""outcome":"totally_fine","mode":"live","validation":"passed","reason":{"code":"x","message":"y"}"#,
            r#""outcome":"succeeded","mode":"prod","validation":"passed""#,
            r#""outcome":"succeeded","mode":"live","validation":"skipped""#,
            r#""outcome":"unverified","mode":"live","validation":"not_run","reason":{"code":"x","message":"y"}"#,
        ] {
            let out = complete(fields);
            assert_eq!(out["outcome"], "unverified", "{fields}");
            assert_eq!(out["reason"]["code"], "invalid_record", "{fields}");
            assert!(out["mode"] == "live" || out["mode"] == "demo", "{fields}");
        }
    }

    #[test]
    fn delegation_complete_other_invariant_violations_are_unverified() {
        for fields in [
            // succeeded with a failing validation disposition
            r#""outcome":"succeeded","mode":"live","validation":"failed""#,
            // non-success without a reason
            r#""outcome":"failed","mode":"live","validation":"not_run""#,
            // simulated outside demo mode
            r#""outcome":"simulated","mode":"live","validation":"not_run","reason":{"code":"demo_mode","message":"m"}"#,
            // demo cannot produce blocked
            r#""outcome":"blocked","mode":"demo","validation":"not_run","reason":{"code":"policy_refused","message":"m"}"#,
        ] {
            let out = complete(fields);
            assert_eq!(out["outcome"], "unverified", "{fields}");
            assert_eq!(out["validation"], "not_run", "{fields}");
        }
    }

    /// M0-G05: a `succeeded` record that carries a failure reason is
    /// contradictory and is forwarded as `unverified`, never as success.
    #[test]
    fn delegation_complete_succeeded_with_failure_reason_is_unverified() {
        let out = complete(
            r#""outcome":"succeeded","mode":"live","validation":"not_defined","reason":{"code":"provider_error","message":"m"}"#,
        );
        assert_eq!(out["outcome"], "unverified");
        assert_eq!(out["reason"]["code"], "invalid_record");
        let detail = out["reason"]["detail"].as_str().unwrap();
        assert!(detail.contains("claimed succeeded(provider_error)"), "{detail}");
        assert!(detail.contains("succeeded cannot carry a failure reason"), "{detail}");
    }

    #[test]
    fn delegation_complete_valid_records_pass_through_unchanged() {
        let ok = complete(r#""outcome":"succeeded","mode":"live","validation":"not_defined","costUsd":0.5"#);
        assert_eq!(ok["outcome"], "succeeded");
        assert_eq!(ok["validation"], "not_defined");
        assert_eq!(ok["costUsd"], 0.5);
        assert!(ok.get("reason").is_none());
        let sim = complete(r#""outcome":"simulated","mode":"demo","validation":"not_run","reason":{"code":"demo_mode","message":"m"}"#);
        assert_eq!(sim["outcome"], "simulated");
        assert_eq!(sim["reason"]["code"], "demo_mode");
        let failed = complete(r#""outcome":"failed","mode":"live","validation":"not_run","reason":{"code":"provider_error","message":"m","detail":"401"}"#);
        assert_eq!(failed["outcome"], "failed");
        assert_eq!(failed["reason"]["detail"], "401");
    }

    #[test]
    fn delegation_state_parses() {
        let line = r#"{"type":"delegation_state","delegationId":"D1","fromBoardId":"coding","state":"running","mode":"live","ts":"2026-09-26T00:00:00.000Z"}"#;
        let env: Envelope = serde_json::from_str(line).expect("parses");
        assert!(matches!(env, Envelope::DelegationState { .. }));
    }
}
