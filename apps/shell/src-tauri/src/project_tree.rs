//! Project-tree scanner — Phase 2 / Zone 1.
//!
//! PRD §7.2: the RTS map's ground plane is an isometric tessellation of the
//! project directory tree. Top-level directories become "biomes," subdirectories
//! become tiles, and files become pedestals. The renderer needs a shallow,
//! bounded snapshot of the tree at boot so it can lay out pedestals without
//! ever blocking the frame budget.
//!
//! This module exposes a single Tauri command `project_tree_scan` that walks
//! the workspace root breadth-first with hard caps on depth and per-directory
//! node count. Costly subtrees (`node_modules`, `target`, …) are skipped at
//! the entry-name level so a huge repo never explodes the response payload.

use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use chrono::{DateTime, Utc};
use serde::Serialize;

/// Maximum walk depth from the project root. Beyond this we drop deeper
/// subtrees entirely; deep dirs are rare and not visually informative.
const MAX_DEPTH: usize = 4;

/// Maximum children kept per directory. Excess children are truncated so a
/// directory with 5,000 files never poisons the response.
const MAX_CHILDREN_PER_DIR: usize = 32;

/// Directory names that are skipped wholesale at any depth.
const SKIP_NAMES: &[&str] = &[
    "node_modules",
    "target",
    ".git",
    "dist",
    ".cargo-skippy-target",
    ".smart-env",
    ".next",
    ".turbo",
    ".venv",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "lowercase")]
enum TreeNodeKind {
    Biome,
    Tile,
    Pedestal,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTreeNode {
    path: String,
    name: String,
    kind: TreeNodeKind,
    depth: usize,
    size_bytes: u64,
    mtime: String,
    children: Vec<ProjectTreeNode>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTree {
    root: String,
    scanned_at: String,
    total_files: u64,
    total_dirs: u64,
    tree: ProjectTreeNode,
}

/// Walk up from `start` until a `.git` directory is found. Mirrors the
/// pattern used by `vault_autocommit_now` in `lib.rs`.
fn locate_workspace_root(start: &Path) -> Option<PathBuf> {
    let mut here: &Path = start;
    loop {
        if here.join(".git").exists() {
            return Some(here.to_path_buf());
        }
        match here.parent() {
            Some(p) => here = p,
            None => return None,
        }
    }
}

fn mtime_to_rfc3339(m: SystemTime) -> String {
    let dt: DateTime<Utc> = m.into();
    dt.to_rfc3339()
}

/// Pick the `kind` for a node based on depth + is_dir. Depth 1 = biome, deeper
/// directories = tile, files at any depth = pedestal.
fn classify(depth: usize, is_dir: bool) -> TreeNodeKind {
    if !is_dir {
        TreeNodeKind::Pedestal
    } else if depth == 1 {
        TreeNodeKind::Biome
    } else {
        TreeNodeKind::Tile
    }
}

/// Collect direct children of `dir` as ordered (dir-first, alpha) entries.
/// Returns `(children, was_truncated)`.
fn list_children(dir: &Path) -> (Vec<(PathBuf, fs::Metadata, String)>, bool) {
    let mut entries: Vec<(PathBuf, fs::Metadata, String)> = Vec::new();
    let read = match fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return (entries, false),
    };
    for entry in read.flatten() {
        let name = match entry.file_name().into_string() {
            Ok(s) => s,
            Err(_) => continue,
        };
        if SKIP_NAMES.contains(&name.as_str()) {
            continue;
        }
        let path = entry.path();
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        entries.push((path, meta, name));
    }

    // Stable ordering: directories first, then files; alphabetical within each.
    entries.sort_by(|a, b| {
        let a_dir = a.1.is_dir();
        let b_dir = b.1.is_dir();
        match (a_dir, b_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.2.to_lowercase().cmp(&b.2.to_lowercase()),
        }
    });

    let truncated = entries.len() > MAX_CHILDREN_PER_DIR;
    if truncated {
        entries.truncate(MAX_CHILDREN_PER_DIR);
    }
    (entries, truncated)
}

/// Breadth-first walk from `root`. Returns the assembled tree plus totals.
fn scan_tree(root: &Path) -> ProjectTree {
    let scanned_at = Utc::now().to_rfc3339();
    let root_name = root
        .file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| root.display().to_string());

