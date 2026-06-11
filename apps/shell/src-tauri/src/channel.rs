//! Channel registry — bridges the sidecar's broadcast bus to per-renderer
//! Tauri 2 `tauri::ipc::Channel<T>` subscribers.
//!
//! The renderer calls `events_subscribe(channel)` at boot; we register the
//! channel here and feed every `Envelope` from the sidecar broadcast into
//! it. Multiple windows / panels can subscribe and each gets its own
//! independent fan-out task driven off a `broadcast::Receiver`.

use std::collections::VecDeque;
use std::sync::Arc;

use parking_lot::Mutex;
use tauri::ipc::Channel;
use tokio::sync::broadcast;
use tracing::{debug, warn};

use crate::envelope::Envelope;

/// How many recent *lifecycle* envelopes to retain for replay to renderers that
/// subscribe after boot. Lifecycle events are one-shot (a board spawning, a
/// model rebind, a claude PTY opening) — if the renderer mounts a beat late it
/// would otherwise never learn the current topology. 64 comfortably covers the
/// 8 boards + staff + a handful of model/spawn events without unbounded growth.
const LIFECYCLE_REPLAY_CAP: usize = 64;

/// State for the global UI event channel.
///
/// `tx` is the single broadcast sender that the sidecar reader task pushes
/// envelopes into. The renderer-facing `Channel<Envelope>` instances are held
/// in `subscribers` so they survive the duration of the registration but the
/// real fan-out is driven by spawned tasks reading from `tx.subscribe()`.
pub struct EventBus {
    tx: broadcast::Sender<Envelope>,
    subscribers: Mutex<Vec<Channel<Envelope>>>,
    /// Bounded ring of recent lifecycle/state envelopes, replayed in order to
    /// each new subscriber so a renderer that registers after boot still learns
    /// the current board/model/spawn topology. High-frequency streaming events
    /// (tokens, logs, telemetry spans) are deliberately excluded — see
    /// [`is_lifecycle`].
    lifecycle_replay: Mutex<VecDeque<Envelope>>,
}

/// Classify an envelope as a *lifecycle/state* event worth replaying to a late
/// subscriber. These are low-frequency, one-shot or last-write-wins events that
/// establish the renderer's view of the world. Streaming/append events
/// (`AgentToken`, `Log`, `TelemetrySpan`, …) are excluded: they're either
/// transient or reconstructed from the live stream, and replaying them would
/// double-count tokens and spam the console.
fn is_lifecycle(env: &Envelope) -> bool {
    matches!(
        env,
        Envelope::AgentState { .. }
            | Envelope::BoardSpawned { .. }
            | Envelope::BoardReady { .. }
            | Envelope::BoardState { .. }
            | Envelope::Delegation { .. }
            | Envelope::DelegationAck { .. }
            | Envelope::DelegationComplete { .. }
            | Envelope::SetModel { .. }
            | Envelope::ClaudeCodeSpawned { .. }
            | Envelope::ClaudeCodeExited { .. }
    )
}

impl EventBus {
    pub fn new() -> Arc<Self> {
        // Capacity 1024 is generous for a UI bus; lagging consumers drop oldest
        // events with a warn-level log inside the spawned fan-out tasks.
        let (tx, _rx) = broadcast::channel::<Envelope>(1024);
        Arc::new(Self {
            tx,
            subscribers: Mutex::new(Vec::new()),
            lifecycle_replay: Mutex::new(VecDeque::with_capacity(LIFECYCLE_REPLAY_CAP)),
        })
    }

    /// Producer-side handle. The sidecar reader task calls `bus.publish(env)`.
    pub fn publish(&self, env: Envelope) {
        // Retain lifecycle envelopes for late-subscriber replay *before*
        // broadcasting, so a renderer that registers between this push and the
        // next still sees it. Bounded ring; oldest lifecycle event is evicted.
        if is_lifecycle(&env) {
            let mut ring = self.lifecycle_replay.lock();
            if ring.len() >= LIFECYCLE_REPLAY_CAP {
                ring.pop_front();
            }
            ring.push_back(env.clone());
        }
        // Send returns Err only when there are zero receivers, which is fine —
        // the lifecycle ring above still captured it for whoever subscribes
        // next, so the boot-before-subscribe window no longer loses state.
        let _ = self.tx.send(env);
    }

