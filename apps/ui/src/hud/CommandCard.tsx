import { useCallback, useMemo } from 'react';
import { BOARD_COSTUMES, numToHex, type BoardId } from '@skippy/sprite-kit';
import { useUiStore } from '../stores/uiStore';
import { useClaudeCodeStore } from '../stores/claudeCodeStore';
import { spawnClaudeCode } from '../lib/claudeCode';

interface Slot {
  hotkey: string;
  label: string;
  /**
   * Optional action id. When set, the button renders enabled and dispatches the
   * named action on click. Slots without an action stay decorative — Phase 4
   * polishes the rest. Currently the only wired action is `spawn_claude_code`.
   */
  action?: 'spawn_claude_code';
}

// ── Skippy slate ─────────────────────────────────────────────────────────────
//
// Skippy's twelve actions cover the orchestrator's vocabulary from PRD §7.4:
// plan, delegate, review, replay, broadcast, vault sync, daily note, pause
// all, cost audit, lint wiki, stop task, open Obsidian. The R slot is
// repurposed to "Claude Code" for Phase 3-prep — Skippy can spawn a one-shot
// `claude` CLI subprocess as a task agent (PRD §5.1 + R-01).
const SKIPPY_SLOTS: Slot[] = [
  { hotkey: 'Q', label: 'Plan' },
  { hotkey: 'W', label: 'Delegate' },
  { hotkey: 'E', label: 'Review' },
  { hotkey: 'R', label: 'Claude Code', action: 'spawn_claude_code' },
  { hotkey: 'A', label: 'Broadcast' },
  { hotkey: 'S', label: 'Sync Vault' },
  { hotkey: 'D', label: 'Daily Note' },
  { hotkey: 'F', label: 'Pause All' },
  { hotkey: 'Z', label: 'Cost Audit' },
  { hotkey: 'X', label: 'Lint Wiki' },
  { hotkey: 'C', label: 'Stop Task' },
  { hotkey: 'V', label: 'Open Obsidian' },
];

/**
 * Per-board slates. Eight 12-button cards customized to each captain's
 * skill area. The opening row (Q/W/E/R) is reserved for the universal Board
 * actions (accept, counter, decline, spawn task); rows two and three are
 * board-specific. Empty slots stay disabled — they're visible scaffolding for
 * future affordances rather than dead buttons.
 *
 * Phase 3-prep: the existing "R — Spawn Task" slot is rewired to
 * `spawn_claude_code`, which is the load-bearing mechanism for boards to
 * spawn task agents from now on (PRD §5.1 + §10 + R-01: `claude` is
 * Rust-spawned via portable-pty, never from Node).
 */
