//! Skippy_space shell — Tauri 2 Rust core.
//!
//! Boots the Tauri app, spawns the Node sidecar, owns the PTY manager, runs
//! the 5-minute git auto-commit task, and exposes a set of commands that the
//! React renderer calls over Tauri IPC.
//!
//! Per CLAUDE.md and PRD §5 the renderer is dumb: all process orchestration,
//! filesystem trust, and credential handling live here.

mod channel;
mod envelope;
mod git_autocommit;
mod pty;
mod sidecar;

use std::sync::Arc;

use tauri::{ipc::Channel, Manager, State};
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;
use uuid::Uuid;

use crate::channel::EventBus;
use crate::envelope::Envelope;
use crate::pty::PtyManager;
use crate::sidecar::SidecarHandle;

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
        .plugin(tauri_plugin_updater::Builder::new().build())
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
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Skippy_space shell");
}
