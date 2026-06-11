// warmpool.ts — UNIMPLEMENTED placeholder for the R-01 warm-start mitigation.
//
// ⚠️ This module does NOT currently mitigate R-01. PRD §15's only Critical risk
// (R-01: the ~12 s Claude Agent SDK `query()` cold-start) remains unmitigated.
// Nothing in the sidecar imports `WarmPool`; `prewarm`/`acquire` are inert. Any
// comment elsewhere that implies a warm pool is keeping SDK contexts hot is
// stale — see the cross-file note at the bottom of this file. Do not cite this
// class as the R-01 mitigation until the body below is actually implemented.
//
// The surface is kept (rather than deleted) as the agreed integration point so
// that wiring a real pool later doesn't ripple through call-sites. The intended
// design, once the SDK is on the always-on path (today it is gated behind
// `PHASE3_AGENTS_ENABLED` in sdk-board.ts):
//   • prewarm(): spin up `size` SDK `query()` contexts in the background and
//     keep them parked on an idle prompt; tag each with `skippy.warmpool.*`
//     OTel attributes (CLAUDE.md: all agent comms are traced).
//   • acquire(): hand back a parked context and kick a background refill so the
//     pool never drops below `size`.
//   • release()/drain(): requeue/reset or gracefully terminate contexts.

import { logger } from './logger.js';

export interface WarmPoolOptions {
  /** Target number of warm SDK contexts kept ready. */
  size?: number;
}

/**
 * Placeholder pool. Every method is a faithful no-op: `acquire()` returns
 * `null` to mean "no warm context — the caller must cold-start," which is the
 * honest current state. This class is not yet referenced by any caller; it
 * exists only so a future implementation has a stable surface to fill in.
 */
export class WarmPool {
  private readonly size: number;

  /** True once a real pool is filled. Always false today (no-op prewarm). */
  private warmed = false;

  constructor(opts: WarmPoolOptions = {}) {
    this.size = opts.size ?? 3;
  }

  /** Whether the pool currently holds warm contexts. Always false (unimplemented). */
  get isWarm(): boolean {
    return this.warmed;
  }

  /**
   * Pre-warm `size` contexts. UNIMPLEMENTED — currently a no-op that logs so the
   * absence of a real warm pool is visible in traces rather than silently
   * assumed. Does not mitigate R-01.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async prewarm(): Promise<void> {
    logger.warn({
      msg: 'warmpool.prewarm() is unimplemented — R-01 cold-start NOT mitigated',
      size: this.size,
    });
  }

  /**
   * Borrow a context. UNIMPLEMENTED — always returns `null` to signal "no warm
   * context available; cold-start instead." The `null` contract is intentional
   * and safe: callers must treat it as cache-miss, never assume a warm path.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async acquire(): Promise<null> {
    return null;
  }

  /** Return a context to the pool. UNIMPLEMENTED — no-op (nothing to requeue). */
  release(_ctx: unknown): void {
    // No pooled contexts exist to requeue/reset/discard.
  }

  /** Drain and dispose all warm contexts. UNIMPLEMENTED — no-op (pool is empty). */
  // eslint-disable-next-line @typescript-eslint/require-await
  async drain(): Promise<void> {
    this.warmed = false;
  }
}

// CROSS-FILE NOTE (outside this module's ownership): the following comments
// still imply R-01 is addressed and should be reworded to say the warm pool is
// unimplemented —
//   • apps/agent-runtime/README.md:90  "stub — R-01 mitigation, populated in Phase 1"
//   • apps/agent-runtime/src/index.ts:65-66  "See PRD R-01 (warmpool / cold-start mitigation)."
//   • apps/agent-runtime/src/supervisor.ts:3  "PRD R-01 specifies 'warm …'"
