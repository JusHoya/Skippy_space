// One-off diagnostic: capture browser console + page errors so we can see
// what's blowing up React mount. Delete once the gallery renders cleanly.

import { test } from '@playwright/test';

test('diagnose: HUD console + pageerror + DOM shape', async ({ page }) => {
  const events: string[] = [];
  page.on('console', (msg) => events.push(`[console.${msg.type()}] ${msg.text()}`));
  page.on('pageerror', (err) => events.push(`[pageerror] ${err.name}: ${err.message}\n${err.stack ?? ''}`));
  page.on('requestfailed', (req) => events.push(`[reqfailed] ${req.method()} ${req.url()} — ${req.failure()?.errorText ?? 'unknown'}`));

  await page.goto('/', { waitUntil: 'networkidle' }).catch((e) => events.push(`[goto.error] ${e.message}`));
  await page.waitForTimeout(2000);

  // Sample top-level HUD descendants so we can see what's actually mounted.
  const domShape = await page.evaluate(() => {
    const hud = document.querySelector('.hud') as HTMLElement | null;
    if (!hud) return { hud: 'MISSING' };
    const hudCS = getComputedStyle(hud);
    const root = document.getElementById('root');
    const rootCS = root ? getComputedStyle(root) : null;
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      hudRect: hud.getBoundingClientRect(),
      hudStyle: {
        display: hudCS.display,
        gridTemplateColumns: hudCS.gridTemplateColumns,
        gridTemplateRows: hudCS.gridTemplateRows,
        gridTemplateAreas: hudCS.gridTemplateAreas,
        height: hudCS.height,
        width: hudCS.width,
        position: hudCS.position,
      },
      rootStyle: rootCS ? {
        display: rootCS.display,
        height: rootCS.height,
        width: rootCS.width,
      } : null,
      children: Array.from(hud.children).map((c) => {
        const cs = getComputedStyle(c as HTMLElement);
        const r = (c as HTMLElement).getBoundingClientRect();
        return {
          tag: c.tagName,
          cls: c.className,
          rect: { x: r.x, y: r.y, w: r.width, h: r.height },
          display: cs.display,
          gridArea: cs.gridArea,
          gridColumn: cs.gridColumn,
          gridRow: cs.gridRow,
        };
      }),
    };
  });

  // eslint-disable-next-line no-console
  console.log('\n=== BROWSER EVENTS ===\n' + events.join('\n') + '\n=== DOM SHAPE ===\n' + JSON.stringify(domShape, null, 2) + '\n=== END ===\n');
});
