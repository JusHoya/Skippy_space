import { useMemo } from 'react';
import { useUiStore } from '../stores/uiStore';

interface Slot {
  hotkey: string;
  label: string;
}

const SKIPPY_SLOTS: Slot[] = [
  { hotkey: 'Q', label: 'Plan' },
  { hotkey: 'W', label: 'Delegate' },
  { hotkey: 'E', label: 'Review' },
  { hotkey: 'R', label: 'Replay' },
  { hotkey: 'A', label: 'Broadcast' },
  { hotkey: 'S', label: 'Sync Vault' },
  { hotkey: 'D', label: 'Daily Note' },
  { hotkey: 'F', label: 'Pause All' },
  { hotkey: 'Z', label: 'Cost Audit' },
  { hotkey: 'X', label: 'Lint Wiki' },
  { hotkey: 'C', label: 'Stop Task' },
  { hotkey: 'V', label: 'Open Obsidian' },
];

const DEFAULT_BOARD_SLOTS: Slot[] = [
  { hotkey: 'Q', label: 'Accept Order' },
  { hotkey: 'W', label: 'Counter' },
  { hotkey: 'E', label: 'Decline' },
  { hotkey: 'R', label: 'Spawn Task' },
  { hotkey: 'A', label: 'Status' },
  { hotkey: 'S', label: 'Memory' },
  { hotkey: 'D', label: 'Effort±' },
  { hotkey: 'F', label: 'Model' },
  { hotkey: 'Z', label: '' },
  { hotkey: 'X', label: '' },
  { hotkey: 'C', label: '' },
  { hotkey: 'V', label: 'Stand Down' },
];

/**
 * 12-button (3x4) command grid — PRD §7.4. Bindings vary by selected agent;
 * we ship Skippy + a generic Board card in Phase 0, and the per-board cards
 * arrive with their charters in Phase 1.
 */
export default function CommandCard() {
  const selectedId = useUiStore((s) => s.selectedAgentId);
  const slots = useMemo<Slot[]>(() => {
    if (selectedId === 'skippy') return SKIPPY_SLOTS;
    return DEFAULT_BOARD_SLOTS;
  }, [selectedId]);

  return (
    <div className="command-card" role="grid" aria-label="Command card">
      {slots.map((slot, idx) => (
        <button
          key={`${slot.hotkey}-${idx}`}
          type="button"
          className={`slot ${slot.label ? '' : 'empty'}`}
          disabled={!slot.label}
          title={slot.label || 'empty'}
        >
          <span className="hotkey">{slot.hotkey}</span>
          <span>{slot.label}</span>
        </button>
      ))}
    </div>
  );
}
