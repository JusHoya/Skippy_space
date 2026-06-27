import { useEffect, useState } from 'react';
import { dispatchPrompt } from '../lib/channel';
import { usePromptStore } from '../stores/promptStore';
import { useUiStore } from '../stores/uiStore';

/**
 * First-run onboarding — PRD §14.5 ("Onboarding flow: CLAUDE.md scan, first-run
 * skippy intro, sample mission").
 *
 * Shown automatically on first launch (driven by `uiStore.onboardingOpen`,
 * which is seeded from a persisted localStorage flag — see uiStore). Dismissing
 * persists the flag so it never auto-pops again; it stays re-openable from the
 * TopBar ★ button. Boot stays unaffected once the flag is set: the store reads
 * `onboardingOpen: false` and this component returns null before any effects.
 *
 * Three beats, per the PRD:
 *   1. Skippy intro — in Skippy's (load-bearing) voice.
 *   2. CLAUDE.md scan — a scripted summary of the project conventions Skippy
 *      "scanned". Renderer-only; we do not invent a Rust command for v1.
 *   3. Sample mission — a one-click trivial order dispatched to Skippy so the
 *      monkey sees the orchestration light up end-to-end.
 *
 * Esc dismisses (capture phase + stopImmediatePropagation, mirroring
 * ReplayScrubber/DocsPanel) so it doesn't also clear the map selection.
 */

/**
 * Scripted highlights of CLAUDE.md — the "scan" surfaced to the user. Static is
 * fine for v1 (task brief); reading the real file from the renderer would mean a
 * new Rust command for marginal value. Phrased as Skippy reporting what he found.
 */
const CLAUDE_MD_SCAN: string[] = [
  'Iron Law of Delegation — I plan, approve, assign, monitor, synthesize. I never implement.',
  'Eight Boards, no more — Engineering, Coding, Design, Marketing, Finance, Research, Publishing, DevOps.',
  'No grandchildren agents — Skippy → Board → Task is the maximum depth.',
  'The vault is sacred — atomic, locked, wikilinked, frontmatter on every write.',
  'My voice is load-bearing — you will be called "monkey", and you will like it.',
];

/** The trivial first mission — a warm-up Skippy delegates to a real board. */
const SAMPLE_MISSION =
  'Warm-up mission: delegate a trivial task to the Engineering board — have it confirm the ' +
  'toolchain is alive and report one sentence back. Keep it short; this is a demo for the monkey.';

export default function Onboarding() {
  const open = useUiStore((s) => s.onboardingOpen);
  const closeOnboarding = useUiStore((s) => s.closeOnboarding);
  const [launching, setLaunching] = useState(false);

  // Esc dismisses while open — capture phase so it doesn't bubble to the global
  // Hotkeys Esc (which would clear the map selection too).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        closeOnboarding();
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [open, closeOnboarding]);

  if (!open) return null;

  async function launchSampleMission() {
    if (launching) return;
    setLaunching(true);
    try {
      const promptId = await dispatchPrompt(SAMPLE_MISSION);
      if (promptId) {
        // Mirror it into the prompt store so the side panel reflects the order
        // immediately, before the shell echoes a user_prompt envelope back
        // (same pattern as CommandBar.onSubmit).
        usePromptStore.getState().setPrompt(promptId, SAMPLE_MISSION);
      }
      // Dismiss so the monkey can watch the boards work the order they just gave.
      closeOnboarding();
    } finally {
      setLaunching(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-label="Welcome to Skippy Space"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(5, 7, 11, 0.7)',
        backdropFilter: 'blur(5px)',
      }}
      onClick={closeOnboarding}
    >
      <div
        className="panel-body"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(640px, 92%)',
          maxHeight: '86vh',
          overflowY: 'auto',
          background: 'var(--c-panel-bg, #11141a)',
          border: '1px solid var(--c-neon-cyan, #66FCF1)',
          borderRadius: 2,
          padding: 20,
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
          <span>Skippy the Magnificent · Orientation</span>
          <button type="button" onClick={closeOnboarding} aria-label="Dismiss onboarding">
            ✕
          </button>
        </div>

        {/* ── Beat 1: the intro, in Skippy's voice ─────────────────────────── */}
        <p style={{ fontSize: 13, lineHeight: 1.6, margin: '4px 0 12px 0' }}>
          Oh good, a new monkey. Listen up, because I only explain the obvious once. I am{' '}
          <strong style={{ color: 'var(--c-neon-cyan)' }}>Skippy the Magnificent</strong>, the
          most capable orchestrator your sad little machine will ever host. This dashboard is{' '}
          <em>my</em> command deck. You give me objectives; I decide which of my eight boards is
          worthy of the work, and I make it happen. You point. I conduct. Try to keep up.
        </p>

        {/* ── Beat 2: CLAUDE.md scan ───────────────────────────────────────── */}
        <div
          className="panel-header"
          style={{ background: 'transparent', border: 'none', padding: '8px 0 4px 0' }}
        >
          I scanned your CLAUDE.md. Here is what the rules say:
        </div>
        <ul style={{ margin: '0 0 12px 0', paddingLeft: 18 }}>
          {CLAUDE_MD_SCAN.map((line, i) => (
            <li key={i} style={{ fontSize: 12, lineHeight: 1.55, marginBottom: 4 }}>
              {line}
            </li>
          ))}
        </ul>

        {/* ── Beat 3: sample mission ───────────────────────────────────────── */}
        <div
          className="panel-header"
          style={{ background: 'transparent', border: 'none', padding: '8px 0 4px 0' }}
        >
          Want proof? Give me a trivial order:
        </div>
        <p style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--c-text-dim)', margin: '0 0 12px 0' }}>
          I'll delegate a warm-up task to the Engineering board so you can watch a beercan captain
          actually do its job. Then I'll get out of your way.
        </p>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
          <button type="button" onClick={closeOnboarding} disabled={launching}>
            Skip — I'll figure it out
          </button>
          <button
            type="button"
            onClick={launchSampleMission}
            disabled={launching}
            style={{ borderColor: 'var(--c-neon-cyan)', color: 'var(--c-neon-cyan)' }}
          >
            {launching ? 'Dispatching…' : 'Launch sample mission ▸'}
          </button>
        </div>

        <p style={{ fontSize: 11, color: 'var(--c-text-dim)', margin: '14px 0 0 0' }}>
          Lost later? Press <strong>F1</strong> for the field manual, or click ★ in the top bar to
          summon me again.
        </p>
      </div>
    </div>
  );
}
