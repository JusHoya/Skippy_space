// Project-tree fetcher + pedestal layout. Phase 2 / Zone 1.
//
// Two responsibilities:
//   1. `fetchProjectTree()` calls the Rust `project_tree_scan` Tauri command
//      and returns the parsed tree. When the renderer runs outside Tauri (e.g.
//      `pnpm dev:ui` in a plain browser tab), a small synthetic tree is
//      returned so the Pixi scene still has something to draw.
//   2. `layoutPedestals()` is a pure, deterministic function that converts a
//      `ProjectTree` into a flat list of `PedestalLayout` records in world-
//      local coordinates. Same input → same output: the renderer can cache
//      the result and only re-run on tree refresh or ring-radius change.
//
// Per CLAUDE.md convention #3 the layout is config-grade data; we compute it
// once and cache it, never mutating per-frame.

import type {
  PedestalLayout,
  ProjectTree,
  ProjectTreeNode,
} from '@skippy/shared';
import { PALETTE } from '@skippy/sprite-kit';
import { safeInvoke, isTauri } from '../lib/tauri';

// ── 1. Fetch ─────────────────────────────────────────────────────────────────

/** ISO-8601 now() helper — kept inline so callers don't need to import time utilities. */
function nowIso(): string {
  return new Date().toISOString();
}

/** Build a synthetic tree mirroring the actual repo layout for non-Tauri dev. */
function buildSyntheticTree(): ProjectTree {
  const now = nowIso();
  const dayMs = 86_400_000;
  const ageIso = (days: number): string => new Date(Date.now() - days * dayMs).toISOString();

  // The six biomes match the real repo so the dev-mode scene reads like prod.
  const biome = (
    name: string,
    files: ReadonlyArray<{ name: string; sizeBytes: number; ageDays: number }>,
  ): ProjectTreeNode => ({
    path: name,
    name,
    kind: 'biome',
    depth: 1,
    sizeBytes: 0,
    mtime: ageIso(2),
    children: files.map((f) => ({
      path: `${name}/${f.name}`,
      name: f.name,
      kind: 'pedestal',
      depth: 2,
      sizeBytes: f.sizeBytes,
      mtime: ageIso(f.ageDays),
      children: [],
    })),
  });

  const biomes: ProjectTreeNode[] = [
    biome('apps', [
      { name: 'shell', sizeBytes: 18_000, ageDays: 1 },
      { name: 'ui', sizeBytes: 42_000, ageDays: 0 },
      { name: 'agent-runtime', sizeBytes: 31_000, ageDays: 3 },
    ]),
    biome('packages', [
      { name: 'shared', sizeBytes: 12_000, ageDays: 4 },
      { name: 'sprite-kit', sizeBytes: 24_000, ageDays: 2 },
      { name: 'memory', sizeBytes: 8_000, ageDays: 14 },
      { name: 'otel', sizeBytes: 6_000, ageDays: 21 },
    ]),
    biome('docs', [
      { name: 'PRD.md', sizeBytes: 96_000, ageDays: 6 },
      { name: 'roadmap.md', sizeBytes: 11_000, ageDays: 9 },
    ]),
    biome('vault', [
      { name: 'CLAUDE.md', sizeBytes: 4_000, ageDays: 20 },
      { name: '40_Daily', sizeBytes: 2_000, ageDays: 0 },
    ]),
    biome('infra', [
      { name: 'langfuse', sizeBytes: 7_000, ageDays: 30 },
      { name: 'letta', sizeBytes: 5_500, ageDays: 30 },
    ]),
    biome('agent_space', [
      { name: 'boards', sizeBytes: 22_000, ageDays: 7 },
      { name: 'staff', sizeBytes: 9_500, ageDays: 12 },
    ]),
  ];

  const root: ProjectTreeNode = {
    path: '.',
    name: 'Skippy_space',
    kind: 'tile',
    depth: 0,
    sizeBytes: 0,
    mtime: now,
    children: biomes,
  };

  const totalFiles = biomes.reduce((acc, b) => acc + b.children.length, 0);
  const totalDirs = 1 + biomes.length;

  return {
    root: 'Skippy_space',
    scannedAt: now,
    totalFiles,
    totalDirs,
    tree: root,
  };
}

/**
 * Fetch the project tree from the Rust shell, or return a synthetic tree when
 * running outside Tauri. Returns `null` only on an unexpected Tauri error so
 * callers can decide whether to retry or fall back.
 */
