// warmpool.ts — STUB for the R-01 mitigation (PRD §15, Risks table).
//
// In Phase 1 we will keep 2–3 pre-initialized Claude Agent SDK contexts hot
// so that spawning a Board agent (or routing a fresh user prompt to one)
// avoids the documented 12s `query()` cold-start. The pool will refill in
// the background on every checkout.
//
// Phase 0 does not need this — there is only one Skippy turn, in-process, and
// it pays the cold-start once at startup. Leaving the surface here so that
// Phase 1 doesn't ripple through call-sites.

import { logger } from './logger.js';

export interface WarmPoolOptions {
  /** Target number of warm SDK contexts kept ready. */
  size?: number;
}

export class WarmPool {
  private readonly size: number;

  constructor(opts: WarmPoolOptions = {}) {
    this.size = opts.size ?? 3;
  }

  /** Pre-warm `size` contexts. No-op in Phase 0. */
  // eslint-disable-next-line @typescript-eslint/require-await
  async prewarm(): Promise<void> {
    // TODO Phase 1: instantiate `size` Claude Agent SDK query() contexts in
    // the background; track each via OTel `skippy.warmpool.*` attributes.
    logger.debug({ msg: 'warmpool.prewarm() noop in Phase 0', size: this.size });
  }

  /** Borrow a context; falls back to cold-start in Phase 0. */
  // eslint-disable-next-line @typescript-eslint/require-await
  async acquire(): Promise<null> {
    // TODO Phase 1: return a ready context; trigger a background refill so
    // the pool never drops below `size`.
    return null;
  }

  /** Return a context to the pool. */
  release(_ctx: unknown): void {
    // TODO Phase 1: requeue / reset / discard depending on usage.
  }

  /** Drain and dispose all warm contexts. */
  // eslint-disable-next-line @typescript-eslint/require-await
  async drain(): Promise<void> {
    // TODO Phase 1: gracefully terminate every pooled context.
  }
}
