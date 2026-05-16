//! PTY — one ConPTY per agent + one for the interactive user shell.
//!
//! Uses `portable-pty` v0.8 with `NativePtySystem`. On Windows this maps to
//! ConPTY (Win10 1809+). We prefer `pwsh.exe` (PowerShell 7) if present in
//! PATH, falling back to `powershell.exe -NoLogo`.
//!
//! Each PTY gets a UUID v4 id; a `Mutex<HashMap<String, PtyEntry>>` lives in
//! Tauri app state. The read loop emits raw bytes as UTF-8 (lossy) chunks via
//! a per-PTY `tauri::ipc::Channel<String>` registered with `pty_subscribe`.
//!
//! Phase 3-prep extension: `open_command` spawns an arbitrary executable in a
//! PTY (used by `claude_code_spawn`) — same machinery as `open()` but with a
//! caller-supplied program/args/env/cwd, and the child handle is parked on a
//! tokio task that publishes a `ClaudeCodeExited` envelope on exit. PRD §5.1
//! / §10 / R-01: the `claude` CLI must be Rust-spawned, never Node-spawned.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::Arc;

use anyhow::{anyhow, Result};
use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tauri::ipc::Channel;
use tokio::sync::mpsc;
use tracing::{debug, info, warn};
use uuid::Uuid;

use crate::channel::EventBus;
use crate::envelope::Envelope;

/// Per-PTY entry stored in the manager. The master is held behind a Mutex so
/// `pty_write` / `pty_resize` / `pty_close` can mutate it from Tauri command
/// handlers. The reader thread holds its own clone of the reader half.
pub struct PtyEntry {
    /// Lock around the master half. `Box<dyn MasterPty + Send>` is portable-pty's owning handle.
    master: Mutex<Box<dyn MasterPty + Send>>,
    /// Writer half of the master, kept separately so we can take a writer at
    /// `pty_open` time and hold it for the lifetime of the PTY.
    writer: Mutex<Box<dyn Write + Send>>,
    /// Channel the subscriber registered via `pty_subscribe` writes into.
    /// `Mutex<Option<...>>` because subscription happens after open.
    sink: Mutex<Option<Channel<String>>>,
    /// Notifies the reader task that the subscriber is ready or has changed.
    subscribe_tx: mpsc::UnboundedSender<Channel<String>>,
    /// If this PTY is hosting a claude-code subprocess, the spawnId is stored
    /// here so the `ClaudeCodeExited` envelope can be correlated with the
    /// matching `ClaudeCodeSpawned` and the renderer's TerminalCluster tab.
    spawn_id: Mutex<Option<String>>,
}

/// Manager — owns the map.
#[derive(Clone, Default)]
pub struct PtyManager {
    inner: Arc<Mutex<HashMap<String, Arc<PtyEntry>>>>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Open a new PTY. Returns the freshly-minted id.
    pub fn open(&self, cols: u16, rows: u16) -> Result<String> {
        let pty_system = native_pty_system();
        let pair = pty_system.openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;

        // Pick a shell: prefer pwsh in PATH, fall back to powershell.
        let cmd = build_shell_command();
        // Spawn the child; we don't keep the child handle around in this
        // scaffold (PRD §10). The PTY pair holds the slave end alive; when we
        // drop the master, the child is reaped by Windows on stream close.
        let _child = pair.slave.spawn_command(cmd)?;
        // Drop the slave so we don't keep an extra handle on it.
        drop(pair.slave);

        let writer = pair.master.take_writer()?;
        let reader = pair.master.try_clone_reader()?;

        let id = Uuid::new_v4().to_string();
        let (sub_tx, sub_rx) = mpsc::unbounded_channel::<Channel<String>>();

        let entry = Arc::new(PtyEntry {
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            sink: Mutex::new(None),
            subscribe_tx: sub_tx,
            spawn_id: Mutex::new(None),
        });

        // Spawn the reader thread (blocking I/O, so a dedicated OS thread).
        spawn_reader_thread(id.clone(), entry.clone(), reader, sub_rx);

        self.inner.lock().insert(id.clone(), entry);
        info!("opened pty {id} ({cols}x{rows})");
        Ok(id)
    }

