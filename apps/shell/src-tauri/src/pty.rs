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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::{anyhow, Result};
use parking_lot::Mutex;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tauri::ipc::Channel;
use tokio::sync::mpsc;
use tracing::{debug, info, warn};
use uuid::Uuid;

/// Upper bound on chunks buffered before a subscriber attaches. Shell banners
/// and `claude --print` preamble fit comfortably; past this we drop the oldest
/// chunks so a never-subscribed PTY can't grow without bound (PRD §5 review:
/// subscribe()'s flush contract must be honored *and* memory-safe).
const MAX_EARLY_CHUNKS: usize = 256;

use crate::channel::EventBus;
use crate::envelope::Envelope;

/// Per-PTY entry stored in the manager. The master is held behind a Mutex so
/// `pty_write` / `pty_resize` / `pty_close` can mutate it from Tauri command
/// handlers. The reader thread holds its own clone of the reader half.
pub struct PtyEntry {
    /// Lock around the master half. `Box<dyn MasterPty + Send>` is portable-pty's owning handle.
    /// Taken (`Option::take`) on `pty_close` so dropping it sends EOF to the
    /// reader thread and tears down the ConPTY master.
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    /// Writer half of the master, kept separately so we can take a writer at
    /// `pty_open` time and hold it for the lifetime of the PTY.
    writer: Mutex<Box<dyn Write + Send>>,
    /// Killer split out from the spawned child. Holding it lets `pty_close`
    /// terminate the user-shell (or claude-code) process — previously the
    /// child handle was discarded at spawn, so closed tabs leaked processes.
    /// `Option` because `kill()` consumes the ability after the first call.
    child_killer: Mutex<Option<Box<dyn ChildKiller + Send + Sync>>>,
    /// Channel the subscriber registered via `pty_subscribe` writes into.
    /// `Mutex<Option<...>>` because subscription happens after open.
    sink: Mutex<Option<Channel<String>>>,
    /// Bounded buffer of decoded chunks produced before any subscriber
    /// attached. Flushed in order to the first subscriber by `subscribe`,
    /// honoring its "queued output can be flushed" contract.
    early_buf: Mutex<Vec<String>>,
    /// Set true on `pty_close` so the reader thread exits promptly even if the
    /// `read` it's parked on hasn't yet returned EOF.
    shutdown: Arc<AtomicBool>,
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
        // Spawn the child and split out a killer so `pty_close` can terminate
        // it. Dropping the master alone is not enough on Windows: ConPTY keeps
        // the child alive until it notices the broken pipe, which can leave a
        // long-lived shell running after the tab is closed.
        let child = pair.slave.spawn_command(cmd)?;
        let child_killer = child.clone_killer();
        // The `Child` itself isn't needed past this point for the user shell —
        // we only need to kill it on close and we've cloned the killer. Drop it
        // to release the extra handle.
        drop(child);
        // Drop the slave so we don't keep an extra handle on it.
        drop(pair.slave);

        let writer = pair.master.take_writer()?;
        let reader = pair.master.try_clone_reader()?;

        let id = Uuid::new_v4().to_string();
        let (sub_tx, sub_rx) = mpsc::unbounded_channel::<Channel<String>>();
        let shutdown = Arc::new(AtomicBool::new(false));

        let entry = Arc::new(PtyEntry {
            master: Mutex::new(Some(pair.master)),
            writer: Mutex::new(writer),
            child_killer: Mutex::new(Some(child_killer)),
            sink: Mutex::new(None),
            early_buf: Mutex::new(Vec::new()),
            shutdown: shutdown.clone(),
            subscribe_tx: sub_tx,
            spawn_id: Mutex::new(None),
        });

        // Spawn the reader thread (blocking I/O, so a dedicated OS thread).
        spawn_reader_thread(id.clone(), entry.clone(), reader, sub_rx, shutdown);

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
        // Split out a killer before the child is moved into the exit-watcher
        // task below, so `pty_close` can terminate it independently of the
        // thread parked in `Child::wait`.
        let child_killer = child.clone_killer();
        drop(pair.slave);

        let writer = pair.master.take_writer()?;
        let reader = pair.master.try_clone_reader()?;

        let id = Uuid::new_v4().to_string();
        let (sub_tx, sub_rx) = mpsc::unbounded_channel::<Channel<String>>();
        let shutdown = Arc::new(AtomicBool::new(false));

