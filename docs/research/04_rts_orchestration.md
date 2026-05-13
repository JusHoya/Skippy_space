# Appendix 04 — RTS-as-Agent-Orchestration: A Visual UX Model

> Captured verbatim from the RTS research agent on 2026-04-29.

> The dashboard isn't a metaphor — it's a literal RTS HUD where every beercan is a Claude subagent. The user is the human-on-the-loop, watching commander Skippy direct a squad of skill-area board agents who in turn spawn task-units across a project's "map."

---

## 1. RTS UX Primitives → Agent Orchestration

**Command hierarchy (Commander → Captains → Units)** — In StarCraft, a Terran Command Center isn't where battles happen; it's where production policy lives. Skippy is the Commander, board agents are Captains (Frontend Captain, Database Captain, DevOps Captain), and ephemeral task-agents are the Units that actually run tools. Orders flow down the tree; status and exceptions flow back up.

**Selection (single-click, drag-box, hotkey groups)** — Single-click selects one beercan and opens its full context window/log in the side panel. Drag-box across the map selects every agent in a region (e.g. "all agents currently touching `/api/auth/`") and lets you issue a group order. `Ctrl+1..9` binds control groups to favorite agent squads — exactly StarCraft's muscle-memory model — so the user can hot-swap between "the testing crew" and "the migration crew."

**Issuing orders (move, attack, build, patrol; shift to queue)** — Right-click sends the selected agent to a target (a file = move, a failing test = attack, a missing module = build, a watched directory = patrol). Holding **Shift while clicking** queues commands like SC2's waypointed move orders — critical because LLM agents already think in plan-then-execute, and a visible queue makes that plan auditable.

**Build orders / production queues** — Each board-agent "Captain" has a production tab. The user (or Skippy) queues task templates: "spawn a refactor-unit," "spawn a test-writer-unit." Like a Barracks queue, this exposes ETA, cost (tokens), and lets you cancel mid-build for a refund.

**Minimap** — A schematic miniature of the project's file/module graph, with colored dots for active agents, blinking yellow for tools-in-flight, red for errored agents. Click any dot to camera-jump. This is the single most stolen primitive in the whole spec.

**Fog of war** — Reinterpreted: agents working on **branches the user hasn't reviewed yet** are shrouded. You see *that* a beercan is working in a region, but not *what* it has produced until you "scout" (open the diff). This preserves the satisfying RTS rhythm of revealed-vs-unrevealed without making it adversarial.

