import { useEventChannel } from './lib/channel';
import TopBar from './hud/TopBar';
import SidePanel from './hud/SidePanel';
import TerminalCluster from './hud/TerminalCluster';
import MinimapPane from './hud/MinimapPane';
import CommandBar from './hud/CommandBar';
import Hotkeys from './hud/Hotkeys';
import SceneRoot from './scene/SceneRoot';
import SpriteGallery from './gallery/SpriteGallery';

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
function MainHud() {
  // Subscribe once to the Tauri event channel; routes envelopes into stores.
  useEventChannel();

  return (
    <div className="hud">
      <Hotkeys />
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

/**
 * Route between the main HUD and the sprite gallery via a query param.
 * `?gallery` (any value or none) flips to the gallery view so we can iterate
 * on costume drawings without booting the full HUD. Keeping this dead-simple
 * — no real router — avoids pulling react-router into the boot path.
 */
export default function App() {
  const isGallery =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('gallery') !== null;

  return isGallery ? <SpriteGallery /> : <MainHud />;
}
