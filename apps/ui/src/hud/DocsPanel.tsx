import { useEffect, useMemo, useRef, useState } from 'react';
import { BOARD_META, type BoardId } from '@skippy/shared';
import { useUiStore } from '../stores/uiStore';

/**
 * In-app docs overlay — PRD §14.5 ("In-app docs (open at any time, F1)").
 *
 * Opens/closes via F1 (global Hotkeys toggles `uiStore.docsOpen`) and closes
 * via F1 or Escape while focused anywhere. Content is a curated, searchable set
 * of help topics baked into the component (v1) — keybindings, the eight boards,
 * how to launch a mission, and Skippy's Iron Law. Searchable by free-text query
 * over each topic's title + body + keyword tags.
 *
 * Follows the ReplayScrubber modal idiom: a fixed full-screen scrim with a
 * centered `.panel-body` card, inline-styled so we lean on the existing HUD CSS
 * vars without inventing a pile of new classes. Esc/F1 are handled in the
 * CAPTURE phase with `stopImmediatePropagation` so a single keypress closes the
 * panel WITHOUT also firing the global Hotkeys bindings underneath it (same
 * pattern ReplayScrubber uses for Esc).
 */

interface DocLine {
  /** Left-hand key/term (e.g. a keybinding or board name). Optional. */
  k?: string;
  /** Right-hand explanation. */
  v: string;
}

interface DocTopic {
  id: string;
  title: string;
  /** Extra search tags that aren't necessarily in the visible text. */
  tags: string[];
  /** Optional intro paragraph rendered above the rows. */
  intro?: string;
  rows: DocLine[];
}

/** The eight boards, rendered straight from the single-source-of-truth meta. */
const BOARD_ROWS: DocLine[] = (Object.keys(BOARD_META) as BoardId[]).map((id) => ({
  k: BOARD_META[id].displayName,
  v: `Codename "${BOARD_META[id].codename}". Commands its task agents; reports up to Skippy.`,
}));

/**
 * Curated help topics. Static content is acceptable for v1 (per task brief) —
 * the important part is that it's searchable and in Skippy's voice where Skippy
 * is the speaker.
 */
const TOPICS: DocTopic[] = [
  {
    id: 'keybindings',
    title: 'Keybindings',
    tags: ['hotkey', 'keyboard', 'shortcut', 'controls', 'f1', 'f2', 'f3', 'f4', 'keys'],
    intro: 'The muscle-memory layer. Bindings defer while you are typing in a field.',
    rows: [
      { k: 'F1', v: 'Open / close these docs.' },
      { k: 'Shift+F1', v: 'Toggle the minimap SIZE layer (re-homed off F1).' },
      { k: 'F2 / F3 / F4', v: 'Toggle minimap layers: git-age, test-coverage, error-density.' },
      { k: 'Space', v: 'Active-pause — freeze the world to issue orders.' },
      { k: 'M', v: 'Open the strategic map.' },
      { k: 'R', v: 'Open the replay scrubber.' },
      { k: 'T', v: 'Focus your terminal.' },
      { k: 'O', v: 'Open the selected agent in Obsidian.' },
      { k: 'Tab', v: 'Cycle the primary through a multi-selection.' },
      { k: 'Esc', v: 'Clear selection / close the open overlay.' },
      { k: '1 – 9', v: 'Recall a control group. Ctrl+N binds it; Shift+N adds to it.' },
      { k: 'Ctrl+K', v: 'Command palette.' },
      { k: 'Ctrl+.', v: 'Cycle through idle agents.' },
      { k: 'Backspace', v: 'Reset the camera to the fit-all view.' },
    ],
  },
  {
    id: 'boards',
    title: 'The Eight Boards',
    tags: ['board', 'captain', 'agents', 'roster', 'engineering', 'coding', 'design', 'devops'],
    intro:
      'Eight captains ring Skippy on the clock-map. Each commands a slate of task agents. ' +
      'The count is fixed at eight, monkey — it keeps the map readable.',
    rows: BOARD_ROWS,
  },
  {
    id: 'launch-mission',
    title: 'Launching a Mission',
    tags: ['mission', 'order', 'prompt', 'delegate', 'command bar', 'start', 'how to'],
    intro:
      'You do not micro-manage the workers. You tell Skippy what you want; Skippy plans it, ' +
      'approves it, and delegates it to the right board.',
    rows: [
      { k: '1', v: 'Type your objective into the command bar at the bottom of the map.' },
      { k: '2', v: 'Press Enter. Skippy decides which board owns the work.' },
      { k: '3', v: 'Watch the beercan captain light up and walk the delegation to its board.' },
      { k: '4', v: 'Press R afterward to replay exactly what happened, frame by frame.' },
    ],
  },
  {
    id: 'iron-law',
    title: "Skippy's Iron Law of Delegation",
    tags: ['iron law', 'delegation', 'skippy', 'orchestrator', 'rules', 'persona'],
    intro:
      'Skippy the Magnificent is an orchestrator, not a laborer. He plans, approves, assigns, ' +
      'monitors, broadcasts, and synthesizes. He does NOT implement — that is what the monkeys ' +
      'and their boards are for.',
    rows: [
      { k: 'Plan', v: 'Skippy decomposes your objective into board-sized work.' },
      { k: 'Approve', v: 'Nothing executes until Skippy signs off on the plan.' },
      { k: 'Assign', v: 'Work goes to exactly one board — Skippy → Board → Task, max depth.' },
      { k: 'Monitor', v: 'Skippy watches the boards; no grandchildren agents are permitted.' },
      { k: 'Synthesize', v: 'Skippy folds the results back into one answer for you.' },
    ],
  },
];

