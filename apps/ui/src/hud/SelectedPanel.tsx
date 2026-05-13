import { useMemo } from 'react';
import { useAgentStore } from '../stores/agentStore';
import { useUiStore } from '../stores/uiStore';
import { usePromptStore } from '../stores/promptStore';
import { safeInvoke } from '../lib/tauri';

/**
 * Selected-agent inspector — PRD §7.4.
 *
 * Phase 0 surfaces identity + discrete state + the streamed Skippy narration.
 * Phase 3 will layer in HP-equivalents (context %, tool-call quota), full
 * span log, and memory-binding links.
 */
export default function SelectedPanel() {
  const selectedId = useUiStore((s) => s.selectedAgentId);
  const agent = useAgentStore((s) => (selectedId ? s.agents[selectedId] : undefined));
  const current = usePromptStore((s) => s.current);

  const display = useMemo(() => {
    if (!selectedId) return { name: 'No selection', role: '—', initial: '?' };
    if (selectedId === 'skippy') {
      return { name: 'Skippy', role: 'The Magnificent · Orchestrator', initial: 'S' };
    }
    const pretty = selectedId
      .split(/[._-]/)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join(' ');
    return {
      name: pretty,
      role: 'Board Captain',
      initial: pretty.charAt(0) || '?',
    };
  }, [selectedId]);

  const openInObsidian = async () => {
    if (!selectedId) return;
    await safeInvoke('open_agent_vault', { agentId: selectedId });
  };

  return (
    <div className="panel-body">
      <div className="identity-block">
        <div className="portrait" aria-hidden>
          {display.initial}
        </div>
        <div className="identity-meta">
          <div className="name">{display.name}</div>
          <div className="role">{display.role}</div>
          <div className="role">
            State:{' '}
            <span style={{ color: agent?.state === 'error' ? 'var(--c-electric-purple)' : 'var(--c-neon-cyan)' }}>
              {agent?.state ?? 'unknown'}
            </span>
          </div>
        </div>
      </div>

      <div className="stat-row">
        <span className="k">Task</span>
        <span className="v">{agent?.task ?? '—'}</span>
      </div>
      <div className="stat-row">
        <span className="k">Last token</span>
        <span className="v" style={{ maxWidth: '60%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {agent?.lastToken ?? '—'}
        </span>
      </div>
      <div className="stat-row">
        <span className="k">Updated</span>
        <span className="v">{agent?.updatedAt ?? '—'}</span>
      </div>

      <div style={{ marginTop: 12 }}>
        <div className="panel-header" style={{ background: 'transparent', padding: '0 0 4px 0', border: 'none' }}>
          Live narration
        </div>
        <div className="log-stream">
          {current
            ? `> ${current.text}\n\n${current.streamed || (current.complete ? '(empty)' : '…')}`
            : '(no active prompt)'}
        </div>
      </div>

      <div style={{ marginTop: 12, display: 'flex', gap: 6 }}>
        <button type="button" onClick={openInObsidian} disabled={!selectedId}>
          Open vault sub-dir
        </button>
      </div>
    </div>
  );
}