export async function fetchProjectTree(): Promise<ProjectTree | null> {
  if (!isTauri()) {
    return buildSyntheticTree();
  }
  const result = await safeInvoke<ProjectTree>('project_tree_scan');
  return result;
}

// ── 2. Layout ────────────────────────────────────────────────────────────────

/** Clamp helper — TS doesn't ship one in the stdlib. */
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 0..255 channel value → 2-char hex. */
function channelToHex(n: number): string {
  return Math.round(clamp(n, 0, 255)).toString(16).padStart(2, '0').toUpperCase();
}

/** Pack r,g,b channels into `#RRGGBB`. */
function rgbToHex(r: number, g: number, b: number): string {
  return `#${channelToHex(r)}${channelToHex(g)}${channelToHex(b)}`;
}

/** Parse `#RRGGBB` (with leading `#`) to r,g,b channels. */
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const s = hex.startsWith('#') ? hex.slice(1) : hex;
  const n = Number.parseInt(s, 16);
  return {
    r: (n >> 16) & 0xff,
    g: (n >> 8) & 0xff,
    b: n & 0xff,
  };
}

/** Linear interpolation between two hex colors at t in [0,1]. */
function lerpHex(a: string, b: string, t: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  const k = clamp(t, 0, 1);
  return rgbToHex(
    ca.r + (cb.r - ca.r) * k,
    ca.g + (cb.g - ca.g) * k,
    ca.b + (cb.b - ca.b) * k,
  );
}

// Age-to-hue stops. Fresh files are devopsGreen; aging files pass through
// financeGold; stale files land at marketingRed. PRD §3.4 palette tokens.
const HUE_FRESH = PALETTE.devopsGreen;       // #2ECC71 — 0 days old
const HUE_WARM = PALETTE.financeGold;        // #F1C40F — ~30 days old
const HUE_STALE = PALETTE.marketingRed;      // #FF6B6B — 90+ days old

/** Map ageDays to a hue between fresh → warm → stale. */
function hueForAge(ageDays: number): string {
  if (ageDays <= 0) return HUE_FRESH;
  if (ageDays >= 90) return HUE_STALE;
  if (ageDays <= 30) {
    return lerpHex(HUE_FRESH, HUE_WARM, ageDays / 30);
  }
  return lerpHex(HUE_WARM, HUE_STALE, (ageDays - 30) / 60);
}

/** Log-scale file size in bytes onto a pedestal height in pixels [6, 40]. */
function heightForSize(sizeBytes: number): number {
  // log10(1 byte)=0 .. log10(1MB)=6. Clamp the input to keep the curve gentle.
  const safe = Math.max(1, sizeBytes);
  const logged = Math.log10(safe);          // ~0..6 across realistic file sizes.
  const t = clamp(logged / 6, 0, 1);
  return 6 + t * (40 - 6);
}

/**
 * Collect every pedestal (file) under a biome, breadth-first, preserving the
 * scanner's child ordering. Returns each pedestal with its computed ageDays.
 */
function collectPedestals(
  biome: ProjectTreeNode,
  now: number,
): Array<{ node: ProjectTreeNode; ageDays: number }> {
  const out: Array<{ node: ProjectTreeNode; ageDays: number }> = [];
  const queue: ProjectTreeNode[] = [biome];
  while (queue.length > 0) {
    const cur = queue.shift() as ProjectTreeNode;
    if (cur.kind === 'pedestal') {
      const mtimeMs = Date.parse(cur.mtime);
      const ageDays = Number.isFinite(mtimeMs)
        ? Math.max(0, (now - mtimeMs) / 86_400_000)
        : 0;
      out.push({ node: cur, ageDays });
      continue;
    }
    for (const child of cur.children) {
      queue.push(child);
    }
  }
  return out;
}

export interface LayoutOpts {
  /** Inner ring radius in world-local px. Must be > 260 to clear the captain ring. */
  innerRadius: number;
  /** Outer ring radius cap. Concentric arcs are spaced from inner to outer. */
  outerRadius: number;
}

/**
 * Convert a `ProjectTree` into world-local pedestal positions.
 *
 * Strategy:
 *   1. Sort biomes alphabetically by name for deterministic ordering.
 *   2. Each biome owns an equal angular wedge of the full 360°.
 *   3. Pedestals in a biome fan out in concentric arcs from innerRadius to
 *      outerRadius. Arc capacity grows with circumference so deeper rings hold
 *      more pedestals — keeps angular spacing roughly even.
 *   4. Within each arc we sort pedestals by path for determinism.
 *
 * Heights encode size on a log scale (PRD §7.2 F1). Hues encode age on a
 * green→amber→red gradient (PRD §7.2 F2).
 */