        let entry = Arc::new(PtyEntry {
            master: Mutex::new(Some(pair.master)),
            writer: Mutex::new(writer),
            child_killer: Mutex::new(Some(child_killer)),
            sink: Mutex::new(None),
            early_buf: Mutex::new(Vec::new()),
            shutdown: shutdown.clone(),
            subscribe_tx: sub_tx,
            spawn_id: Mutex::new(Some(spawn_id.clone())),
        });

        spawn_reader_thread(id.clone(), entry.clone(), reader, sub_rx, shutdown);

        // Insert into the manager map *before* spawning the exit watcher so the
        // entry is guaranteed present when the watcher later removes it on exit.
        self.inner.lock().insert(id.clone(), entry);

        // Ordering gate: the caller (`claude_code_spawn`) publishes
        // `ClaudeCodeSpawned` immediately after this function returns. A child
        // that exits instantly could otherwise let the watcher publish
        // `ClaudeCodeExited` *before* the spawn envelope — and the renderer's
        // `markExited` is a no-op for an unknown spawn, so the exit would be lost
        // and the tab would hang "running" forever. We hold the watcher behind a
        // oneshot that we only fire once the entry is registered and we're about
        // to hand control back to the caller, so the exit can never overtake the
        // spawn.
        let (spawned_gate_tx, spawned_gate_rx) = tokio::sync::oneshot::channel::<()>();

        // Wait for the child and publish the exit envelope, then evict the map
        // entry. portable-pty's `Child` is `Send` but not `Sync`; ownership
        // transfers cleanly into the task. We do the blocking `Child::wait`
        // inside `spawn_blocking` so a tokio worker isn't pinned for the whole
        // subprocess lifetime, and await the spawn gate first.
        let pty_id_for_task = id.clone();
        let spawn_id_for_task = spawn_id.clone();
        let bus_for_task = bus.clone();
        let map_for_task = self.inner.clone();
        tokio::spawn(async move {
            // Block the exit publish until the spawn envelope is on its way.
            // If the sender is dropped (open path errored out), proceed anyway —
            // we still need to reap the child and clean up the map entry.
            let _ = spawned_gate_rx.await;

            let pty_id_for_wait = pty_id_for_task.clone();
            let exit_code = tokio::task::spawn_blocking(move || {
                let mut child = child;
                match child.wait() {
                    Ok(s) => {
                        // portable-pty's `ExitStatus::exit_code()` is `u32`; on
                        // Windows there's no signal concept so this is the actual
                        // exit code. Cast to i32 for parity with the TS-side
                        // `number|null` shape.
                        Some(s.exit_code() as i32)
                    }
                    Err(e) => {
                        warn!("claude_code pty {pty_id_for_wait} wait failed: {e}");
                        None
                    }
                }
            })
            .await
            .unwrap_or(None);

            match exit_code {
                Some(code) => info!(
                    "claude_code pty {pty_id_for_task} exited (code={code}, spawn_id={spawn_id_for_task})"
                ),
                None => info!(
                    "claude_code pty {pty_id_for_task} exit code unavailable (spawn_id={spawn_id_for_task})"
                ),
            }

            // Evict the now-dead entry from the manager map. Dropping the entry
            // releases the ConPTY master + writer; the reader thread already
            // observed EOF. A later `pty_close` for this id becomes a clean
            // "no such pty" rather than acting on a corpse.
            map_for_task.lock().remove(&pty_id_for_task);

            let env = Envelope::ClaudeCodeExited {
                spawn_id: spawn_id_for_task,
                pty_id: pty_id_for_task,
                exit_code,
                ts: chrono::Utc::now().to_rfc3339(),
            };
            bus_for_task.publish(env);
        });

