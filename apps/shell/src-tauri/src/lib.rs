//! Skippy_space shell — Tauri 2 Rust core.
//!
//! Boots the Tauri app, spawns the Node sidecar, owns the PTY manager, runs
//! the 5-minute git auto-commit task, and exposes a set of commands that the
//! React renderer calls over Tauri IPC.
//!
//! Per CLAUDE.md and PRD §5 the renderer is dumb: all process orchestration,
//! filesystem trust, and credential handling live here.

mod channel;
mod claude_spawn;
mod cmd_set_model;
mod envelope;
mod git_autocommit;
mod project_tree;
mod pty;
mod replay;
mod sidecar;

use std::sync::Arc;

use serde::Serialize;
use tauri::{ipc::Channel, State};
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;
use uuid::Uuid;

use crate::channel::EventBus;
use crate::envelope::Envelope;
use crate::pty::PtyManager;
use crate::sidecar::SidecarHandle;

/// Default Claude model used when `claude_code_spawn` receives no `model`
/// override. Mirrors `AVAILABLE_MODELS[1].id` in `packages/shared/src/phase3prep.ts`
/// — the Sonnet 4.6 tier, which is the recommended default for board work.
const DEFAULT_CLAUDE_MODEL: &str = "claude-sonnet-4-6";

/// Shared app state injected into every Tauri command handler.
pub struct AppState {
    pub sidecar: SidecarHandle,
    pub pty: PtyManager,
    pub bus: Arc<EventBus>,
}

// ---------- Tauri commands ----------

/// Forward a user prompt to the Node sidecar as a `user_prompt` envelope.
/// Returns the generated promptId so the renderer can correlate downstream
/// `agent_state` / `agent_token` / `agent_complete` events.
#[tauri::command]
async fn dispatch_user_prompt(text: String, state: State<'_, AppState>) -> Result<String, String> {
    let prompt_id = Uuid::new_v4().to_string();
    let ts = chrono::Utc::now().to_rfc3339();
    let env = Envelope::UserPrompt {
        prompt_id: prompt_id.clone(),
        text,
        ts,
    };
    // Mirror to the UI bus so any open panel sees the dispatch immediately.
    state.bus.publish(env.clone());
    let line = serde_json::to_string(&env).map_err(|e| e.to_string())?;
    state.sidecar.write_line(line).map_err(|e| e.to_string())?;
    Ok(prompt_id)
}

#[tauri::command]
async fn pty_open(cols: u16, rows: u16, state: State<'_, AppState>) -> Result<String, String> {
    state.pty.open(cols, rows).map_err(|e| e.to_string())
}

#[tauri::command]
async fn pty_write(pty_id: String, data: String, state: State<'_, AppState>) -> Result<(), String> {
    state.pty.write(&pty_id, &data).map_err(|e| e.to_string())
}

#[tauri::command]
async fn pty_resize(
    pty_id: String,
    cols: u16,
    rows: u16,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.pty.resize(&pty_id, cols, rows).map_err(|e| e.to_string())
}

