// ModelPicker.tsx — Phase 3-prep (Zone 5).
//
// Compact <select> dropdown styled to slot into the TopBar (Skippy scope) or
// the SelectedPanel (per-board scope). The option list comes from
// `AVAILABLE_MODELS` in @skippy/shared so the renderer never carries its own
// model whitelist — `phase3prep.ts` is the single source of truth.
//
// Per PRD §3.3 / §13.5 / §15 R-01/R-09: the user picks a model per-agent;
// no "apply to all boards" — that's how cost control gets accidentally
// disabled. Options are grouped by tier (Opus / Sonnet / Haiku) via <optgroup>
// so the dropdown reads like the cost-discipline matrix the PRD asks for.

import { useMemo } from 'react';
import {
  AVAILABLE_MODELS,
  type ModelId,
  type ModelScope,
  type ModelTier,
} from '@skippy/shared';

export interface ModelPickerProps {
  scope: ModelScope;
  currentModel: ModelId;
  onChange: (next: ModelId) => void;
  /** Optional className hook for callers that want their own width / margin. */
  className?: string;
}

/**
 * Pretty-print a tier id for the <optgroup label>. Capitalized so the
 * dropdown reads "Opus / Sonnet / Haiku" in the order the array declares.
 */
function tierLabel(tier: ModelTier): string {
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

export default function ModelPicker({
  scope,
  currentModel,
  onChange,
  className,
}: ModelPickerProps) {
  // Group models by tier without losing the declared order. Map preserves
  // insertion order so the first model in each tier wins the optgroup slot
  // for that tier — matches the way AVAILABLE_MODELS is authored.
  const tiers = useMemo(() => {
    const out = new Map<ModelTier, (typeof AVAILABLE_MODELS)[number][]>();
    for (const m of AVAILABLE_MODELS) {
      const bucket = out.get(m.tier) ?? [];
      bucket.push(m);
      out.set(m.tier, bucket);
    }
    return out;
  }, []);

  const current = AVAILABLE_MODELS.find((m) => m.id === currentModel);
  const tooltip = current
    ? `${current.label} — ${current.recommendedFor}`
    : `Model: ${currentModel}`;

  return (
    <select
      className={className}
      value={currentModel}
      onChange={(e) => onChange(e.target.value as ModelId)}
      title={tooltip}
      aria-label={`Model for ${scope}`}
      style={{
        width: 120,
        fontFamily: 'var(--font-hud)',
        fontSize: 11,
        letterSpacing: '0.06em',
        color: 'var(--c-starlight)',
        background: 'var(--c-panel-bg-soft)',
        border: '1px solid var(--c-neon-cyan)',
        borderRadius: 2,
        padding: '2px 6px',
        outline: 'none',
        cursor: 'pointer',
      }}
    >
      {Array.from(tiers.entries()).map(([tier, models]) => (
        <optgroup key={tier} label={tierLabel(tier)}>
          {models.map((m) => (
            <option key={m.id} value={m.id} title={m.recommendedFor}>
              {m.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
