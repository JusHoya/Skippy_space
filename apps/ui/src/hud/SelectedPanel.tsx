import { useMemo } from 'react';
import {
  BOARD_COSTUMES,
  BOARD_LABELS,
  numToHex,
  type BoardId,
} from '@skippy/sprite-kit';
import { useAgentStore } from '../stores/agentStore';
import { useUiStore } from '../stores/uiStore';
import { usePromptStore } from '../stores/promptStore';
import { useModelStore } from '../stores/modelStore';
import { safeInvoke } from '../lib/tauri';
import ModelPicker from './ModelPicker';
import type { ModelId, ModelScope } from '@skippy/shared';

/**
 * Selected-agent inspector — PRD §7.4.
 *
 * Phase 0 surfaced only Skippy. Phase 1 generalizes the panel so any of the
 * eight Board captains renders with its accent color, label, and current
 * discrete state from the agentStore. Phase 3 will layer in HP-equivalents
 * (context %, tool-call quota), full span log, and memory-binding links.
 */

interface Display {
  name: string;
  role: string;
  initial: string;
  /** Accent color as `#RRGGBB`; used to tint the panel header / state text. */
  accentHex: string;
  /** A short, human-readable kind tag for the panel chip. */
  kind: 'skippy' | 'board' | 'staff' | 'task' | 'unknown';
  boardId?: BoardId;
}

const SKIPPY_ACCENT = '#66FCF1'; // PALETTE.neonCyan
const DEFAULT_ACCENT = '#C5C6C7'; // PALETTE.starlight

function parseBoardId(agentId: string): BoardId | null {
  if (!agentId.startsWith('board.')) return null;
  const candidate = agentId.slice(6);
  if (candidate in BOARD_COSTUMES) return candidate as BoardId;
  return null;
}

