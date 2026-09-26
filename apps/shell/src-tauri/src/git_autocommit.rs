//! Git auto-commit — every 5 minutes, commit `vault/` changes only.
//!
//! Per PRD FR-WIKI-06 / §8.4: vault sync is git-only, with auto-commit every
//! 5 min. This task never pushes; it never commits anything outside
//! `vault/`; it skips silently when not inside a git repo or `vault/`
//! doesn't exist.
//!
//! ## Isolated-index algorithm (A05)
//!
//! The naive approach (`git add vault/ && git commit`) stages and commits
//! through the *shared* index, which means any unrelated change the user had
//! already staged (outside `vault/`) gets swept into the auto-commit too.
//! To avoid that we build the commit through a throwaway index that never
//! touches the user's real one:
//!
//! 0. Before anything else, if a pending-index-sync marker file exists
//!    (`<git-dir>/skippy-autocommit-pending`, left behind by a previous tick
//!    whose commit landed but whose real-index sync failed), retry syncing
//!    just the paths that are still safe to touch, then clear the marker.
//!    See [`recover_pending_sync`].
//! 1. Resolve `HEAD` (or note it's unborn — no commits yet).
//! 2. Fail fast, without touching anything, if `<git-dir>/index.lock`
//!    already exists (someone else holds the real index lock).
//! 3. Seed a temp index file with `GIT_INDEX_FILE=<tmp> git read-tree HEAD`
//!    (skipped when HEAD is unborn — an empty index is the correct seed).
//! 4. `GIT_INDEX_FILE=<tmp> git add -A -- vault` stages *only* the vault
//!    pathspec (respecting `.gitignore`) into the temp index, from the
//!    working tree. `write-tree` + `diff HEAD` against it gives the full
//!    candidate path list.
//! 5. From that candidate list, compute three exclusion sets and restore
//!    each matching path back to its HEAD state in the temp index (or
//!    remove it if HEAD doesn't have it), so none of them are ever part of
//!    this auto-commit:
//!      a. skip-worktree / assume-unchanged vault paths
//!         ([`list_flagged_vault_paths`]),
//!      b. paths whose staged blob differs from BOTH HEAD and the working
//!         tree ("staged-vs-worktree conflict",
//!         [`list_staged_vs_worktree_conflicts`]),
//!      c. well-known secret filenames ([`SECRET_FILENAME_PATTERNS`]) and,
//!         for everything else, a content scan of the working-tree bytes
//!         for high-confidence secret markers ([`SECRET_CONTENT_PATTERNS`]).
//!    All three are reported back to the caller as `skipped` paths.
//! 6. `write-tree` again (only if anything was restored). If the resulting
//!    tree is identical to what HEAD already has for `vault/`, there's
//!    nothing to commit — bail out cleanly (`Ok(AutocommitOutcome::NoOp)`).
//! 7. `git commit-tree <tree> [-p HEAD] -m <msg>` builds the commit object.
//!    `commit-tree` is plumbing: it never runs commit hooks, so a flaky
//!    `pre-commit`/`commit-msg` hook (or a secret-scanning one) in the
//!    user's repo cannot block, corrupt, or protect vault sync — which is
//!    exactly why the exclusions in step 5c exist as a *built-in* guard.
//! 8. `git update-ref HEAD <new> <old>` advances HEAD with a compare-and-
//!    swap: `<old>` is the HEAD we observed in step 1 (or the empty string
//!    for "must not exist yet" when unborn). If something else moved HEAD
//!    in the meantime, this fails explicitly instead of silently
//!    clobbering a concurrent commit, and nothing else has happened yet —
//!    the real index and working tree are untouched.
//! 9. Only *after* that succeeds do we touch the real index, and only for
//!    the vault paths that actually changed, excluding everything from step
//!    5 (so a plain `git reset` can never strip their skip-worktree /
//!    assume-unchanged flags even though their content is unchanged). If
//!    this sync fails (e.g. something else grabbed the index lock right
//!    after our commit landed), the commit is **not** rolled back and is
//!    **not** reported as a failure — HEAD has already moved. Instead a
//!    pending marker is written (new sha + parent sha) and the outcome is
//!    [`AutocommitOutcome::CommittedIndexSyncPending`]; the next tick's step
//!    0 finishes the job.
//!
//! The temp index file is removed in all cases (success, no-op, or error).
//!
//! ## Secrets (FR-WIKI-06)
//!
//! `commit-tree` never runs hooks, so a repo's own secret-scanning
//! pre-commit hook can never see (or block) this commit. The built-in guard
//! above is the only line of defense: a static filename/extension exclusion
//! list (`.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`,
//! `id_ed25519*`, `id_ecdsa*`, `*credentials*.json`, `.npmrc`, `.netrc`,
//! `*.kdbx`, `secrets.*`) plus a content scan of every remaining candidate
//! blob's working-tree bytes for high-confidence secret markers (private
//! key headers, AWS access key ids, Anthropic/GitHub/Slack token prefixes).
//! Matches are skipped — left exactly as HEAD has them, or absent — never
//! committed, and reported back as `skipped` paths.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use once_cell::sync::Lazy;
use regex::Regex;
use tokio::process::Command;
use tracing::{debug, info, warn};

use crate::channel::EventBus;
use crate::envelope::Envelope;

const INTERVAL_SECS: u64 = 300; // 5 minutes per PRD §8.4
const VAULT_PATHSPEC: &str = "vault";
/// Git's well-known empty-tree object id (`git hash-object -t tree /dev/null`).
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const PENDING_MARKER_NAME: &str = "skippy-autocommit-pending";
const SYNC_RETRY_ATTEMPTS: u32 = 3;
const SYNC_RETRY_DELAY_MS: u64 = 20;

/// Built-in exclusion list (FR-WIKI-06 secret guard). Filenames/extensions
/// that should never be swept into the vault auto-commit, matched against
/// the vault-relative path. Kept in parity with the Node twin's
/// `SECRET_FILENAME_PATTERNS`.
static SECRET_FILENAME_PATTERNS: Lazy<Vec<Regex>> = Lazy::new(|| {
    [
        r"(^|/)\.env[^/]*$",
        r"\.pem$",
        r"\.key$",
        r"\.p12$",
        r"\.pfx$",
        r"(^|/)id_rsa[^/]*$",
        r"(^|/)id_ed25519[^/]*$",
        r"(^|/)id_ecdsa[^/]*$",
        r"(?i)credentials[^/]*\.json$",
        r"(^|/)\.npmrc$",
        r"(^|/)\.netrc$",
        r"\.kdbx$",
        r"(?i)(^|/)secrets\.[^/]*$",
    ]
    .iter()
    .map(|p| Regex::new(p).expect("static secret filename pattern"))
    .collect()
});