const BOARD_SLOTS: Record<BoardId, Slot[]> = {
  engineering: [
    { hotkey: 'Q', label: 'Accept' },
    { hotkey: 'W', label: 'Counter' },
    { hotkey: 'E', label: 'Decline' },
    { hotkey: 'R', label: 'Claude Code', action: 'spawn_claude_code' },
    { hotkey: 'A', label: 'Refactor' },
    { hotkey: 'S', label: 'Add Test' },
    { hotkey: 'D', label: 'Profile' },
    { hotkey: 'F', label: 'Diagram' },
    { hotkey: 'Z', label: 'Architecture' },
    { hotkey: 'X', label: 'Trade Study' },
    { hotkey: 'C', label: 'Effort±' },
    { hotkey: 'V', label: 'Stand Down' },
  ],
  coding: [
    { hotkey: 'Q', label: 'Accept' },
    { hotkey: 'W', label: 'Counter' },
    { hotkey: 'E', label: 'Decline' },
    { hotkey: 'R', label: 'Claude Code', action: 'spawn_claude_code' },
    { hotkey: 'A', label: 'Debug' },
    { hotkey: 'S', label: 'TDD' },
    { hotkey: 'D', label: 'Review' },
    { hotkey: 'F', label: 'Reverse' },
    { hotkey: 'Z', label: 'Run Tests' },
    { hotkey: 'X', label: 'Lint' },
    { hotkey: 'C', label: 'Effort±' },
    { hotkey: 'V', label: 'Stand Down' },
  ],
  design: [
    { hotkey: 'Q', label: 'Accept' },
    { hotkey: 'W', label: 'Counter' },
    { hotkey: 'E', label: 'Decline' },
    { hotkey: 'R', label: 'Claude Code', action: 'spawn_claude_code' },
    { hotkey: 'A', label: 'Mockup' },
    { hotkey: 'S', label: 'Palette' },
    { hotkey: 'D', label: 'Sprite Pass' },
    { hotkey: 'F', label: 'Tokens' },
    { hotkey: 'Z', label: 'Critique' },
    { hotkey: 'X', label: 'A/B' },
    { hotkey: 'C', label: 'Effort±' },
    { hotkey: 'V', label: 'Stand Down' },
  ],
  marketing: [
    { hotkey: 'Q', label: 'Accept' },
    { hotkey: 'W', label: 'Counter' },
    { hotkey: 'E', label: 'Decline' },
    { hotkey: 'R', label: 'Claude Code', action: 'spawn_claude_code' },
    { hotkey: 'A', label: 'Draft Post' },
    { hotkey: 'S', label: 'A/B Variants' },
    { hotkey: 'D', label: 'Schedule' },
    { hotkey: 'F', label: 'Analytics' },
    { hotkey: 'Z', label: 'Funnel' },
    { hotkey: 'X', label: 'Voice Check' },
    { hotkey: 'C', label: 'Effort±' },
    { hotkey: 'V', label: 'Stand Down' },
  ],
  finance: [
    { hotkey: 'Q', label: 'Accept' },
    { hotkey: 'W', label: 'Counter' },
    { hotkey: 'E', label: 'Decline' },
    { hotkey: 'R', label: 'Claude Code', action: 'spawn_claude_code' },
    { hotkey: 'A', label: 'Macro' },
    { hotkey: 'S', label: 'Micro' },
    { hotkey: 'D', label: 'Backtest' },
    { hotkey: 'F', label: 'Cost Audit' },
    { hotkey: 'Z', label: 'Allocate' },
    { hotkey: 'X', label: 'Risk' },
    { hotkey: 'C', label: 'Effort±' },
    { hotkey: 'V', label: 'Stand Down' },
  ],
  research: [
    { hotkey: 'Q', label: 'Accept' },
    { hotkey: 'W', label: 'Counter' },
    { hotkey: 'E', label: 'Decline' },
    { hotkey: 'R', label: 'Claude Code', action: 'spawn_claude_code' },
    { hotkey: 'A', label: 'Web Search' },
    { hotkey: 'S', label: 'Lit Review' },
    { hotkey: 'D', label: 'Ingest' },
    { hotkey: 'F', label: 'Distill' },
    { hotkey: 'Z', label: 'Hallucinate?' },
    { hotkey: 'X', label: 'Source Cite' },
    { hotkey: 'C', label: 'Effort±' },
    { hotkey: 'V', label: 'Stand Down' },
  ],
  publishing: [
    { hotkey: 'Q', label: 'Accept' },
    { hotkey: 'W', label: 'Counter' },
    { hotkey: 'E', label: 'Decline' },
    { hotkey: 'R', label: 'Claude Code', action: 'spawn_claude_code' },
    { hotkey: 'A', label: 'Draft' },
    { hotkey: 'S', label: 'Edit' },
    { hotkey: 'D', label: 'Headline' },
    { hotkey: 'F', label: 'Schedule' },
    { hotkey: 'Z', label: 'Newsletter' },
    { hotkey: 'X', label: 'Crosspost' },
    { hotkey: 'C', label: 'Effort±' },
    { hotkey: 'V', label: 'Stand Down' },
  ],
  devops: [
    { hotkey: 'Q', label: 'Accept' },
    { hotkey: 'W', label: 'Counter' },
    { hotkey: 'E', label: 'Decline' },
    { hotkey: 'R', label: 'Claude Code', action: 'spawn_claude_code' },
    { hotkey: 'A', label: 'CI Status' },
    { hotkey: 'S', label: 'Deploy' },
    { hotkey: 'D', label: 'Rollback' },
    { hotkey: 'F', label: 'Build' },
    { hotkey: 'Z', label: 'Update Deps' },
    { hotkey: 'X', label: 'Tail Logs' },
    { hotkey: 'C', label: 'Effort±' },
    { hotkey: 'V', label: 'Stand Down' },
  ],
};

/**
 * Generic fallback for staff / task agents. Slimmer than a Board card; the
 * universal accept/decline row is replaced by inspection actions. Task agents
 * cannot spawn further claude-code subprocesses (no grandchildren per
 * CLAUDE.md "Don't" #7), so the `spawn_claude_code` action is intentionally
 * absent here.
 */
