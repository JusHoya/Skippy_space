// Phase 2 contracts — RTS UX surface (PRD §7 + §14.3).
//
// The Phase 2 work is split across five parallel sub-agents (file pedestals,
// task-agent walkers, selection + hotkeys, camera + queue, fog + minimap).
// Each agent writes against the contracts in this module so the integration
// step in SceneRoot can wire everything up by `import`-ing names rather than
// duck-typing across modules.
//
// Anything that crosses the Tauri IPC boundary (project tree from Rust →
// renderer) gets a Zod schema. Pure UI-internal shapes are TypeScript-only —
// no need to runtime-validate intra-renderer data.

import { z } from 'zod';
import { AgentIdSchema, type AgentId } from './agents.js';

// ── 1. File-pedestal map (Zone 1) ────────────────────────────────────────────

/**
 * Node kind in the project-tree tessellation. PRD §7.2:
 *   • biome  → top-level directory (apps/, packages/, docs/, vault/, infra/, …)
 *   • tile   → mid-level subdirectory
 *   • pedestal → leaf file
 */
export const TreeNodeKindSchema = z.enum(['biome', 'tile', 'pedestal']);
export type TreeNodeKind = z.infer<typeof TreeNodeKindSchema>;

/**
 * One entry returned by the Rust `project_tree_scan` command. The scan is
 * shallow-first with a depth cap so the renderer can render a tessellation
 * without blocking the boot path.
 */
export interface ProjectTreeNode {
  path: string;
  name: string;
  kind: TreeNodeKind;
  depth: number;
  sizeBytes: number;
  mtime: string;
  children: ProjectTreeNode[];
}

export const ProjectTreeNodeSchema: z.ZodType<ProjectTreeNode> = z.lazy(() =>
  z.object({
    path: z.string(),
    name: z.string(),
    kind: TreeNodeKindSchema,
    depth: z.number().int().nonnegative(),
    /** Logical-byte size; 0 for directories. */
    sizeBytes: z.number().int().nonnegative(),
    /** ISO-8601 timestamp of the last filesystem mtime — drives git-age tint. */
    mtime: z.string().datetime({ offset: true }),
    /** Direct children for biomes/tiles; empty for pedestals. */
    children: z.array(ProjectTreeNodeSchema),
  }),
);

/** Top-level project-tree scan result returned by Tauri command. */
export const ProjectTreeSchema = z.object({
  root: z.string(),
  scannedAt: z.string().datetime({ offset: true }),
  totalFiles: z.number().int().nonnegative(),
  totalDirs: z.number().int().nonnegative(),
  tree: ProjectTreeNodeSchema,
});
export type ProjectTree = z.infer<typeof ProjectTreeSchema>;

/**
 * Layout for a single file pedestal in world-local coords. Computed once when
 * the tree is loaded (or when ring radius changes) and cached — the renderer
 * never recomputes per-frame.
 *
 * Pedestals are arranged on concentric rings *outside* the clock-ring of
 * board captains (default ring radius 200). Each biome takes a sector wedge
 * determined by canonical sort order so the geometry is deterministic.
 */
export interface PedestalLayout {
  /** Canonical agent-path-style id: `pedestal.<relative/posix/path>`. */
  id: string;
  /** Relative POSIX path inside the project root. */
  path: string;
  /** Display name (file basename). */
  name: string;
  /** Which biome wedge this pedestal sits in. */
  biome: string;
  /** World-local x in pixels (0 = throne center). */
  x: number;
  /** World-local y in pixels (0 = throne center). Pixi y is down-positive. */
  y: number;
  /** Pedestal height; encodes file size (PRD §7.2 F1). */
  heightPx: number;
  /** Pedestal hue HSL string; encodes git age (PRD §7.2 F2). */
  hueHex: string;
  /** Original size in bytes — for tooltips + layer toggles. */
  sizeBytes: number;
  /** Age in days (now − mtime) — for the F2 layer overlay. */
  ageDays: number;
}

// ── 2. Task agent walkers (Zone 2) ───────────────────────────────────────────

/**
 * Animated path a task-agent sprite follows from its captain pad to a target
 * pedestal. The path is precomputed at spawn time; the tick loop advances
 * `progress` linearly against `durationSec`.
 */
export interface WalkPath {
  /** World-local origin x. */
  fromX: number;
  /** World-local origin y. */
  fromY: number;
  /** World-local target x. */
  toX: number;
  /** World-local target y. */
  toY: number;
  /** Total path duration in seconds. */
  durationSec: number;
  /** Optional 1-2 intermediate waypoints for non-linear walks. */
  waypoints?: Array<{ x: number; y: number }>;
}

/** A live task-agent registered in the scene. */
export interface TaskAgentSpec {
  /** Canonical id: `task.<ulid>`. */
  id: AgentId;
  /** Captain who spawned this agent. */
  parentBoardId: string;
  /** Pedestal id the agent is walking to / working at. */
  targetPedestalId: string;
  /** Spawn timestamp (ms since scene start). */
  spawnedAt: number;
  /** Current path or `null` once arrived. */
  path: WalkPath | null;
  /** Path progress 0..1. */
  progress: number;
}

// ── 3. Selection + control groups (Zone 3) ───────────────────────────────────

export const CONTROL_GROUP_KEYS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
export type ControlGroupKey = (typeof CONTROL_GROUP_KEYS)[number];

/** A user-bound selection group, à la SC2 Ctrl+1..9. */
export interface ControlGroup {
  key: ControlGroupKey;
  members: AgentId[];
  /** ISO timestamp last bound — used for the "stale binding" affordance. */
  boundAt: string;
}

