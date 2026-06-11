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

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Result};
use parking_lot::Mutex;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};

use crate::channel::EventBus;
use crate::envelope::Envelope;

/// Upper bound on stdin lines we hold while the sidecar is between spawns.
/// A few queued prompts are worth replaying once the child comes back; an
/// unbounded queue would let a wedged sidecar pin memory, so past this we drop
/// the *oldest* line and report it as failed via a Log envelope. The renderer
/// sees the death (set_tx(None)) and the per-drop log rather than a value that
/// silently vanished into a dead channel.
const MAX_PENDING_LINES: usize = 256;

/// Handle exposed to Tauri commands. Holds the mpsc sender for stdin lines.
#[derive(Clone)]
pub struct SidecarHandle {
    stdin_tx: Arc<Mutex<Option<mpsc::UnboundedSender<String>>>>,
    /// Lines that could not be delivered because the child was absent (or were
    /// queued-but-undrained when it died). Replayed in order to the next child
    /// on spawn so a prompt sent across a restart boundary isn't dropped on the
    /// floor. Bounded by [`MAX_PENDING_LINES`].
    pending: Arc<Mutex<VecDeque<String>>>,
    bus: Arc<EventBus>,
}

impl SidecarHandle {
    pub fn new(bus: Arc<EventBus>) -> Self {
        Self {
            stdin_tx: Arc::new(Mutex::new(None)),
            pending: Arc::new(Mutex::new(VecDeque::new())),
            bus,
        }
    }

    /// Write a JSON line to the sidecar's stdin.
    ///
    /// When the sidecar is alive, the line is handed to the writer task. When
    /// the child is absent (not yet spawned, or dead between restarts), the
    /// line is parked on the bounded [`pending`](Self::pending) queue to be
    /// replayed on the next spawn **and** an error is returned so the caller
    /// (and through it the renderer) learns the prompt did not reach a running
    /// runtime — rather than getting an `Ok` that silently drops into the void.
    pub fn write_line(&self, line: String) -> Result<()> {
        // Take the sender out from under the lock so we don't hold it across
        // the (cheap, non-blocking) `send`.
        let tx = self.stdin_tx.lock().clone();
        match tx {
            Some(tx) => {
                if let Err(e) = tx.send(line.clone()) {
                    // The writer task's receiver was dropped (child died after
                    // we read the sender). Park for replay and surface failure.
                    self.push_pending(line);
                    return Err(anyhow!(
                        "sidecar stdin channel closed mid-write; line queued for replay: {e}"
                    ));
                }
                Ok(())
            }
            None => {
                self.push_pending(line);
                Err(anyhow!(
                    "sidecar not running; line queued for replay once the agent-runtime restarts"
                ))
            }
        }
    }

    /// Park a line for replay on the next spawn. Bounded: on overflow the
    /// oldest pending line is dropped and reported as failed.
    fn push_pending(&self, line: String) {
        let mut q = self.pending.lock();
        if q.len() >= MAX_PENDING_LINES {
            if let Some(dropped) = q.pop_front() {
                let preview: String = dropped.chars().take(120).collect();
                self.bus.publish(Envelope::log(
                    "error",
                    "sidecar",
                    format!("pending stdin queue full; dropped oldest line: {preview}"),
                ));
            }
        }
        q.push_back(line);
    }

    /// Re-queue lines recovered from a dying child's writer at the *front* of
    /// the pending queue, preserving their original send order. These lines
    /// were accepted before anything currently queued, so front-insertion keeps
    /// replay order correct. Still bounded: on overflow the newest (back) lines
    /// are dropped and reported, since the recovered (older) prompts take
    /// precedence.
    fn requeue_pending(&self, lines: Vec<String>) {
        if lines.is_empty() {
            return;
        }
        let mut q = self.pending.lock();
        // Prepend the whole batch in order: insert front-to-back from the end.
        for line in lines.into_iter().rev() {
            q.push_front(line);
        }
        // Enforce the bound by trimming the newest (back) lines.
        while q.len() > MAX_PENDING_LINES {
            if let Some(dropped) = q.pop_back() {
                let preview: String = dropped.chars().take(120).collect();
                self.bus.publish(Envelope::log(
                    "error",
                    "sidecar",
                    format!("pending stdin queue full on requeue; dropped newest line: {preview}"),
                ));
            }
        }
    }

