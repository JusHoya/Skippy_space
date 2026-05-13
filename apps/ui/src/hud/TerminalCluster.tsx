import { useState } from 'react';
import TerminalPane from './TerminalPane';

/**
 * Bottom strip of N xterm panes — PRD §7.6. Phase 0 ships a single user PTY
 * tab; agent-attached PTYs join the cluster in Phase 1 when the boards start
 * spawning their own claude-code subprocesses.
 */
interface Tab {
  id: string;
  label: string;
}

export default function TerminalCluster() {
  const [tabs] = useState<Tab[]>([{ id: 'user', label: '$ user shell' }]);
  const [active, setActive] = useState<string>('user');

  return (
    <div className="terminal-cluster">
      <div className="terminal-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`terminal-tab ${tab.id === active ? 'active' : ''}`}
            onClick={() => setActive(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="terminal-host">
        {/* Keep all tabs mounted to preserve scrollback; show only the active one. */}
        {tabs.map((tab) => (
          <div
            key={tab.id}
            style={{
              position: 'absolute',
              inset: 4,
              display: tab.id === active ? 'block' : 'none',
            }}
          >
            <TerminalPane tabId={tab.id} />
          </div>
        ))}
      </div>
    </div>
  );
}