#[tauri::command]
async fn pty_close(pty_id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.pty.close(&pty_id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn pty_subscribe(
    pty_id: String,
    channel: Channel<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.pty.subscribe(&pty_id, channel).map_err(|e| e.to_string())
}

#[tauri::command]
async fn events_subscribe(channel: Channel<Envelope>, state: State<'_, AppState>) -> Result<(), String> {
    state.bus.register(channel);
    Ok(())
}

// ---------- claude_code_spawn (PRD §5.1, §10, R-01) ----------

/// Wire-format result of `claude_code_spawn`. Mirrors
/// `ClaudeCodeSpawnResult` in `packages/shared/src/phase3prep.ts`.
/// All field names are explicit camelCase to match the TS contract — Serde
/// serializes structs as JSON objects, so the renderer receives this verbatim
/// via Tauri IPC.
#[derive(Debug, Clone, Serialize)]
struct ClaudeCodeSpawnResultDto {
    #[serde(rename = "spawnId")]
    spawn_id: String,
    #[serde(rename = "ptyId")]
    pty_id: String,
    #[serde(rename = "parentAgentId")]
    parent_agent_id: String,
    model: String,
    cwd: String,
}

/// Resolve the project root: prefer the current working directory but walk
/// upward until we hit a `.git` directory. Tauri's working dir at runtime is
/// `apps/shell/src-tauri` in dev mode, so we usually walk up two levels.
fn resolve_project_root() -> Result<std::path::PathBuf, String> {
    let here = std::env::current_dir().map_err(|e| format!("cwd unreadable: {e}"))?;
    let mut probe = here.as_path();
    loop {
        if probe.join(".git").exists() {
            return Ok(probe.to_path_buf());
        }
        match probe.parent() {
            Some(p) => probe = p,
            // Fall back to the current directory if we never find `.git` —
            // safer than refusing to spawn at all.
            None => return Ok(here),
        }
    }
}

/// Availability of the PTY claude lane for the renderer's "R" slot. See
/// `claude_spawn` for the gate. Cheap; no side effects.
#[tauri::command]
fn claude_code_spawn_availability() -> claude_spawn::SpawnAvailability {
    claude_spawn::availability(std::env::var(claude_spawn::OPT_IN_ENV).ok().as_deref())
}

/// Spawn a `claude` CLI subprocess in a PTY on behalf of an agent (Skippy or
/// a Board captain). PRD §5.1 + R-01 require this to be Rust-spawned via
/// `portable-pty`, never from the Node sidecar — `Node-spawning-claude-code`
/// is a known-broken combination (issues #34 + #771).
///
/// INELIGIBLE BY DEFAULT (FR-SEC-01, red-team N3): this lane has no enforced
/// charter policy — the shell cannot broker the CLI's tool calls, so the
/// user's own `~/.claude` permissions/hooks/MCP would apply instead of the
/// charter. It refuses with a structured `ineligible` error unless the
/// developer opt-in `SKIPPY_ALLOW_UNGATED_CLAUDE_SPAWN=1` is set, in which
/// case it logs loudly and still passes the strongest native restriction
/// flags (`--permission-mode default`, `--setting-sources=`,
/// `--strict-mcp-config`; never a bypass). The enforced adapter is T10.
///
/// Returns the spawn metadata so the renderer can attach a TerminalCluster
/// tab to the PTY via the existing `pty_subscribe` channel.
///
/// Failure modes:
/// * ineligible (no opt-in) — structured `{code: "ineligible", message}`.
/// * `claude` not on PATH — surfaced as `executable claude not found on PATH`.
/// * cwd unreadable / PTY open failure — surfaced verbatim from portable-pty.
/// In all cases we *do not* publish a `claude_code_spawned` envelope; the
/// renderer learns about the failure via the rejected promise.
#[tauri::command]
async fn claude_code_spawn(
    parent_agent_id: String,
    task_brief: String,
    model: Option<String>,
    cwd: Option<String>,
    state: State<'_, AppState>,
) -> Result<ClaudeCodeSpawnResultDto, claude_spawn::SpawnRefusal> {
    let refusal = |message: String| claude_spawn::SpawnRefusal {
        code: "spawn_failed",
        message,
    };

    // Gate first: nothing below runs for an ineligible lane.
    claude_spawn::gate(std::env::var(claude_spawn::OPT_IN_ENV).ok().as_deref()).inspect_err(|r| {
        warn!("claude_code_spawn refused for parent={parent_agent_id}: {}", r.message);
    })?;
    warn!(
        "claude_code_spawn: UNGATED developer lane active ({}=1) for parent={parent_agent_id}; \
         the charter policy is NOT enforced, only native CLI flags apply",
        claude_spawn::OPT_IN_ENV
    );

    let resolved_model = model.unwrap_or_else(|| DEFAULT_CLAUDE_MODEL.to_string());
    let resolved_cwd_path = match cwd {
        Some(p) => {
            let pb = std::path::PathBuf::from(p);
            if !pb.is_absolute() {
                return Err(refusal("cwd must be an absolute path".to_string()));
            }
            pb
        }
        None => resolve_project_root().map_err(refusal)?,
    };
    let resolved_cwd_str = resolved_cwd_path
        .to_str()
        .ok_or_else(|| refusal("cwd contains non-utf8 bytes".to_string()))?
        .to_string();
    let spawn_id = Uuid::new_v4().to_string();

    // Structured argv (never a shell string); see `claude_spawn::build_args`
    // for the flag-by-flag rationale and the `--help` evidence.
    let owned_args = claude_spawn::build_args(&task_brief, &resolved_model);
    let args: Vec<&str> = owned_args.iter().map(String::as_str).collect();
    // ANTHROPIC_API_KEY is the only env var the CLI strictly needs; we forward
    // it from the shell's env if set. (claude also reads ~/.claude credentials
    // if the user has run `claude auth`, so this is best-effort.)
    let mut env_pairs: Vec<(&str, &str)> = Vec::new();
    let api_key_env = std::env::var("ANTHROPIC_API_KEY").ok();
    if let Some(ref v) = api_key_env {
        env_pairs.push(("ANTHROPIC_API_KEY", v.as_str()));
    }

    let pty_id = state
        .pty
        .open_command(
            "claude",
            &args,
            &env_pairs,
            &resolved_cwd_path,
            120,
            30,
            spawn_id.clone(),
            state.bus.clone(),
        )
        .map_err(|e| refusal(e.to_string()))?;

    let ts = chrono::Utc::now().to_rfc3339();
    state.bus.publish(Envelope::ClaudeCodeSpawned {
        spawn_id: spawn_id.clone(),
        pty_id: pty_id.clone(),
        parent_agent_id: parent_agent_id.clone(),
        model: resolved_model.clone(),
        cwd: resolved_cwd_str.clone(),
        ts,
    });

    info!(
        "claude_code_spawn ok: spawn_id={spawn_id} pty_id={pty_id} parent={parent_agent_id} model={resolved_model}"
    );

    Ok(ClaudeCodeSpawnResultDto {
        spawn_id,
        pty_id,
        parent_agent_id,
        model: resolved_model,
        cwd: resolved_cwd_str,
    })
}

/// Trigger an immediate git auto-commit cycle. Useful for the UI "commit
/// vault now" affordance and for tests.
#[tauri::command]
async fn vault_autocommit_now(state: State<'_, AppState>) -> Result<(), String> {
    let root = std::env::current_dir().map_err(|e| e.to_string())?;
    // Walk up to the repo root just like the supervisor does.
    let mut here = root.as_path();
    let repo_root = loop {
        if here.join(".git").exists() {
            break here.to_path_buf();
        }
        match here.parent() {
            Some(p) => here = p,
            None => return Err("not inside a git repo".to_string()),
        }
    };
    git_autocommit::try_commit(&repo_root, &state.bus)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------- Entry point ----------

/// Initialize tracing with `RUST_LOG` or a sensible default.
fn init_tracing() {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,skippy_shell_lib=debug"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(true)
        .try_init();
}

pub fn run() {
    init_tracing();
    info!("skippy_shell booting");

    let bus = EventBus::new();
    let sidecar_handle = SidecarHandle::new(bus.clone());
    let pty_manager = PtyManager::new();

    let state = AppState {
        sidecar: sidecar_handle.clone(),
        pty: pty_manager.clone(),
        bus: bus.clone(),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        // tauri-plugin-updater is wired in Phase 4 along with the EV cert and
        // signing keypair (PRD §11.2 + §14.5). Without those configured it
        // panics at boot on the missing `plugins.updater` config block.
        // .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(state)
        .setup(move |app| {
            let handle = app.handle().clone();
            let sidecar_for_task = sidecar_handle.clone();
            tauri::async_runtime::spawn(async move {
                sidecar::spawn_supervisor(handle, sidecar_for_task).await;
            });
            git_autocommit::spawn_autocommit(bus.clone());
            warn!("skippy_shell setup complete; awaiting renderer");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            dispatch_user_prompt,
            pty_open,
            pty_write,
            pty_resize,
            pty_close,
            pty_subscribe,
            events_subscribe,
            vault_autocommit_now,
            claude_code_spawn,
            claude_code_spawn_availability,
            cmd_set_model::dispatch_set_model,
            project_tree::project_tree_scan,
            replay::replay_list_sessions,
            replay::replay_load,
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Skippy_space shell");
}