    /// Drain the pending queue, replaying each line into the freshly-spawned
    /// child's stdin. Called once a new writer is wired up. Lines that fail to
    /// enqueue (the brand-new writer already gone) are put back so they survive
    /// to the *next* spawn.
    fn replay_pending(&self, tx: &mpsc::UnboundedSender<String>) {
        let drained: Vec<String> = {
            let mut q = self.pending.lock();
            q.drain(..).collect()
        };
        if drained.is_empty() {
            return;
        }
        info!("replaying {} queued stdin line(s) to restarted sidecar", drained.len());
        for line in drained {
            if let Err(e) = tx.send(line) {
                // Writer already gone again; re-queue the (consumed) line so it
                // isn't lost. `SendError` carries the value back.
                self.push_pending(e.0);
            }
        }
    }

    fn set_tx(&self, tx: Option<mpsc::UnboundedSender<String>>) {
        *self.stdin_tx.lock() = tx;
    }

    /// Publish the new writer AND replay the queued backlog into it as ONE
    /// critical section under the `stdin_tx` lock. `write_line` acquires that same
    /// lock before it can send, so it cannot slip a fresh line in between the
    /// publish and the replay — which would otherwise let a new prompt jump ahead
    /// of the older queued lines (ordering race). Lock order is stdin_tx -> pending,
    /// matching `write_line`'s fail path, so this can't deadlock.
    fn publish_tx_and_replay(&self, tx: mpsc::UnboundedSender<String>) {
        let mut slot = self.stdin_tx.lock();
        *slot = Some(tx.clone());
        let drained: Vec<String> = {
            let mut q = self.pending.lock();
            q.drain(..).collect()
        };
        if !drained.is_empty() {
            info!("replaying {} queued stdin line(s) to restarted sidecar", drained.len());
            for line in drained {
                if let Err(e) = tx.send(line) {
                    self.push_pending(e.0);
                }
            }
        }
    }
}

