// Visual smoke test for the sprite gallery (?gallery URL) and the main HUD.
//
// Verifies that all 9 procedural costumes mount, that each tile shows its
// label + state, and that clicking a tile advances the animation FSM. Then it
// compares the rendered page against a committed baseline via
// `expect(page).toHaveScreenshot()` — so a visual regression FAILS the run
// instead of silently overwriting the baseline (see playwright.config.ts).
//
// Baselines live under tests/visual/__snapshots__/ and are refreshed only on an
// explicit `npx playwright test --update-snapshots` run.

import { test, expect, type Locator, type Page } from '@playwright/test';
import zlib from 'node:zlib';

/**
 * Count the number of distinct colours in a PNG buffer (sampled on a grid).
 *
 * We decode the PNG with Node's built-in zlib — no extra dependency — because
 * reading a WebGL canvas back in-page (`drawImage` + `getImageData`) returns a
 * blank buffer when Pixi runs with the default `preserveDrawingBuffer: false`.
 * Playwright's element screenshot captures the *composited* output instead, so
 * it sees what the user sees. A flat/blank canvas yields ~1 colour; a rendered
 * beercan/HUD yields many.
 */
function distinctColorsInPng(png: Buffer): number {
  // PNG signature is 8 bytes; chunks follow as [len:u32][type:4][data][crc:u32].
  let p = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (p + 8 <= png.length) {
    const len = png.readUInt32BE(p);
    const type = png.toString('ascii', p + 4, p + 8);
    const data = png.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9] ?? 0;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    p += 12 + len;
  }
  if (width === 0 || height === 0 || idat.length === 0) return 0;

  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
  if (channels === 0) return 0; // palette/other — unexpected for Playwright PNGs
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);

  // Reverse the per-scanline PNG filters (None/Sub/Up/Average/Paeth). Buffer
  // reads are coalesced with `?? 0` to satisfy `noUncheckedIndexedAccess`; the
  // loop bounds already keep every index in range.
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++] ?? 0;
    const so = y * stride;
    const po = pos;
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[po + x] ?? 0;
      const a = x >= channels ? out[so + x - channels] ?? 0 : 0;
      const b = y > 0 ? out[so - stride + x] ?? 0 : 0;
      const c = x >= channels && y > 0 ? out[so - stride + x - channels] ?? 0 : 0;
      let v: number;
      switch (filter) {
        case 1:
          v = rawByte + a;
          break;
        case 2:
          v = rawByte + b;
          break;
        case 3:
          v = rawByte + ((a + b) >> 1);
          break;
        case 4: {
          const pp = a + b - c;
          const pa = Math.abs(pp - a);
          const pb = Math.abs(pp - b);
          const pc = Math.abs(pp - c);
          v = rawByte + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          v = rawByte;
      }
      out[so + x] = v & 0xff;
    }
    pos += stride;
  }

  // Sample on an 8px grid; a blank canvas collapses to one colour.
  const seen = new Set<string>();
  for (let y = 0; y < height; y += 8) {
    for (let x = 0; x < width; x += 8) {
      const i = y * stride + x * channels;
      seen.add(`${out[i] ?? 0},${out[i + 1] ?? 0},${out[i + 2] ?? 0}`);
    }
  }
  return seen.size;
}

/**
 * Assert that a <canvas> has actually painted real content — i.e. it is not the
 * blank canvas you get when Pixi failed to mount or WebGL is unavailable. This
 * is what makes the HUD/gallery checks unable to "pass on a blank canvas".
 *
 * We screenshot the canvas via Playwright (composited output) and require the
 * image to contain more than a handful of distinct colours. >4 comfortably
 * clears AA/gradient noise on a flat fill while still failing hard on a blank or
 * single-colour canvas.
 */
async function expectCanvasPainted(canvas: Locator, label: string): Promise<void> {
  await expect(canvas, `${label}: canvas should be attached`).toBeVisible();
  // Guard against a zero-sized canvas (Pixi init bailed before sizing).
  const box = await canvas.boundingBox();
  expect(box, `${label}: canvas should have a non-zero box`).not.toBeNull();
  expect(box!.width, `${label}: canvas width`).toBeGreaterThan(0);
  expect(box!.height, `${label}: canvas height`).toBeGreaterThan(0);

  // Poll: Pixi paints on a ticker, so the first frame may land a beat after the
  // canvas is in the DOM. Re-screenshot until it has content or we time out.
  await expect
    .poll(
      async () => {
        const shot = await canvas.screenshot();
        return distinctColorsInPng(shot);
      },
      {
        message: `${label}: canvas should paint real content (Pixi mounted, WebGL up), not a blank fill`,
        timeout: 10_000,
        intervals: [200, 400, 800],
      },
    )
    .toBeGreaterThan(4);
}

