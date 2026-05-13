import { useMemo } from 'react';
import { useAgentStore } from '../stores/agentStore';
import { useUiStore } from '../stores/uiStore';
import { safeInvoke } from '../lib/tauri';

/**
 * Top status strip — PRD §7.1. In Phase 0 the values are placeholders driven
 * by what the renderer can compute locally; Phase 3 wires in real telemetry
 * from the OTel stream and Letta context-window stats.
 */
export default function TopBar() {
  const agents = useAgentStore((s) => s.agents);
  const paused = useUiStore((s) => s.paused);
  const togglePaused = useUiStore((s) => s.togglePaused);

  const supply = useMemo(() => {
    const total = Object.keys(agents).length;
    return { used: total, cap: 30 };
  }, [agents]);

  const handleAutoCommit = async () => {
    await safeInvoke('vault_autocommit_now');
  };

  return (
    <div className="topbar">
      <div className="topbar-inner">
        <span className="topbar-brand">SKIPPY · SPACE</span>
        <span className="topbar-stat">
          tok/s <span className="value">0.0</span>
          <span className="unit">k</span>
        </span>
        <span className="topbar-stat">
          ctx <span className="value">0</span>
          <span className="unit">/200k</span>
        </span>
        <span className="topbar-stat">
          supply{' '}
          <span className="value">
            {supply.used}/{supply.cap}
          </span>
        </span>
        <span className="topbar-stat">
          {paused ? (
            <span style={{ color: 'var(--c-electric-purple)' }}>◼ PAUSED</span>
          ) : (
            <span style={{ color: 'var(--c-muted-cyan)' }}>▶ LIVE</span>
          )}
        </span>
        <div className="topbar-spacer" />
        <div className="topbar-actions">
          <button type="button" title="Active-pause (Space)" onClick={togglePaused}>
            {paused ? '▶' : '⏸'}
          </button>
          <button type="button" title="Auto-commit vault now" onClick={handleAutoCommit}>
            ⎘
          </button>
          <button type="button" title="Settings" disabled>
            ⚙
          </button>
          <button type="button" title="User" disabled>
            👤
          </button>
        </div>
      </div>
    </div>
  );
}
