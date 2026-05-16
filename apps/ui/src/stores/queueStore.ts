// Active-pause order queue (PRD §7.2, workflow §13.3).
//
// When the world is paused, the user shift-right-clicks a sequence of orders;
// each is enqueued here. When the user un-pauses (Zone 6 glue), the queue is
// drained in FIFO order and dispatched. This store deliberately does NOT
// touch `uiStore.paused` — Zone 6 reads both stores together to decide when
// to release the queue.
//
// `isQueueing` is a derived convenience flag the HUD reads: it's true once
// the user has issued ≥1 order while paused, and resets when the queue is
// released or explicitly cleared. The flag isn't recomputed against
// `uiStore.paused`; it's a one-way latch flipped by `enqueue` and lowered by
// `releaseAll`/`clearQueue` so HUD code can stay store-local.

import { create } from 'zustand';
import { newPromptId, type QueuedOrder } from '@skippy/shared';

export interface QueueStore {
  /** Pending orders in FIFO insertion order. */
  queued: QueuedOrder[];
  /**
   * True after `enqueue` is called at least once before `releaseAll` or
   * `clearQueue` resets it. The HUD overlay uses this to render the "active
   * pause has queued moves" badge.
   */
  isQueueing: boolean;

  /**
   * Enqueue a new order. The store assigns the ULID `id` (via `newPromptId`)
   * and an ISO `enqueuedAt`, so callers pass only the semantic payload.
   * Returns the fully-realized order for callers that need the assigned id.
   */
  enqueue: (order: Omit<QueuedOrder, 'id' | 'enqueuedAt'>) => QueuedOrder;
  /** Pop the head of the queue (FIFO). Returns undefined when empty. */
  dequeue: () => QueuedOrder | undefined;
  /** Inspect the head without removing it. */
  peek: () => QueuedOrder | undefined;
  /** Clear without releasing — lowers `isQueueing`. */
  clearQueue: () => void;
  /**
   * Return all queued orders in dispatch order and clear them. Caller is
   * responsible for dispatching the returned orders to their targets. Also
   * lowers `isQueueing`.
   */
  releaseAll: () => QueuedOrder[];
}

export const useQueueStore = create<QueueStore>((set, get) => ({
  queued: [],
  isQueueing: false,

  enqueue: (order) => {
    // Build the realized order with id + timestamp. We spread the input first
    // so that explicit `undefined` values in optional fields don't survive
    // through TS's `exactOptionalPropertyTypes` check on the consumer side —
    // callers pass only the semantic fields they care about.
    const realized: QueuedOrder = {
      ...order,
      id: newPromptId(),
      enqueuedAt: new Date().toISOString(),
    };
    set((s) => ({
      queued: [...s.queued, realized],
      isQueueing: true,
    }));
    return realized;
  },

  dequeue: () => {
    const head = get().queued[0];
    if (!head) return undefined;
    set((s) => ({ queued: s.queued.slice(1) }));
    return head;
  },

  peek: () => get().queued[0],

  clearQueue: () => set({ queued: [], isQueueing: false }),

  releaseAll: () => {
    const all = get().queued;
    if (all.length === 0) {
      // Still flip the flag — `isQueueing` is a one-way latch from the HUD's
      // POV, and a manual "release nothing" should leave the badge cleared.
      set({ isQueueing: false });
      return [];
    }
    set({ queued: [], isQueueing: false });
    return all;
  },
}));

/**
 * Reactive selector hook — useful for HUD overlays that just want the
 * pending count without subscribing to the full array.
 */
export const useQueueCount = (): number => useQueueStore((s) => s.queued.length);
