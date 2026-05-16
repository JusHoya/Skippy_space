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