    /// Open a PTY hosting an arbitrary executable. Used by `claude_code_spawn`
    /// to launch the `claude` CLI in `--print --output-format stream-json`
    /// mode. Unlike [`open`], this:
    ///
    /// * accepts caller-supplied `program`, `args`, `env`, and `cwd`,
    /// * stashes the supplied `spawn_id` on the entry so cleanup can find both,
    /// * holds the child handle on a dedicated tokio task that waits for exit
    ///   and publishes a [`Envelope::ClaudeCodeExited`] envelope onto the
    ///   shared event bus.
    ///
    /// Returns the same `ptyId` shape as [`open`] so the renderer can use the
    /// existing `pty_subscribe` / `pty_write` / `pty_resize` / `pty_close`
    /// machinery against it.
    ///
    /// On failure to locate the binary (PATH miss) or to spawn it (ConPTY
    /// error, working dir denied, etc.), returns an `anyhow::Error` rather
    /// than panicking — the caller is expected to surface it to the renderer.
    pub fn open_command(
        &self,
        program: &str,
        args: &[&str],
        env: &[(&str, &str)],
        cwd: &Path,
        cols: u16,
        rows: u16,
        spawn_id: String,
        bus: Arc<EventBus>,
    ) -> Result<String> {
        let pty_system = native_pty_system();
        let pair = pty_system.openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;

        // Cheap pre-flight: if the binary isn't on PATH at all, fail fast
        // with a friendly error instead of letting portable-pty surface a
        // raw OS error. Dev envs without `claude` installed are the common
        // miss here (PRD R-01 mitigation: report it, don't crash).
        if !is_on_path(program) {
            return Err(anyhow!(
                "executable `{program}` not found on PATH; install it or extend PATH"
            ));
        }

        let mut cb = CommandBuilder::new(program);
        for a in args {
            cb.arg(*a);
        }
        for (k, v) in env {
            cb.env(*k, *v);
        }
        // Working directory: portable-pty validates it lazily on spawn, so
        // any IO error there is reported below as a `spawn` failure.
        cb.cwd(cwd);

        // Spawn the child and hold the handle so we can wait on it.
        let child = pair
            .slave
            .spawn_command(cb)
            .map_err(|e| anyhow!("spawn `{program}` failed: {e}"))?;
        drop(pair.slave);

        let writer = pair.master.take_writer()?;
        let reader = pair.master.try_clone_reader()?;

        let id = Uuid::new_v4().to_string();
        let (sub_tx, sub_rx) = mpsc::unbounded_channel::<Channel<String>>();

        let entry = Arc::new(PtyEntry {
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            sink: Mutex::new(None),
            subscribe_tx: sub_tx,
            spawn_id: Mutex::new(Some(spawn_id.clone())),
        });

        spawn_reader_thread(id.clone(), entry.clone(), reader, sub_rx);

        // Wait for the child on a dedicated tokio task. portable-pty's
        // `Child` is `Send` but not `Sync`; ownership transfers cleanly.
        // We use `spawn_blocking` because `Child::wait` is blocking and we
        // don't want to occupy a tokio worker thread for the full lifetime
        // of the subprocess.
        let pty_id_for_task = id.clone();
        let spawn_id_for_task = spawn_id.clone();
        let bus_for_task = bus.clone();
        tokio::task::spawn_blocking(move || {
            let mut child = child;
            let exit_status = match child.wait() {
                Ok(s) => s,
                Err(e) => {
                    warn!("claude_code pty {pty_id_for_task} wait failed: {e}");
                    let env = Envelope::ClaudeCodeExited {
                        spawn_id: spawn_id_for_task,
                        pty_id: pty_id_for_task,
                        exit_code: None,
                        ts: chrono::Utc::now().to_rfc3339(),
                    };
                    bus_for_task.publish(env);
                    return;
                }
            };
            // portable-pty's `ExitStatus::exit_code()` is `u32`; on Windows
            // there's no signal concept so this is the actual exit code.
            // We cast to i32 for parity with the TS-side `number|null` shape.
            let code = exit_status.exit_code() as i32;
            info!(
                "claude_code pty {pty_id_for_task} exited (code={code}, spawn_id={spawn_id_for_task})"
            );
            let env = Envelope::ClaudeCodeExited {
                spawn_id: spawn_id_for_task,
                pty_id: pty_id_for_task,
                exit_code: Some(code),
                ts: chrono::Utc::now().to_rfc3339(),
            };
            bus_for_task.publish(env);
        });

        self.inner.lock().insert(id.clone(), entry);
        info!(
            "opened claude_code pty {id} ({cols}x{rows}, program={program}, spawn_id={spawn_id})"
        );
        Ok(id)
    }

    pub fn write(&self, pty_id: &str, data: &str) -> Result<()> {
        let entry = self.get(pty_id)?;
        let mut w = entry.writer.lock();
        w.write_all(data.as_bytes())?;
        w.flush()?;
        Ok(())
    }

    pub fn resize(&self, pty_id: &str, cols: u16, rows: u16) -> Result<()> {
        let entry = self.get(pty_id)?;
        let master = entry.master.lock();
        master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }

    pub fn close(&self, pty_id: &str) -> Result<()> {
        let mut map = self.inner.lock();
        if let Some(entry) = map.remove(pty_id) {
            // If this PTY was hosting a claude-code subprocess, the spawn_id
            // is on the entry — preserve it in the log so the renderer's
            // tab-close event can be correlated against the spawn record.
            let spawn_id = entry.spawn_id.lock().clone();
            // Drop the entry; the reader thread will see EOF and exit. The
            // exit-watcher task will then observe the child's exit code and
            // publish the matching `claude_code_exited` envelope.
            drop(entry);
            match spawn_id {
                Some(sid) => info!("closed pty {pty_id} (claude_code spawn_id={sid})"),
                None => info!("closed pty {pty_id}"),
            }
            Ok(())
        } else {
            Err(anyhow!("no such pty: {pty_id}"))
        }
    }

    pub fn subscribe(&self, pty_id: &str, channel: Channel<String>) -> Result<()> {
        let entry = self.get(pty_id)?;
        // Replace the sink and tell the reader thread about the new channel so
        // any queued output can be flushed to it.
        *entry.sink.lock() = Some(channel.clone());
        entry
            .subscribe_tx
            .send(channel)
            .map_err(|e| anyhow!("subscriber channel closed: {e}"))?;
        Ok(())
    }

    fn get(&self, pty_id: &str) -> Result<Arc<PtyEntry>> {
        self.inner
            .lock()
            .get(pty_id)
            .cloned()
            .ok_or_else(|| anyhow!("no such pty: {pty_id}"))
    }
}

/// Pick `pwsh.exe` if available, otherwise `powershell.exe -NoLogo`.
fn build_shell_command() -> CommandBuilder {
    if which_pwsh() {
        let mut cb = CommandBuilder::new("pwsh.exe");
        cb.arg("-NoLogo");
        cb
    } else {
        let mut cb = CommandBuilder::new("powershell.exe");
        cb.arg("-NoLogo");
        cb
    }
}

fn which_pwsh() -> bool {
    is_on_path("pwsh.exe")
}

/// Cheap PATH probe. Returns `true` if `program` (or, on Windows, any of its
/// PATHEXT-style siblings — `.exe`, `.cmd`, `.bat`) exists in any PATH entry.
/// We don't need the resolved path because `portable-pty` does its own
/// resolution; the probe is just to give a friendly error before we hand the
/// name to `CommandBuilder`.
fn is_on_path(program: &str) -> bool {
    let path = match std::env::var_os("PATH") {
        Some(p) => p,
        None => return false,
    };
    // If the caller already supplied an extension, just look for the literal.
    let has_ext = std::path::Path::new(program).extension().is_some();
    // PATHEXT defaults on Windows; npm "shims" install both `claude` (no ext)
    // and `claude.cmd`. We probe each variant.
    let pathext_default = ".COM;.EXE;.BAT;.CMD";
    let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| pathext_default.to_string());
    let exts: Vec<String> = if has_ext {
        vec![String::new()]
    } else {
        let mut v = vec![String::new()]; // try the bare name first (Unix-style shims)
        for ext in pathext.split(';') {
            let ext = ext.trim();
            if !ext.is_empty() {
                v.push(ext.to_string());
            }
        }
        v
    };
    for dir in std::env::split_paths(&path) {
        for ext in &exts {
            let candidate = if ext.is_empty() {
                dir.join(program)
            } else {
                dir.join(format!("{program}{ext}"))
            };
            if candidate.is_file() {
                return true;
            }
        }
    }
    false
}

/// Dedicated OS thread that owns the reader half of a PTY and forwards bytes
/// to whichever `Channel<String>` is currently subscribed. Lives until EOF.
fn spawn_reader_thread(
    id: String,
    entry: Arc<PtyEntry>,
    mut reader: Box<dyn Read + Send>,
    mut subscribe_rx: mpsc::UnboundedReceiver<Channel<String>>,
) {
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            // Try to refresh the channel without blocking.
            while let Ok(ch) = subscribe_rx.try_recv() {
                *entry.sink.lock() = Some(ch);
            }

            match reader.read(&mut buf) {
                Ok(0) => {
                    debug!("pty {id} EOF");
                    break;
                }
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buf[..n]).into_owned();
                    let sink = entry.sink.lock().clone();
                    if let Some(ch) = sink {
                        if let Err(e) = ch.send(chunk) {
                            warn!("pty {id} channel send failed: {e}");
                            // Subscriber went away; clear so we don't keep trying.
                            *entry.sink.lock() = None;
                        }
                    }
                    // If no subscriber yet, the bytes are dropped. xterm
                    // typically subscribes before sending input so this is
                    // only a concern for cold-start lag.
                }
                Err(e) => {
                    warn!("pty {id} read error: {e}");
                    break;
                }
            }
        }
    });
}