/**
 * Drag-box selection in renderer screen-space coordinates. The store holds
 * `null` when no box is in progress; `endX/endY` track the mouse cursor.
 */
export interface DragBox {
  /** Origin of the drag, in renderer canvas pixels (top-left = 0,0). */
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  /** True once the cursor has moved more than the drag-threshold from origin. */
  active: boolean;
}

// ── 4. Camera + strategic zoom + order queue (Zone 4) ────────────────────────

/**
 * Strategic-zoom "level of detail" stages. PRD §7.2: wheel out smoothly
 * transitions sprite → icon → dot → org level (à la Supreme Commander).
 */
export const ZOOM_LODS = ['sprite', 'icon', 'dot', 'org'] as const;
export type ZoomLod = (typeof ZOOM_LODS)[number];

/** Numerical zoom-scale thresholds at which each LOD activates. */
export const ZOOM_LOD_THRESHOLDS: Record<ZoomLod, number> = {
  sprite: 0.55,
  icon: 0.3,
  dot: 0.15,
  org: 0,
};

/**
 * Camera state — scale + world-space pan. The scene's world Container reads
 * these on every frame.
 */
export interface CameraView {
  /** Uniform zoom scale; 1.0 = "as designed". */
  scale: number;
  /** Pan offset x (world-space). 0 = throne under cursor. */
  panX: number;
  /** Pan offset y (world-space). */
  panY: number;
  /** Min/max zoom clamps. */
  minScale: number;
  maxScale: number;
}

export const DEFAULT_CAMERA_VIEW: CameraView = {
  scale: 1.0,
  panX: 0,
  panY: 0,
  minScale: 0.08,
  maxScale: 2.5,
};

/** Compute the active LOD for a given scale. */
export function lodForScale(scale: number): ZoomLod {
  if (scale >= ZOOM_LOD_THRESHOLDS.sprite) return 'sprite';
  if (scale >= ZOOM_LOD_THRESHOLDS.icon) return 'icon';
  if (scale >= ZOOM_LOD_THRESHOLDS.dot) return 'dot';
  return 'org';
}

/**
 * A single order queued during active-pause (PRD §7.2). Released in dispatch
 * order when the user un-pauses; dependent orders execute serially.
 */
export interface QueuedOrder {
  /** ULID assigned at enqueue time. */
  id: string;
  /** Agent receiving the order. */
  targetAgentId: AgentId;
  /** Hotkey label (e.g., "W" for delegate) — used by the HUD overlay. */
  hotkey?: string;
  /** Short human-readable label, e.g. "delegate". */
  label: string;
  /** Optional pedestal id the order targets. */
  targetPedestalId?: string;
  /** Optional free-form payload (mission brief, etc.). */
  payload?: Record<string, unknown>;
  /** ISO-8601 enqueue timestamp. */
  enqueuedAt: string;
}

// ── 5. Fog of war + minimap layers (Zone 5) ──────────────────────────────────

export const FOG_STATES = ['unexplored', 'shrouded', 'bright'] as const;
export type FogState = (typeof FOG_STATES)[number];

/**
 * A region of the map under fog. Keyed by pedestal id for files and by biome
 * name for directories (so a whole untouched biome reads as black without
 * needing per-leaf entries).
 */
export interface FogRegion {
  /** `pedestal.*` for files; `biome.*` for top-level dirs. */
  regionId: string;
  state: FogState;
  /** Agent that last touched this region, populated when state≥shrouded. */
  lastSeenBy?: AgentId;
  /** ISO timestamp the region was last touched. */
  lastSeenAt?: string;
  /** Number of pending changes (open PRs, agent diffs) — for the hover tooltip. */
  pendingChanges?: number;
}

/**
 * Minimap feature-layer toggles (PRD §7.2 F1–F4). At most one can be active
 * at a time — pressing the corresponding F-key toggles it on/off.
 */
export const MINIMAP_LAYERS = ['size', 'gitAge', 'testCoverage', 'errorDensity'] as const;
export type MinimapLayer = (typeof MINIMAP_LAYERS)[number];

/** F-key bindings → layer name. */
export const MINIMAP_LAYER_KEYS: Record<MinimapLayer, 'F1' | 'F2' | 'F3' | 'F4'> = {
  size: 'F1',
  gitAge: 'F2',
  testCoverage: 'F3',
  errorDensity: 'F4',
};

// ── 6. Hotkey command identifiers (Zone 3 ↔ Zone 6) ──────────────────────────

/**
 * Stable identifiers for every global hotkey-bound command. The Hotkeys
 * component dispatches one of these; SceneRoot / CommandCard receivers map
 * them to concrete actions. Adding a new command here is the entry point for
 * a new HUD affordance.
 */
export const HOTKEY_COMMANDS = [
  'select.cycleControlGroup',
  'select.cycleIdle',
  'select.clear',
  'pause.toggle',
  'camera.zoomIn',
  'camera.zoomOut',
  'camera.resetView',
  'map.openStrategic',
  'replay.open',
  'terminal.focusUser',
  'palette.open',
  'minimap.toggleLayer',
  'obsidian.openSelected',
  'command.slot',
] as const;
export type HotkeyCommand = (typeof HOTKEY_COMMANDS)[number];

/**
 * Event payload for a hotkey trigger. `command` is the verb; `args` are
 * optional structured args (e.g. `{ key: 1 }` for Ctrl+1).
 */
export interface HotkeyEvent {
  command: HotkeyCommand;
  args?: Record<string, unknown>;
}

// ── 7. Cross-zone re-exports ─────────────────────────────────────────────────

export { AgentIdSchema };
