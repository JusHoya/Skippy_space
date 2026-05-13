//! PTY — one ConPTY per agent + one for the interactive user shell.
//!
//! Uses `portable-pty` v0.8 with `NativePtySystem`. On Windows this maps to
//! ConPTY (Win10 1809+). We prefer `pwsh.exe` (PowerShell 7) if present in
//! PATH, falling back to `powershell.exe -NoLogo`.
//!
//! Each PTY gets a UUID v4 id; a `Mutex<HashMap<String, PtyEntry>>` lives in
//! Tauri app state. The read loop emits raw bytes as UTF-8 (lossy) chunks via
//! a per-PTY `tauri::ipc::Channel<String>` registered with `pty_subscribe`.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Arc;

use anyhow::{anyhow, Result};
use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tauri::ipc::Channel;
use tokio::sync::mpsc;
use tracing::{debug, info, warn};
use uuid::Uuid;

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
        });

        // Spawn the reader thread (blocking I/O, so a dedicated OS thread).
        spawn_reader_thread(id.clone(), entry.clone(), reader, sub_rx);

        self.inner.lock().insert(id.clone(), entry);
        info!("opened pty {id} ({cols}x{rows})");
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
            // Drop the entry; the reader thread will see EOF and exit.
            drop(entry);
            info!("closed pty {pty_id}");
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
    // Cheap PATH lookup; we don't need the resolved path because portable-pty
    // does its own PATH resolution.
    let path = match std::env::var_os("PATH") {
        Some(p) => p,
        None => return false,
    };
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join("pwsh.exe");
        if candidate.is_file() {
            return true;
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