    let root_meta = fs::metadata(root).ok();
    let root_mtime = root_meta
        .as_ref()
        .and_then(|m| m.modified().ok())
        .map(mtime_to_rfc3339)
        .unwrap_or_else(|| scanned_at.clone());

    let mut tree_root = ProjectTreeNode {
        path: ".".to_string(),
        name: root_name,
        kind: TreeNodeKind::Tile,
        depth: 0,
        size_bytes: 0,
        mtime: root_mtime,
        children: Vec::new(),
    };

    let mut total_files: u64 = 0;
    let mut total_dirs: u64 = 1; // count the root.

    // Queue holds (absolute path, depth, pointer into tree as a path through
    // child indices). We avoid raw pointers by re-traversing the tree via the
    // index path each pop — depth is capped at 4 so it stays O(1) per visit.
    let mut queue: VecDeque<(PathBuf, usize, Vec<usize>)> = VecDeque::new();
    queue.push_back((root.to_path_buf(), 0, Vec::new()));

    while let Some((dir, depth, index_path)) = queue.pop_front() {
        if depth >= MAX_DEPTH {
            continue;
        }
        let (entries, _truncated) = list_children(&dir);

        // Resolve the parent node we're attaching children to via index path.
        let parent = navigate_mut(&mut tree_root, &index_path);

        for (child_path, meta, name) in entries {
            let is_dir = meta.is_dir();
            let child_depth = depth + 1;
            let kind = classify(child_depth, is_dir);
            let size_bytes = if is_dir { 0 } else { meta.len() };
            let mtime = meta
                .modified()
                .map(mtime_to_rfc3339)
                .unwrap_or_else(|_| scanned_at.clone());

            // Relative POSIX-style path from the project root.
            let rel_path = child_path
                .strip_prefix(root)
                .unwrap_or(&child_path)
                .to_string_lossy()
                .replace('\\', "/");

            let node = ProjectTreeNode {
                path: rel_path,
                name,
                kind,
                depth: child_depth,
                size_bytes,
                mtime,
                children: Vec::new(),
            };
            parent.children.push(node);

            if is_dir {
                total_dirs += 1;
                let mut next_index_path = index_path.clone();
                next_index_path.push(parent.children.len() - 1);
                queue.push_back((child_path, child_depth, next_index_path));
            } else {
                total_files += 1;
            }
        }
    }

    ProjectTree {
        root: root.to_string_lossy().replace('\\', "/"),
        scanned_at,
        total_files,
        total_dirs,
        tree: tree_root,
    }
}

/// Resolve a child-index path to a mutable reference. Panics only on an
/// internal invariant violation; the queue always pushes valid paths.
fn navigate_mut<'a>(root: &'a mut ProjectTreeNode, indices: &[usize]) -> &'a mut ProjectTreeNode {
    let mut cur = root;
    for &i in indices {
        cur = &mut cur.children[i];
    }
    cur
}

/// Tauri command: scan the project tree once. When `root` is `None`, walk up
/// from the current working directory until a `.git/` is found.
#[tauri::command]
pub async fn project_tree_scan(root: Option<String>) -> Result<ProjectTree, String> {
    let root_path = match root {
        Some(s) => PathBuf::from(s),
        None => {
            let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
            locate_workspace_root(&cwd)
                .ok_or_else(|| "not inside a git repo".to_string())?
        }
    };
    if !root_path.exists() {
        return Err(format!("root does not exist: {}", root_path.display()));
    }
    let tree = scan_tree(&root_path);
    Ok(tree)
}
