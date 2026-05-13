import { useEventChannel } from './lib/channel';
import TopBar from './hud/TopBar';
import SidePanel from './hud/SidePanel';
import TerminalCluster from './hud/TerminalCluster';
import MinimapPane from './hud/MinimapPane';
import CommandBar from './hud/CommandBar';
import SceneRoot from './scene/SceneRoot';

/**
 * Top-level HUD layout (PRD §7.1).
 *
 * The map (PixiJS scene) lives in `./scene/SceneRoot` and is owned by Agent P.
 * Everything around it — TopBar, SidePanel, TerminalCluster, MinimapPane, and
 * the floating CommandBar — is owned by this app.
 *
 * Per CLAUDE.md, per-frame data does NOT flow through this tree; it lives in
 * the scene's transient ref-store.
 */
export default function App() {
  // Subscribe once to the Tauri event channel; routes envelopes into stores.
  useEventChannel();

  return (
    <div className="hud">
      <TopBar />
      <div className="map-area">
        <SceneRoot />
        <CommandBar />
      </div>
      <SidePanel />
      <TerminalCluster />
      <MinimapPane />
    </div>
  );
}
