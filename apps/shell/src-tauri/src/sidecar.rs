//! Sidecar — manages the Node 22 LTS agent-runtime child process.
//!
//! Responsibilities:
//! - Locate `apps/agent-runtime/dist/index.js` (resource dir in prod, workspace
//!   in dev).
//! - Spawn via `tokio::process::Command::new("node")` with stdin/stdout/stderr
//!   piped.
//! - Drain a `mpsc<String>` channel into the child's stdin (newline-delimited
//!   JSON; the sidecar speaks JSONL).
//! - Read child stdout line-by-line, deserialize each as `Envelope`,
//!   broadcast to the global UI bus.
//! - Read child stderr line-by-line, surface as `Envelope::Log`.
//! - If the child exits, log + restart with 2s backoff unless the
//!   `SKIPPY_NO_RESTART` env var is set.
//! - Forward `ANTHROPIC_API_KEY` and `SKIPPY_MODEL` to the child env.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Result};
use parking_lot::Mutex;
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};

use crate::channel::EventBus;
use crate::envelope::Envelope;

/// Handle exposed to Tauri commands. Holds the mpsc sender for stdin lines.
#[derive(Clone)]
pub struct SidecarHandle {
    stdin_tx: Arc<Mutex<Option<mpsc::UnboundedSender<String>>>>,
    bus: Arc<EventBus>,
}

impl SidecarHandle {
    pub fn new(bus: Arc<EventBus>) -> Self {
        Self {
            stdin_tx: Arc::new(Mutex::new(None)),
            bus,
        }
    }

    /// Write a JSON line to the sidecar's stdin. Returns an error if the
    /// sidecar has not yet spawned (e.g. dev mode without the dist build).
    pub fn write_line(&self, line: String) -> Result<()> {
        let guard = self.stdin_tx.lock();
        let tx = guard
            .as_ref()
            .ok_or_else(|| anyhow!("sidecar not running; agent-runtime dist not found?"))?;
        tx.send(line)
            .map_err(|e| anyhow!("sidecar stdin channel closed: {e}"))?;
        Ok(())
    }

    fn set_tx(&self, tx: Option<mpsc::UnboundedSender<String>>) {
        *self.stdin_tx.lock() = tx;
    }
}

/// Locate the sidecar entry point. In prod (bundled), it lives under the
/// resource directory at `agent-runtime/dist/index.js`. In dev, we prefer the
/// workspace path `${WORKSPACE}/apps/agent-runtime/dist/index.js`.
fn locate_sidecar_entry(app: &AppHandle) -> Option<PathBuf> {
    // Dev workspace lookup first; cheap and authoritative when present.
    if let Ok(cwd) = std::env::current_dir() {
        let candidates = [
            cwd.join("apps").join("agent-runtime").join("dist").join("index.js"),
            // When run from apps/shell/src-tauri.
            cwd.join("..").join("..").join("agent-runtime").join("dist").join("index.js"),
            // When run from apps/shell.
            cwd.join("..").join("agent-runtime").join("dist").join("index.js"),
        ];
        for c in &candidates {
            if c.exists() {
                return Some(c.clone());
            }
        }
    }

    // Production: Tauri resource dir.
    if let Ok(resource_dir) = app.path().resource_dir() {
        let p = resource_dir
            .join("agent-runtime")
            .join("dist")
            .join("index.js");
        if p.exists() {
            return Some(p);
        }
        // Also try the bare `dist/index.js` layout in case `resources` was
        // configured without the `agent-runtime/` prefix.
        let p2 = resource_dir.join("dist").join("index.js");
        if p2.exists() {
            return Some(p2);
        }
    }

    None
}