**Resources** — Tokens are the universal currency. Compute time is gas. API rate limit is supply cap. A persistent resource bar at the top of the screen (à la SC2's `mineral / vespene / supply`) reads `tokens / s · context-headroom · 14/200 supply (concurrent agents)`.

**Tech tree / upgrades** — Tool unlocks. As Skippy verifies a board-agent's reliability on a class of task, that agent's command card grows new buttons (e.g., "auto-merge," "deploy-to-prod"). Visible tech-tree screen shows progression and gates risky tools behind explicit user approval.

**HUD telemetry** — HP = remaining context-window budget; mana = tool-call quota in the rolling minute; APM = real APM, agent actions per minute. A unit whose HP is draining fast is one that's about to need compaction.

**Replay system** — SC2 replays are sacred. Every Skippy_space session writes a replay file you can scrub, fast-forward, and pause; selecting any agent at timestamp T shows what *that agent* knew at T. This is essentially distributed-tracing-as-a-game-replay.

---

## 2. Reference RTS Titles — One Element to Steal Each

- **StarCraft II — Control Groups (Ctrl+1..9).** Steal verbatim. Lets the power-user form ad-hoc squads of agents and hot-swap focus without traversing menus. The single highest-leverage borrowing. ([Liquipedia](https://liquipedia.net/starcraft2/Hotkeys))
- **Age of Empires IV — The "ZZZ" idle indicator + idle-villager hotkey.** Steal the **idle agent indicator** in the bottom-left toolbar plus a `Ctrl+.` hotkey to cycle through agents that are blocked, awaiting input, or have completed without re-tasking. Idleness is the #1 inefficiency to surface. ([AoE Wiki](https://ageofempires.fandom.com/wiki/User_interface))
- **Company of Heroes 3 — Tactical Map overlay.** Steal the **full-screen tactical pause-overlay** — a strategic view that floats above the live world with thicker icons, no animation noise, ideal for issuing big-picture orders to many agents. ([CoH3 wishlist](https://community.companyofheroes.com/coh-franchise-home/company-of-heroes-3/forums/1-general-discussion/threads/2926-community-wishlist-for-tactical-map?page=1))
- **Supreme Commander — Strategic Zoom.** Steal the **continuous zoom from beercan-portrait → file-level → repo-level → org-level**, with sprites smoothly degrading to icons as you pull out. This eliminates the minimap/main-view duality — they become the same surface at different magnifications. ([Wikipedia: SupCom](https://en.wikipedia.org/wiki/Supreme_Commander_(video_game)))
- **They Are Billions — Active-pause planning mode.** Steal the **Spacebar pause that lets you queue every order, then unpause to execute.** Perfect for high-stakes agent operations: stop the world, plan a 14-step refactor across six agents, then release. ([Steam Discussions](https://steamcommunity.com/app/644930/discussions/0/1620599015900577435/))

---

## 3. Academic / Industry Telemetry Lineage

The intellectually honest claim: the AI-research community has been building agent-observation dashboards for a decade, just not for LLMs.

- **PySC2 / SC2LE (DeepMind, 2017)** ships a renderer that shows the agent's *actual observation tensor* alongside the human-readable game — a dual view of "what the policy sees" vs "what the human sees." Translate: a dual-pane in Skippy_space showing the raw context window the agent is reasoning over, side-by-side with the rendered map. ([PySC2 GitHub](https://github.com/google-deepmind/pysc2))
- **AlphaStar** exposed feature-layer overlays (units, terrain, visibility) as separable channels you could toggle. Translate: layer toggles on the minimap — "show only file-touch heatmap," "show only error-locations," "show only test-coverage." ([AlphaStar Implementation](https://dohyeongkim.medium.com/alphastar-implementation-series-part5-fd275bea68b5))
- **BenchMARL / PyMARLzoo+** publish interactive plots of multi-agent reward and behavior across runs. Translate: the **replay/history tab** that compares past Skippy_space sessions on the same task ("v3 of the auth migration was 40% faster than v2"). ([BenchMARL paper](https://matteobettini.com/publication/benchmarl/BenchMARL.pdf))
- **CrewAI / LangSmith mission-control dashboards (2026 cohort)** are converging on visual task-boards plus per-agent step traces. Skippy_space's contribution is replacing the boring kanban with an actual battlefield. ([HowToDeploy: AI Agent Mission Control](https://www.howtodeploy.app/blog/ai-agent-mission-control), [Codebridge](https://www.codebridge.tech/articles/mastering-multi-agent-orchestration-coordination-is-the-new-scale-frontier))

---

## 4. Sprite / Animation Stack — Recommendation

**Primary pick: PixiJS (v8) with `@pixi/react` bindings.**

Why: PixiJS is the fastest pure-2D WebGL renderer in the JS ecosystem (≈2× Phaser, ≈3× smaller bundle), and Skippy_space is fundamentally a renderer problem, not a game-engine problem — there's no physics, no collision, no sound design. You want raw sprite throughput so 200 beercans can animate at 60fps over a Tailwind-styled HUD. ([js-game-rendering-benchmark](https://github.com/Shirajuki/js-game-rendering-benchmark), [Phaser vs PixiJS](https://generalistprogrammer.com/comparisons/phaser-vs-pixijs))

Pair it with React for the HUD/side-panel/terminal so you keep accessibility, keyboard handling, and your existing component library intact. The Pixi stage is a single React-rendered `<Application>`; everything outside the map (terminal, panels, command card) is plain DOM. This is how Figma and Linear's canvas products are built.

**WebGL vs Canvas2D:** WebGL, no contest — Pixi auto-falls back to Canvas2D on hostile environments, but the dashboard's natural scale (8 board agents × ~25 task-units each at peak) demands batched draw calls.

**Atlas / spritesheet tooling:** TexturePacker (commercial) or the free Free Texture Packer, exporting a `.json` + `.png` atlas Pixi consumes natively via `Assets.load()`.

**Animation frame budget per beercan:**

- **Idle:** 6 frames @ 8fps (subtle bob, blinking LED)
- **Working:** 8 frames @ 12fps (typing/welding loop with sparks)
- **Thinking:** 4 frames @ 6fps (thought bubble pulse, used while waiting on LLM)
- **Completed:** 1-shot 12 frames (triumphant pose, confetti particle)
- **Error:** 4 frames @ 4fps (red blink, slumped posture) — looped until acknowledged
- **Speaking:** 3-frame mouth-flap loop, blendable with idle/working

That's six clips × ~6 frames average × 8 role costumes ≈ 280 frames. Trivial. ([PixiJS AnimatedSprite docs](https://react.pixijs.io/7.x/components/AnimatedSprite/))

Runner-up: **Phaser** if you ever add scripted scenarios/tutorials. **Excalibur** is too game-y. **Three.js with sprite billboards** is overkill unless you want a 3D bridge view someday — defer.

---

## 5. Concrete UX Model — Sketch the Screen

```
+------------------------------------------------------------------+
|  RESOURCE BAR  | tokens/s 3.2k | ctx 142k/200k | 14/30 supply    |
+------------------------------------------------------------------+
|                                            |                     |
|                                            |   SELECTED AGENT    |
|                                            |   ┌─────────┐       |
|                                            |   │ Skippy  │       |
|         RTS BATTLEFIELD VIEWPORT           |   │ (portrait)│      |
|         (PixiJS canvas — file/module       |   └─────────┘       |
|          map with beercan agents)          |   HP: 142k ctx      |
|                                            |   APM: 47           |
|         [Skippy] commands the center       |   Task: orchestrate |
|         8 board-captains in a ring         |   ─────────────     |
|         Task units swarm out to            |   FULL LOG / TRACE  |
|         /src, /tests, /db, etc.            |   (scrollable)      |
|                                            |                     |
|                                            |   COMMAND CARD      |
|                                            |   [Q][W][E][R]      |
|                                            |   [A][S][D][F]      |
|                                            |   [Z][X][C][V]      |
|                                            |   (5x3 SC2-style)   |
+------------------------------------------------------------------+
| MINIMAP   | TERMINAL (live stdout, prompt input)    | IDLE: 2 ZZZ |
| ▢▢▢▢▢▢   | $ skippy delegate "fix the auth bug"    |             |
+------------------------------------------------------------------+
```

**Main viewport (center, ~70% of screen).** The PixiJS battlefield. The ground-plane is a stylized projection of the project: a top-down isometric grid where each tile is a directory, and tiles tessellate into a continent shaped by the actual repo tree. Files within a directory are little pedestals; agents stand on or walk between them. Skippy himself sits on the throne tile at center — a **command center sprite** with antennae that pulse when broadcasting orders.

**Board-agent command center (inner ring).** The 8 board-captains form a **clock-face ring** around Skippy: 12 o'clock = Architecture, 3 = Backend, 6 = Database, 9 = Frontend, etc. Each captain stands inside its own colored hex pad with a costume denoting role (Frontend wears a paint-spattered apron; Database wears a hard hat with a disk-platter logo; DevOps wears coveralls with a Kubernetes patch). A captain's hex glows when it has unfinished orders.

**Task-spawn animation.** When a board-captain accepts an order, a **chime + a beam of light** descends onto its hex; the captain salutes and a fresh beercan **pops out of a barracks-doorway** in front of it (8-frame spawn anim). The new task-unit then **walks** along a glowing path to its build site (a specific file pedestal). On arrival it plays the working anim. On completion it plays a 1-shot success and **either re-tasks** (walking to a new site) or **despawns** (vanishes in a puff).

**Selection model.** Click a beercan → it gets a green selection circle, the right-hand panel populates with its portrait, role, current prompt, full conversation log, tool-call list, token cost, and uptime. Drag-box selects multiples; the panel collapses to a roster header + per-unit collapsibles. Right-clicking a target with a unit selected issues an order; **Shift+right-click** queues it.

**Fog of war reinterpretation.** Three states per region of the project map:
1. **Unexplored (black)** — modules no agent has ever touched in this session.
2. **Shrouded (gray, last-known)** — modules an agent worked on, but on a branch you haven't merged/reviewed. You see the structure but not the latest content. Hover shows "Last seen by `frontend-captain` at 14:32, 23 changes pending review."
3. **Bright (live)** — modules currently under an agent's gaze, content streaming in real time.

**Minimap.** Bottom-left, ~200×200px. The same map geometry, miniaturized, with a yellow **viewport rectangle** showing what's in the main view (steal SC2's exactly). Dots colored by agent role; size by activity intensity. Right-click on the minimap = camera jump. Layer toggles (steal AlphaStar's feature layers): **F1** files-touched heatmap, **F2** error-locations, **F3** test-coverage gradient, **F4** git-blame age.

**Idle indicator (steal AoE).** Bottom-right toolbar shows `ZZZ ×2` when two agents are idle/blocked; pressing `Ctrl+.` cycles selection through them.

**Strategic zoom (steal SupCom).** Mouse-wheel out smoothly transitions sprites → icons → dots → org-level overview where the entire repo is one Skippy face. There is no separate "minimap" mode; the minimap is just the same map zoomed all the way out, optionally pinned in a corner.

**Active-pause (steal They Are Billions).** Spacebar freezes all agents mid-tool-call, dims the world, and lets the user queue a multi-step plan across many units. Unpause = release. Critical for high-risk operations like "deploy to prod."

---

## 6. Anti-Patterns — Three RTS Conventions That Would HARM This

1. **Adversarial agent-vs-agent combat.** RTS thrives on opponent asymmetry; agents fighting each other in Skippy_space would model conflict as zero-sum and reward whichever beercan "wins" a merge battle. The right model is **construction RTS** (think *Factorio*, *They Are Billions* defense, or *SimCity*) — co-operative against an external problem (the bug, the feature, the failing test). Don't draw HP bars over agents that imply they can damage each other.

2. **Hard resource scarcity gamification.** SC2 punishes you for floating minerals; that pressure creates flow but also stress. A dashboard that flashes red and plays a "low minerals" siren when token usage spikes will feel **hostile and punitive** during real engineering work. Show resources, but never alarm-pulse them — reserve red for *actual errors and human-decision-required* states. The user should feel like a general, not a starving colonist.

3. **APM-as-skill leaderboards / ranked ladder UX.** RTS culture conflates clicks-per-minute with skill. Importing that into agent orchestration teaches users to over-prompt and micromanage — the **opposite** of good orchestration, where good Skippy use looks like **issuing one elegant order and watching it cascade.** Show APM as diagnostic telemetry, never as a score, and never gamify "your skill rating" against other Skippy users. The status symbol should be **how few orders you had to give for how much output**, which is the exact inverse of RTS skill metrics.

A bonus fourth: **don't auto-steal the doomed-fortress aesthetic of *They Are Billions*.** Borrow the pause mechanic, leave the apocalyptic dread at the door — Skippy is supposed to be a magnificent beercan, not the last bastion of humanity.

---

## Sources

- [StarCraft II Hotkeys — Liquipedia](https://liquipedia.net/starcraft2/Hotkeys)
- [Buttons & Command Card — SC2 Editor Tutorials](https://s2editor-guides.readthedocs.io/New_Tutorials/04_Data_Editor/075_Buttons/)
- [Strategic Zoom in RTSes — Matchsticks for my Eyes](https://www.matchstickeyes.com/2011/01/11/i-can-see-my-base-from-here-strategic-zoom-in-rtses/)
- [Supreme Commander — Wikipedia](https://en.wikipedia.org/wiki/Supreme_Commander_(video_game))
- [Why Company of Heroes Is So Good — RetroStyle](https://retrostylegames.com/blog/analyzing-company-of-heroes-3-game-design/)
- [CoH3 Tactical Map Wishlist](https://community.companyofheroes.com/coh-franchise-home/company-of-heroes-3/forums/1-general-discussion/threads/2926-community-wishlist-for-tactical-map?page=1)
- [They Are Billions — PC Gamer](https://www.pcgamer.com/they-are-billions-is-an-rts-thats-all-about-defense/)
- [They Are Billions — Steam command queue discussion](https://steamcommunity.com/app/644930/discussions/0/1620599015900577435/)
- [Age of Empires User Interface — Fandom Wiki](https://ageofempires.fandom.com/wiki/User_interface)
- [PySC2 — DeepMind GitHub](https://github.com/google-deepmind/pysc2)
- [AlphaStar — DeepMind GitHub](https://github.com/google-deepmind/alphastar)
- [AlphaStar Implementation — Network](https://dohyeongkim.medium.com/alphastar-implementation-series-part5-fd275bea68b5)
- [BenchMARL — Bettini et al.](https://matteobettini.com/publication/benchmarl/BenchMARL.pdf)
- [Extended MARL Benchmarking — AAMAS 2025](https://www.ifaamas.org/Proceedings/aamas2025/pdfs/p1613.pdf)
- [The Code Agent Orchestra — Addy Osmani](https://addyosmani.com/blog/code-agent-orchestra/)
- [AI Agent Mission Control Dashboards 2026 — HowToDeploy](https://www.howtodeploy.app/blog/ai-agent-mission-control)
- [AI Orchestration Guide 2026 — Codebridge](https://www.codebridge.tech/articles/mastering-multi-agent-orchestration-coordination-is-the-new-scale-frontier)
- [JS Game Rendering Benchmark — GitHub](https://github.com/Shirajuki/js-game-rendering-benchmark)
- [Web Game Engines Comparison 2026 — Cinevva](https://app.cinevva.com/guides/web-game-engines-comparison.html)
- [Phaser vs PixiJS — Generalist Programmer](https://generalistprogrammer.com/comparisons/phaser-vs-pixijs)
- [PixiJS React AnimatedSprite docs](https://react.pixijs.io/7.x/components/AnimatedSprite/)
- [pixi-react GitHub](https://github.com/pixijs/pixi-react)
- [Fog of War — Design The Game](https://www.designthegame.com/learning/tutorial/the-art-science-fog-war-systems-video-games)
- [Fog of War — Wikipedia](https://en.wikipedia.org/wiki/Fog_of_war)
