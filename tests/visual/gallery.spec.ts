// Visual smoke test for the sprite gallery (?gallery URL).
//
// Verifies that all 9 procedural costumes mount, that each tile shows its
// label + state, and that clicking a tile advances the animation FSM. Saves
// a full-page screenshot to tests/visual/screenshots/ for the assistant /
// human to inspect.

import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SHOTS_DIR = path.join(__dirname, 'screenshots');

test.describe('sprite gallery', () => {
  test('all 9 costumes render with labels', async ({ page }) => {
    await page.goto('/?gallery');

    // Wait for the gallery root and at least one tile.
    await expect(page.locator('.gallery-page')).toBeVisible();
    await expect(page.locator('.gallery-tile').first()).toBeVisible({ timeout: 10_000 });

    // 9 costumes per listAllCostumes() (Skippy + 8 boards).
    const tiles = page.locator('.gallery-tile');
    await expect(tiles).toHaveCount(9);

    // The header should display the count.
    await expect(page.locator('.gallery-count')).toHaveText(/9 costumes/);

    // Every tile should have a label and a state readout.
    const labels = page.locator('.gallery-tile-label');
    await expect(labels).toHaveCount(9);

    // Verify Skippy is present + by name.
    await expect(page.locator('.gallery-tile-label', { hasText: 'Skippy' })).toBeVisible();

    // Wait a moment for Pixi to paint at least one frame on each canvas.
    await page.waitForTimeout(500);

    // Full-page screenshot so the assistant can eyeball the result.
    await page.screenshot({
      path: path.join(SHOTS_DIR, 'gallery-overview.png'),
      fullPage: true,
    });
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

    // Capture a screenshot mid-cycle for review.
    await page.waitForTimeout(300);
    await skippyTile.screenshot({
      path: path.join(SHOTS_DIR, 'skippy-speaking.png'),
    });
  });

  test('main HUD renders without ?gallery', async ({ page }) => {
    await page.goto('/');
    // The HUD root carries the `.hud` class per index.css.
    await expect(page.locator('.hud')).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(800); // let Pixi paint a few frames
    await page.screenshot({
      path: path.join(SHOTS_DIR, 'hud-overview.png'),
      fullPage: true,
    });
  });
});
