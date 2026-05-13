/**
 * Minimap — PRD §7.2.
 *
 * Phase 0 placeholder: an empty grid with the agent population overlaid as
 * coloured dots. Phase 2 wires this to a downsampled snapshot of the Pixi
 * scene texture and supports F1–F4 layer toggles.
 */
import { useAgentStore } from '../stores/agentStore';

export default function MinimapPane() {
  const agents = useAgentStore((s) => s.agents);
  const count = Object.keys(agents).length;

  return (
    <div className="minimap">
      <div className="panel-header">
        <span>Minimap</span>
        <span style={{ color: 'var(--c-text-dim)' }}>F1·F2·F3·F4</span>
      </div>
      <div className="minimap-canvas" aria-hidden />
      <div className="minimap-legend">
        <span>Agents · {count}</span>
        <span>Ctrl+. cycles idle</span>
      </div>
    </div>
  );
}
