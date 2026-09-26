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
//! 1. Resolve `HEAD` (or note it's unborn — no commits yet).
//! 2. Fail fast, without touching anything, if `<git-dir>/index.lock`
//!    already exists (someone else holds the real index lock).
//! 3. Seed a temp index file with `GIT_INDEX_FILE=<tmp> git read-tree HEAD`
//!    (skipped when HEAD is unborn — an empty index is the correct seed).
//! 4. `GIT_INDEX_FILE=<tmp> git add -A -- vault` stages *only* the vault
//!    pathspec (respecting `.gitignore`) into the temp index, from the
//!    working tree — regardless of whatever the user had or hadn't staged
//!    there themselves.
//! 5. `GIT_INDEX_FILE=<tmp> git write-tree` produces a tree. If it's
//!    identical to what HEAD already has for `vault/`, there's nothing to
//!    commit — bail out cleanly (`Ok(false)`).
//! 6. `git commit-tree <tree> [-p HEAD] -m <msg>` builds the commit object.
//!    `commit-tree` is plumbing: it never runs commit hooks, so a flaky
//!    `pre-commit`/`commit-msg` hook in the user's repo cannot block or
//!    corrupt vault sync.
//! 7. `git update-ref HEAD <new> <old>` advances HEAD with a compare-and-
//!    swap: `<old>` is the HEAD we observed in step 1 (or the empty string
//!    for "must not exist yet" when unborn). If something else moved HEAD
//!    in the meantime, this fails explicitly instead of silently
//!    clobbering a concurrent commit.
//! 8. Only *after* that succeeds do we touch the real index, and only for
//!    the vault pathspec: `git reset -q <new> -- vault` brings the real
//!    index's vault entries in line with the new commit, leaving every
//!    other staged path exactly as the user left it.
//!
//! The temp index file is removed in all cases (success, no-op, or error).
//! If the user had themselves staged vault changes before the tick, those
//! changes are captured by step 4 (which reads the working tree, not the
//! index) and get swept into the auto-commit — after which their vault
//! entries in the real index simply reflect "clean" (matching the new
//! HEAD) rather than "staged." This is the documented, chosen behavior:
//! vault content is always auto-managed by this task regardless of whether
//! the user staged it by hand.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use tokio::process::Command;
use tracing::{debug, info, warn};

use crate::channel::EventBus;
use crate::envelope::Envelope;

const INTERVAL_SECS: u64 = 300; // 5 minutes per PRD §8.4
const VAULT_PATHSPEC: &str = "vault";
/// Git's well-known empty-tree object id (`git hash-object -t tree /dev/null`).
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

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
                Ok(true) => {}
                Ok(false) => debug!("git_autocommit: no vault/ changes"),
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

/// Build the candidate tree for the next auto-commit into a throwaway index
/// file, without ever touching the real index. Returns the tree sha.
async fn build_vault_tree(root: &Path, temp_index: &Path, head: Option<&str>) -> Result<String> {
    let idx = temp_index.to_string_lossy().into_owned();
    if let Some(head) = head {
        git(root, &["read-tree", head], &[("GIT_INDEX_FILE", &idx)])
            .await
            .context("git read-tree HEAD into temp index failed")?;
    }
    // -A (not just add) so vault deletions are captured too; pathspec keeps
    // this scoped to vault/ only. .gitignore is respected by default.
    git(
        root,
        &["add", "-A", "--", VAULT_PATHSPEC],
        &[("GIT_INDEX_FILE", &idx)],
    )
    .await
    .context("git add -A -- vault into temp index failed")?;
    git(root, &["write-tree"], &[("GIT_INDEX_FILE", &idx)])
        .await
        .context("git write-tree from temp index failed")
}