        info!(
            "opened claude_code pty {id} ({cols}x{rows}, program={program}, spawn_id={spawn_id})"
        );
        // Release the watcher now that the entry is registered and we're
        // returning to the caller, which publishes `ClaudeCodeSpawned` next.
        let _ = spawned_gate_tx.send(());
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
        match master.as_ref() {
            Some(m) => {
                m.resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })?;
                Ok(())
            }
            // Master already taken by a concurrent `pty_close`; the PTY is on
            // its way out, so a resize is a harmless no-op.
            None => Err(anyhow!("pty {pty_id} is closing")),
        }
    }

    pub fn close(&self, pty_id: &str) -> Result<()> {
        let mut map = self.inner.lock();
        if let Some(entry) = map.remove(pty_id) {
            // If this PTY was hosting a claude-code subprocess, the spawn_id
            // is on the entry — preserve it in the log so the renderer's
            // tab-close event can be correlated against the spawn record.
            let spawn_id = entry.spawn_id.lock().clone();

            // 1. Tell the reader thread to stop looping (it re-checks this flag
            //    after every read and before sleeping).
            entry.shutdown.store(true, Ordering::SeqCst);

            // 2. Kill the child process. Dropping the master alone does not
            //    reliably reap the child on Windows/ConPTY, so we terminate it
            //    explicitly. `kill` is idempotent-ish here: if the child has
            //    already exited the OS returns an error we can safely ignore.
            if let Some(mut killer) = entry.child_killer.lock().take() {
                if let Err(e) = killer.kill() {
                    debug!("pty {pty_id} child kill returned {e} (likely already exited)");
                }
            }

            // 3. Drop the ConPTY master. This closes the read side, so the
            //    reader thread's blocking `read` returns EOF and the thread
            //    exits even if it was parked when we set the shutdown flag.
            let _ = entry.master.lock().take();

            // The exit-watcher task (claude-code PTYs only) will observe the
            // child's exit and publish the matching `claude_code_exited`
            // envelope.
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

        // Hold the sink lock across the whole flush+register so the reader
        // thread (which takes the same lock to decide "route to sink vs.
        // buffer") cannot interleave a fresh chunk between the flush and the
        // registration — that would reorder output. Drain the buffer, send it,
        // then publish the sink, all under one lock.
        let mut sink = entry.sink.lock();
        let queued: Vec<String> = std::mem::take(&mut *entry.early_buf.lock());
        for chunk in queued {
            if let Err(e) = channel.send(chunk) {
                warn!("pty {pty_id} early-flush send failed: {e}");
                return Err(anyhow!("subscriber channel closed during flush: {e}"));
            }
        }
        *sink = Some(channel.clone());
        drop(sink);

        // Tell the reader thread about the new channel as well so its cached
        // sink (refreshed via the mpsc, independent of the Mutex) stays in
        // sync for resubscription.
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

/// Decode the next chunk of PTY bytes into a UTF-8 `String`, carrying any
/// trailing incomplete multibyte sequence forward via `carry`.
///
/// ConPTY emits raw UTF-8; a fixed-size `read` can land mid-codepoint, so
/// decoding each read independently (as the old code did with
/// `from_utf8_lossy`) turned every split character into a U+FFFD replacement —
/// mojibake in the terminal. Here we:
///
/// 1. prepend any bytes carried over from the previous read to `bytes`,
/// 2. find the longest valid UTF-8 prefix,
/// 3. emit that prefix as a `String`,
/// 4. stash the remaining (incomplete) tail back into `carry` for next time.
///
/// Genuinely invalid bytes (not just a truncated tail) are replaced lossily so
/// a single bad byte can't wedge the stream. On EOF the caller flushes any
/// residual `carry` (see [`flush_carry`]).
fn decode_with_carry(carry: &mut Vec<u8>, bytes: &[u8]) -> String {
    // Combine the carried tail with the freshly-read bytes.
    let mut combined: Vec<u8> = Vec::with_capacity(carry.len() + bytes.len());
    combined.append(carry); // moves carry's contents out, leaving it empty
    combined.extend_from_slice(bytes);

    match std::str::from_utf8(&combined) {
        Ok(s) => s.to_owned(),
        Err(e) => {
            let valid_up_to = e.valid_up_to();
            // SAFETY: `valid_up_to` is, by definition, a valid UTF-8 boundary.
            let good = unsafe { std::str::from_utf8_unchecked(&combined[..valid_up_to]) }.to_owned();
            let rest = &combined[valid_up_to..];
            match e.error_len() {
                // `None` => the tail is a *truncated* (but so-far-valid) multibyte
                // sequence. Carry it forward to be completed by the next read.
                None => {
                    carry.extend_from_slice(rest);
                    good
                }
                // `Some(len)` => `rest` starts with genuinely invalid bytes.
                // Emit a replacement char for them and decode whatever follows
                // lossily so we don't lose the rest of the chunk.
                Some(len) => {
                    let mut out = good;
                    out.push('\u{FFFD}');
                    let tail = &rest[len..];
                    // Recurse on the remainder: it may itself end in a
                    // truncated sequence we need to carry.
                    out.push_str(&decode_with_carry(carry, tail));
                    out
                }
            }
        }
    }
}

/// Flush any bytes left in `carry` at EOF as a lossy string. A well-behaved
/// stream ends on a codepoint boundary so this is usually empty, but a process
/// killed mid-write can leave a dangling partial sequence.
fn flush_carry(carry: &mut Vec<u8>) -> Option<String> {
    if carry.is_empty() {
        return None;
    }
    let tail = std::mem::take(carry);
    Some(String::from_utf8_lossy(&tail).into_owned())
}

/// Dedicated OS thread that owns the reader half of a PTY and forwards bytes
/// to whichever `Channel<String>` is currently subscribed. Before a subscriber
/// attaches, decoded chunks are parked in a bounded buffer and flushed by
/// [`PtyManager::subscribe`]. Lives until EOF or until `pty_close` signals
/// `shutdown` and drops the master (which forces the blocking read to EOF).
fn spawn_reader_thread(
    id: String,
    entry: Arc<PtyEntry>,
    mut reader: Box<dyn Read + Send>,
    mut subscribe_rx: mpsc::UnboundedReceiver<Channel<String>>,
    shutdown: Arc<AtomicBool>,
) {
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        // Trailing bytes of an incomplete UTF-8 sequence, carried between reads.
        let mut carry: Vec<u8> = Vec::new();
        loop {
            if shutdown.load(Ordering::SeqCst) {
                break;
            }
            // Try to refresh the channel without blocking. Done under the sink
            // lock so it stays consistent with the routing decision below.
            while let Ok(ch) = subscribe_rx.try_recv() {
                *entry.sink.lock() = Some(ch);
            }

            match reader.read(&mut buf) {
                Ok(0) => {
                    debug!("pty {id} EOF");
                    if let Some(tail) = flush_carry(&mut carry) {
                        route_chunk(&id, &entry, tail);
                    }
                    break;
                }
                Ok(n) => {
                    let chunk = decode_with_carry(&mut carry, &buf[..n]);
                    if !chunk.is_empty() {
                        route_chunk(&id, &entry, chunk);
                    }
                }
                Err(e) => {
                    // A dropped master (on close) surfaces here as an error on
                    // some platforms rather than a clean EOF; treat shutdown as
                    // expected and stay quiet.
                    if shutdown.load(Ordering::SeqCst) {
                        debug!("pty {id} read ended after close: {e}");
                    } else {
                        warn!("pty {id} read error: {e}");
                    }
                    break;
                }
            }
        }
    });
}

