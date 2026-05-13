import { useAgentStore } from '../stores/agentStore';

/**
 * Aggregate telemetry — PRD §7.5 / §9.4.
 *
 * Phase 0 shows agent population + state distribution. Phase 3 will replace
 * this with the cost meter, latency histogram, context-window stacked bar,
 * and error feed, all subscribed to the OTel-Channel stream.
 */
export default function TelemetryPanel() {
  const agents = useAgentStore((s) => s.agents);
  const entries = Object.entries(agents);
  const byState = entries.reduce<Record<string, number>>((acc, [, snap]) => {
    acc[snap.state] = (acc[snap.state] ?? 0) + 1;
    return acc;
  }, {});

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

      <div style={{ marginTop: 12 }}>
        <div className="panel-header" style={{ background: 'transparent', padding: '0 0 4px 0', border: 'none' }}>
          Cost meter
        </div>
        <div className="stat-row">
          <span className="k">Session $</span>
          <span className="v">$0.00</span>
        </div>
        <div className="stat-row">
          <span className="k">p50 latency</span>
          <span className="v">— ms</span>
        </div>
        <div className="stat-row">
          <span className="k">p95 latency</span>
          <span className="v">— ms</span>
        </div>
      </div>

      <div style={{ marginTop: 12, fontSize: 11, color: 'var(--c-text-dim)' }}>
        Real values arrive when the OTel collector starts streaming spans into
        the Tauri Channel (Phase 3).
      </div>
    </div>
  );
}
