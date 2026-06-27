// Playwright config for Skippy_space visual smoke tests.
//
// Goal: let the assistant (and CI) verify that the renderer actually paints
// what it should — gallery tiles, HUD layout, animation transitions — without
// requiring a human eyeball on every change. Tests live in `tests/visual/`
// and compare against committed baselines under `tests/visual/__snapshots__/`,
// so a visual regression FAILS the run instead of silently overwriting the
// baseline.
//
// Baselines are regenerated only on an explicit `--update-snapshots` run
// (`updateSnapshots: 'missing'` below means a normal run never rewrites an
// existing baseline — it only fills in a baseline that doesn't exist yet, then
// fails so the new image gets reviewed before it's trusted).

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/visual',
  // Commit baselines next to the specs, OS-suffixed by Playwright so a Linux CI
  // baseline and a local Windows baseline can coexist instead of clobbering.
  snapshotPathTemplate: '{testDir}/__snapshots__/{testFilePath}/{arg}-{platform}{ext}',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // Default to 'missing': a normal run compares against the committed baseline
  // and never rewrites it; a baseline that is genuinely absent is generated
  // once (and the test still fails so a human/assistant signs off on the new
  // image). `npx playwright test --update-snapshots` overrides this to refresh
  // baselines on purpose. We never silently overwrite on every run.
  updateSnapshots: 'missing',
  // 1 retry locally absorbs the transient flake we see when the validator runs
  // gallery → HUD back-to-back: 9 Pixi apps churning mount/destroy can starve
  // the next test's first paint past the default toBeVisible timeout.
  retries: process.env.CI ? 2 : 1,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  // Per-test budget: Vite cold-start re-optimize after a lockfile change can
  // swallow 30–60 s before the first test even gets to act; 9 Pixi apps in
  // gallery.spec then add their own paint cost. 120 s leaves headroom.
  timeout: 120_000,
  expect: {
    timeout: 15_000,
    // Visual-comparison tolerances. WebGL/Pixi output carries a little
    // anti-aliasing and sub-pixel rounding noise between runs even with no real
    // change, so we allow a tiny diff budget. `maxDiffPixelRatio` is the
    // fraction of differing pixels we tolerate; keep it small enough that a
    // real regression (a missing tile, blank canvas, broken layout) blows past
    // it. `threshold` is the per-pixel colour-distance below which two pixels
    // count as equal (0–1; lower = stricter).
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.02,
      threshold: 0.2,
      // Pixi animates continuously (idle bob, blink); freeze CSS animations and
      // let Playwright retry the capture until two consecutive frames match so
      // the comparison isn't racing the ticker.
      animations: 'disabled',
      caret: 'hide',
    },
  },
  use: {
    baseURL: 'http://localhost:5173',
    // The gallery's Pixi ticker animates continuously and `animations:'disabled'`
    // only freezes CSS, so a full-page screenshot races the tick. The gallery
    // honors reduced-motion by rendering a single fixed frame (GalleryTile),
    // making the visual baselines byte-stable without freezing the live app.
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1280, height: 800 },
    navigationTimeout: 30_000,
    actionTimeout: 15_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'pnpm --filter @skippy/ui dev',
    port: 5173,
    reuseExistingServer: !process.env.CI,
    // 180 s tolerates Vite cold-start + dep re-optimize when launched fresh by
    // `pnpm validate:phase0` after a lockfile change.
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