/// Route one decoded chunk to the live subscriber, or buffer it (bounded) if
/// none has attached yet. Holding the `sink` lock for the whole decision keeps
/// this mutually exclusive with [`PtyManager::subscribe`]'s flush, so output
/// can never be reordered across the subscribe boundary.
fn route_chunk(id: &str, entry: &PtyEntry, chunk: String) {
    let mut sink = entry.sink.lock();
    match sink.as_ref() {
        Some(ch) => {
            if let Err(e) = ch.send(chunk) {
                warn!("pty {id} channel send failed: {e}");
                // Subscriber went away; clear so we don't keep trying.
                *sink = None;
            }
        }
        None => {
            // No subscriber yet — park the chunk for the first subscriber to
            // flush. Bound the buffer so a never-subscribed PTY can't grow
            // without limit; drop the oldest chunk on overflow.
            let mut early = entry.early_buf.lock();
            if early.len() >= MAX_EARLY_CHUNKS {
                early.remove(0);
            }
            early.push(chunk);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A multibyte UTF-8 codepoint split across two reads must decode intact,
    /// not as mojibake. Uses U+1F37A BEER MUG (🍺, 4 bytes: F0 9F 8D BA) — apt
    /// for a fleet of beercan sprites — split after the second byte.
    #[test]
    fn multibyte_codepoint_split_across_chunks_decodes_intact() {
        let beer = "🍺";
        let bytes = beer.as_bytes();
        assert_eq!(bytes.len(), 4, "🍺 should be 4 UTF-8 bytes");

        let (first, second) = bytes.split_at(2);

        let mut carry: Vec<u8> = Vec::new();

        // First read ends mid-codepoint: no complete char yet, tail carried.
        let out1 = decode_with_carry(&mut carry, first);
        assert_eq!(out1, "", "no complete codepoint should be emitted yet");
        assert_eq!(carry, first, "the incomplete tail must be carried forward");

        // Second read completes the codepoint.
        let out2 = decode_with_carry(&mut carry, second);
        assert_eq!(out2, beer, "the split codepoint should decode intact");
        assert!(carry.is_empty(), "carry should be drained once complete");
    }

    /// A three-way split (one byte per read) of the same 4-byte codepoint also
    /// reassembles correctly, exercising repeated carry accumulation.
    #[test]
    fn multibyte_codepoint_split_byte_by_byte_decodes_intact() {
        let snowman = "☃"; // U+2603, 3 bytes: E2 98 83
        let bytes = snowman.as_bytes();
        assert_eq!(bytes.len(), 3);

        let mut carry: Vec<u8> = Vec::new();
        let mut assembled = String::new();
        for b in bytes {
            assembled.push_str(&decode_with_carry(&mut carry, &[*b]));
        }
        assembled.push_str(&flush_carry(&mut carry).unwrap_or_default());
        assert_eq!(assembled, snowman);
        assert!(carry.is_empty());
    }

    /// ASCII plus a clean trailing codepoint decodes in one shot with no carry.
    #[test]
    fn complete_chunk_leaves_no_carry() {
        let mut carry: Vec<u8> = Vec::new();
        let out = decode_with_carry(&mut carry, "monkey ☕".as_bytes());
        assert_eq!(out, "monkey ☕");
        assert!(carry.is_empty());
    }

    /// Genuinely invalid bytes (not a truncated tail) become a replacement
    /// char and don't wedge the stream or get stuck in the carry.
    #[test]
    fn invalid_bytes_become_replacement_and_clear_carry() {
        let mut carry: Vec<u8> = Vec::new();
        // 0xFF is never valid UTF-8; surround it with ASCII.
        let out = decode_with_carry(&mut carry, &[b'a', 0xFF, b'b']);
        assert_eq!(out, "a\u{FFFD}b");
        assert!(carry.is_empty());
    }

    /// EOF flush surfaces a dangling partial sequence lossily rather than
    /// silently swallowing it.
    #[test]
    fn flush_carry_emits_residual_partial_sequence() {
        let mut carry: Vec<u8> = vec![0xF0, 0x9F]; // first half of 🍺
        let flushed = flush_carry(&mut carry);
        assert!(flushed.is_some());
        assert!(carry.is_empty());
        // Empty carry flushes to None.
        assert!(flush_carry(&mut carry).is_none());
    }

    /// `close` must remove the entry from the manager map, so a *second* close
    /// for the same id is a clean "no such pty" rather than acting on a corpse.
    /// This is the map-eviction invariant the `claude_code` exit-watcher relies
    /// on (it calls the same `map.remove`): once an entry is evicted, a later
    /// `pty_close` for that id can't double-kill or resurrect it. We exercise the
    /// real `open` path (a ConPTY-backed shell) so the removal is end-to-end, not
    /// a mocked map. Skipped gracefully if no shell is on PATH (portable CI).
    #[test]
    fn close_evicts_entry_so_second_close_is_no_such_pty() {
        // The user-shell open path uses pwsh/powershell; if neither resolves on
        // PATH (e.g. a stripped CI container) there's nothing to open, so skip
        // rather than fail spuriously.
        if !is_on_path("pwsh.exe") && !is_on_path("powershell.exe") {
            eprintln!("no PowerShell on PATH; skipping ConPTY close-eviction test");
            return;
        }

        let mgr = PtyManager::new();
        let id = mgr.open(80, 24).expect("open a user-shell PTY");
        // The freshly-opened PTY is in the map.
        assert!(mgr.get(&id).is_ok(), "opened PTY should be present in the map");

        // First close tears it down and removes it from the map.
        mgr.close(&id).expect("first close should succeed");

        // The entry is gone: a second close — and any later lookup — sees a
        // clean miss, proving the map was evicted rather than left holding a
        // dead entry. This is exactly the post-exit state the exit-watcher
        // produces via `map_for_task.lock().remove(&pty_id)`.
        assert!(
            mgr.get(&id).is_err(),
            "closed PTY must be evicted from the map"
        );
        let second = mgr.close(&id);
        assert!(
            second.is_err(),
            "second close of an evicted PTY must be a clean 'no such pty', not a corpse op"
        );
        assert!(
            second.unwrap_err().to_string().contains("no such pty"),
            "the miss should surface as the canonical 'no such pty' error"
        );
    }
}
