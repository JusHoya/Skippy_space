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
import { useReplayStore } from '../stores/replayStore';

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

/**
 * Map F-key code → minimap layer name.
 *
 * PRD §14.5 reconciliation (Phase 4): F1 is reassigned to the in-app docs
 * overlay, so it is NO LONGER a plain minimap-layer key here. The `size`
 * layer that used to live on F1 is re-homed to **Shift+F1** (see
 * `SHIFT_F_KEY_LAYERS` and the matching legend in MinimapPane). F2–F4 keep
 * their original layers untouched, preserving muscle memory for three of four.
 */
const F_KEY_LAYERS: Record<string, MinimapLayer> = {
  F2: 'gitAge',
  F3: 'testCoverage',
  F4: 'errorDensity',
};

/** Minimap layers reached via Shift+F-key (the F1 re-home — see above). */
const SHIFT_F_KEY_LAYERS: Record<string, MinimapLayer> = {
  F1: 'size',
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
      // Only hijack Tab when there's actually a group to cycle (>1 member).
      // With nothing (or one) selected we must let Tab through so it keeps
      // driving the browser/HUD focus ring — swallowing it unconditionally
      // breaks keyboard navigation everywhere else (REVIEW §4).
      if (e.code === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        if (useSelectionStore.getState().multiSelected.length > 1) {
          useSelectionStore.getState().cycleTabForward();
          e.preventDefault();
        }
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

      // ── Backspace → reset camera to the default/fit view ──────────────────
      // RTS camera-home convention (cf. SC2 Backspace). SceneRoot consumes the
      // `camera.resetView` command and calls `useCameraStore.resetView()`,
      // which restores DEFAULT_CAMERA_VIEW (pan + scale). Without this binding
      // the reset action — and the §7.4 strategic-zoom default — is unreachable
      // (REVIEW §4). Guarded by `isEditableTarget` above so we never eat a
      // Backspace meant for a text field.
      if (e.code === 'Backspace' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
        emit({ command: 'camera.resetView' });
        e.preventDefault();
        return;
      }

      // ── Ctrl+K → command palette ──────────────────────────────────────────
      if (e.code === 'KeyK' && e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
        emit({ command: 'palette.open' });
        e.preventDefault();
        return;
      }

      // ── F1 → in-app docs overlay (PRD §14.5) ──────────────────────────────
      // PRD §14.5 assigns F1 to the in-app docs. We toggle `uiStore.docsOpen`
      // directly (discrete UI state — convention #3). Shift+F1 keeps the
      // displaced minimap "size" overlay reachable from the keyboard. When the
      // docs panel is already open it owns F1/Esc in the capture phase (see
      // DocsPanel) and stops propagation, so this branch only ever *opens* it.
      if (e.code === 'F1' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        if (e.shiftKey) {
          const layer = SHIFT_F_KEY_LAYERS[e.code];
          if (layer) emit({ command: 'minimap.toggleLayer', args: { layer } });
        } else {
          useUiStore.getState().toggleDocs();
        }
        e.preventDefault();
        return;
      }

      // ── F2..F4 → minimap layer toggle ─────────────────────────────────────
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
          // WS8: open the replay scrubber. We also emit the pub/sub command so
          // any other subscriber (Zone 6) can react to the same intent.
          useReplayStore.getState().openScrubber();
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
