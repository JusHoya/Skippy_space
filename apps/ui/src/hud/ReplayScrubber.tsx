import { useEffect, useMemo } from 'react';
import {
  reconstructAt,
  recordAgentId,
  useReplayStore,
  type ReplayRecord,
} from '../stores/replayStore';

/**
 * Replay scrubber — PRD §9.5 (WS8/D5).
 *
 * A modal panel (only mounted when `replayStore.open`) that lets the user pick a
 * recorded session, scrub a range slider over its envelope stream, and read the
 * selected envelope plus the reconstructed per-agent state at that index.
 *
 * Opened by the `R` hotkey (see Hotkeys.tsx → openScrubber). Closed by Esc or
 * the close button. Uses the existing HUD CSS idiom (panel-body / stat-row /
 * k+v) with a fixed overlay so it floats above the map without a router.
 */

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function recordSummary(rec: ReplayRecord): string {
  if (!rec || typeof rec !== 'object') return String(rec);
  const t = typeof rec.type === 'string' ? rec.type : '(no type)';
  // ReplayRecord is now the strict Envelope union — only some variants carry an
  // agentId, so read it through the type-safe helper rather than a bare property.
  const id = recordAgentId(rec);
  const agent = id ? ` · ${id}` : '';
  return `${t}${agent}`;
}

export default function ReplayScrubber() {
  const open = useReplayStore((s) => s.open);
  const sessions = useReplayStore((s) => s.sessions);
  const activeSessionId = useReplayStore((s) => s.activeSessionId);
  const records = useReplayStore((s) => s.records);
  const selectedIndex = useReplayStore((s) => s.selectedIndex);
  const closeScrubber = useReplayStore((s) => s.closeScrubber);
  const loadSession = useReplayStore((s) => s.loadSession);
  const setSelectedIndex = useReplayStore((s) => s.setSelectedIndex);

  // Esc closes the panel while it's open.
  //
  // The global Hotkeys listener also handles Esc (→ clearMulti, clearing the
  // map selection). Both are window keydown listeners, so an un-scoped handler
  // here would let a single Esc both close the scrubber AND wipe the user's map
  // selection. We register in the CAPTURE phase — which runs before the
  // Hotkeys bubble-phase listener regardless of mount order — and call
  // stopImmediatePropagation so the keystroke is consumed by the scrubber alone
  // while it is open. When the scrubber is closed this effect is torn down, so
  // Esc falls through to Hotkeys as normal.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        closeScrubber();
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [open, closeScrubber]);

  const selectedRecord = records[selectedIndex];
  const reconstruction = useMemo(
    () => reconstructAt(records, selectedIndex),
    [records, selectedIndex],
  );
  const agents = Object.values(reconstruction).sort((a, b) =>
    a.agentId.localeCompare(b.agentId),
  );

  if (!open) return null;

  const maxIndex = Math.max(0, records.length - 1);

  return (
    <div
      role="dialog"
      aria-label="Replay scrubber"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 40,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(5, 7, 11, 0.55)',
        backdropFilter: 'blur(4px)',
      }}
      onClick={closeScrubber}
    >
      <div
        className="panel-body"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(760px, 92%)',
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
          <span>Replay scrubber</span>
          <button type="button" onClick={closeScrubber} aria-label="Close replay scrubber">
            ✕
          </button>
        </div>

        {/* ── Session picker ─────────────────────────────────────────────── */}
        <div className="stat-row" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="k">Session</span>
          <span className="v" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <select
              value={activeSessionId ?? ''}
              onChange={(e) => {
                if (e.target.value) void loadSession(e.target.value);
              }}
            >
              <option value="" disabled>
                {sessions.length > 0 ? 'Select a session…' : 'No replays found'}
              </option>
              {sessions.map((s) => (
                <option key={s.sessionId} value={s.sessionId}>
                  {s.sessionId} · {fmtBytes(s.sizeBytes)}
                </option>
              ))}
            </select>
          </span>
        </div>

        {/* ── Range slider over records ──────────────────────────────────── */}
        <div style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
            <span>
              Frame {records.length > 0 ? selectedIndex + 1 : 0} / {records.length}
            </span>
            <span style={{ color: 'var(--c-text-dim)' }}>
              {selectedRecord ? recordSummary(selectedRecord) : '—'}
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={maxIndex}
            value={selectedIndex}
            disabled={records.length === 0}
            onChange={(e) => setSelectedIndex(Number(e.target.value))}
            style={{ width: '100%', marginTop: 4 }}
          />
        </div>

        {/* ── Selected record readout ────────────────────────────────────── */}
        <div style={{ marginTop: 12 }}>
          <div
            className="panel-header"
            style={{ background: 'transparent', border: 'none', padding: '0 0 4px 0' }}
          >
            Selected envelope
          </div>
          <pre
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              maxHeight: 160,
              overflowY: 'auto',
              margin: 0,
              padding: 8,
              background: 'rgba(0,0,0,0.3)',
              borderRadius: 3,
            }}
          >
            {selectedRecord ? JSON.stringify(selectedRecord, null, 2) : '(no records loaded)'}
          </pre>
        </div>

        {/* ── Reconstructed per-agent state at this index ────────────────── */}
        <div style={{ marginTop: 12 }}>
          <div
            className="panel-header"
            style={{ background: 'transparent', border: 'none', padding: '0 0 4px 0' }}
          >
            Agent state @ frame {records.length > 0 ? selectedIndex + 1 : 0}
          </div>
          {agents.length === 0 ? (
            <div style={{ fontSize: 11, color: 'var(--c-text-dim)' }}>
              No agent activity up to this frame.
            </div>
          ) : (
            agents.map((a) => (
              <div className="stat-row" key={a.agentId}>
                <span className="k">{a.agentId}</span>
                <span className="v">
                  {a.state ?? '—'}
                  {a.model ? ` · ${a.model}` : ''}
                  {a.lastToken ? ` · "${a.lastToken.slice(0, 24)}"` : ''}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
