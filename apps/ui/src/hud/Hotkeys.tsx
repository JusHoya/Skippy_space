// Global hotkey listener — PRD §7.7 SC2-muscle-memory bindings.
//
// Renders nothing. Mounts window keydown/keyup on mount, removes on unmount.
// Selection-style hotkeys mutate `selectionStore` + `uiStore` directly;
// HUD-style hotkeys (M, R, T, F1-F4, …) emit a `HotkeyEvent` through a small
// module-level pub/sub so Zone 6 (SceneRoot / CommandCard) can subscribe in
// app wiring without owning a circular import.

import { useEffect } from 'react';
import type { AgentId, ControlGroupKey, HotkeyEvent, MinimapLayer } from '@skippy/shared';
import { useUiStore } from '../stores/uiStore';
import { useAgentStore } from '../stores/agentStore';
import { useSelectionStore } from '../stores/selectionStore';

// ── Pub/sub dispatcher ──────────────────────────────────────────────────────

type Listener = (e: HotkeyEvent) => void;
const listeners = new Set<Listener>();

/** Subscribe to dispatched hotkey events. Returns an unsubscribe fn. */
export function onHotkey(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function emit(e: HotkeyEvent): void {
  for (const l of listeners) l(e);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** True when the user is typing in an editable field — hotkeys must defer. */
function isEditableTarget(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  // `contenteditable` regions (rich-text composers, future MD editors).
  if ((el as HTMLElement).isContentEditable) return true;
  return false;
}

/** Map `Digit1`..`Digit9` → ControlGroupKey, else null. */
function digitFromCode(code: string): ControlGroupKey | null {
  if (!code.startsWith('Digit')) return null;
  const n = Number(code.slice(5));
  if (!Number.isInteger(n) || n < 1 || n > 9) return null;
  return n as ControlGroupKey;
}

/** Map F-key code → minimap layer name. */
const F_KEY_LAYERS: Record<string, MinimapLayer> = {
  F1: 'size',
  F2: 'gitAge',
  F3: 'testCoverage',
  F4: 'errorDensity',
};

/** Current selection set: multi if non-empty, else the uiStore primary. */
function currentSelection(): AgentId[] {
  const multi = useSelectionStore.getState().multiSelected;
  if (multi.length > 0) return [...multi];
  const primary = useUiStore.getState().selectedAgentId;
  return primary ? [primary] : [];
}

// ── Component ───────────────────────────────────────────────────────────────

export default function Hotkeys(): null {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (isEditableTarget()) return;

      // ── Control-group digit row (Ctrl+N / N / Shift+N) ────────────────────
      const digit = digitFromCode(e.code);
      if (digit !== null) {
        // Ignore digit events that carry Alt/Meta — leave them for the OS.
        if (e.altKey || e.metaKey) return;
        const sel = useSelectionStore.getState();
        if (e.ctrlKey && !e.shiftKey) {
          // Ctrl+N → bind current selection to control group N.
          const members = currentSelection();
          if (members.length > 0) sel.bindControlGroup(digit, members);
          e.preventDefault();
          return;
        }
        if (e.shiftKey && !e.ctrlKey) {
          // Shift+N → add current selection to control group N.
          const members = currentSelection();
          if (members.length > 0) sel.addToControlGroup(digit, members);
          e.preventDefault();
          return;
        }
        if (!e.ctrlKey && !e.shiftKey) {
          // N → recall.
          const recalled = sel.recallControlGroup(digit);
          if (recalled && recalled.length > 0) sel.setMulti(recalled);
          e.preventDefault();
          return;
        }
        return;
      }

      // ── Tab → cycle primary through multi-selection ───────────────────────
      if (e.code === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        useSelectionStore.getState().cycleTabForward();
        e.preventDefault();
        return;
      }

      // ── Space → active-pause toggle ───────────────────────────────────────
      if (e.code === 'Space' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
        useUiStore.getState().togglePaused();
        e.preventDefault();
        return;
      }

      // ── Ctrl+. → cycle through idle agents ────────────────────────────────
      if (e.code === 'Period' && e.ctrlKey && !e.altKey && !e.metaKey) {
        const agents = useAgentStore.getState().agents;
        const idleIds = (Object.entries(agents) as Array<[string, { state: string } | undefined]>)
          .filter(([, snap]) => snap?.state === 'idle')
          .map(([id]) => id as AgentId);
        if (idleIds.length > 0) {
          const idx = useSelectionStore.getState().advanceIdleCursor();
          const pick = idleIds[((idx % idleIds.length) + idleIds.length) % idleIds.length];
          if (pick) useSelectionStore.getState().setMulti([pick]);
        }
        e.preventDefault();
        return;
      }

      // ── Ctrl+K → command palette ──────────────────────────────────────────
      if (e.code === 'KeyK' && e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
        emit({ command: 'palette.open' });
        e.preventDefault();
        return;
      }

      // ── F1..F4 → minimap layer toggle ─────────────────────────────────────
      const layer = F_KEY_LAYERS[e.code];
      if (layer && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
        emit({ command: 'minimap.toggleLayer', args: { layer } });
        e.preventDefault();
        return;
      }

      // ── Escape → clear multi-selection ────────────────────────────────────
      if (e.code === 'Escape' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
        useSelectionStore.getState().clearMulti();
        e.preventDefault();
        return;
      }

      // ── Single-letter HUD commands (no modifiers) ─────────────────────────
      if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
      switch (e.code) {
        case 'KeyT':
          emit({ command: 'terminal.focusUser' });
          e.preventDefault();
          return;
        case 'KeyM':
          emit({ command: 'map.openStrategic' });
          e.preventDefault();
          return;
        case 'KeyR':
          emit({ command: 'replay.open' });
          e.preventDefault();
          return;
        case 'KeyO':
          emit({ command: 'obsidian.openSelected' });
          e.preventDefault();
          return;
        default:
          return;
      }
    }

    function onKeyUp(_e: KeyboardEvent): void {
      // Reserved — voice push-to-talk (`~`) and chord shortcuts land here in v1.1.
    }

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  return null;
}
