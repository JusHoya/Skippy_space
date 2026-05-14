// Sprite gallery — renders every named costume side-by-side so the user can
// iterate on the procedural drawings without the full HUD around them.
//
// Accessed via `?gallery` in the URL — see `App.tsx`. The page is intentionally
// chrome-light: dark-matter background, HUD font, a back-to-HUD link, a tile
// grid, and a short legend.

import { listAllCostumes } from '@skippy/sprite-kit';
import GalleryTile from './GalleryTile';

export default function SpriteGallery() {
  const costumes = listAllCostumes();

  return (
    <div className="gallery-page">
      <header className="gallery-header">
        <a href="/" className="gallery-back">
          ← back to HUD
        </a>
        <div className="gallery-titlewrap">
          <h1 className="gallery-title">Skippy_space · Costume Gallery</h1>
          <p className="gallery-sub">
            Click any beercan to cycle: idle → thinking → speaking → working → completed → error → idle.
          </p>
        </div>
        <span className="gallery-count">{costumes.length} costumes</span>
      </header>

      <main className="gallery-grid">
        {costumes.map((c) => (
          <GalleryTile key={c.id} id={c.id} label={c.label} costume={c.costume} />
        ))}
      </main>

      <footer className="gallery-footer">
        <span>PRD §12 · procedural Pixi v8 Graphics · no atlas yet</span>
      </footer>
    </div>
  );
}
