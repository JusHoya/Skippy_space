import { useUiStore } from '../stores/uiStore';
import SelectedPanel from './SelectedPanel';
import TelemetryPanel from './TelemetryPanel';
import CommandCard from './CommandCard';

/**
 * Right-rail container — switches between the SelectedPanel (info about the
 * currently selected agent) and the TelemetryPanel (aggregate live stats).
 * The CommandCard pins to the bottom regardless of tab, à la SC2.
 */
export default function SidePanel() {
  const tab = useUiStore((s) => s.panelTab);
  const setTab = useUiStore((s) => s.setPanelTab);

  return (
    <aside className="side-panel">
      <div className="panel-tabs">
        <button
          type="button"
          className={`panel-tab ${tab === 'selected' ? 'active' : ''}`}
          onClick={() => setTab('selected')}
        >
          Selected
        </button>
        <button
          type="button"
          className={`panel-tab ${tab === 'telemetry' ? 'active' : ''}`}
          onClick={() => setTab('telemetry')}
        >
          Telemetry
        </button>
      </div>
      {tab === 'selected' ? <SelectedPanel /> : <TelemetryPanel />}
      <CommandCard />
    </aside>
  );
}
