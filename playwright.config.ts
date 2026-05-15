// Playwright config for Skippy_space visual smoke tests.
//
// Goal: let the assistant (and CI) verify that the renderer actually paints
// what it should — gallery tiles, HUD layout, animation transitions — without
// requiring a human eyeball on every change. Tests live in `tests/visual/`
// and emit screenshots that future regression tests can diff against.

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/visual',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
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
  },
  use: {
    baseURL: 'http://localhost:5173',
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