const GENERIC_SLOTS: Slot[] = [
  { hotkey: 'Q', label: 'Inspect' },
  { hotkey: 'W', label: 'Order' },
  { hotkey: 'E', label: '' },
  { hotkey: 'R', label: 'Spawn Sub' },
  { hotkey: 'A', label: 'Status' },
  { hotkey: 'S', label: 'Memory' },
  { hotkey: 'D', label: 'Effort±' },
  { hotkey: 'F', label: 'Model' },
  { hotkey: 'Z', label: '' },
  { hotkey: 'X', label: '' },
  { hotkey: 'C', label: '' },
  { hotkey: 'V', label: 'Stand Down' },
];

function parseBoardId(agentId: string | null): BoardId | null {
  if (!agentId) return null;
  if (!agentId.startsWith('board.')) return null;
  const tail = agentId.slice(6);
  if (tail in BOARD_COSTUMES) return tail as BoardId;
  return null;
}

/**
 * 12-button (3×4) command grid — PRD §7.4. Slate is keyed by the currently
 * selected agent: Skippy gets his orchestrator vocabulary, each Board captain
 * gets their skill-area-specific deck, staff/task agents get the generic deck.
 *
 * Phase 3-prep: the `R` slot on Skippy and every board now dispatches
 * `spawn_claude_code`, which prompts the user for a one-line task brief via
 * `window.prompt()` and invokes the Rust shell's `claude_code_spawn` Tauri
 * command. Cheap UI; Phase 4 will replace the prompt with a proper inline
 * task-brief composer.
 */
export default function CommandCard() {
  const selectedId = useUiStore((s) => s.selectedAgentId);
  const setTaskBrief = useClaudeCodeStore((s) => s.setTaskBrief);

  const { slots, accentHex } = useMemo<{ slots: Slot[]; accentHex: string }>(() => {
    if (selectedId === 'skippy') {
      return { slots: SKIPPY_SLOTS, accentHex: '#66FCF1' };
    }
    const boardId = parseBoardId(selectedId);
    if (boardId) {
      return {
        slots: BOARD_SLOTS[boardId],
        accentHex: numToHex(BOARD_COSTUMES[boardId].accentColor),
      };
    }
    return { slots: GENERIC_SLOTS, accentHex: '#45A29E' };
  }, [selectedId]);

  const handleSpawnClaudeCode = useCallback(async () => {
    if (!selectedId) return;
    // Only Skippy and the eight Board captains may spawn claude-code task
    // agents. Anyone else falls through to a no-op (the button is also hidden
    // there because GENERIC_SLOTS doesn't carry the action).
    const isSkippy = selectedId === 'skippy';
    const isBoard = parseBoardId(selectedId) !== null;
    if (!isSkippy && !isBoard) return;

    // Phase 4 will replace this with an inline composer overlay; for now the
    // cheapest possible UI is a `window.prompt`.
    const brief = window.prompt(
      `Spawn claude-code task agent for ${selectedId}.\n\nTask brief (one line):`,
      '',
    );
    if (brief === null) return; // user cancelled
    const trimmed = brief.trim();
    if (trimmed.length === 0) return;

    const result = await spawnClaudeCode({
      parentAgentId: selectedId,
      taskBrief: trimmed,
    });
    if (result === null) {
      // safeInvoke logged the failure; surface a quick alert so the user knows.
      // Phase 4 will replace with a toast.
      console.warn(
        `[skippy/ui] spawnClaudeCode failed (parent=${selectedId}). Is the \`claude\` CLI on PATH?`,
      );
      return;
    }
    // Stash the brief on the store right away so the TerminalCluster tab gets
    // a meaningful label even before the `claude_code_spawned` envelope arrives.
    setTaskBrief(result.spawnId, trimmed);
  }, [selectedId, setTaskBrief]);

  return (
    <div
      className="command-card"
      role="grid"
      aria-label="Command card"
      style={{ borderTopColor: accentHex }}
    >
      {slots.map((slot, idx) => {
        const enabled = slot.label !== '' && slot.action !== undefined ? true : !!slot.label;
        const hasHandler = slot.action === 'spawn_claude_code';
        return (
          <button
            key={`${slot.hotkey}-${idx}`}
            type="button"
            className={`slot ${slot.label ? '' : 'empty'} ${slot.action ? 'wired' : ''}`}
            disabled={!enabled || !hasHandler}
            title={slot.label || 'empty'}
            onClick={hasHandler ? handleSpawnClaudeCode : undefined}
          >
            <span className="hotkey" style={slot.label ? { color: accentHex } : undefined}>
              {slot.hotkey}
            </span>
            <span>{slot.label}</span>
          </button>
        );
      })}
    </div>
  );
}
