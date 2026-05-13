import { useState, type FormEvent } from 'react';
import { dispatchPrompt } from '../lib/channel';
import { usePromptStore } from '../stores/promptStore';

/**
 * Floating prompt entry — sits over the bottom of the map (PRD §7.1).
 * Enter submits to Skippy via `dispatch_user_prompt`. While the most recent
 * prompt is streaming, the status pill shows "thinking…" then "speaking…"
 * until the agent_complete envelope flips `complete` true.
 */
export default function CommandBar() {
  const [draft, setDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const current = usePromptStore((s) => s.current);

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

  return (
    <form className="command-bar" onSubmit={onSubmit}>
      <input
        type="text"
        autoFocus
        spellCheck={false}
        placeholder="Order Skippy ▸  e.g.  build me a CLI that fetches ArXiv plasma papers"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        aria-label="Command to Skippy"
      />
      {status ? <span className="status">{status}</span> : null}
      <button type="submit" disabled={submitting || draft.trim().length === 0}>
        Send
      </button>
    </form>
  );
}
