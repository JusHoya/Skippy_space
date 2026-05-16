// TUI-style Agent Navigator overlay — floats above the CommandBar when the
// user presses ↓ from an empty input (PRD Phase 3-prep, Zone 3).
//
// Keyboard model (when open):
//   ↑ / ↓  → move cursor (clamped with wrap-around)
//   Enter  → pick the current entry (parent translates to `selectionStore`)
//   Esc    → close
//
// All four keys call `e.preventDefault()` so the global `Hotkeys.tsx` listener
// (which is mounted on `window`, same phase as ours) does NOT also see them
// — its handlers explicitly bail out when the active element is editable, but
// preventDefault is still the safe belt-and-braces signal that this overlay
// has claimed the keystroke.

import { useEffect } from 'react';
import type { AgentActivityEntry } from '@skippy/shared';
import { relativeTime } from './agentActivity';

interface AgentNavigatorProps {
  open: boolean;
  entries: AgentActivityEntry[];
  cursorIndex: number;
  onCursorChange: (i: number) => void;
  onPick: (entry: AgentActivityEntry) => void;
  onClose: () => void;
}

const MAX_DISPLAY = 12;

const panelStyle: React.CSSProperties = {
  position: 'absolute',
  left: '50%',
  transform: 'translateX(-50%)',
  bottom: 64,
  width: 'min(720px, 90%)',
  background: 'rgba(11, 12, 16, 0.92)',
  border: '1px solid var(--c-muted-cyan)',
  borderRadius: 2,
  backdropFilter: 'blur(6px)',
  boxShadow: '0 4px 24px rgba(0, 0, 0, 0.6)',
  zIndex: 21,
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  color: 'var(--c-starlight)',
  maxHeight: 360,
  overflowY: 'auto',
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '6px 12px',
  borderBottom: '1px solid var(--c-panel-border)',
  fontFamily: 'var(--font-hud)',
  fontSize: 10,
  letterSpacing: '0.16em',
  textTransform: 'uppercase',
  color: 'var(--c-muted-cyan)',
};

const rowStyleBase: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '14px 1fr auto auto',
  alignItems: 'center',
  gap: 10,
  padding: '6px 12px',
  borderLeft: '2px solid transparent',
  cursor: 'pointer',
};

const dotStyleBase: React.CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: '50%',
  display: 'inline-block',
};

const stateBadgeStyleBase: React.CSSProperties = {
  fontFamily: 'var(--font-hud)',
  fontSize: 9,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  padding: '2px 6px',
  borderRadius: 2,
  border: '1px solid var(--c-panel-border)',
  color: 'var(--c-text-dim)',
};

const summaryStyle: React.CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  minWidth: 0,
};

const labelStyle: React.CSSProperties = {
  fontFamily: 'var(--font-hud)',
  letterSpacing: '0.08em',
  fontSize: 11,
  marginRight: 8,
};

const lastSeenStyle: React.CSSProperties = {
  fontSize: 10,
  color: 'var(--c-text-dim)',
  whiteSpace: 'nowrap',
};

const emptyStyle: React.CSSProperties = {
  padding: '12px 16px',
  fontStyle: 'italic',
  color: 'var(--c-text-dim)',
  textAlign: 'center',
};

export default function AgentNavigator({
  open,
  entries,
  cursorIndex,
  onCursorChange,
  onPick,
  onClose,
}: AgentNavigatorProps) {
  // Cap display at 12 entries (most-recent / best-ranked wins via the helper).
  const visible = entries.slice(0, MAX_DISPLAY);
  const count = visible.length;

  // Keyboard handling — attached only while open so the listener can be GC'd
  // when collapsed. We register on `window` because the CommandBar input keeps
  // focus while the navigator is open (per spec), so a local element listener
  // would never fire.
  useEffect(() => {
    if (!open) return;

    function handleKeyDown(e: KeyboardEvent): void {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      switch (e.key) {
        case 'ArrowDown': {
          e.preventDefault();
          e.stopPropagation();
          if (count === 0) return;
          const next = (cursorIndex + 1 + count) % count;
          onCursorChange(next);
          return;
        }
        case 'ArrowUp': {
          e.preventDefault();
          e.stopPropagation();
          if (count === 0) return;
          const next = (cursorIndex - 1 + count) % count;
          onCursorChange(next);
          return;
        }
        case 'Enter': {
          e.preventDefault();
          e.stopPropagation();
          if (count === 0) return;
          const safeIndex = Math.max(0, Math.min(cursorIndex, count - 1));
          const pick = visible[safeIndex];
          if (pick) onPick(pick);
          return;
        }
        case 'Escape': {
          e.preventDefault();
          e.stopPropagation();
          onClose();
          return;
        }
        default:
          return;
      }
    }

    // capture-phase listener so we run BEFORE the global `Hotkeys.tsx` handler
    // (which uses default-phase / bubble). Combined with the `isEditableTarget`
    // bail-out in Hotkeys.tsx and our preventDefault, this guarantees the
    // navigator wins these keys cleanly.
    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [open, count, cursorIndex, onCursorChange, onPick, onClose, visible]);

  if (!open) return null;

  const safeCursor = count > 0 ? Math.max(0, Math.min(cursorIndex, count - 1)) : -1;

  return (
    <div
      className="agent-navigator"
      role="listbox"
      aria-label="Agent navigator"
      aria-activedescendant={
        safeCursor >= 0 && visible[safeCursor]
          ? `agent-nav-${visible[safeCursor].agentId}`
          : undefined
      }
      style={panelStyle}
    >
      <div style={headerStyle}>
        <span>Active agents · ↑↓ navigate · Enter selects · Esc closes</span>
        <span>{count}</span>
      </div>

      {count === 0 ? (
        <div style={emptyStyle}>No active agents</div>
      ) : (
        visible.map((entry, i) => {
          const selected = i === safeCursor;
          const rowStyle: React.CSSProperties = {
            ...rowStyleBase,
            background: selected
              ? 'rgba(102, 252, 241, 0.10)'
              : i % 2 === 0
              ? 'transparent'
              : 'rgba(255,255,255,0.015)',
            borderLeft: selected ? '2px solid var(--c-neon-cyan)' : '2px solid transparent',
          };
          const dotStyle: React.CSSProperties = {
            ...dotStyleBase,
            background: entry.accentHex,
            boxShadow: selected ? `0 0 6px ${entry.accentHex}` : 'none',
          };
          const stateBadgeStyle: React.CSSProperties = {
            ...stateBadgeStyleBase,
            color: entry.state === 'error' ? 'var(--c-electric-purple)' : entry.accentHex,
            borderColor: entry.state === 'error' ? 'var(--c-electric-purple)' : 'var(--c-panel-border)',
          };
          return (
            <div
              key={entry.agentId}
              id={`agent-nav-${entry.agentId}`}
              role="option"
              aria-selected={selected}
              style={rowStyle}
              onMouseEnter={() => onCursorChange(i)}
              onClick={() => onPick(entry)}
            >
              <span aria-hidden style={dotStyle} />
              <div style={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
                <span style={{ ...labelStyle, color: entry.accentHex }}>{entry.label}</span>
                <span style={summaryStyle}>{entry.summary}</span>
              </div>
              <span style={stateBadgeStyle}>{entry.state}</span>
              <span style={lastSeenStyle}>{relativeTime(entry.lastSeen)}</span>
            </div>
          );
        })
      )}
    </div>
  );
}
