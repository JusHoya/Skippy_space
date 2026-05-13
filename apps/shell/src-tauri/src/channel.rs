//! Channel registry — bridges the sidecar's broadcast bus to per-renderer
//! Tauri 2 `tauri::ipc::Channel<T>` subscribers.
//!
//! The renderer calls `events_subscribe(channel)` at boot; we register the
//! channel here and feed every `Envelope` from the sidecar broadcast into
//! it. Multiple windows / panels can subscribe and each gets its own
//! independent fan-out task driven off a `broadcast::Receiver`.

use std::sync::Arc;

use parking_lot::Mutex;
use tauri::ipc::Channel;
use tokio::sync::broadcast;
use tracing::{debug, warn};

use crate::envelope::Envelope;

/// State for the global UI event channel.
///
/// `tx` is the single broadcast sender that the sidecar reader task pushes
/// envelopes into. The renderer-facing `Channel<Envelope>` instances are held
/// in `subscribers` so they survive the duration of the registration but the
/// real fan-out is driven by spawned tasks reading from `tx.subscribe()`.
pub struct EventBus {
    tx: broadcast::Sender<Envelope>,
    subscribers: Mutex<Vec<Channel<Envelope>>>,
}

impl EventBus {
    pub fn new() -> Arc<Self> {
        // Capacity 1024 is generous for a UI bus; lagging consumers drop oldest
        // events with a warn-level log inside the spawned fan-out tasks.
        let (tx, _rx) = broadcast::channel::<Envelope>(1024);
        Arc::new(Self {
            tx,
            subscribers: Mutex::new(Vec::new()),
        })
    }

    /// Producer-side handle. The sidecar reader task calls `bus.publish(env)`.
    pub fn publish(&self, env: Envelope) {
        // Send returns Err only when there are zero receivers, which is fine —
        // we simply drop the event in that case. Renderer hasn't subscribed yet.
        let _ = self.tx.send(env);
    }

    /// Renderer-side registration. Wires a `tauri::ipc::Channel<Envelope>` to
    /// the bus by spawning a fan-out task that reads from `tx.subscribe()` and
    /// sends each envelope down the channel.
    pub fn register(self: &Arc<Self>, channel: Channel<Envelope>) {
        let mut rx = self.tx.subscribe();
        let outbound = channel.clone();
        self.subscribers.lock().push(channel);

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
                        warn!("event bus lagged by {n} envelopes — slow consumer");
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
}
