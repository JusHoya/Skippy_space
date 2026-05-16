import { useEffect, useMemo, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { AgentId } from '@skippy/shared';
import { dispatchPrompt } from '../lib/channel';
import { usePromptStore } from '../stores/promptStore';
import { useAgentStore } from '../stores/agentStore';
import { useSelectionStore } from '../stores/selectionStore';
import AgentNavigator from './AgentNavigator';
import { buildAgentActivity } from './agentActivity';

/**
 * Floating prompt entry — sits over the bottom of the map (PRD §7.1).
 *
 * Enter submits to Skippy via `dispatch_user_prompt`. While the most recent
 * prompt is streaming, the status pill shows "thinking…" then "speaking…"
 * until the agent_complete envelope flips `complete` true.
 *
 * Phase 3-prep: pressing ↓ from an empty input opens an Agent Navigator
 * overlay (Claude Code TUI-style). The navigator owns ↑/↓/Enter/Esc while
 * open; the input stays focused so closing the overlay (Esc) returns the
 * caret naturally without a manual `focus()` dance.
 */
export default function CommandBar() {
  const [draft, setDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [cursorIndex, setCursorIndex] = useState(0);

  const current = usePromptStore((s) => s.current);
  const agents = useAgentStore((s) => s.agents);
  // `current` is subscribed for status, but also because new tokens shift
  // agent `lastToken` timestamps, which we want reflected in the navigator
  // ranking. The dependency on `current` in the memo below picks that up.

  const entries = useMemo(
    () => buildAgentActivity(agents),
    // `current` participates so streaming tokens re-rank the list even when
    // the agentStore reference doesn't change identity (Zustand always
    // returns a new object on setAgent, but this guards against any future
    // stable-identity refactor).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agents, current?.streamed, current?.complete],
  );

  // When entries reshape, keep the cursor inside bounds.
  useEffect(() => {
    if (cursorIndex >= entries.length) {
      setCursorIndex(entries.length > 0 ? entries.length - 1 : 0);
    }
  }, [entries.length, cursorIndex]);

  const status =
    submitting
      ? 'dispatching…'
      : current && !current.complete
      ? current.streamed.length > 0
        ? 'speaking…'
        : 'thinking…'
      : null;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    // If the navigator is open, Enter is owned by AgentNavigator's keydown
    // handler; bail out of the form submit so we don't double-dispatch.
    if (navOpen) return;
    const text = draft.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    try {
      const promptId = await dispatchPrompt(text);
      if (promptId) {
        // Mirror outgoing prompt into the store so the side panel reflects it
        // even before the shell echoes a user_prompt envelope back.
        usePromptStore.getState().setPrompt(promptId, text);
      }
      setDraft('');
    } finally {
      setSubmitting(false);
    }
  }

  function onInputKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    // ArrowDown from an empty input opens the navigator. Non-empty input
    // leaves the keystroke alone so caret-movement still works inside text.
    if (e.key === 'ArrowDown' && !navOpen && draft.length === 0) {
      e.preventDefault();
      setCursorIndex(0);
      setNavOpen(true);
    }
  }

  return (
    <>
      <AgentNavigator
        open={navOpen}
        entries={entries}
        cursorIndex={cursorIndex}
        onCursorChange={setCursorIndex}
        onPick={(entry) => {
          useSelectionStore.getState().setMulti([entry.agentId as AgentId]);
          setNavOpen(false);
        }}
        onClose={() => setNavOpen(false)}
      />
      <form className="command-bar" onSubmit={onSubmit}>
        <input
          type="text"
          autoFocus
          spellCheck={false}
          placeholder="Order Skippy ▸  e.g.  build me a CLI that fetches ArXiv plasma papers"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onInputKeyDown}
          aria-label="Command to Skippy"
          aria-expanded={navOpen}
          aria-controls="agent-navigator"
        />
        {status ? <span className="status">{status}</span> : null}
        <button type="submit" disabled={submitting || draft.trim().length === 0 || navOpen}>
          Send
        </button>
      </form>
    </>
  );
}
