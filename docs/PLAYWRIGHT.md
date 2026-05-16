# Playwright MCP for Skippy_space

The official Microsoft Playwright MCP server (`@playwright/mcp`) is
registered on Skippy, all eight Board captains, and all four Staff
Officers. This doc captures the why, the install path, a sample
registration, three example agent prompts, and the operational risks.

The canonical registry entry lives in
[`agent_space/CLAUDE.md` — MCP server registry](../agent_space/CLAUDE.md).
This doc is a working companion, not the source of truth.

## Why we registered Playwright

Phase 3 wires each agent's `mcp_servers:` declaration into a live
`query()` config. Before that goes in, we need every Board to inherit a
browser by default so that:

- **Engineering** can verify a deployed web UI when API-level checks
  are insufficient.
- **Coding** can run E2E smoke tests and reproduce user-reported UI
  regressions inside the TDD loop.
- **Design** can run visual-regression sweeps and capture reference
  screenshots of the running RTS HUD.
- **Marketing** can schedule, post, and screenshot on web-only platforms
  (LinkedIn personal-page composer, TikTok web upload).
- **Finance** can scrape macro-data dashboards that refuse to expose an
  API — never to authenticate into a live brokerage account.
- **Research** can navigate JavaScript-heavy sources and quote the
  rendered DOM with the URL as citation.
- **Publishing** can capture rendered publication views (post-Pandoc PDF
  preview, GitHub README, conference-portal page).
- **DevOps** can smoke a release artifact's web surface and check
  SmartScreen status post-deploy.
- **Staff Officers** get scoped read-only usage: `psych-monitor` verifies
  rendered claims, `memory-manager` detects link-rot, `skill-auditor`
  drives Playwright examples in a new skill to grade them,
  `agent-creator` registers it on new task agents whose brief needs it.

Skippy himself has Playwright in his `mcp_servers` array but, per the
Iron Law of Delegation, delegates browser work to the relevant captain
rather than running it himself.

## Install

The MCP server itself:

```powershell
# One-shot (recommended for ad-hoc use):
pnpm dlx @playwright/mcp@latest

# Pinned global install:
pnpm add -g @playwright/mcp
```

The browsers Playwright drives are **not bundled** by the MCP server.
Install them once per machine:

```powershell
# Minimum: Chromium only.
npx playwright install chromium

# Optional: Firefox + WebKit if a mission requires multi-browser checks.
npx playwright install firefox webkit
```

When Phase 3's `agent_space/settings.json` lands, pin a known-good
Playwright MCP version there to keep tooling reproducible across
sessions.

## Sample MCP server entry

A Phase-3 agent will load a config block of this shape (compatible with
the Claude Agent SDK's MCP server schema):

```json
{
  "mcpServers": {
    "playwright": {
      "command": "pnpm",
      "args": ["dlx", "@playwright/mcp@latest"]
    }
  }
}
```

For pinned setups, replace the `command` + `args` with a direct path to
the globally installed binary (`@playwright/mcp`'s `bin` entry).

## Example agent prompts

These exercise the browser via the typical Playwright MCP tools
(`browser_navigate`, `browser_snapshot`, `browser_click`,
`browser_evaluate`):

1. **Coding Board — local smoke test:**

   > "Verify the dashboard renders at `http://localhost:5173`: navigate,
   > snapshot the page, and confirm the topbar shows 'tokens/s' and the
   > eight Board hex-pads are visible. Return the snapshot text and a
   > pass/fail verdict."

2. **DevOps Board — release artifact verification:**

   > "Navigate to the GitHub PR page for PR #42 in `JusHoya/Skippy_space`,
   > snapshot the checks panel, and screenshot the diff for the
   > Tauri-build job. Land the screenshot at
   > `vault/30_Projects/devops/builds/pr-42-checks.png`."

3. **Research Board — JS-rendered metadata pull:**

   > "Navigate to `https://www.youtube.com/watch?v=dQw4w9WgXcQ`, wait for
   > the player to render, then `browser_evaluate` to extract the video
   > title, channel name, view count, and published date. Cite the URL
   > and return the result as a single atomic note draft."

## Risks

- **Credentials.** Do not paste real credentials into a Playwright
  session driven by an LLM. For platforms that need auth (LinkedIn,
  TikTok), load a pre-authenticated user profile from disk; never
  `browser_type` a password from a prompt.
- **Sandbox.** The MCP server can drive Chromium with full filesystem
  and network access. Treat Playwright agents as you would Bash: any
  charter using it has `permission_mode: ask` and runs under the
  Skippy_space sandbox unless the user explicitly approves
  `bypassPermissions`.
- **Rate limits.** Playwright bypasses normal API rate-limit ergonomics
  (no `Retry-After` headers, no quota meter). Boards that automate
  posting must add their own back-off; the Marketing Board's
  `social_media_engineer` is responsible for tracking each platform's
  current quota and throttling accordingly.
- **Destructive clicks.** `psych-monitor` is read-only and uses
  Playwright only for `browser_navigate` + `browser_snapshot` +
  `browser_evaluate` — never `browser_click` on a destructive action.
  Other Boards must be deliberate: the same agent that takes a screenshot
  can also publish a post; review missions before running them.
- **Cold start.** A fresh Chromium launch can take 2–5 s on Windows;
  add that to your ETA when delegating. Per PRD R-01, prefer keeping a
  warm browser context for repeated calls within a session.

## See also

- [`agent_space/CLAUDE.md`](../agent_space/CLAUDE.md) — canonical MCP
  server registry.
- [PRD §8.9](./PRD.md) — Obsidian integration plumbing + MCP server
  priorities.
- [PRD §6.1](./PRD.md) — charter schema, `mcp_servers` field.
- Microsoft Playwright MCP — `https://github.com/microsoft/playwright-mcp`.
