//! `dispatch_set_model` — Phase 3-prep (Zone 5).
//!
//! Renderer → sidecar control message: rebind a scope to a model. The shell
//! serializes the payload as a `set_model` JSONL envelope and pushes it down
//! the same stdin pipe used by `dispatch_user_prompt`. The agent-runtime's
//! `modelRegistry.ts` parses the line and updates its in-process binding so
//! the next LLM call from that scope picks up the new model.
//!
//! Wire shape (mirrors `packages/shared/src/phase3prep.ts::SetModelEnvelope`):
//!   { "type": "set_model", "scope": "skippy" | "board.<id>",
//!     "modelId": "claude-opus-4-7", "ts": "2026-05-15T..." }
//!
//! Coordinated with the shared envelope schema and `envelope.rs::SetModel`.
//! The struct here is deliberately a *separate* serializable shape so we don't
//! depend on the union-level `Envelope` enum's `tag = "type"` machinery — the
//! one-shot `serde_json::to_string` over this minimal struct produces the
//! exact JSONL line the sidecar expects without any wrapping or nesting.

use serde::Serialize;
use tauri::State;

use crate::AppState;

/// Compact serializable shape that hits the sidecar's stdin as one line.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SetModelLine {
    /// Always the literal `"set_model"`. Discriminator the runtime switches on.
    #[serde(rename = "type")]
    kind: &'static str,
    /// `"skippy"` or `"board.<id>"`. Validated upstream in the renderer.
    scope: String,
    /// One of the `AVAILABLE_MODELS` ids in `@skippy/shared`.
    model_id: String,
    /// RFC-3339 timestamp; the runtime uses it for telemetry, not dedup.
    ts: String,
}

/// Forward a model-rebind to the sidecar. The renderer calls
/// `await invoke('dispatch_set_model', { scope, modelId })`; we serialize +
/// write one JSONL line and return Ok. Errors here are surfaced to the
/// renderer as plain strings (matching the existing command pattern).
#[tauri::command]
pub async fn dispatch_set_model(
    scope: String,
    model_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let payload = SetModelLine {
        kind: "set_model",
        scope,
        model_id,
        ts: chrono::Utc::now().to_rfc3339(),
    };
    let line = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
    state.sidecar.write_line(line).map_err(|e| e.to_string())?;
    Ok(())
}