/// High-confidence secret content markers. A hit on any candidate blob's
/// working-tree content excludes that path from the commit, regardless of
/// its name. Kept in parity with the Node twin's `SECRET_CONTENT_PATTERNS`.
static SECRET_CONTENT_PATTERNS: Lazy<Vec<Regex>> = Lazy::new(|| {
    [
        r"-----BEGIN [A-Z ]*PRIVATE KEY-----",
        r"AKIA[0-9A-Z]{16}",
        r"sk-ant-",
        r"gh[po]_[A-Za-z0-9]{20,}",
        r"github_pat_[A-Za-z0-9_]{20,}",
        r"xox[baprs]-[A-Za-z0-9-]+",
    ]
    .iter()
    .map(|p| Regex::new(p).expect("static secret content pattern"))
    .collect()
});

fn matches_secret_filename(vault_relative_path: &str) -> bool {
    SECRET_FILENAME_PATTERNS.iter().any(|re| re.is_match(vault_relative_path))
}

/// Outcome of one autocommit tick.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AutocommitOutcome {
    /// Nothing under `vault/` had changed; no commit was created.
    NoOp,
    /// A commit was created and the real index was synced to it.
    Committed,
    /// A commit was created (HEAD advanced) but syncing the real index
    /// failed; a pending marker was persisted and will be retried on the
    /// next tick, before anything else.
    CommittedIndexSyncPending,
}

impl AutocommitOutcome {
    #[allow(dead_code)] // convenience accessor for callers outside this module/tests
    pub fn committed(&self) -> bool {
        !matches!(self, AutocommitOutcome::NoOp)
    }
}