export function layoutPedestals(tree: ProjectTree, opts: LayoutOpts): PedestalLayout[] {
  const { innerRadius, outerRadius } = opts;
  if (innerRadius <= 260) {
    // Defensive: the captain ring is 200 px, so innerRadius must clear it with
    // a buffer. We still produce output but log a console warning.
    // eslint-disable-next-line no-console
    console.warn(
      `[layoutPedestals] innerRadius (${innerRadius}) ≤ 260 — pedestals may overlap captains`,
    );
  }
  if (outerRadius < innerRadius) {
    return [];
  }

  const biomes = tree.tree.children
    .filter((n) => n.kind === 'biome')
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));

  if (biomes.length === 0) {
    return [];
  }

  const now = Date.parse(tree.scannedAt);
  const safeNow = Number.isFinite(now) ? now : Date.now();
  const wedgeDeg = 360 / biomes.length;

  const out: PedestalLayout[] = [];

  for (let bi = 0; bi < biomes.length; bi++) {
    const biome = biomes[bi];
    if (!biome) continue;

    const pedestals = collectPedestals(biome, safeNow);
    // Deterministic intra-biome ordering by path.
    pedestals.sort((a, b) => a.node.path.localeCompare(b.node.path));
    if (pedestals.length === 0) continue;

    // Wedge spans [wedgeStart, wedgeStart + wedgeDeg). Leave 10% padding at
    // each edge so adjacent biomes read as distinct sectors.
    const wedgeStart = bi * wedgeDeg;
    const innerWedge = wedgeDeg * 0.8;
    const wedgePad = wedgeDeg * 0.1;

    // Distribute pedestals across concentric arcs. Capacity per arc scales
    // with circumference so denser biomes spill outward gracefully.
    const arcs: PedestalLayout[][] = [];
    let arcIdx = 0;
    const arcStepBase = 26; // px between concentric arcs.

    for (const { node, ageDays } of pedestals) {
      // Compute current arc radius; bail out once we cross the outer cap.
      const r = innerRadius + arcIdx * arcStepBase;
      if (r > outerRadius && arcIdx > 0) {
        // Cap reached — start overflowing into the outermost arc.
        arcIdx = Math.max(0, Math.floor((outerRadius - innerRadius) / arcStepBase));
      }
      const circumferenceWedge = (innerWedge / 360) * 2 * Math.PI * r;
      const capacity = Math.max(1, Math.floor(circumferenceWedge / 18));

      if (!arcs[arcIdx]) arcs[arcIdx] = [];
      const arc = arcs[arcIdx];
      if (!arc) continue;

      if (arc.length >= capacity) {
        arcIdx += 1;
        if (!arcs[arcIdx]) arcs[arcIdx] = [];
      }

      const targetArc = arcs[arcIdx];
      if (!targetArc) continue;

      const layout: PedestalLayout = {
        id: `pedestal.${node.path}`,
        path: node.path,
        name: node.name,
        biome: biome.name,
        x: 0, // filled in below once arc geometry is known
        y: 0,
        heightPx: heightForSize(node.sizeBytes),
        hueHex: hueForAge(ageDays),
        sizeBytes: node.sizeBytes,
        ageDays,
      };
      targetArc.push(layout);
    }

    // Now that arcs are populated, place each pedestal at an even angle within
    // the wedge. We use the arc index to derive radius and the slot index for
    // the angle.
    for (let ai = 0; ai < arcs.length; ai++) {
      const arc = arcs[ai];
      if (!arc || arc.length === 0) continue;
      const radius = Math.min(innerRadius + ai * arcStepBase, outerRadius);
      const n = arc.length;
      // Evenly space [0..n-1] across (wedgePad, wedgeStart + wedgeDeg - wedgePad)
      // so even one-pedestal arcs land in the middle.
      for (let si = 0; si < n; si++) {
        const t = n === 1 ? 0.5 : si / (n - 1);
        const angleDeg = wedgeStart + wedgePad + t * innerWedge;
        const angleRad = (angleDeg * Math.PI) / 180;
        // Same convention as clockRing.ts: 0deg = 12 o'clock (negative y).
        const x = Math.sin(angleRad) * radius;
        const y = -Math.cos(angleRad) * radius;
        const layout = arc[si];
        if (!layout) continue;
        layout.x = x;
        layout.y = y;
        out.push(layout);
      }
    }
  }

  return out;
}