/// Spawn-and-supervise loop. Restart with 2s backoff unless
/// `SKIPPY_NO_RESTART` is set.
pub async fn spawn_supervisor(app: AppHandle, handle: SidecarHandle) {
    let no_restart = std::env::var("SKIPPY_NO_RESTART").is_ok();

    loop {
        let entry = match locate_sidecar_entry(&app) {
            Some(p) => p,
            None => {
                let msg = "apps/agent-runtime/dist/index.js not found; sidecar not started. \
                           Run `pnpm --filter @skippy/agent-runtime build`. UI will still load.";
                warn!("{msg}");
                handle.bus.publish(Envelope::log("warn", "sidecar", msg));
                // In dev we deliberately do NOT block startup if the runtime
                // isn't built yet. Sleep and re-check on the next backoff.
                if no_restart {
                    return;
                }
                tokio::time::sleep(Duration::from_secs(5)).await;
                continue;
            }
        };

        info!("spawning sidecar: node {}", entry.display());
        handle.bus.publish(Envelope::log(
            "info",
            "sidecar",
            format!("spawning node {}", entry.display()),
        ));

        match spawn_once(&entry, &handle).await {
            Ok(status) => {
                let msg = format!("sidecar exited with status {status:?}");
                warn!("{msg}");
                handle.bus.publish(Envelope::log("warn", "sidecar", msg));
            }
            Err(e) => {
                let msg = format!("sidecar spawn error: {e}");
                error!("{msg}");
                handle.bus.publish(Envelope::log("error", "sidecar", msg));
            }
        }

        // Drop the writer handle so the renderer knows we're between
        // generations.
        handle.set_tx(None);

        if no_restart {
            info!("SKIPPY_NO_RESTART set; not restarting sidecar");
            return;
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

/// One spawn + watch cycle. Returns the exit status (or an error if the
/// process refused to start at all).
async fn spawn_once(entry: &Path, handle: &SidecarHandle) -> Result<std::process::ExitStatus> {
    let mut cmd = Command::new("node");
    cmd.arg(entry);
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.kill_on_drop(true);

    // Forward env vars that the runtime cares about, if set.
    for var in ["ANTHROPIC_API_KEY", "SKIPPY_MODEL"] {
        if let Ok(v) = std::env::var(var) {
            cmd.env(var, v);
        }
    }

    let mut child: Child = cmd.spawn().map_err(|e| anyhow!("node spawn failed: {e}"))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| anyhow!("sidecar child has no stdin"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("sidecar child has no stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow!("sidecar child has no stderr"))?;

    // mpsc<String> -> child stdin. Unbounded; renderer pacing keeps this sane.
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    handle.set_tx(Some(tx));

    // Writer task: drain rx and write `line + "\n"`.
    let writer = tokio::spawn(async move {
        let mut stdin = stdin;
        while let Some(line) = rx.recv().await {
            if let Err(e) = stdin.write_all(line.as_bytes()).await {
                warn!("sidecar stdin write failed: {e}");
                break;
            }
            if let Err(e) = stdin.write_all(b"\n").await {
                warn!("sidecar stdin newline write failed: {e}");
                break;
            }
            if let Err(e) = stdin.flush().await {
                warn!("sidecar stdin flush failed: {e}");
                break;
            }
        }
        debug!("sidecar stdin writer task ending");
    });

    // stdout reader: parse JSONL into Envelopes and broadcast.
    let bus_out = handle.bus.clone();
    let stdout_reader = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    match serde_json::from_str::<Envelope>(trimmed) {
                        Ok(env) => bus_out.publish(env),
                        Err(e) => {
                            // Non-envelope line; surface as a log so devs can see it.
                            debug!("non-envelope stdout: {trimmed}");
                            bus_out.publish(Envelope::log(
                                "debug",
                                "sidecar.stdout",
                                format!("unparsed line: {trimmed} ({e})"),
                            ));
                        }
                    }
                }
                Ok(None) => {
                    debug!("sidecar stdout EOF");
                    break;
                }
                Err(e) => {
                    warn!("sidecar stdout read error: {e}");
                    break;
                }
            }
        }
    });

    // stderr reader: surface each line as a log envelope.
    let bus_err = handle.bus.clone();
    let stderr_reader = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    if line.trim().is_empty() {
                        continue;
                    }
                    bus_err.publish(Envelope::log("warn", "sidecar.stderr", line));
                }
                Ok(None) => break,
                Err(e) => {
                    warn!("sidecar stderr read error: {e}");
                    break;
                }
            }
        }
    });

    let status = child.wait().await?;
    // Stop the writer first, then wait for readers to drain.
    drop(writer); // dropping the JoinHandle does not cancel; rx will close on tx drop in supervisor.
    let _ = stdout_reader.await;
    let _ = stderr_reader.await;
    Ok(status)
}