test.describe('sprite gallery', () => {
  test('all 9 costumes render with labels', async ({ page }) => {
    await page.goto('/?gallery');

    // Wait for the gallery root and at least one tile.
    await expect(page.locator('.gallery-page')).toBeVisible();
    await expect(page.locator('.gallery-tile').first()).toBeVisible({ timeout: 10_000 });

    // The Roster is the FIRST .gallery-grid (Skippy + 8 boards). A second grid
    // below it — the Phase 4 "Animation states" showcase — pins Skippy across
    // every FSM branch, so we scope the 9-costume assertions to the roster grid
    // rather than the whole page (which carries 9 + 8 tiles).
    const roster = page.locator('.gallery-grid').first();

    // 9 costumes per listAllCostumes() (Skippy + 8 boards).
    const tiles = roster.locator('.gallery-tile');
    await expect(tiles).toHaveCount(9);

    // The header should display the count.
    await expect(page.locator('.gallery-count')).toHaveText(/9 costumes/);

    // Every tile should have a label and a state readout.
    const labels = roster.locator('.gallery-tile-label');
    await expect(labels).toHaveCount(9);

    // Verify Skippy is present + by name (the roster carries exactly one Skippy
    // tile; the states showcase below adds per-state Skippy tiles).
    await expect(roster.locator('.gallery-tile-label', { hasText: 'Skippy' })).toHaveCount(1);

    // Every tile must mount a real Pixi canvas.
    const canvases = roster.locator('.gallery-tile-stage canvas');
    await expect(canvases).toHaveCount(9);

    // Readiness gate: ALL nine roster tiles must have rendered their first frame.
    // `data-painted` is a deterministic flag GalleryTile sets after its first
    // tick — it proves every tile's Pixi app mounted AND its ticker ran (a failed
    // init never sets it, so a blank/broken gallery fails here). Robust where a
    // pixel-colour heuristic is not (a frozen small can sweeps too few pixels to
    // clear a colour-diversity floor).
    await expect(roster.locator('.gallery-tile-stage[data-painted="1"]')).toHaveCount(9, {
      timeout: 15_000,
    });

    // NOTE: we deliberately do NOT pixel-diff the full 9-tile roster here. Two
    // costumes (Skippy, Publishing) carry tile-filling procedural fills whose
    // alpha gradients render with GPU/WebGL sub-pixel non-determinism — an
    // intermittent ~12% (two-tile) diff even with the animation clock frozen and
    // the glow halos suppressed. That noise floor exceeds the signal of a real
    // regression (a single missing/blank tile is ~11%), so a roster-wide
    // screenshot can't tell breakage from noise. Per-tile pixel coverage lives in
    // the 'clicking a tile cycles' test below (a single-tile `skippy-speaking.png`
    // baseline, which is stable); the DOM + `data-painted` assertions above are
    // the reliable blank-gallery / missing-tile guard.
  });

  test('clicking a tile cycles the animation state', async ({ page }) => {
    await page.goto('/?gallery');
    await expect(page.locator('.gallery-tile').first()).toBeVisible({ timeout: 10_000 });

    const skippyTile = page.locator('.gallery-tile', { hasText: 'Skippy' }).first();
    const stateReadout = skippyTile.locator('.gallery-tile-state');

    await expect(stateReadout).toHaveText('idle');
    await skippyTile.click();
    await expect(stateReadout).toHaveText('thinking');
    await skippyTile.click();
    await expect(stateReadout).toHaveText('speaking');

    // The tile's canvas must still be painting in the new state, then diff the
    // tile against its baseline so a broken `speaking` animation is caught.
    await expectCanvasPainted(skippyTile.locator('.gallery-tile-stage canvas'), 'skippy tile (speaking)');
    await expect(skippyTile).toHaveScreenshot('skippy-speaking.png');
  });

  test('main HUD renders real content (not a blank canvas)', async ({ page }) => {
    // Suppress the Phase 4 first-run onboarding overlay so this test exercises
    // the actual HUD chrome, not the intro modal. The overlay auto-shows on a
    // fresh profile (uiStore seeds `onboardingOpen` from this localStorage key);
    // seeding "seen" before the app boots keeps it dormant. Key mirrors
    // `ONBOARDING_SEEN_KEY` in apps/ui/src/stores/uiStore.ts.
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem('skippy.onboarding.seen.v1', '1');
      } catch {
        /* private-mode / storage disabled — overlay defaults to dormant anyway */
      }
    });
    await page.goto('/');

    // The HUD root carries the `.hud` class per index.css.
    await expect(page.locator('.hud')).toBeVisible({ timeout: 10_000 });

    // Concrete rendered content — the TopBar brand + live stat strip. If the
    // app mounts but the HUD chrome fails to render, these are missing and the
    // test fails (the old version passed as long as `.hud` was present).
    await expect(page.locator('.topbar-brand')).toHaveText(/SKIPPY/i);
    await expect(page.locator('.topbar-stat').first()).toBeVisible();
    // The supply stat is a deterministic readout ("used/cap") that doesn't
    // depend on any live LLM/telemetry stream, so it's safe to assert offline.
    await expect(page.locator('.topbar-stat', { hasText: 'supply' })).toBeVisible();

    // The PixiJS scene must mount a canvas AND paint into it. The whole point of
    // the finding: a blank scene canvas used to sail through. Now it can't.
    const sceneCanvas = page.locator('.map-area canvas').first();
    await expectCanvasPainted(sceneCanvas, 'HUD scene');

    // Visual baseline comparison for the full HUD layout. Animations are frozen
    // (config), so the diff is stable run-to-run; per-frame telemetry text is
    // masked out below so a changing tok/s number doesn't trip the diff.
    await expect(page).toHaveScreenshot('hud-overview.png', {
      fullPage: true,
      // Mask volatile readouts that legitimately change between runs (live
      // throughput / context numbers) so they don't register as regressions.
      mask: [page.locator('.topbar-stat .value')],
    });
  });
});

// Re-exported for any future spec that wants to assert canvas paint elsewhere.
export { expectCanvasPainted };
export type { Page };