/// Locate the sidecar entry point. In prod (bundled), it lives under the
/// resource directory; in dev, we prefer the workspace path
/// `${WORKSPACE}/apps/agent-runtime/dist/index.js`.
///
/// ## Bundled-path resolution (the subtle part)
///
/// `tauri.conf.json` bundles the runtime with
/// `resources: ["../../agent-runtime/dist/**/*"]`. Tauri 2 does **not** flatten
/// those `..` segments — it rewrites each leading `..` to a literal `_up_`
/// directory under `$RESOURCE`, so the real on-disk layout is
/// `$RESOURCE/_up_/_up_/agent-runtime/dist/index.js`. The previous code looked
/// under `$RESOURCE/agent-runtime/dist/index.js` and `$RESOURCE/dist/index.js`
/// — neither of which Tauri 2 ever produces — so the packaged app always booted
/// with *no* agent runtime.
///
/// We resolve it via `app.path().resolve(<same string as the config glob's
/// directory>, BaseDirectory::Resource)`, which applies the identical `_up_`
/// rewrite rules and gives us the path Tauri actually wrote.
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

    // Production: ask Tauri to resolve the bundled resource using the *same*
    // relative path we declared in `bundle.resources`. This is the only layout
    // Tauri 2 actually writes (leading `..` -> `_up_`).
    match app
        .path()
        .resolve("../../agent-runtime/dist/index.js", BaseDirectory::Resource)
    {
        Ok(p) => {
            if p.exists() {
                return Some(p);
            }
            warn!(
                "bundled sidecar not found at resolved resource path {}",
                p.display()
            );
        }
        Err(e) => {
            warn!("failed to resolve bundled sidecar resource path: {e}");
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

        // Ensure the writer handle is cleared so `write_line` reports the
        // sidecar as down (and queues for replay) while we're between
        // generations. `spawn_once` already does this on its Ok path; this also
        // covers the Err path where the process refused to start.
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
    // Publish the writer and replay any lines queued while we were down (or
    // undrained when the previous child died) as one critical section, so a
    // concurrent write_line can't jump a fresh prompt ahead of the backlog.
    handle.publish_tx_and_replay(tx.clone());

    // Writer task: drain rx and write `line + "\n"`. On exit it returns any
    // lines it could not write (because the child's stdin broke mid-stream, or
    // because the channel closed with lines still buffered) so the supervisor
    // can re-queue them for replay to the next child instead of dropping them.
    let writer = tokio::spawn(async move {
        let mut stdin = stdin;
        let mut undelivered: Vec<String> = Vec::new();
        while let Some(line) = rx.recv().await {
            if let Err(e) = stdin.write_all(line.as_bytes()).await {
                warn!("sidecar stdin write failed: {e}");
                undelivered.push(line);
                break;
            }
            if let Err(e) = stdin.write_all(b"\n").await {
                warn!("sidecar stdin newline write failed: {e}");
                undelivered.push(line);
                break;
            }
            if let Err(e) = stdin.flush().await {
                warn!("sidecar stdin flush failed: {e}");
                undelivered.push(line);
                break;
            }
        }
        // Drain anything still buffered in the channel (the supervisor drops the
        // sender on child exit, which closes rx; recv() returns remaining items
        // first, then None — but if we broke out on a write error above, pull
        // the rest now so nothing is stranded in the closed channel).
        while let Ok(line) = rx.try_recv() {
            undelivered.push(line);
        }
        debug!("sidecar stdin writer task ending ({} undelivered)", undelivered.len());
        undelivered
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
    // Close the stdin channel so the writer task's `rx.recv()` returns None and
    // the task finishes, handing back any lines it couldn't deliver. We must
    // clear the handle's sender *and* drop our local clone for all senders to be
    // gone; only then does rx close.
    handle.set_tx(None);
    drop(tx);
    // Recover undelivered stdin lines and re-queue them for the next spawn so a
    // prompt in flight when the child died isn't silently lost.
    match writer.await {
        Ok(undelivered) => handle.requeue_pending(undelivered),
        Err(e) => warn!("sidecar stdin writer task panicked: {e}"),
    }
    // Wait for readers to drain.
    let _ = stdout_reader.await;
    let _ = stderr_reader.await;
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channel::EventBus;

    fn handle() -> SidecarHandle {
        SidecarHandle::new(EventBus::new())
    }

    /// Drain an mpsc receiver synchronously into a Vec for assertions.
    fn drain(rx: &mut mpsc::UnboundedReceiver<String>) -> Vec<String> {
        let mut out = Vec::new();
        while let Ok(line) = rx.try_recv() {
            out.push(line);
        }
        out
    }

    /// When the child is absent, `write_line` must NOT return Ok into the void —
    /// it returns an error AND parks the line for replay, so the renderer learns
    /// the prompt didn't land and the prompt survives the restart.
    #[test]
    fn write_line_without_child_errors_and_queues_for_replay() {
        let h = handle();
        let res = h.write_line("{\"type\":\"user_prompt\"}".to_string());
        assert!(res.is_err(), "write_line into a dead sidecar must surface failure");

        // The line is parked, not dropped: replaying it to a fresh writer
        // delivers it.
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        h.replay_pending(&tx);
        assert_eq!(drain(&mut rx), vec!["{\"type\":\"user_prompt\"}".to_string()]);
        // Queue is now empty.
        let (tx2, mut rx2) = mpsc::unbounded_channel::<String>();
        h.replay_pending(&tx2);
        assert!(drain(&mut rx2).is_empty(), "replay drains the pending queue");
    }

    /// Lines queued while down replay to the next child in the order they were
    /// written.
    #[test]
    fn pending_lines_replay_in_fifo_order() {
        let h = handle();
        for i in 0..3 {
            let _ = h.write_line(format!("line-{i}"));
        }
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        h.replay_pending(&tx);
        assert_eq!(drain(&mut rx), vec!["line-0", "line-1", "line-2"]);
    }

    /// Lines recovered from a dying child's writer were accepted *before* any
    /// lines queued afterwards, so they must replay first — `requeue_pending`
    /// prepends them in order.
    #[test]
    fn requeue_prepends_recovered_lines_before_newer_pending() {
        let h = handle();
        // A line arrives while down (queued at back).
        let _ = h.write_line("newer".to_string());
        // The dying writer hands back two undelivered (older) lines, in order.
        h.requeue_pending(vec!["older-a".to_string(), "older-b".to_string()]);

        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        h.replay_pending(&tx);
        assert_eq!(
            drain(&mut rx),
            vec!["older-a", "older-b", "newer"],
            "recovered lines replay ahead of, and in order before, newer queued lines"
        );
    }

    /// The pending queue is bounded — a wedged sidecar can't pin unbounded
    /// memory. Past the cap the oldest line is dropped.
    #[test]
    fn pending_queue_is_bounded() {
        let h = handle();
        for i in 0..(MAX_PENDING_LINES + 5) {
            let _ = h.write_line(format!("l{i}"));
        }
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        h.replay_pending(&tx);
        let drained = drain(&mut rx);
        assert_eq!(drained.len(), MAX_PENDING_LINES, "queue capped at MAX_PENDING_LINES");
        // Oldest 5 dropped, so the first surviving line is l5.
        assert_eq!(drained.first().unwrap(), "l5");
    }
}
