//! Envelope — the event contract between the Node sidecar, the Rust shell, and the React renderer.
//!
//! Mirrors `packages/shared/src/envelope.ts`. JSON discriminant is `type` in
//! `snake_case` (e.g. `user_prompt`, `agent_state`, `agent_token`,
//! `agent_complete`, `log`). Adapter properties on the wire use camelCase
//! (`promptId`, `agentId`, `totalTokens`) so the renderer can consume the
//! envelope verbatim without renaming.
//!
//! Coordinated with sibling agents (R/UI/Runtime). Do not change variant names
//! or field names without a synchronized update across `packages/shared/`,
//! `apps/agent-runtime/`, and `apps/ui/`.

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