    /// Renderer-side registration. Wires a `tauri::ipc::Channel<Envelope>` to
    /// the bus by spawning a fan-out task that reads from `tx.subscribe()` and
    /// sends each envelope down the channel.
    ///
    /// Two resilience guarantees beyond a naive fan-out:
    ///
    /// 1. **Late-subscriber replay.** Before wiring the live stream we resubscribe
    ///    *then* flush the retained lifecycle ring, so a renderer that mounts after
    ///    boot still learns the current board/model/spawn topology rather than
    ///    losing every one-shot lifecycle envelope that fired before it arrived.
    ///    We subscribe before replaying so no live event can slip through the gap
    ///    between the two steps.
    /// 2. **Lag-aware resync.** If this consumer falls behind and the broadcast
    ///    buffer overruns (`RecvError::Lagged`), we don't silently desync — we log
    ///    a resync marker and re-send the lifecycle ring so the renderer can
    ///    rebuild authoritative state for everything except the dropped streaming
    ///    deltas.
    pub fn register(self: &Arc<Self>, channel: Channel<Envelope>) {
        // Subscribe first so any envelope published during replay is also queued
        // on `rx` and delivered by the live loop below (it will be a harmless
        // duplicate of a replayed lifecycle event, which the renderer dedupes by
        // id, rather than a lost one).
        let mut rx = self.tx.subscribe();

        // Replay retained lifecycle state to the freshly-registered channel.
        for env in self.snapshot_lifecycle() {
            if let Err(e) = channel.send(env) {
                warn!("event channel lifecycle replay failed (renderer closed early): {e}");
                return;
            }
        }

        let outbound = channel.clone();
        self.subscribers.lock().push(channel);

        let bus = Arc::clone(self);
        tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(env) => {
                        if let Err(e) = outbound.send(env) {
                            warn!("event channel send failed (renderer probably closed): {e}");
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        // The renderer fell behind and lost `n` envelopes. Signal
                        // an explicit resync instead of silently desyncing, then
                        // re-establish authoritative lifecycle state by replaying
                        // the retained ring. Streaming deltas (tokens) in the gap
                        // are genuinely gone, but board/model/spawn state is
                        // rebuilt rather than left stale forever.
                        warn!("event bus lagged by {n} envelopes — resyncing slow consumer");
                        let marker = Envelope::log(
                            "warn",
                            "event-bus.resync",
                            format!(
                                "renderer lagged; dropped {n} envelope(s); replaying lifecycle state"
                            ),
                        );
                        if outbound.send(marker).is_err() {
                            break;
                        }
                        let mut closed = false;
                        for env in bus.snapshot_lifecycle() {
                            if outbound.send(env).is_err() {
                                closed = true;
                                break;
                            }
                        }
                        if closed {
                            break;
                        }
                        continue;
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        debug!("event bus closed; ending fan-out task");
                        break;
                    }
                }
            }
        });
    }

    /// Snapshot the retained lifecycle ring in publish order. Cloned out from
    /// under the lock so callers can send without holding it.
    fn snapshot_lifecycle(&self) -> Vec<Envelope> {
        self.lifecycle_replay.lock().iter().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn board_spawned(id: &str) -> Envelope {
        Envelope::BoardSpawned {
            board_id: id.to_string(),
            agent_id: format!("{id}.captain"),
            model: "claude-sonnet-4-6".to_string(),
            ts: "2026-06-10T00:00:00Z".to_string(),
        }
    }

    fn agent_token(text: &str) -> Envelope {
        Envelope::AgentToken {
            agent_id: "skippy".to_string(),
            prompt_id: "p-1".to_string(),
            text: text.to_string(),
            ts: "2026-06-10T00:00:00Z".to_string(),
        }
    }

    /// Lifecycle/state envelopes are retained; high-frequency streaming and log
    /// envelopes are not — replaying tokens would double-count, replaying logs
    /// would spam the console.
    #[test]
    fn is_lifecycle_admits_state_excludes_streaming() {
        assert!(is_lifecycle(&board_spawned("coding")));
        assert!(is_lifecycle(&Envelope::SetModel {
            scope: "skippy".into(),
            model_id: "claude-opus-4-8".into(),
            ts: "2026-06-10T00:00:00Z".into(),
        }));
        assert!(is_lifecycle(&Envelope::ClaudeCodeSpawned {
            spawn_id: "s-1".into(),
            pty_id: "pty-1".into(),
            parent_agent_id: "skippy".into(),
            model: "claude-sonnet-4-6".into(),
            cwd: "/repo".into(),
            ts: "2026-06-10T00:00:00Z".into(),
        }));
        // Streaming + log envelopes must be excluded.
        assert!(!is_lifecycle(&agent_token("hi")));
        assert!(!is_lifecycle(&Envelope::log("info", "src", "msg")));
    }

    /// A subscriber that registers after lifecycle events were published still
    /// learns them via the replay ring, and in publish order — this is the
    /// boot-before-subscribe window the finding flags. Token/log noise is not
    /// replayed.
    #[test]
    fn late_subscriber_sees_buffered_lifecycle_in_order() {
        let bus = EventBus::new();
        bus.publish(board_spawned("engineering"));
        bus.publish(agent_token("noise")); // not retained
        bus.publish(board_spawned("coding"));
        bus.publish(Envelope::log("info", "src", "noise")); // not retained

        let snap = bus.snapshot_lifecycle();
        assert_eq!(snap.len(), 2, "only the two lifecycle events are retained");
        match (&snap[0], &snap[1]) {
            (
                Envelope::BoardSpawned { board_id: a, .. },
                Envelope::BoardSpawned { board_id: b, .. },
            ) => {
                assert_eq!(a, "engineering", "publish order preserved");
                assert_eq!(b, "coding");
            }
            other => panic!("unexpected retained envelopes: {other:?}"),
        }
    }

    /// The replay ring is bounded: once past the cap the oldest lifecycle event
    /// is evicted so a long session can't grow it without limit.
    #[test]
    fn lifecycle_ring_is_bounded_and_evicts_oldest() {
        let bus = EventBus::new();
        for i in 0..(LIFECYCLE_REPLAY_CAP + 10) {
            bus.publish(board_spawned(&format!("b{i}")));
        }
        let snap = bus.snapshot_lifecycle();
        assert_eq!(snap.len(), LIFECYCLE_REPLAY_CAP, "ring capped at LIFECYCLE_REPLAY_CAP");
        // The first retained event should be the (10th) one — the oldest 10 are gone.
        match &snap[0] {
            Envelope::BoardSpawned { board_id, .. } => assert_eq!(board_id, "b10"),
            other => panic!("unexpected head: {other:?}"),
        }
    }
}
