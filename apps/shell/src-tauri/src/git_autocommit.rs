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
use tokio::sync::Mutex;
use tracing::{debug, info, warn};

use crate::channel::EventBus;
use crate::envelope::Envelope;

const INTERVAL_SECS: u64 = 300; // 5 minutes per PRD §8.2

/// Serializes every commit attempt across the whole process. The 5-minute
/// interval loop and the on-demand `vault_autocommit_now` command both reach
/// `try_commit`; without this gate they can fire `git add`/`git commit`
/// concurrently and collide on `.git/index.lock` (git aborts with
/// "Another git process seems to be running"). Holding it for the duration of
/// one commit attempt makes the two paths mutually exclusive.
static COMMIT_LOCK: Mutex<()> = Mutex::const_new(());

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
///
/// Serialized process-wide via [`COMMIT_LOCK`] so the interval loop and the
/// on-demand `vault_autocommit_now` command can never race on `.git/index.lock`.
pub async fn try_commit(root: &Path, bus: &Arc<EventBus>) -> Result<bool> {
    let _guard = COMMIT_LOCK.lock().await;
    commit_locked(root, bus).await
}

/// The actual commit attempt. Callers must already hold [`COMMIT_LOCK`].
async fn commit_locked(root: &Path, bus: &Arc<EventBus>) -> Result<bool> {
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

    // Scope the commit to `vault/` with an explicit pathspec. A bare
    // `git commit -m <msg>` would sweep ANY entry the user already staged
    // outside vault/ into our auto-commit — violating this module's
    // "never commits anything outside vault/" contract and PRD §8.2. The
    // `-- vault/` pathspec commits only matching entries and ignores the rest.
    let commit = Command::new("git")
        .arg("-C")
        .arg(root)
        .arg("commit")
        .arg("-m")
        .arg(&message)
        .arg("--")
        .arg("vault/")
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
