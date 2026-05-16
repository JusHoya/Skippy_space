import { useMemo, useState } from 'react';
import TerminalPane from './TerminalPane';
import { useClaudeCodeStore, type ClaudeCodeSpawnEntry } from '../stores/claudeCodeStore';

/**
 * Bottom strip of N xterm panes — PRD §7.6. Phase 0 shipped a single user PTY
 * tab; Phase 3-prep wires in agent-attached PTYs spawned by `claude_code_spawn`
 * (PRD §5.1 + R-01). Each entry in `claudeCodeStore.spawns` becomes one tab
 * pointing at the existing Rust-side ptyId; closing the tab unsubscribes the
 * renderer but does NOT kill the subprocess — the user's PTY-close affordance
 * is the only way to kill it.
 */
interface Tab {
  id: string;
  label: string;
  /** When set, attach to an existing Rust-side PTY instead of opening a new one. */
  existingPtyId?: string;
}

/** First 20 chars of the task brief, with a fallback label. */
function tabLabelFor(entry: ClaudeCodeSpawnEntry): string {
  const trimmed = (entry.taskBrief ?? '').trim();
  const head = trimmed.length > 0 ? trimmed.slice(0, 20) : entry.parentAgentId;
  const suffix = entry.exitedAt ? ` ✓${entry.exitCode ?? '?'}` : '';
  return `claude: ${head}${suffix}`;
}

export default function TerminalCluster() {
  // The user PTY tab is always present.
  const userTab: Tab = { id: 'user', label: '$ user shell' };
  const spawns = useClaudeCodeStore((s) => s.spawns);
  const removeSpawn = useClaudeCodeStore((s) => s.remove);

  const claudeTabs = useMemo<Tab[]>(
    () =>
      Object.values(spawns)
        // Drop placeholder entries that don't yet have a real ptyId — those are
        // local-only stubs created by `setTaskBrief` before the Rust shell
        // replies. They'll get the ptyId once `claude_code_spawned` arrives.
        .filter((s) => s.ptyId !== '')
        // Oldest-first so the tab order is stable as the user spawns more.
        .sort((a, b) => a.spawnedAt.localeCompare(b.spawnedAt))
        .map((s) => ({
          id: `claude:${s.spawnId}`,
          label: tabLabelFor(s),
          existingPtyId: s.ptyId,
        })),
    [spawns],
  );

  const tabs: Tab[] = useMemo(() => [userTab, ...claudeTabs], [claudeTabs]);
  const [active, setActive] = useState<string>('user');

  // If the active tab disappears (e.g. the user closed it), fall back to user.
  const activeExists = tabs.some((t) => t.id === active);
  const effectiveActive = activeExists ? active : 'user';

  const closeClaudeTab = (spawnId: string) => {
    // Drop the renderer-side record. The subprocess and its PTY continue to
    // run; the Rust shell's exit-watcher task will publish `claude_code_exited`
    // when the process eventually ends. We *don't* call `pty_close` here —
    // the user can re-attach (when we add that affordance) by reopening the
    // tab; for now closing just hides scrollback.
    removeSpawn(spawnId);
    if (effectiveActive === `claude:${spawnId}`) {
      setActive('user');
    }
  };

  return (
    <div className="terminal-cluster">
      <div className="terminal-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`terminal-tab ${tab.id === effectiveActive ? 'active' : ''}`}
            onClick={() => setActive(tab.id)}
            // Right-click on a claude-code tab removes it from the renderer
            // (does NOT kill the subprocess). Keyboard/Touch users get the
            // same affordance via the inline × button below.
            onContextMenu={(e) => {
              if (tab.id.startsWith('claude:')) {
                e.preventDefault();
                closeClaudeTab(tab.id.slice('claude:'.length));
              }
            }}
            title={tab.label}
          >
            <span>{tab.label}</span>
            {tab.id.startsWith('claude:') ? (
              <span
                role="button"
                aria-label={`Close ${tab.label}`}
                className="terminal-tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  closeClaudeTab(tab.id.slice('claude:'.length));
                }}
                style={{ marginLeft: 6, opacity: 0.5, cursor: 'pointer' }}
              >
                ×
              </span>
            ) : null}
          </button>
        ))}
      </div>
      <div className="terminal-host">
        {/* Keep all tabs mounted to preserve scrollback; show only the active one. */}
        {tabs.map((tab) => (
          <div
            key={tab.id}
            style={{
              position: 'absolute',
              inset: 4,
              display: tab.id === effectiveActive ? 'block' : 'none',
            }}
          >
            {/* Conditional spread so `existingPtyId` is omitted (not =undefined)
                when this is the user shell tab — required by tsconfig's
                `exactOptionalPropertyTypes: true`. */}
            <TerminalPane
              tabId={tab.id}
              {...(tab.existingPtyId !== undefined ? { existingPtyId: tab.existingPtyId } : {})}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