export default function SelectedPanel() {
  const selectedId = useUiStore((s) => s.selectedAgentId);
  const agent = useAgentStore((s) => (selectedId ? s.agents[selectedId] : undefined));
  const current = usePromptStore((s) => s.current);
  const boardModels = useModelStore((s) => s.boardModels);
  const setBoardModel = useModelStore((s) => s.setBoardModel);

  const display = useMemo<Display>(() => {
    if (!selectedId) {
      return {
        name: 'No selection',
        role: 'Click an agent on the map.',
        initial: '?',
        accentHex: DEFAULT_ACCENT,
        kind: 'unknown',
      };
    }
    if (selectedId === 'skippy') {
      return {
        name: 'Skippy',
        role: 'The Magnificent · Orchestrator',
        initial: 'S',
        accentHex: SKIPPY_ACCENT,
        kind: 'skippy',
      };
    }
    const boardId = parseBoardId(selectedId);
    if (boardId) {
      const label = BOARD_LABELS[boardId];
      return {
        name: label,
        role: `Board Captain · ${label}`,
        initial: label.charAt(0).toUpperCase(),
        accentHex: numToHex(BOARD_COSTUMES[boardId].accentColor),
        kind: 'board',
        boardId,
      };
    }
    // Fallback for staff / task agents that arrive in later phases.
    const pretty = selectedId
      .split(/[._-]/)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join(' ');
    return {
      name: pretty,
      role: selectedId.startsWith('staff.') ? 'Staff Officer' : 'Agent',
      initial: pretty.charAt(0) || '?',
      accentHex: DEFAULT_ACCENT,
      kind: selectedId.startsWith('staff.') ? 'staff' : selectedId.startsWith('task.') ? 'task' : 'unknown',
    };
  }, [selectedId]);

  const costume = display.boardId ? BOARD_COSTUMES[display.boardId] : undefined;
  const costumeSwatch = costume
    ? [
        { label: 'Hat', value: costume.hat },
        { label: 'Body', value: costume.body },
        { label: 'Accessory', value: costume.accessory },
        { label: 'Insignia', value: costume.insignia },
      ].filter((row) => Boolean(row.value))
    : null;

  // Default task placeholder — Phase 3 will replace with a live task feed.
  const taskText =
    agent?.task ??
    (display.kind === 'board' ? 'No active orders — awaiting Skippy.' : '—');

  const openInObsidian = async () => {
    if (!selectedId) return;
    await safeInvoke('open_agent_vault', { agentId: selectedId });
  };

  // Empty-state shortcut: no selection at all.
  if (!selectedId) {
    return (
      <div className="panel-body">
        <div className="identity-block">
          <div className="portrait" aria-hidden>?</div>
          <div className="identity-meta">
            <div className="name">No selection</div>
            <div className="role">Click an agent on the map.</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="panel-body">
      <div
        className="identity-block"
        style={{
          // Accent-colored title bar — a subtle left border tinted to the
          // selected agent's costume, plus a faded fill behind the identity row.
          borderLeft: `3px solid ${display.accentHex}`,
          paddingLeft: 8,
          background: `linear-gradient(90deg, ${display.accentHex}1A 0%, transparent 60%)`,
        }}
      >
        <div
          className="portrait"
          aria-hidden
          style={{ color: display.accentHex, borderColor: display.accentHex }}
        >
          {display.initial}
        </div>
        <div className="identity-meta">
          <div className="name" style={{ color: display.accentHex }}>{display.name}</div>
          <div className="role">{display.role}</div>
          <div className="role">
            State:{' '}
            <span
              style={{
                color: agent?.state === 'error' ? 'var(--c-electric-purple)' : display.accentHex,
              }}
            >
              {agent?.state ?? 'unknown'}
            </span>
          </div>
        </div>
      </div>

      {display.kind === 'board' && display.boardId && (
        <div
          className="stat-row"
          style={{ display: 'flex', alignItems: 'center', gap: 8 }}
        >
          <span className="k">Model</span>
          <span className="v" style={{ display: 'flex', alignItems: 'center' }}>
            <ModelPicker
              scope={`board.${display.boardId}` as ModelScope}
              currentModel={boardModels[display.boardId] as ModelId}
              onChange={(next) => setBoardModel(display.boardId!, next)}
            />
          </span>
        </div>
      )}
      <div className="stat-row">
        <span className="k">Task</span>
        <span className="v">{taskText}</span>
      </div>
      <div className="stat-row">
        <span className="k">Last token</span>
        <span
          className="v"
          style={{ maxWidth: '60%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {agent?.lastToken ?? '—'}
        </span>
      </div>
      <div className="stat-row">
        <span className="k">Updated</span>
        <span className="v">{agent?.updatedAt ?? '—'}</span>
      </div>

      {costumeSwatch && costumeSwatch.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div
            className="panel-header"
            style={{ background: 'transparent', padding: '0 0 4px 0', border: 'none' }}
          >
            Costume
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            <span
              aria-hidden
              style={{
                display: 'inline-block',
                width: 16,
                height: 16,
                borderRadius: 4,
                background: display.accentHex,
                border: '1px solid var(--c-dark-matter)',
                marginRight: 4,
              }}
              title={`Accent ${display.accentHex}`}
            />
            {costumeSwatch.map((row) => (
              <span
                key={row.label}
                className="stat-row"
                style={{ padding: '2px 6px', borderRadius: 3, background: 'rgba(0,0,0,0.25)' }}
              >
                <span className="k">{row.label}</span>
                <span className="v" style={{ marginLeft: 6 }}>{row.value}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {display.kind === 'skippy' && (
        <div style={{ marginTop: 12 }}>
          <div
            className="panel-header"
            style={{ background: 'transparent', padding: '0 0 4px 0', border: 'none' }}
          >
            Live narration
          </div>
          <div className="log-stream">
            {current
              ? `> ${current.text}\n\n${current.streamed || (current.complete ? '(empty)' : '…')}`
              : '(no active prompt)'}
          </div>
        </div>
      )}

      <div style={{ marginTop: 12, display: 'flex', gap: 6 }}>
        <button type="button" onClick={openInObsidian} disabled={!selectedId}>
          Open vault sub-dir
        </button>
      </div>
    </div>
  );
}
