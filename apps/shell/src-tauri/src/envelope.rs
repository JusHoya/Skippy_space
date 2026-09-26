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
    /// shell forwards it verbatim and never infers success. Mirrors
    /// `DelegationCompleteEnvelope` + `TerminalRecordShape` in @skippy/shared.
    DelegationComplete {
        #[serde(rename = "delegationId")]
        delegation_id: String,
        #[serde(rename = "fromBoardId")]
        from_board_id: String,
        outcome: String,
        mode: String,
        validation: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<OutcomeReason>,
        summary: String,
        #[serde(rename = "costUsd", skip_serializing_if = "Option::is_none")]
        cost_usd: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        artifacts: Option<Vec<ArtifactRef>>,
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

    #[test]
    fn delegation_state_parses() {
        let line = r#"{"type":"delegation_state","delegationId":"D1","fromBoardId":"coding","state":"running","mode":"live","ts":"2026-09-26T00:00:00.000Z"}"#;
        let env: Envelope = serde_json::from_str(line).expect("parses");
        assert!(matches!(env, Envelope::DelegationState { .. }));
    }
}