/// True if `tree` differs from what `head` (or the empty tree, if unborn)
/// currently has for the vault pathspec.
async fn vault_tree_changed(root: &Path, head: Option<&str>, tree: &str) -> Result<bool> {
    let base = head.unwrap_or(EMPTY_TREE);
    let status = git_status_only(root, &["diff", "--quiet", base, tree, "--", VAULT_PATHSPEC])
        .await
        .context("git diff --quiet base..tree failed to run")?;
    // exit code 0 => no diff; 1 => diff; anything else is a real error.
    match status.code() {
        Some(0) => Ok(false),
        Some(1) => Ok(true),
        _ => bail!("git diff --quiet exited abnormally ({status:?})"),
    }
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

/// Bring the real index's `vault/` entries in line with `commit`, without
/// touching any other staged path.
async fn sync_real_index_to_commit(root: &Path, commit: &str) -> Result<()> {
    git(root, &["reset", "-q", commit, "--", VAULT_PATHSPEC], &[])
        .await
        .context("git reset -q <commit> -- vault failed to sync real index")?;
    Ok(())
}

/// One commit attempt. Returns `Ok(true)` if a commit was created, `Ok(false)`
/// if there was nothing to commit. Errors are explicit (locked index, CAS
/// race, not a repo, etc.) and never silently swallowed into `Ok(false)`.
pub async fn try_commit(root: &Path, bus: &Arc<EventBus>) -> Result<bool> {
    match run_autocommit(root).await {
        Ok(true) => {
            info!("git_autocommit: committed vault/");
            bus.publish(Envelope::log(
                "info",
                "git_autocommit",
                "committed vault/ via isolated index",
            ));
            Ok(true)
        }
        Ok(false) => Ok(false),
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
async fn run_autocommit(root: &Path) -> Result<bool> {
    let vault = root.join("vault");
    if !vault.exists() {
        return Ok(false);
    }

    let git_dir = resolve_git_dir(root).await.context("not a git repository")?;

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
    let outcome = run_autocommit_inner(root, &temp_index, head.as_deref()).await;
    let _ = tokio::fs::remove_file(&temp_index).await;
    outcome
}

async fn run_autocommit_inner(
    root: &Path,
    temp_index: &Path,
    head: Option<&str>,
) -> Result<bool> {
    let tree = build_vault_tree(root, temp_index, head).await?;

    if !vault_tree_changed(root, head, &tree).await? {
        return Ok(false);
    }

    let stamp = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let message = format!("chore(vault): auto-commit {stamp}");

    let new_commit = commit_and_advance_head(root, &tree, head, &message).await?;
    sync_real_index_to_commit(root, &new_commit).await?;
    Ok(true)
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

    #[tokio::test]
    async fn commits_vault_changes_and_leaves_new_head() {
        let repo = TempRepo::new("basic");
        seed_initial_commit(&repo);
        repo.write("vault/note.md", "---\nid: 1\n---\nhello vault\n");

        let committed = run_autocommit(repo.path()).await.expect("autocommit ok");
        assert!(committed);
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

        let committed = run_autocommit(repo.path()).await.expect("autocommit ok");
        assert!(committed);

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
        assert!(run_autocommit(repo.path()).await.unwrap());
        assert_eq!(repo.log_count(), 2);

        // Second call: nothing changed under vault/, must be a clean no-op.
        let committed_again = run_autocommit(repo.path()).await.expect("autocommit ok");
        assert!(!committed_again);
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

        let committed = run_autocommit(repo.path()).await.expect("autocommit ok");
        assert!(committed);

        let files = repo.git_ok(&["ls-tree", "-r", "--name-only", "HEAD"]);
        assert!(files.contains("vault/keep.md"));
        assert!(!files.contains("scratch.tmp"), "ignored file was committed: {files}");
    }

    #[tokio::test]
    async fn unborn_head_repo_commits_first_vault_snapshot() {
        let repo = TempRepo::new("unborn");
        // No commits at all yet.
        repo.write("vault/note.md", "first ever vault note\n");

        let committed = run_autocommit(repo.path()).await.expect("autocommit ok");
        assert!(committed);
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
        let tree = build_vault_tree(repo.path(), &temp_index, head.as_deref())
            .await
            .unwrap();
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
        let committed = run_autocommit(repo.path()).await.expect("autocommit ok");
        assert!(committed);
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
        let committed = run_autocommit(repo.path()).await.expect("autocommit ok");
        assert!(!committed);
    }
}
