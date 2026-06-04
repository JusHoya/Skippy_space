//! Replay session reader — Phase 3 / WS8 (PRD §9.5).
//!
//! The Node sidecar writes one `.jsonl` replay file per session under
//! `vault/.skippy/replays/`. This module exposes two Tauri commands the
//! renderer's `ReplayScrubber` calls over IPC:
//!
//!   * `replay_list_sessions` — enumerate the available replay files (id, abs
//!     path, size, mtime). Returns an empty vec when the dir is absent.
//!   * `replay_load` — return the raw `.jsonl` contents for one session id,
//!     after validating the id is a bare filename (no path traversal).
//!
//! The vault root is resolved the same way `project_tree`/`vault_autocommit`
//! resolve the workspace root: walk up from the cwd to the first `.git/`, then
//! descend into `vault/.skippy/replays/`.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

/// One discovered replay file. Field names are camelCase on the wire so the
/// renderer can consume the struct verbatim via Tauri IPC.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaySession {
    session_id: String,
    path: String,
    size_bytes: u64,
    modified_ms: u64,
}

/// Walk up from `start` until a `.git` directory is found. Mirrors the pattern
/// used by `project_tree::locate_workspace_root` and `vault_autocommit_now`.
fn locate_workspace_root(start: &Path) -> Option<PathBuf> {
    let mut here: &Path = start;
    loop {
        if here.join(".git").exists() {
            return Some(here.to_path_buf());
        }
        match here.parent() {
            Some(p) => here = p,
            None => return None,
        }
    }
}

/// Resolve `<workspace>/vault/.skippy/replays`. Falls back to the cwd-relative
/// path when no `.git/` ancestor exists — callers tolerate a missing dir.
fn replays_dir() -> Result<PathBuf, String> {
    let cwd = std::env::current_dir().map_err(|e| format!("cwd unreadable: {e}"))?;
    let root = locate_workspace_root(&cwd).unwrap_or(cwd);
    Ok(root.join("vault").join(".skippy").join("replays"))
}

/// Convert a `SystemTime` to milliseconds since the Unix epoch (0 on error).
fn system_time_to_ms(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Validate that `session_id` is a bare filename — no path separators, no `..`,
/// no drive/root components — so `replay_load` can never escape the replays dir.
fn is_safe_session_id(session_id: &str) -> bool {
    if session_id.is_empty() {
        return false;
    }
    if session_id.contains('/') || session_id.contains('\\') {
        return false;
    }
    if session_id.contains("..") {
        return false;
    }
    // A single path component whose `file_name()` round-trips to itself is safe.
    let p = Path::new(session_id);
    p.components().count() == 1 && p.file_name().and_then(|s| s.to_str()) == Some(session_id)
}

/// Tauri command: list the available replay sessions. Never errors on a missing
/// directory — returns an empty vec so the renderer can show "no replays yet".
#[tauri::command]
pub async fn replay_list_sessions() -> Result<Vec<ReplaySession>, String> {
    let dir = replays_dir()?;
    let read = match fs::read_dir(&dir) {
        Ok(r) => r,
        // Missing dir (no session has ever run) → empty, not an error.
        Err(_) => return Ok(Vec::new()),
    };

    let mut sessions: Vec<ReplaySession> = Vec::new();
    for entry in read.flatten() {
        let path = entry.path();
        // Only `*.jsonl` files are replay logs.
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        let session_id = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let modified_ms = meta.modified().map(system_time_to_ms).unwrap_or(0);
        sessions.push(ReplaySession {
            session_id,
            path: path.to_string_lossy().replace('\\', "/"),
            size_bytes: meta.len(),
            modified_ms,
        });
    }

    // Newest first — the most recently-modified session is the likely default.
    sessions.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    Ok(sessions)
}

/// Tauri command: return the raw `.jsonl` contents for one replay session.
/// Validates `session_id` is a bare filename to prevent path traversal.
#[tauri::command]
pub async fn replay_load(session_id: String) -> Result<String, String> {
    if !is_safe_session_id(&session_id) {
        return Err(format!("invalid session id: {session_id}"));
    }
    let dir = replays_dir()?;
    let file = dir.join(format!("{session_id}.jsonl"));
    fs::read_to_string(&file).map_err(|e| format!("read {}: {e}", file.display()))
}
