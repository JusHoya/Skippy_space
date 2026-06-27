// Sprite gallery — renders every named costume side-by-side so the user can
// iterate on the procedural drawings without the full HUD around them.
//
// Accessed via `?gallery` in the URL — see `App.tsx`. The page is intentionally
// chrome-light: dark-matter background, HUD font, a back-to-HUD link, a tile
// grid, and a short legend.
//
// Two sections:
//   1. Roster   — all 9 costumes (Skippy + 8 boards), click any to cycle states.
//   2. States   — Skippy pinned across every key animation state at once, so a
//                 human can eyeball each FSM branch side-by-side.

import type { CSSProperties } from 'react';
import {
  listAllCostumes,
  SKIPPY_COSTUME,
  type AnimationState,
} from '@skippy/sprite-kit';
import GalleryTile from './GalleryTile';

// The key animation states shown in the "States" showcase, in FSM order.
const SHOWCASE_STATES: AnimationState[] = [
  'idle',
  'thinking',
  'speaking',
  'working',
  'completed',
  'error',
  'spawning',
  'despawning',
];

const sectionTitleStyle: CSSProperties = {
  fontFamily: 'var(--font-hud)',
  fontSize: 12,
  letterSpacing: '0.18em',
  textTransform: 'uppercase',
  color: 'var(--c-muted-cyan)',
  padding: '18px 20px 0',
  margin: 0,
};

const sectionSubStyle: CSSProperties = {
  fontFamily: 'var(--font-body)',
  fontSize: 11,
  color: 'var(--c-text-dim)',
  padding: '2px 20px 0',
  margin: 0,
};

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

      <h2 style={sectionTitleStyle}>Roster · Skippy + 8 Boards</h2>
      <p style={sectionSubStyle}>Each board reads distinct at a glance — silhouette, accent, insignia.</p>
      <main className="gallery-grid">
        {costumes.map((c) => (
          <GalleryTile key={c.id} id={c.id} label={c.label} costume={c.costume} />
        ))}
      </main>

      <h2 style={sectionTitleStyle}>Animation states · Skippy the Magnificent</h2>
      <p style={sectionSubStyle}>Every FSM branch playing at once (one-shots auto-replay).</p>
      <section className="gallery-grid">
        {SHOWCASE_STATES.map((s) => (
          <GalleryTile
            key={`state-${s}`}
            id={`skippy-${s}`}
            label={`Skippy · ${s}`}
            costume={SKIPPY_COSTUME}
            initialState={s}
            cycle={false}
          />
        ))}
      </section>

      <footer className="gallery-footer">
        <span>PRD §12 · procedural Pixi v8 Graphics · no atlas yet</span>
      </footer>
    </div>
  );
}
