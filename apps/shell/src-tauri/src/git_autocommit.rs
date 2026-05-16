//! Git auto-commit — every 5 minutes, commit `vault/` changes only.
//!
//! Per PRD §8.2: vault sync is git-only, with auto-commit every 5 min. This
//! task never pushes; it never commits anything outside `vault/`; it skips
//! silently when not inside a git repo.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use tokio::process::Command;
use tracing::{debug, info, warn};

use crate::channel::EventBus;
use crate::envelope::Envelope;

const INTERVAL_SECS: u64 = 300; // 5 minutes per PRD §8.2

/// Find the workspace root by walking up from cwd looking for `.git/`. Returns
/// `None` if not in a git repo.
fn locate_workspace_root() -> Option<PathBuf> {
    let cwd = std::env::current_dir().ok()?;
    let mut here: &Path = &cwd;
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

/// Spawn the 5-minute interval loop.
///
/// Uses `tauri::async_runtime::spawn` rather than `tokio::spawn` so the caller
/// can invoke this from Tauri's synchronous `setup` callback. Inside that
/// callback the Tokio reactor is owned by Tauri's async runtime; raw
/// `tokio::spawn` would panic with "no reactor running."
pub fn spawn_autocommit(bus: Arc<EventBus>) {
    tauri::async_runtime::spawn(async move {
        let root = match locate_workspace_root() {
            Some(r) => r,
            None => {
                debug!("git_autocommit: not inside a git repo; skipping");
                bus.publish(Envelope::log(
                    "info",
                    "git_autocommit",
                    "not a git repo; vault auto-commit disabled",
                ));
                return;
            }
        };

        let vault = root.join("vault");
        if !vault.exists() {
            debug!("git_autocommit: vault/ does not exist; skipping");
            bus.publish(Envelope::log(
                "info",
                "git_autocommit",
                format!("vault/ does not exist under {}; auto-commit disabled", root.display()),
            ));
            return;
        }

        info!(
            "git_autocommit: armed, watching vault/ under {} (every {INTERVAL_SECS}s)",
            root.display()
        );
        let mut interval = tokio::time::interval(Duration::from_secs(INTERVAL_SECS));
        // First tick fires immediately; skip it so we don't commit right at boot.
        interval.tick().await;

        loop {
            interval.tick().await;
            match try_commit(&root, &bus).await {
                Ok(true) => {}
                Ok(false) => debug!("git_autocommit: no vault/ changes"),
                Err(e) => warn!("git_autocommit: failed: {e}"),
            }
        }
    });
}

/// One commit attempt. Returns Ok(true) if a commit was created.
pub async fn try_commit(root: &Path, bus: &Arc<EventBus>) -> Result<bool> {
    let porcelain = Command::new("git")
        .arg("-C")
        .arg(root)
        .arg("status")
        .arg("--porcelain")
        .arg("vault/")
        .output()
        .await?;
    if !porcelain.status.success() {
        let stderr = String::from_utf8_lossy(&porcelain.stderr);
        bus.publish(Envelope::log(
            "warn",
            "git_autocommit",
            format!("git status failed: {stderr}"),
        ));
        return Ok(false);
    }
    if porcelain.stdout.is_empty() {
        return Ok(false);
    }

    // git add vault/
    let add = Command::new("git")
        .arg("-C")
        .arg(root)
        .arg("add")
        .arg("vault/")
        .output()
        .await?;
    if !add.status.success() {
        let stderr = String::from_utf8_lossy(&add.stderr);
        bus.publish(Envelope::log(
            "warn",
            "git_autocommit",
            format!("git add failed: {stderr}"),
        ));
        return Ok(false);
    }

    // commit message: chore(vault): auto-commit <ISO8601-UTC>
    let stamp = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let message = format!("chore(vault): auto-commit {stamp}");

    let commit = Command::new("git")
        .arg("-C")
        .arg(root)
        .arg("commit")
        .arg("-m")
        .arg(&message)
        .output()
        .await?;
    if !commit.status.success() {
        let stderr = String::from_utf8_lossy(&commit.stderr);
        bus.publish(Envelope::log(
            "warn",
            "git_autocommit",
            format!("git commit failed: {stderr}"),
        ));
        return Ok(false);
    }

    info!("git_autocommit: committed vault/ — {message}");
    bus.publish(Envelope::log(
        "info",
        "git_autocommit",
        format!("committed vault/ — {message}"),
    ));
    Ok(true)
}
