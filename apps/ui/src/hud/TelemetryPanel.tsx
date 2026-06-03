import { contextPct } from '@skippy/shared';
import { useAgentStore } from '../stores/agentStore';
import { useTelemetryStore, percentile } from '../stores/telemetryStore';

/**
 * Aggregate telemetry — PRD §7.5 / §9.4 (D5).
 *
 * Phase 3: the four real widgets — cost meter (by bucket), latency histogram
 * (p50/p95/p99), context-window pressure bar (per agent), and error feed — all
 * subscribed to the OTel→Channel stream via `telemetryStore`. Falls back to an
 * "awaiting telemetry" state before any span arrives (Docker/sidecar warming).
 */

function usd(v: number): string {
  if (v === 0) return '$0.00';
  return `$${v.toFixed(v < 1 ? 4 : 2)}`;
}

function ms(v: number): string {
  return `${Math.round(v)} ms`;
}

function barColor(pct: number): string {
  if (pct < 0.5) return 'var(--c-accent, #66FCF1)';
  if (pct < 0.8) return '#F1C40F';
  return '#BC13FE';
}

export default function TelemetryPanel() {
  const agents = useAgentStore((s) => s.agents);
  const sessionCostUsd = useTelemetryStore((s) => s.sessionCostUsd);
  const costByBucket = useTelemetryStore((s) => s.costByBucket);
  const latencies = useTelemetryStore((s) => s.latencies);
  const contextByAgent = useTelemetryStore((s) => s.contextByAgent);
  const errors = useTelemetryStore((s) => s.errors);
  const lastSpanAt = useTelemetryStore((s) => s.lastSpanAt);

  const entries = Object.entries(agents);
  const byState = entries.reduce<Record<string, number>>((acc, [, snap]) => {
    acc[snap.state] = (acc[snap.state] ?? 0) + 1;
    return acc;
  }, {});

  const buckets = Object.entries(costByBucket).sort((a, b) => b[1] - a[1]);
  const contexts = Object.entries(contextByAgent);
  const live = lastSpanAt !== null;

  return (
    <div className="panel-body">
      <div className="panel-header" style={{ background: 'transparent', padding: '0 0 4px 0', border: 'none' }}>
        Population
      </div>
      <div className="stat-row">
        <span className="k">Total agents</span>
        <span className="v">{entries.length}</span>
      </div>
      {Object.entries(byState).map(([state, count]) => (
        <div className="stat-row" key={state}>
          <span className="k">{state}</span>
          <span className="v">{count}</span>
        </div>
      ))}

      {/* ── Cost meter (§9.4 widget 1) ─────────────────────────────────────── */}
      <div style={{ marginTop: 12 }}>
        <div className="panel-header" style={{ background: 'transparent', padding: '0 0 4px 0', border: 'none' }}>
          Cost meter
        </div>
        <div className="stat-row">
          <span className="k">Session $</span>
          <span className="v">{usd(sessionCostUsd)}</span>
        </div>
        {buckets.map(([bucket, cost]) => (
          <div className="stat-row" key={bucket}>
            <span className="k" style={{ opacity: 0.8 }}>
              ↳ {bucket}
            </span>
            <span className="v">{usd(cost)}</span>
          </div>
        ))}
      </div>

      {/* ── Latency histogram (§9.4 widget 2) ──────────────────────────────── */}
      <div style={{ marginTop: 12 }}>
        <div className="panel-header" style={{ background: 'transparent', padding: '0 0 4px 0', border: 'none' }}>
          LLM latency {latencies.length > 0 ? `(n=${latencies.length})` : ''}
        </div>
        <div className="stat-row">
          <span className="k">p50</span>
          <span className="v">{latencies.length ? ms(percentile(latencies, 50)) : '— ms'}</span>
        </div>
        <div className="stat-row">
          <span className="k">p95</span>
          <span className="v">{latencies.length ? ms(percentile(latencies, 95)) : '— ms'}</span>
        </div>
        <div className="stat-row">
          <span className="k">p99</span>
          <span className="v">{latencies.length ? ms(percentile(latencies, 99)) : '— ms'}</span>
        </div>
      </div>

      {/* ── Context-window pressure (§9.4 widget 3) ────────────────────────── */}
      {contexts.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div className="panel-header" style={{ background: 'transparent', padding: '0 0 4px 0', border: 'none' }}>
            Context pressure
          </div>
          {contexts.map(([agentId, c]) => {
            const pct = contextPct(c.model, c.usedTokens);
            return (
              <div key={agentId} style={{ margin: '4px 0' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
                  <span>{agentId}</span>
                  <span>
                    {Math.round(c.usedTokens / 1000)}k / {Math.round(c.limitTokens / 1000)}k
                  </span>
                </div>
                <div style={{ height: 6, background: 'rgba(255,255,255,0.08)', borderRadius: 3, overflow: 'hidden' }}>
                  <div
                    style={{
                      width: `${Math.round(pct * 100)}%`,
                      height: '100%',
                      background: barColor(pct),
                      transition: 'width 200ms',
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Error feed (§9.4 widget 4) ─────────────────────────────────────── */}
      {errors.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div className="panel-header" style={{ background: 'transparent', padding: '0 0 4px 0', border: 'none', color: '#BC13FE' }}>
            Errors ({errors.length})
          </div>
          {errors
            .slice(-5)
            .reverse()
            .map((e, i) => (
              <div key={`${e.ts}-${i}`} style={{ fontSize: 11, color: '#E0A0FF', margin: '2px 0' }}>
                <strong>{e.agentId}</strong> {e.errorKind}: {e.message.slice(0, 60)}
              </div>
            ))}
        </div>
      )}

      {!live && (
        <div style={{ marginTop: 12, fontSize: 11, color: 'var(--c-text-dim)' }}>
          Awaiting telemetry — values populate once the sidecar streams spans
          over the Tauri Channel.
        </div>
      )}
    </div>
  );
}