/** Build the lowercased haystack for a topic once, for cheap query filtering. */
function topicHaystack(t: DocTopic): string {
  const rowText = t.rows.map((r) => `${r.k ?? ''} ${r.v}`).join(' ');
  return `${t.title} ${t.intro ?? ''} ${t.tags.join(' ')} ${rowText}`.toLowerCase();
}

export default function DocsPanel() {
  const open = useUiStore((s) => s.docsOpen);
  const closeDocs = useUiStore((s) => s.closeDocs);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // F1 / Esc close the panel while it is open. Registered in the CAPTURE phase
  // so it runs before the global Hotkeys bubble-phase listener — and
  // stopImmediatePropagation ensures a single F1/Esc closes docs WITHOUT also
  // re-toggling docs (F1) or clearing the map selection (Esc) underneath.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' || e.code === 'F1') {
        e.preventDefault();
        e.stopImmediatePropagation();
        closeDocs();
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [open, closeDocs]);

  // Focus the search box when the panel opens so the user can type immediately.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return TOPICS;
    return TOPICS.filter((t) => topicHaystack(t).includes(q));
  }, [query]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-label="In-app docs"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 45,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(5, 7, 11, 0.55)',
        backdropFilter: 'blur(4px)',
      }}
      onClick={closeDocs}
    >
      <div
        className="panel-body"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(720px, 92%)',
          maxHeight: '82vh',
          overflowY: 'auto',
          background: 'var(--c-panel-bg, #11141a)',
          border: '1px solid var(--c-muted-cyan, #45a29e)',
          borderRadius: 2,
          padding: 16,
        }}
      >
        <div
          className="panel-header"
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            background: 'transparent',
            border: 'none',
            padding: '0 0 8px 0',
          }}
        >
          <span>Field Manual · F1</span>
          <button type="button" onClick={closeDocs} aria-label="Close docs">
            ✕
          </button>
        </div>

        {/* ── Search ──────────────────────────────────────────────────────── */}
        <input
          ref={inputRef}
          type="text"
          spellCheck={false}
          placeholder="Search the manual…  e.g.  pause, boards, iron law"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search docs"
          style={{ width: '100%', fontFamily: 'var(--font-mono)', marginBottom: 12 }}
        />

        {/* ── Topics ──────────────────────────────────────────────────────── */}
        {results.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--c-text-dim)' }}>
            Nothing matches "{query.trim()}". Even Skippy can't help you there, monkey.
          </div>
        ) : (
          results.map((t) => (
            <section key={t.id} style={{ marginBottom: 16 }}>
              <div
                className="panel-header"
                style={{ background: 'transparent', border: 'none', padding: '0 0 4px 0' }}
              >
                {t.title}
              </div>
              {t.intro ? (
                <p style={{ fontSize: 12, lineHeight: 1.5, margin: '0 0 8px 0' }}>{t.intro}</p>
              ) : null}
              {t.rows.map((r, i) => (
                <div className="stat-row" key={`${t.id}-${i}`}>
                  {r.k ? (
                    <span className="k" style={{ minWidth: 96 }}>
                      {r.k}
                    </span>
                  ) : null}
                  <span className="v">{r.v}</span>
                </div>
              ))}
            </section>
          ))
        )}
      </div>
    </div>
  );
}