/// Find the workspace root by walking up from cwd looking for `.git/`. Returns
/// `None` if not in a git repo.
fn locate_workspace_root() -> Option<PathBuf> {
    let cwd = std::env::current_dir().ok()?;
    let mut here: &Path = &cwd;
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

/// Spawn the 5-minute interval loop.
///
/// Uses `tauri::async_runtime::spawn` rather than `tokio::spawn` so the caller
/// can invoke this from Tauri's synchronous `setup` callback. Inside that
/// callback the Tokio reactor is owned by Tauri's async runtime; raw
/// `tokio::spawn` would panic with "no reactor running."
pub fn spawn_autocommit(bus: Arc<EventBus>) {
    tauri::async_runtime::spawn(async move {
        let root = match locate_workspace_root() {
            Some(r) => r,
            None => {
                debug!("git_autocommit: not inside a git repo; skipping");
                bus.publish(Envelope::log(
                    "info",
                    "git_autocommit",
                    "not a git repo; vault auto-commit disabled",
                ));
                return;
            }
        };

        let vault = root.join("vault");
        if !vault.exists() {
            debug!("git_autocommit: vault/ does not exist; skipping");
            bus.publish(Envelope::log(
                "info",
                "git_autocommit",
                format!("vault/ does not exist under {}; auto-commit disabled", root.display()),
            ));
            return;
        }

        info!(
            "git_autocommit: armed, watching vault/ under {} (every {INTERVAL_SECS}s)",
            root.display()
        );
        let mut interval = tokio::time::interval(Duration::from_secs(INTERVAL_SECS));
        // First tick fires immediately; skip it so we don't commit right at boot.
        interval.tick().await;

        loop {
            interval.tick().await;
            match try_commit(&root, &bus).await {
                Ok(AutocommitOutcome::NoOp) => debug!("git_autocommit: no vault/ changes"),
                Ok(AutocommitOutcome::Committed) => {}
                Ok(AutocommitOutcome::CommittedIndexSyncPending) => {
                    warn!("git_autocommit: committed vault/ but index sync is pending; will retry next tick");
                }
                Err(e) => warn!("git_autocommit: failed: {e}"),
            }
        }
    });
}

/// Run a git subcommand with `-C root`, returning stdout (trimmed) on
/// success or an error containing stderr on failure. `extra_env` is applied
/// on top of the inherited environment (used for `GIT_INDEX_FILE`).
async fn git(root: &Path, args: &[&str], extra_env: &[(&str, &str)]) -> Result<String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(root);
    cmd.args(args);
    for (k, v) in extra_env {
        cmd.env(k, v);
    }
    let output = cmd
        .output()
        .await
        .with_context(|| format!("failed to spawn git {args:?}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("git {args:?} failed: {}", stderr.trim());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Same as [`git`] but tolerates any nonzero exit (used for boolean-style
/// commands like `diff --quiet`); returns the raw exit status alongside
/// stdout/stderr.
async fn git_status_only(root: &Path, args: &[&str]) -> Result<std::process::ExitStatus> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(root);
    cmd.args(args);
    let output = cmd
        .output()
        .await
        .with_context(|| format!("failed to spawn git {args:?}"))?;
    Ok(output.status)
}

/// Resolve the git directory (handles worktrees/submodules where `.git` is a
/// file, not a directory) as an absolute path.
async fn resolve_git_dir(root: &Path) -> Result<PathBuf> {
    let raw = git(root, &["rev-parse", "--git-dir"], &[])
        .await
        .context("not a git repository")?;
    let p = PathBuf::from(raw);
    Ok(if p.is_absolute() { p } else { root.join(p) })
}

/// `Some(sha)` if `HEAD` resolves to a commit, `None` if HEAD is unborn
/// (fresh repo, no commits yet).
async fn resolve_head(root: &Path) -> Result<Option<String>> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(root).args(["rev-parse", "--verify", "-q", "HEAD"]);
    let output = cmd.output().await.context("failed to spawn git rev-parse HEAD")?;
    if output.status.success() {
        Ok(Some(String::from_utf8_lossy(&output.stdout).trim().to_string()))
    } else {
        Ok(None)
    }
}

fn lines(s: &str) -> Vec<String> {
    s.split('\n').filter(|l| !l.is_empty()).map(str::to_string).collect()
}

/// True if `tree` differs from what `head` (or the empty tree, if unborn)
/// currently has for the vault pathspec.
async fn vault_tree_changed(root: &Path, head: Option<&str>, tree: &str) -> Result<bool> {
    let base = head.unwrap_or(EMPTY_TREE);
    let status = git_status_only(root, &["diff", "--quiet", base, tree, "--", VAULT_PATHSPEC])
        .await
        .context("git diff --quiet base..tree failed to run")?;
    match status.code() {
        Some(0) => Ok(false),
        Some(1) => Ok(true),
        _ => bail!("git diff --quiet exited abnormally ({status:?})"),
    }
}

/// Vault paths that changed between `base` and `tree`.
async fn changed_vault_paths(root: &Path, base: &str, tree: &str) -> Vec<String> {
    match git(root, &["diff", "--name-only", base, tree, "--", VAULT_PATHSPEC], &[]).await {
        Ok(out) => lines(&out),
        Err(_) => Vec::new(),
    }
}

/// skip-worktree (`S` tag) and assume-unchanged (any lowercase tag) vault
/// paths, from the REAL index (not the throwaway one).
async fn list_flagged_vault_paths(root: &Path) -> Vec<String> {
    let out = match git(root, &["ls-files", "-v", "--", VAULT_PATHSPEC], &[]).await {
        Ok(out) => out,
        Err(_) => return Vec::new(),
    };
    let mut flagged = Vec::new();
    for line in lines(&out) {
        if line.len() < 3 {
            continue;
        }
        let tag = line.as_bytes()[0];
        let path = line[2..].to_string();
        if tag == b'S' || tag.is_ascii_lowercase() {
            flagged.push(path);
        }
    }
    flagged
}

/// Vault paths whose staged blob differs from BOTH HEAD and the working
/// tree ("staged-vs-worktree conflict" — a partially-staged vault edit).
async fn list_staged_vs_worktree_conflicts(root: &Path) -> Vec<String> {
    let staged = match git(root, &["diff", "--cached", "--name-only", "--", VAULT_PATHSPEC], &[]).await {
        Ok(out) => lines(&out),
        Err(_) => Vec::new(),
    };
    let worktree: std::collections::HashSet<String> =
        match git(root, &["diff", "--name-only", "--", VAULT_PATHSPEC], &[]).await {
            Ok(out) => lines(&out).into_iter().collect(),
            Err(_) => std::collections::HashSet::new(),
        };
    staged.into_iter().filter(|p| worktree.contains(p)).collect()
}

/// Restore `path` in the temp index to its HEAD state, or remove it
/// entirely if HEAD doesn't have it — undoing whatever `add -A` staged
/// there so it's never part of this auto-commit.
async fn restore_path_to_head(root: &Path, temp_index: &str, head: Option<&str>, path: &str) -> Result<()> {
    let env = [("GIT_INDEX_FILE", temp_index)];
    let mut head_entry = String::new();
    if let Some(head) = head {
        head_entry = git(root, &["ls-tree", head, "--", path], &[]).await.unwrap_or_default();
    }
    if let Some((mode, sha)) = parse_ls_tree_blob(&head_entry) {
        // --add: the path may have been removed from the temp index
        // entirely (e.g. `add -A` staged a deletion for a skip-worktree
        // file that no longer exists on disk), in which case a bare
        // --cacheinfo update would fail with "missing --add option".
        let cacheinfo = format!("{mode},{sha},{path}");
        git(root, &["update-index", "--add", "--cacheinfo", &cacheinfo], &env)
            .await
            .context("git update-index --cacheinfo failed while restoring an excluded vault path")?;
        return Ok(());
    }
    // Not in HEAD (or not a blob): ensure it's absent from the temp index.
    // `--force-remove` errors if the path is already absent; that's fine.
    let _ = git(root, &["update-index", "--force-remove", "--", path], &env).await;
    Ok(())
}

fn parse_ls_tree_blob(entry: &str) -> Option<(String, String)> {
    // "<mode> blob <sha>\t<path>"
    let (head, _) = entry.split_once('\t')?;
    let mut parts = head.split_whitespace();
    let mode = parts.next()?;
    let kind = parts.next()?;
    let sha = parts.next()?;
    if kind != "blob" {
        return None;
    }
    Some((mode.to_string(), sha.to_string()))
}

async fn scan_working_tree_for_secrets(root: &Path, paths: &[String]) -> Vec<String> {
    let mut hits = Vec::new();
    for p in paths {
        let abs = root.join(p);
        let content = match tokio::fs::read(&abs).await {
            Ok(bytes) => bytes,
            Err(_) => continue, // deletion, or unreadable: nothing to scan
        };
        let text = String::from_utf8_lossy(&content);
        if SECRET_CONTENT_PATTERNS.iter().any(|re| re.is_match(&text)) {
            hits.push(p.clone());
        }
    }
    hits
}

/// Build the commit object for `tree` (parented on `head`, if any) and
/// atomically advance `HEAD` with a compare-and-swap against `head`. Never
/// touches the real index. On CAS failure (something else moved HEAD)
/// returns an explicit error and leaves refs/index untouched.
async fn commit_and_advance_head(
    root: &Path,
    tree: &str,
    head: Option<&str>,
    message: &str,
) -> Result<String> {
    let mut args: Vec<&str> = vec!["-c", "commit.gpgsign=false", "commit-tree", tree];
    if let Some(head) = head {
        args.push("-p");
        args.push(head);
    }
    args.push("-m");
    args.push(message);
    let new_commit = git(root, &args, &[])
        .await
        .context("git commit-tree failed")?;

    // Compare-and-swap HEAD. An empty old-value means "HEAD must not exist
    // yet" (unborn repo); otherwise it must exactly match what we observed.
    let old = head.unwrap_or("");
    git(root, &["update-ref", "HEAD", &new_commit, old], &[])
        .await
        .context("git update-ref HEAD failed (HEAD moved concurrently, or ref update raced)")?;

    Ok(new_commit)
}

async fn with_retries<F, Fut>(mut f: F) -> Result<()>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<()>>,
{
    let mut last_err = None;
    for attempt in 0..SYNC_RETRY_ATTEMPTS {
        match f().await {
            Ok(()) => return Ok(()),
            Err(e) => {
                last_err = Some(e);
                if attempt + 1 < SYNC_RETRY_ATTEMPTS {
                    tokio::time::sleep(Duration::from_millis(SYNC_RETRY_DELAY_MS)).await;
                }
            }
        }
    }
    Err(last_err.unwrap())
}

/// Bring the real index's vault entries that actually changed in line with
/// `commit`, excluding every path in `excluded` (skip-worktree,
/// assume-unchanged, staged-vs-worktree conflicts, secret hits — none of
/// which changed in `commit` to begin with, but excluded defensively so a
/// `git reset` can never strip their flags).
async fn sync_real_index_after_commit(root: &Path, commit: &str, excluded: &[String]) -> Result<()> {
    with_retries(|| async {
        let mut args: Vec<String> = vec!["reset".into(), "-q".into(), commit.into(), "--".into(), VAULT_PATHSPEC.into()];
        for p in excluded {
            args.push(format!(":(exclude){p}"));
        }
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        git(root, &arg_refs, &[])
            .await
            .context("git reset -q <commit> -- vault failed to sync real index")?;
        Ok(())
    })
    .await
}

fn pending_marker_path(git_dir: &Path) -> PathBuf {
    git_dir.join(PENDING_MARKER_NAME)
}

#[derive(serde::Serialize, serde::Deserialize)]
struct PendingMarker {
    new: String,
    parent: Option<String>,
}

async fn write_pending_marker(git_dir: &Path, new_sha: &str, parent_sha: Option<&str>) -> Result<()> {
    let marker = PendingMarker {
        new: new_sha.to_string(),
        parent: parent_sha.map(str::to_string),
    };
    let json = serde_json::to_string(&marker)?;
    tokio::fs::write(pending_marker_path(git_dir), json).await?;
    Ok(())
}

async fn real_index_blob_for(root: &Path, path: &str) -> Option<String> {
    let out = git(root, &["ls-files", "-s", "--", path], &[]).await.ok()?;
    let line = out.lines().next()?;
    let mut parts = line.split_whitespace();
    let _mode = parts.next()?;
    Some(parts.next()?.to_string())
}

async fn tree_blob_for(root: &Path, tree: &str, path: &str) -> Option<String> {
    if tree == EMPTY_TREE {
        return None;
    }
    let out = git(root, &["ls-tree", tree, "--", path], &[]).await.ok()?;
    parse_ls_tree_blob(&out).map(|(_, sha)| sha)
}

/// Result of [`recover_pending_sync`].
#[allow(dead_code)] // new_sha/error are surfaced for logging/tests; not all callers read them
#[derive(Debug, Clone)]
pub struct RecoveryOutcome {
    pub synced: bool,
    pub new_sha: String,
    pub error: Option<String>,
}

/// Step 0 of every tick: if a previous tick's commit landed but its
/// real-index sync failed, finish the job now, before touching anything
/// else. Only paths whose real-index entry still equals the PARENT commit's
/// blob (i.e. untouched by the user since) are synced — anything the user
/// has since staged differently is left alone and stays pending rather than
/// being clobbered.
async fn recover_pending_sync(root: &Path, git_dir: &Path) -> Option<RecoveryOutcome> {
    let marker_path = pending_marker_path(git_dir);
    let raw = tokio::fs::read_to_string(&marker_path).await.ok()?;
    let marker: PendingMarker = match serde_json::from_str(&raw) {
        Ok(m) => m,
        Err(_) => {
            // Corrupt marker: drop it rather than getting stuck forever.
            let _ = tokio::fs::remove_file(&marker_path).await;
            return None;
        }
    };

    let base = marker.parent.clone().unwrap_or_else(|| EMPTY_TREE.to_string());
    let new_sha = marker.new.clone();

    let result = with_retries(|| {
        let base = base.clone();
        let new_sha = new_sha.clone();
        async move {
            let changed = changed_vault_paths(root, &base, &new_sha).await;
            let mut safe = Vec::new();
            for p in &changed {
                let index_blob = real_index_blob_for(root, p).await;
                let parent_blob = tree_blob_for(root, &base, p).await;
                if index_blob == parent_blob {
                    safe.push(p.clone());
                }
            }
            if !safe.is_empty() {
                let mut args: Vec<String> = vec!["reset".into(), "-q".into(), new_sha.clone(), "--".into()];
                args.extend(safe);
                let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
                git(root, &arg_refs, &[])
                    .await
                    .context("recovery: git reset -q <new> -- <safe paths> failed")?;
            }
            Ok(())
        }
    })
    .await;

    match result {
        Ok(()) => {
            let _ = tokio::fs::remove_file(&marker_path).await;
            Some(RecoveryOutcome { synced: true, new_sha, error: None })
        }
        Err(e) => Some(RecoveryOutcome { synced: false, new_sha, error: Some(e.to_string()) }),
    }
}

/// One commit attempt. Errors are explicit (locked index, CAS race, not a
/// repo, etc.) and never silently swallowed into `Ok(NoOp)`. A committed-
/// but-sync-pending result is `Ok`, not `Err` — HEAD has already moved and
/// this is not a failed commit.
pub async fn try_commit(root: &Path, bus: &Arc<EventBus>) -> Result<AutocommitOutcome> {
    match run_autocommit(root).await {
        Ok(AutocommitOutcome::Committed) => {
            info!("git_autocommit: committed vault/");
            bus.publish(Envelope::log(
                "info",
                "git_autocommit",
                "committed vault/ via isolated index",
            ));
            Ok(AutocommitOutcome::Committed)
        }
        Ok(AutocommitOutcome::CommittedIndexSyncPending) => {
            info!("git_autocommit: committed vault/ but index sync is pending");
            bus.publish(Envelope::log(
                "warn",
                "git_autocommit",
                "committed vault/ but real-index sync is pending; will retry next tick",
            ));
            Ok(AutocommitOutcome::CommittedIndexSyncPending)
        }
        Ok(AutocommitOutcome::NoOp) => Ok(AutocommitOutcome::NoOp),
        Err(e) => {
            bus.publish(Envelope::log(
                "warn",
                "git_autocommit",
                format!("autocommit failed: {e}"),
            ));
            Err(e)
        }
    }
}

/// Core algorithm, free of `EventBus` so it's directly unit-testable against
/// real temporary git repos. See module docs for the full isolated-index
/// transaction.
async fn run_autocommit(root: &Path) -> Result<AutocommitOutcome> {
    let vault = root.join("vault");
    if !vault.exists() {
        return Ok(AutocommitOutcome::NoOp);
    }

    let git_dir = resolve_git_dir(root).await.context("not a git repository")?;

    // Step 0: finish any interrupted sync from a previous tick first.
    let _recovered = recover_pending_sync(root, &git_dir).await;

    // Fail fast and explicitly if the real index is locked. We never delete
    // someone else's lock file.
    let index_lock = git_dir.join("index.lock");
    if index_lock.exists() {
        bail!(
            "git index is locked ({}); skipping autocommit",
            index_lock.display()
        );
    }

    let head = resolve_head(root).await?;

    let temp_index =
        git_dir.join(format!("skippy-autocommit-index-{}", uuid::Uuid::new_v4()));
    // Always clean up the temp index file, whatever the outcome.
    let outcome = run_autocommit_inner(root, &git_dir, &temp_index, head.as_deref()).await;
    let _ = tokio::fs::remove_file(&temp_index).await;
    outcome
}

async fn run_autocommit_inner(
    root: &Path,
    git_dir: &Path,
    temp_index: &Path,
    head: Option<&str>,
) -> Result<AutocommitOutcome> {
    let idx = temp_index.to_string_lossy().into_owned();
    let env = [("GIT_INDEX_FILE", idx.as_str())];

    if let Some(head) = head {
        git(root, &["read-tree", head], &env)
            .await
            .context("git read-tree HEAD into temp index failed")?;
    }
    // -A (not just add) so vault deletions are captured too; pathspec keeps
    // this scoped to vault/ only. .gitignore is respected by default.
    git(root, &["add", "-A", "--", VAULT_PATHSPEC], &env)
        .await
        .context("git add -A -- vault into temp index failed")?;

    let flagged = list_flagged_vault_paths(root).await;
    let conflicts = list_staged_vs_worktree_conflicts(root).await;
    let excluded: std::collections::HashSet<String> = flagged.iter().chain(conflicts.iter()).cloned().collect();

    let base = head.map(str::to_string).unwrap_or_else(|| EMPTY_TREE.to_string());
    let preliminary_tree = git(root, &["write-tree"], &env)
        .await
        .context("git write-tree from temp index failed")?;
    let all_changed = changed_vault_paths(root, &base, &preliminary_tree).await;

    let secret_name_hits: Vec<String> = all_changed
        .iter()
        .filter(|p| !excluded.contains(*p) && matches_secret_filename(p))
        .cloned()
        .collect();
    let remaining: Vec<String> = all_changed
        .iter()
        .filter(|p| !excluded.contains(*p) && !secret_name_hits.contains(p))
        .cloned()
        .collect();
    let secret_content_hits = scan_working_tree_for_secrets(root, &remaining).await;

    let mut to_restore: Vec<String> = excluded.iter().cloned().collect();
    to_restore.extend(secret_name_hits.iter().cloned());
    to_restore.extend(secret_content_hits.iter().cloned());

    for p in &to_restore {
        restore_path_to_head(root, &idx, head, p).await?;
    }

    let tree = if !to_restore.is_empty() {
        git(root, &["write-tree"], &env)
            .await
            .context("git write-tree (post-exclusion) from temp index failed")?
    } else {
        preliminary_tree
    };

    let mut skipped = flagged;
    skipped.extend(conflicts);
    skipped.extend(secret_name_hits);
    skipped.extend(secret_content_hits);
    if !skipped.is_empty() {
        debug!("git_autocommit: skipped vault paths (excluded/secret): {}", skipped.join(", "));
    }

    if !vault_tree_changed(root, head, &tree).await? {
        return Ok(AutocommitOutcome::NoOp);
    }

    let stamp = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let message = format!("chore(vault): auto-commit {stamp}");

    let new_commit = commit_and_advance_head(root, &tree, head, &message).await?;

    let excluded_for_sync: Vec<String> = to_restore;
    match sync_real_index_after_commit(root, &new_commit, &excluded_for_sync).await {
        Ok(()) => Ok(AutocommitOutcome::Committed),
        Err(_e) => {
            // HEAD already advanced — this is NOT a failed commit.
            write_pending_marker(git_dir, &new_commit, head).await?;
            Ok(AutocommitOutcome::CommittedIndexSyncPending)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command as StdCommand;

    /// A throwaway repo under the OS temp dir (no `tempfile` dependency
    /// needed — cleaned up on `Drop`).
    struct TempRepo {
        dir: PathBuf,
    }

    impl TempRepo {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "skippy-autocommit-test-{name}-{}",
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            let repo = Self { dir };
            repo.git(&["init", "-q", "-b", "main"]);
            repo.git(&["config", "user.name", "Skippy Test"]);
            repo.git(&["config", "user.email", "skippy-test@example.invalid"]);
            // Local repo-only guardrails so the *user's* global config
            // (gpg signing, hooks path, etc.) can never interfere.
            repo.git(&["config", "commit.gpgsign", "false"]);
            repo.git(&["config", "core.hooksPath", ".no-hooks"]);
            repo
        }

        fn path(&self) -> &Path {
            &self.dir
        }

        fn git(&self, args: &[&str]) -> std::process::Output {
            let out = StdCommand::new("git")
                .arg("-C")
                .arg(&self.dir)
                .args(args)
                .output()
                .expect("git spawn");
            out
        }

        fn git_ok(&self, args: &[&str]) -> String {
            let out = self.git(args);
            assert!(
                out.status.success(),
                "git {args:?} failed: {}",
                String::from_utf8_lossy(&out.stderr)
            );
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        }

        fn write(&self, rel: &str, contents: &str) {
            let p = self.dir.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, contents).unwrap();
        }

        fn remove(&self, rel: &str) {
            let _ = std::fs::remove_file(self.dir.join(rel));
        }

        fn ls_files_s(&self) -> String {
            self.git_ok(&["ls-files", "-s"])
        }

        fn diff_cached(&self) -> String {
            self.git_ok(&["diff", "--cached"])
        }

        fn log_count(&self) -> usize {
            let out = self.git(&["rev-list", "--count", "HEAD"]);
            if !out.status.success() {
                return 0;
            }
            String::from_utf8_lossy(&out.stdout).trim().parse().unwrap_or(0)
        }
    }

    impl Drop for TempRepo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn seed_initial_commit(repo: &TempRepo) {
        repo.write("README.md", "hello\n");
        repo.git_ok(&["add", "README.md"]);
        repo.git_ok(&["commit", "-q", "-m", "initial"]);
    }

    #[cfg(unix)]
    fn write_hook(repo: &TempRepo, hooks_dir_name: &str, hook_name: &str, script: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let hooks_dir = repo.dir.join(hooks_dir_name);
        std::fs::create_dir_all(&hooks_dir).unwrap();
        let hook_path = hooks_dir.join(hook_name);
        std::fs::write(&hook_path, script).unwrap();
        let mut perms = std::fs::metadata(&hook_path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&hook_path, perms).unwrap();
        repo.git_ok(&["config", "core.hooksPath", hooks_dir_name]);
        hook_path
    }

    #[cfg(windows)]
    fn write_hook(repo: &TempRepo, hooks_dir_name: &str, hook_name: &str, script: &str) -> PathBuf {
        // Git for Windows ships an `sh.exe` that recognizes `#!/bin/sh`
        // shebangs for hook scripts without a `.exe` extension.
        let hooks_dir = repo.dir.join(hooks_dir_name);
        std::fs::create_dir_all(&hooks_dir).unwrap();
        let hook_path = hooks_dir.join(hook_name);
        std::fs::write(&hook_path, script).unwrap();
        repo.git_ok(&["config", "core.hooksPath", hooks_dir_name]);
        hook_path
    }

    #[tokio::test]
    async fn commits_vault_changes_and_leaves_new_head() {
        let repo = TempRepo::new("basic");
        seed_initial_commit(&repo);
        repo.write("vault/note.md", "---\nid: 1\n---\nhello vault\n");

        let outcome = run_autocommit(repo.path()).await.expect("autocommit ok");
        assert_eq!(outcome, AutocommitOutcome::Committed);
        assert_eq!(repo.log_count(), 2);

        let head_msg = repo.git_ok(&["log", "-1", "--pretty=%s"]);
        assert!(head_msg.starts_with("chore(vault): auto-commit"));

        // vault file is committed and clean in the real index.
        let status = repo.git_ok(&["status", "--porcelain", "vault/"]);
        assert!(status.is_empty(), "expected vault/ clean, got: {status}");
    }

    #[tokio::test]
    async fn unrelated_staged_file_stays_staged_and_is_not_committed() {
        let repo = TempRepo::new("unrelated-staged");
        seed_initial_commit(&repo);

        // Stage an unrelated (non-vault) change, do NOT commit it.
        repo.write("src/other.txt", "unrelated work in progress\n");
        repo.git_ok(&["add", "src/other.txt"]);
        let staged_before = repo.diff_cached();
        let non_vault_ls_before: Vec<String> = repo
            .ls_files_s()
            .lines()
            .filter(|l| !l.contains("vault/"))
            .map(str::to_string)
            .collect();
        assert!(!staged_before.is_empty(), "expected something staged");

        repo.write("vault/note.md", "vault content\n");

        let outcome = run_autocommit(repo.path()).await.expect("autocommit ok");
        assert_eq!(outcome, AutocommitOutcome::Committed);

        // Unrelated staged file: still staged (same blob, untouched by the
        // autocommit) even though the autocommit itself did happen and the
        // real index also now carries the new, now-clean vault entry.
        let staged_after = repo.diff_cached();
        let non_vault_ls_after: Vec<String> = repo
            .ls_files_s()
            .lines()
            .filter(|l| !l.contains("vault/"))
            .map(str::to_string)
            .collect();
        assert_eq!(staged_before, staged_after, "unrelated staged diff changed");
        assert_eq!(
            non_vault_ls_before, non_vault_ls_after,
            "unrelated (non-vault) index entries changed"
        );

        let committed_files = repo.git_ok(&["show", "--stat", "--pretty=format:", "HEAD"]);
        assert!(
            !committed_files.contains("other.txt"),
            "unrelated file leaked into autocommit: {committed_files}"
        );
        assert!(committed_files.contains("note.md"));
    }

    #[tokio::test]
    async fn noop_when_vault_unchanged() {
        let repo = TempRepo::new("noop");
        seed_initial_commit(&repo);
        repo.write("vault/note.md", "vault content\n");
        assert_eq!(run_autocommit(repo.path()).await.unwrap(), AutocommitOutcome::Committed);
        assert_eq!(repo.log_count(), 2);

        // Second call: nothing changed under vault/, must be a clean no-op.
        let again = run_autocommit(repo.path()).await.expect("autocommit ok");
        assert_eq!(again, AutocommitOutcome::NoOp);
        assert_eq!(repo.log_count(), 2, "no-op must not create a commit");
    }

    #[tokio::test]
    async fn ignored_vault_files_are_not_committed() {
        let repo = TempRepo::new("ignored");
        seed_initial_commit(&repo);
        repo.write(".gitignore", "vault/*.tmp\n");
        repo.git_ok(&["add", ".gitignore"]);
        repo.git_ok(&["commit", "-q", "-m", "add gitignore"]);

        repo.write("vault/keep.md", "keep me\n");
        repo.write("vault/scratch.tmp", "ignore me\n");

        let outcome = run_autocommit(repo.path()).await.expect("autocommit ok");
        assert_eq!(outcome, AutocommitOutcome::Committed);

        let files = repo.git_ok(&["ls-tree", "-r", "--name-only", "HEAD"]);
        assert!(files.contains("vault/keep.md"));
        assert!(!files.contains("scratch.tmp"), "ignored file was committed: {files}");
    }

    #[tokio::test]
    async fn unborn_head_repo_commits_first_vault_snapshot() {
        let repo = TempRepo::new("unborn");
        // No commits at all yet.
        repo.write("vault/note.md", "first ever vault note\n");

        let outcome = run_autocommit(repo.path()).await.expect("autocommit ok");
        assert_eq!(outcome, AutocommitOutcome::Committed);
        assert_eq!(repo.log_count(), 1);

        let parents = repo.git_ok(&["log", "-1", "--pretty=%P"]);
        assert!(parents.is_empty(), "first commit must have no parents");
    }

    #[tokio::test]
    async fn preexisting_index_lock_fails_explicitly_without_touching_anything() {
        let repo = TempRepo::new("index-lock");
        seed_initial_commit(&repo);
        repo.write("vault/note.md", "vault content\n");

        let git_dir = repo.path().join(".git");
        let lock_path = git_dir.join("index.lock");
        std::fs::write(&lock_path, b"").unwrap();

        let ls_before = repo.ls_files_s();
        let diff_before = repo.diff_cached();
        let log_before = repo.log_count();

        let result = run_autocommit(repo.path()).await;
        assert!(result.is_err(), "expected explicit failure with index.lock present");

        assert!(lock_path.exists(), "must never delete someone else's index.lock");
        assert_eq!(repo.ls_files_s(), ls_before, "real index must be untouched");
        assert_eq!(repo.diff_cached(), diff_before, "real staged diff must be untouched");
        assert_eq!(repo.log_count(), log_before, "no commit must be created");

        std::fs::remove_file(&lock_path).unwrap();
    }

    #[tokio::test]
    async fn concurrent_head_move_fails_the_cas_and_leaves_index_untouched() {
        let repo = TempRepo::new("cas-race");
        seed_initial_commit(&repo);
        repo.write("vault/note.md", "vault content\n");

        // Reproduce exactly what run_autocommit does, but hold on to the
        // stale `head` value across a concurrent commit to simulate a race
        // against another writer that moved HEAD in between.
        let git_dir = resolve_git_dir(repo.path()).await.unwrap();
        let head = resolve_head(repo.path()).await.unwrap();
        let temp_index = git_dir.join(format!("race-index-{}", uuid::Uuid::new_v4()));
        let idx = temp_index.to_string_lossy().into_owned();
        let env = [("GIT_INDEX_FILE", idx.as_str())];
        if let Some(h) = head.as_deref() {
            git(repo.path(), &["read-tree", h], &env).await.unwrap();
        }
        git(repo.path(), &["add", "-A", "--", VAULT_PATHSPEC], &env).await.unwrap();
        let tree = git(repo.path(), &["write-tree"], &env).await.unwrap();
        let _ = tokio::fs::remove_file(&temp_index).await;

        // Someone else advances HEAD concurrently.
        repo.write("README.md", "concurrent writer\n");
        repo.git_ok(&["add", "README.md"]);
        repo.git_ok(&["commit", "-q", "-m", "concurrent commit"]);

        let ls_before = repo.ls_files_s();
        let diff_before = repo.diff_cached();

        // Now attempt to advance HEAD using the now-stale `head` as the CAS
        // expected value — this must fail explicitly.
        let message = "chore(vault): auto-commit race-test".to_string();
        let result =
            commit_and_advance_head(repo.path(), &tree, head.as_deref(), &message).await;
        assert!(result.is_err(), "stale CAS must fail explicitly");

        // We never got to the index-sync step, so the real index must be
        // completely untouched.
        assert_eq!(repo.ls_files_s(), ls_before);
        assert_eq!(repo.diff_cached(), diff_before);
    }

    #[tokio::test]
    async fn detached_head_still_commits() {
        let repo = TempRepo::new("detached");
        seed_initial_commit(&repo);
        let head = repo.git_ok(&["rev-parse", "HEAD"]);
        repo.git_ok(&["checkout", "-q", &head]);

        repo.write("vault/note.md", "vault content on detached head\n");
        let outcome = run_autocommit(repo.path()).await.expect("autocommit ok");
        assert_eq!(outcome, AutocommitOutcome::Committed);
        assert_eq!(repo.log_count(), 2);
    }

    #[tokio::test]
    async fn not_a_git_repo_errors() {
        let dir = std::env::temp_dir().join(format!("skippy-not-a-repo-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(dir.join("vault")).unwrap();
        let result = run_autocommit(&dir).await;
        assert!(result.is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn missing_vault_dir_is_a_quiet_noop() {
        let repo = TempRepo::new("no-vault");
        seed_initial_commit(&repo);
        let outcome = run_autocommit(repo.path()).await.expect("autocommit ok");
        assert_eq!(outcome, AutocommitOutcome::NoOp);
    }

    // --- Defect 1: failure after update-ref must self-heal. -------------

    #[tokio::test]
    async fn index_lock_appearing_only_after_head_moves_is_reported_pending_and_self_heals() {
        let repo = TempRepo::new("pending-sync");
        seed_initial_commit(&repo);
        repo.write("vault/note.md", "vault content\n");

        // A reference-transaction hook that grabs the index lock right
        // after update-ref lands — stands in for e.g. an IDE grabbing the
        // lock in between our update-ref and our own reset. The hook
        // receives the state ("prepared"/"committed"/"aborted") as $1, not
        // on stdin (stdin carries the "<old> <new> <refname>" lines).
        let lock_path = repo.dir.join(".git").join("index.lock");
        let lock_str = lock_path.to_string_lossy().replace('\\', "/");
        let script = format!(
            "#!/bin/sh\ncat >/dev/null\nif [ \"$1\" = \"committed\" ]; then : > \"{lock_str}\"\nfi\nexit 0\n"
        );
        write_hook(&repo, ".hooks", "reference-transaction", &script);

        let outcome = run_autocommit(repo.path()).await.expect("autocommit ok");
        assert_eq!(
            outcome,
            AutocommitOutcome::CommittedIndexSyncPending,
            "commit landed but sync must be reported as pending, not failed"
        );
        assert_eq!(repo.log_count(), 2, "HEAD must have advanced despite the sync failure");

        let git_dir = repo.dir.join(".git");
        let marker_path = pending_marker_path(&git_dir);
        assert!(marker_path.exists(), "a pending-sync marker must be persisted");

        std::fs::remove_file(&lock_path).ok();
        repo.git_ok(&["config", "core.hooksPath", ".no-hooks"]);

        // Next tick: recovery must run BEFORE anything else and must sync
        // the real index to the new commit's vault blobs, not leave the
        // real index reverted to the old vault blob.
        let recovered = recover_pending_sync(repo.path(), &git_dir).await;
        assert!(matches!(recovered, Some(r) if r.synced), "pending sync must be recovered on the next tick");
        assert!(!marker_path.exists(), "pending marker must be cleared after recovery");

        let diff_cached = repo.git_ok(&["diff", "--cached", "--", "vault/note.md"]);
        assert!(diff_cached.is_empty(), "real index must reflect the committed vault blob, not revert it");
    }

    #[tokio::test]
    async fn pending_sync_recovery_does_not_clobber_a_reused_vault_path() {
        let repo = TempRepo::new("pending-sync-safe");
        seed_initial_commit(&repo);
        repo.write("vault/note.md", "v1\n");
        let first = run_autocommit(repo.path()).await.expect("autocommit ok");
        assert_eq!(first, AutocommitOutcome::Committed);
        let parent_sha = repo.git_ok(&["rev-parse", "HEAD"]);

        // Simulate a commit whose real-index sync never happened: a second
        // vault edit lands, HEAD advances, but the real index is reset back
        // to the parent's vault blob (as defect 1 describes).
        repo.write("vault/note.md", "v2\n");
        repo.git_ok(&["add", "-A", "--", "vault"]);
        let tree_sha = repo.git_ok(&["write-tree"]);
        let new_sha = repo.git_ok(&[
            "-c",
            "commit.gpgsign=false",
            "commit-tree",
            &tree_sha,
            "-p",
            &parent_sha,
            "-m",
            "chore(vault): auto-commit synthetic",
        ]);
        repo.git_ok(&["update-ref", "HEAD", &new_sha, &parent_sha]);
        repo.git_ok(&["reset", "-q", &parent_sha, "--", "vault"]);

        let git_dir = repo.dir.join(".git");
        write_pending_marker(&git_dir, &new_sha, Some(&parent_sha)).await.unwrap();

        // The user stages their OWN edit to note.md before the next tick
        // runs — this must NOT be clobbered by recovery.
        repo.write("vault/note.md", "user edit in progress\n");
        repo.git_ok(&["add", "--", "vault/note.md"]);
        let user_staged_blob = repo.git_ok(&["rev-parse", ":vault/note.md"]);

        let _ = run_autocommit(repo.path()).await;

        let blob_after = repo.git_ok(&["rev-parse", ":vault/note.md"]);
        assert_eq!(blob_after, user_staged_blob, "recovery must not clobber the user's own staged edit");
    }

    // --- Defect 2: secrets must never be committed, even without hooks. -

    #[tokio::test]
    async fn well_known_secret_filenames_are_excluded() {
        let repo = TempRepo::new("secret-names");
        seed_initial_commit(&repo);
        repo.write("vault/notes.md", "ordinary note\n");
        repo.write("vault/.env.production", "API_KEY=super-secret\n");
        repo.write("vault/credentials.json", "{\"token\":\"x\"}\n");
        repo.write(
            "vault/id_rsa",
            "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n",
        );

        let outcome = run_autocommit(repo.path()).await.expect("autocommit ok");
        assert_eq!(outcome, AutocommitOutcome::Committed);

        let files = repo.git_ok(&["ls-tree", "-r", "--name-only", "HEAD"]);
        assert!(files.contains("vault/notes.md"));
        assert!(!files.contains("vault/.env.production"), "secret filename .env.production was committed");
        assert!(!files.contains("vault/credentials.json"), "secret filename credentials.json was committed");
        assert!(!files.contains("vault/id_rsa"), "secret filename id_rsa was committed");
    }

    #[tokio::test]
    async fn secret_content_markers_are_excluded_under_an_innocuous_filename() {
        let repo = TempRepo::new("secret-content");
        seed_initial_commit(&repo);
        repo.write("vault/leaked-notes.md", "AKIAABCDEFGHIJKLMNOP is an AWS key I found\n");
        repo.write("vault/fine.md", "nothing to see here\n");

        let outcome = run_autocommit(repo.path()).await.expect("autocommit ok");
        assert_eq!(outcome, AutocommitOutcome::Committed);

        let files = repo.git_ok(&["ls-tree", "-r", "--name-only", "HEAD"]);
        assert!(files.contains("vault/fine.md"));
        assert!(!files.contains("vault/leaked-notes.md"), "content-scanned secret was committed");
    }

    // --- Defect 3/4: skip-worktree and assume-unchanged flags survive. --

    #[tokio::test]
    async fn skip_worktree_vault_file_is_not_committed_as_deleted_and_keeps_its_flag() {
        let repo = TempRepo::new("skip-worktree");
        seed_initial_commit(&repo);
        repo.write("vault/sparse.md", "sparse content\n");
        repo.git_ok(&["add", "vault/sparse.md"]);
        repo.git_ok(&["commit", "-q", "-m", "add sparse vault file"]);
        repo.git_ok(&["update-index", "--skip-worktree", "vault/sparse.md"]);

        repo.remove("vault/sparse.md");
        repo.write("vault/other.md", "other content\n");

        let outcome = run_autocommit(repo.path()).await.expect("autocommit ok");
        assert_eq!(outcome, AutocommitOutcome::Committed);

        let files = repo.git_ok(&["ls-tree", "-r", "--name-only", "HEAD"]);
        assert!(files.contains("vault/sparse.md"), "skip-worktree file must not be committed as deleted");
        assert!(files.contains("vault/other.md"));

        let flag = repo.git_ok(&["ls-files", "-v", "--", "vault/sparse.md"]);
        assert!(flag.starts_with("S "), "skip-worktree flag must survive, got: {flag}");
    }

    #[tokio::test]
    async fn assume_unchanged_vault_file_with_a_local_edit_is_not_committed_and_keeps_its_flag() {
        let repo = TempRepo::new("assume-unchanged");
        seed_initial_commit(&repo);
        repo.write("vault/assumed.md", "original\n");
        repo.git_ok(&["add", "vault/assumed.md"]);
        repo.git_ok(&["commit", "-q", "-m", "add assumed vault file"]);
        repo.git_ok(&["update-index", "--assume-unchanged", "vault/assumed.md"]);

        repo.write("vault/assumed.md", "locally edited, should not be swept up\n");
        repo.write("vault/real-change.md", "real change\n");

        let outcome = run_autocommit(repo.path()).await.expect("autocommit ok");
        assert_eq!(outcome, AutocommitOutcome::Committed);

        let committed_content = repo.git_ok(&["show", "HEAD:vault/assumed.md"]);
        assert_eq!(committed_content, "original", "assume-unchanged local edit must not be committed");

        let flag = repo.git_ok(&["ls-files", "-v", "--", "vault/assumed.md"]);
        assert!(flag.starts_with('h'), "assume-unchanged flag must survive, got: {flag}");
    }

    // --- Defect 5: staged-vs-worktree conflicts are left alone. ---------

    #[tokio::test]
    async fn staged_vs_worktree_conflict_is_skipped_not_clobbered() {
        let repo = TempRepo::new("partial-stage");
        seed_initial_commit(&repo);
        repo.write("vault/partial.md", "head version\n");
        repo.git_ok(&["add", "vault/partial.md"]);
        repo.git_ok(&["commit", "-q", "-m", "add partial vault file"]);

        // Stage one edit...
        repo.write("vault/partial.md", "staged version\n");
        repo.git_ok(&["add", "vault/partial.md"]);
        // ...then edit the working tree again without staging that.
        repo.write("vault/partial.md", "worktree version\n");

        let staged_blob_before = repo.git_ok(&["rev-parse", ":vault/partial.md"]);

        let _ = run_autocommit(repo.path()).await;

        let head_content = repo.git_ok(&["show", "HEAD:vault/partial.md"]);
        assert_eq!(head_content, "head version");
        let staged_blob_after = repo.git_ok(&["rev-parse", ":vault/partial.md"]);
        assert_eq!(staged_blob_after, staged_blob_before, "user's staged blob must be left alone");
        let worktree_diff = repo.git_ok(&["diff", "--", "vault/partial.md"]);
        assert!(worktree_diff.contains("worktree version"));
    }
}
