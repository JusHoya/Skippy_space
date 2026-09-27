//! Git auto-commit — every 5 minutes, commit `vault/` changes only.
//!
//! Per PRD FR-WIKI-06 / §8.4: vault sync is git-only, with auto-commit every
//! 5 min. This task never pushes; it never commits anything outside
//! `vault/`; it skips silently when not inside a git repo or `vault/`
//! doesn't exist. The Node twin is `scripts/git-autocommit.mjs`; both must
//! stay in exact semantic parity, and the secret lists live in ONE shared
//! file, `scripts/git-autocommit-secret-patterns.json` (`include_str!` here,
//! `readFileSync` there).
//!
//! ## Path handling (E5-1, E5-4, E5-5)
//!
//! Every path-listing git command runs with `-z` and its output is handled
//! as raw bytes, so non-ASCII names are never C-quoted or mangled and round-
//! trip exactly. Every git call runs with `GIT_LITERAL_PATHSPECS=1`, and no
//! user path is ever put on a command line: per-path input goes through
//! stdin (`update-index -z --index-info`, `cat-file --batch`) or a NUL-
//! delimited `--pathspec-from-file`.
//!
//! ## Isolated-index algorithm (A05)
//!
//! 0. If a pending-index-sync marker exists
//!    (`<git-dir>/skippy-autocommit-pending`, `{version, ref, new, parent}`,
//!    left by a tick whose commit landed but whose real-index sync failed),
//!    validate it first (E5-2): recover only if HEAD is still symbolically on
//!    `ref` and resolves to exactly `new`; otherwise (reset --hard, checkout
//!    of another branch, a user commit on top, a corrupt marker) drop it
//!    WITHOUT touching the index and report it as dropped. If recovery is
//!    attempted and fails, the tick stops with an explicit error rather than
//!    stacking a commit on an unsynced index. See [`recover_pending_sync`].
//! 1. Resolve `HEAD` (or note it's unborn) and the symbolic ref it names.
//! 2. Fail fast, without touching anything, if `<git-dir>/index.lock`
//!    already exists (someone else holds the real index lock).
//! 3. Snapshot the real index's vault entries (`ls-files -s -v -z`) and
//!    HEAD's (`ls-tree -r -z`). A vault path is USER-OWNED (E5-6/E5-7) if
//!    its real-index entry differs from HEAD in any way: staged add/modify/
//!    delete, `rm --cached`, either side of a rename or copy, intent-to-add,
//!    or unmerged. Skip-worktree / assume-unchanged paths are FLAGGED.
//!    Neither is ever committed or re-synced.
//! 4. Seed a throwaway index (`GIT_INDEX_FILE=<tmp> git read-tree HEAD`),
//!    `add -A -- vault` into it, `write-tree` -> preliminary tree. The
//!    candidate list is every vault path whose (mode, oid) differs between
//!    HEAD and that tree.
//! 5. Exclusions, each restored to its HEAD state in the temp index (or
//!    removed if HEAD lacks it) with ONE `update-index -z --index-info`:
//!      a. flagged paths, b. user-owned paths,
//!      c. secret filename hits, d. secret content hits — the content scan
//!         reads the exact blobs the commit would contain (`cat-file
//!         --batch`), one char per byte and again with NULs stripped (UTF-16).
//!    All are reported back as `skipped` paths.
//! 6. If nothing is left, no-op. Otherwise `write-tree` -> final tree.
//! 7. `git commit-tree <tree> [-p HEAD] -m <msg>` builds the commit object.
//!    `commit-tree` is plumbing: it never runs commit hooks, so a flaky
//!    `pre-commit`/`commit-msg` hook (or a secret-scanning one) in the
//!    user's repo cannot block, corrupt, or protect vault sync — which is
//!    exactly why the exclusions in step 5c/5d exist as a *built-in* guard.
//! 8. `git update-ref HEAD <new> <old>` advances HEAD with a compare-and-
//!    swap (`<old>` empty = "must not exist yet" when unborn). If something
//!    else moved HEAD, this fails explicitly before the real index is
//!    touched.
//! 9. Sync the real index ONLY for the committed paths (parent -> new), and
//!    only those whose real-index entry still equals the parent's (re-read at
//!    sync time), via `reset -q <new> --pathspec-from-file` (literal, NUL-
//!    delimited). If that fails after bounded retries, the commit is **not**
//!    rolled back and **not** reported as a failure: a pending marker is
//!    written and the outcome is
//!    [`AutocommitOutcome::CommittedIndexSyncPending`].
//!
//! Known window (E5-9): between step 8 and a successful sync (normally
//! milliseconds; up to the next tick if the sync hit a held `index.lock`),
//! the real index still holds the parent's blobs for the committed paths. A
//! user `git commit` made inside that window records those parent blobs,
//! i.e. it reverts the autocommitted vault change in the user's commit. The
//! marker is then dropped (HEAD moved) and the next tick re-commits the
//! working-tree content, so the revert lasts only until the next tick.
//!
//! The temp index / pathspec files are removed in all cases.
//!
//! ## Secrets (FR-WIKI-06)
//!
//! `commit-tree` never runs hooks, so a repo's own secret-scanning
//! pre-commit hook can never see (or block) this commit. The built-in guard
//! is the only line of defense: filename rules (case-insensitive: `.env` /
//! `.env.*`, `.envrc`, key/cert/keystore extensions, `id_*` SSH keys,
//! `*credentials*.json`, `.npmrc`/`.netrc`/`_netrc`/`.pypirc`/
//! `.git-credentials`, `secrets.*` except Markdown notes) plus a content scan
//! for private-key armor (incl. PGP), AWS key ids and secret-key
//! assignments, Anthropic/OpenAI/Stripe/GitHub/Slack/Google key shapes.
//! Matches are skipped — left exactly as HEAD has them, or absent.

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use once_cell::sync::Lazy;
use regex::Regex;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tracing::{debug, info, warn};

use crate::channel::EventBus;
use crate::envelope::Envelope;

const INTERVAL_SECS: u64 = 300; // 5 minutes per PRD §8.4
const VAULT_PATHSPEC: &str = "vault";
/// Git's well-known empty-tree object id (`git hash-object -t tree /dev/null`).
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const PENDING_MARKER_NAME: &str = "skippy-autocommit-pending";
const PENDING_MARKER_VERSION: u64 = 2;
const SYNC_RETRY_ATTEMPTS: u32 = 3;
const SYNC_RETRY_DELAY_MS: u64 = 20;

/// Shared with the Node twin (single source of truth).
const SECRET_PATTERNS_JSON: &str = include_str!("../../../../scripts/git-autocommit-secret-patterns.json");

/// A repo-relative path as raw bytes (exactly what git stores).
type BPath = Vec<u8>;
/// Vault entries keyed by path: value is `"<mode> <oid>"`.
type Entries = BTreeMap<BPath, String>;

struct FilenameRule {
    re: Regex,
    unless: Option<Regex>,
}

struct ContentRule {
    re: Regex,
    ignore_ascii_case: bool,
}

struct SecretRules {
    filename: Vec<FilenameRule>,
    content: Vec<ContentRule>,
}

static SECRET_RULES: Lazy<SecretRules> = Lazy::new(|| {
    let v: serde_json::Value = serde_json::from_str(SECRET_PATTERNS_JSON).expect("secret patterns JSON");
    let re = |s: &serde_json::Value| Regex::new(s.as_str().expect("pattern string")).expect("secret pattern regex");
    let filename = v["filename"]
        .as_array()
        .expect("filename rules")
        .iter()
        .map(|r| FilenameRule {
            re: re(&r["pattern"]),
            unless: r.get("unless").map(re),
        })
        .collect();
    let content = v["content"]
        .as_array()
        .expect("content rules")
        .iter()
        .map(|r| ContentRule {
            re: re(&r["pattern"]),
            ignore_ascii_case: r.get("ignoreAsciiCase").and_then(serde_json::Value::as_bool).unwrap_or(false),
        })
        .collect();
    SecretRules { filename, content }
});

/// One char per byte (identical to Node's `Buffer#toString('latin1')`).
fn latin1(bytes: &[u8]) -> String {
    bytes.iter().map(|&b| b as char).collect()
}

/// Secret filename rules, matched against the ASCII-lowercased path.
fn matches_secret_filename(path: &[u8]) -> bool {
    let p = latin1(&path.to_ascii_lowercase());
    SECRET_RULES
        .filename
        .iter()
        .any(|r| r.re.is_match(&p) && !r.unless.as_ref().is_some_and(|u| u.is_match(&p)))
}

/// Secret content rules, matched against the exact blob bytes (one char per
/// byte) and, if it has NULs, again with every NUL removed (UTF-16 text).
fn matches_secret_content(bytes: &[u8]) -> bool {
    let mut views = vec![latin1(bytes)];
    if bytes.contains(&0) {
        let stripped: Vec<u8> = bytes.iter().copied().filter(|&b| b != 0).collect();
        views.push(latin1(&stripped));
    }
    views.iter().any(|view| {
        let lower = view.to_ascii_lowercase();
        SECRET_RULES
            .content
            .iter()
            .any(|r| r.re.is_match(if r.ignore_ascii_case { &lower } else { view }))
    })
}

fn display_path(p: &[u8]) -> String {
    String::from_utf8_lossy(p).into_owned()
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

/// Result of [`recover_pending_sync`].
#[allow(dead_code)] // fields are surfaced for logging/tests; not all callers read them
#[derive(Debug, Clone)]
pub struct RecoveryOutcome {
    pub synced: bool,
    pub new_sha: Option<String>,
    /// Set when the marker was discarded without touching the index.
    pub dropped: Option<String>,
    pub error: Option<String>,
}

/// Full result of one tick (mirrors the Node twin's return value).
#[derive(Debug, Clone)]
pub(crate) struct AutocommitReport {
    pub outcome: AutocommitOutcome,
    /// Vault paths withheld from the commit (user-staged, flagged, secret).
    pub skipped: Vec<String>,
    pub recovered: Option<RecoveryOutcome>,
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

/// Run `git -C root <args>` with `GIT_LITERAL_PATHSPECS=1` plus `extra_env`,
/// feeding `input` on stdin, returning raw stdout or an error with stderr.
async fn git_raw<S: AsRef<OsStr>>(
    root: &Path,
    args: &[S],
    extra_env: &[(&str, &OsStr)],
    input: Option<&[u8]>,
) -> Result<Vec<u8>> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(root);
    cmd.args(args);
    cmd.env("GIT_LITERAL_PATHSPECS", "1");
    for (k, v) in extra_env {
        cmd.env(k, v);
    }
    cmd.stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() });
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd.kill_on_drop(true);
    let describe = || {
        args.iter()
            .map(|a| a.as_ref().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join(" ")
    };
    let mut child = cmd.spawn().with_context(|| format!("failed to spawn git {}", describe()))?;
    let stdin = child.stdin.take();
    let write = async move {
        match (stdin, input) {
            (Some(mut s), Some(data)) => {
                let r = s.write_all(data).await;
                drop(s);
                r
            }
            _ => Ok(()),
        }
    };
    let (written, output) = tokio::join!(write, child.wait_with_output());
    let output = output.with_context(|| format!("failed to run git {}", describe()))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("git {} failed: {}", describe(), stderr.trim());
    }
    written.with_context(|| format!("failed to write stdin of git {}", describe()))?;
    Ok(output.stdout)
}

/// [`git_raw`] without stdin, returning trimmed UTF-8 stdout. `extra_env` is
/// applied on top of the inherited environment (used for `GIT_INDEX_FILE`).
async fn git(root: &Path, args: &[&str], extra_env: &[(&str, &OsStr)]) -> Result<String> {
    let out = git_raw(root, args, extra_env, None).await?;
    Ok(String::from_utf8_lossy(&out).trim().to_string())
}

/// Split `-z` output into records.
fn split_z(buf: &[u8]) -> impl Iterator<Item = &[u8]> {
    buf.split(|&b| b == 0).filter(|r| !r.is_empty())
}

/// `(meta fields, path)` of a `<meta>\t<path>` record.
fn split_record(rec: &[u8]) -> Option<(Vec<String>, BPath)> {
    let tab = rec.iter().position(|&b| b == b'\t')?;
    let meta = latin1(&rec[..tab]).split(' ').map(str::to_string).collect();
    Some((meta, rec[tab + 1..].to_vec()))
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
    Ok(git(root, &["rev-parse", "--verify", "-q", "HEAD"], &[]).await.ok())
}

/// The ref HEAD points at (`refs/heads/main`), or `None` when detached.
async fn resolve_symbolic_head(root: &Path) -> Result<Option<String>> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["symbolic-ref", "-q", "HEAD"])
        .stdin(Stdio::null())
        .output()
        .await
        .context("failed to spawn git symbolic-ref")?;
    match output.status.code() {
        Some(0) => {
            let r = String::from_utf8_lossy(&output.stdout).trim().to_string();
            Ok(if r.is_empty() { None } else { Some(r) })
        }
        Some(1) => Ok(None), // detached
        _ => bail!(
            "git symbolic-ref -q HEAD failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ),
    }
}

/// Vault entries of a tree-ish (empty for `None` / the empty tree).
async fn tree_entries(root: &Path, treeish: Option<&str>) -> Result<Entries> {
    let mut map = Entries::new();
    let Some(treeish) = treeish.filter(|t| *t != EMPTY_TREE) else {
        return Ok(map);
    };
    let out = git_raw(root, &["ls-tree", "-r", "-z", treeish, "--", VAULT_PATHSPEC], &[], None)
        .await
        .context("git ls-tree failed")?;
    for rec in split_z(&out) {
        let (meta, path) = split_record(rec).ok_or_else(|| anyhow!("malformed ls-tree record"))?;
        if meta.len() < 3 {
            bail!("malformed ls-tree record");
        }
        map.insert(path, format!("{} {}", meta[0], meta[2]));
    }
    Ok(map)
}

/// Real-index vault snapshot.
struct IndexSnapshot {
    /// Stage-0 entries.
    entries: Entries,
    /// skip-worktree (`S`) / assume-unchanged (lowercase tag) paths.
    flagged: BTreeSet<BPath>,
    /// Paths with any nonzero stage.
    unmerged: BTreeSet<BPath>,
}

async fn real_index_snapshot(root: &Path) -> Result<IndexSnapshot> {
    let out = git_raw(root, &["ls-files", "-s", "-v", "-z", "--", VAULT_PATHSPEC], &[], None)
        .await
        .context("git ls-files -s -v failed")?;
    let mut snap = IndexSnapshot {
        entries: Entries::new(),
        flagged: BTreeSet::new(),
        unmerged: BTreeSet::new(),
    };
    for rec in split_z(&out) {
        let (meta, path) = split_record(rec).ok_or_else(|| anyhow!("malformed ls-files record"))?;
        if meta.len() < 4 {
            bail!("malformed ls-files record");
        }
        if meta[3] != "0" {
            snap.unmerged.insert(path);
            continue;
        }
        let tag = meta[0].as_bytes().first().copied().unwrap_or(b'H');
        if tag == b'S' || tag.is_ascii_lowercase() {
            snap.flagged.insert(path.clone());
        }
        snap.entries.insert(path, format!("{} {}", meta[1], meta[2]));
    }
    Ok(snap)
}

/// Paths whose entry differs between two entry maps, in byte order.
fn differing_paths(a: &Entries, b: &Entries) -> Vec<BPath> {
    let mut out: BTreeSet<BPath> = BTreeSet::new();
    for (p, v) in a {
        if b.get(p) != Some(v) {
            out.insert(p.clone());
        }
    }
    for p in b.keys() {
        if !a.contains_key(p) {
            out.insert(p.clone());
        }
    }
    out.into_iter().collect()
}

/// Vault paths the user has staged something for (real index != HEAD).
fn user_owned_paths(snap: &IndexSnapshot, head_entries: &Entries) -> BTreeSet<BPath> {
    let mut owned = snap.unmerged.clone();
    owned.extend(differing_paths(&snap.entries, head_entries));
    owned
}

/// Content-scan blobs by oid with one `cat-file --batch`. Returns hit oids.
async fn scan_blobs_for_secrets(root: &Path, oids: &[String]) -> Result<BTreeSet<String>> {
    let unique: Vec<String> = oids.iter().cloned().collect::<BTreeSet<_>>().into_iter().collect();
    let mut hits = BTreeSet::new();
    if unique.is_empty() {
        return Ok(hits);
    }
    let input: String = unique.iter().map(|o| format!("{o}\n")).collect();
    let out = git_raw(root, &["cat-file", "--batch"], &[], Some(input.as_bytes()))
        .await
        .context("git cat-file --batch failed")?;
    let mut pos = 0usize;
    for oid in &unique {
        let nl = out[pos..]
            .iter()
            .position(|&b| b == b'\n')
            .map(|i| pos + i)
            .ok_or_else(|| anyhow!("cat-file --batch: truncated output"))?;
        let header = latin1(&out[pos..nl]);
        let fields: Vec<&str> = header.split(' ').collect();
        pos = nl + 1;
        if fields.get(1) == Some(&"missing") {
            bail!("cat-file --batch: blob {oid} missing");
        }
        let size: usize = fields
            .get(2)
            .and_then(|s| s.parse().ok())
            .ok_or_else(|| anyhow!("cat-file --batch: unexpected header"))?;
        if fields[0] != oid || pos + size > out.len() {
            bail!("cat-file --batch: unexpected header");
        }
        if matches_secret_content(&out[pos..pos + size]) {
            hits.insert(oid.clone());
        }
        pos += size + 1; // trailing LF
    }
    Ok(hits)
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

async fn with_retries<T, F, Fut>(mut f: F) -> Result<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T>>,
{
    let mut last_err = None;
    for attempt in 0..SYNC_RETRY_ATTEMPTS {
        match f().await {
            Ok(v) => return Ok(v),
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

/// Bring the real index in line with `new_commit` for exactly `paths` (the
/// paths the autocommit changed), skipping any path whose real-index entry
/// no longer equals `parent_entries` (the user staged something since), is
/// flagged, or is unmerged. Literal, NUL-delimited pathspec file; never a
/// whole-vault reset. Returns the number of paths synced.
async fn sync_real_index(
    root: &Path,
    git_dir: &Path,
    new_commit: &str,
    parent_entries: &Entries,
    paths: &[BPath],
) -> Result<usize> {
    with_retries(|| async {
        let snap = real_index_snapshot(root).await?;
        let safe: Vec<&BPath> = paths
            .iter()
            .filter(|p| {
                !snap.flagged.contains(*p)
                    && !snap.unmerged.contains(*p)
                    && snap.entries.get(*p) == parent_entries.get(*p)
            })
            .collect();
        if safe.is_empty() {
            return Ok(0); // never run a pathspec-less reset
        }
        let spec_file = git_dir.join(format!("skippy-autocommit-pathspec-{}", uuid::Uuid::new_v4()));
        let mut content = Vec::new();
        for p in &safe {
            content.extend_from_slice(p);
            content.push(0);
        }
        tokio::fs::write(&spec_file, &content)
            .await
            .context("failed to write pathspec file")?;
        let mut spec_arg = OsString::from("--pathspec-from-file=");
        spec_arg.push(&spec_file);
        let args: Vec<OsString> = vec![
            "reset".into(),
            "-q".into(),
            new_commit.into(),
            spec_arg,
            "--pathspec-file-nul".into(),
        ];
        let result = git_raw(root, &args, &[], None).await;
        let _ = tokio::fs::remove_file(&spec_file).await;
        result.context("git reset -q <commit> --pathspec-from-file failed to sync the real index")?;
        Ok(safe.len())
    })
    .await
}

fn pending_marker_path(git_dir: &Path) -> PathBuf {
    git_dir.join(PENDING_MARKER_NAME)
}

async fn write_pending_marker(
    git_dir: &Path,
    head_ref: Option<&str>,
    new_sha: &str,
    parent_sha: Option<&str>,
) -> Result<()> {
    let json = serde_json::json!({
        "version": PENDING_MARKER_VERSION,
        "ref": head_ref,
        "new": new_sha,
        "parent": parent_sha,
    });
    tokio::fs::write(pending_marker_path(git_dir), json.to_string()).await?;
    Ok(())
}

struct PendingMarker {
    new: String,
    parent: Option<String>,
    /// `None` = legacy (v1) marker without a ref; `Some(None)` = detached.
    head_ref: Option<Option<String>>,
}

fn is_oid(s: &str) -> bool {
    (s.len() == 40 || s.len() == 64) && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Validate a marker's JSON; `None` if unusable.
fn parse_marker(raw: &str) -> Option<PendingMarker> {
    let v: serde_json::Value = serde_json::from_str(raw).ok()?;
    let obj = v.as_object()?;
    let new = obj.get("new")?.as_str().filter(|s| is_oid(s))?.to_string();
    let parent = match obj.get("parent") {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(s)) if is_oid(s) => Some(s.clone()),
        Some(_) => return None,
    };
    let head_ref = match obj.get("ref") {
        None => None,
        Some(serde_json::Value::Null) => Some(None),
        Some(serde_json::Value::String(s)) if s.starts_with("refs/") => Some(Some(s.clone())),
        Some(_) => return None,
    };
    Some(PendingMarker { new, parent, head_ref })
}

/// Step 0 of every tick. See the module docs. `None` if there was no marker.
async fn recover_pending_sync(root: &Path, git_dir: &Path) -> Option<RecoveryOutcome> {
    let marker_path = pending_marker_path(git_dir);
    let raw = match tokio::fs::read(&marker_path).await {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => {
            return Some(RecoveryOutcome {
                synced: false,
                new_sha: None,
                dropped: None,
                error: Some(format!("cannot read pending marker: {e}")),
            })
        }
    };
    let Some(marker) = parse_marker(&raw) else {
        let _ = tokio::fs::remove_file(&marker_path).await;
        return Some(RecoveryOutcome {
            synced: false,
            new_sha: None,
            dropped: Some("corrupt pending marker".into()),
            error: None,
        });
    };

    let checked = async {
        let head = resolve_head(root).await?;
        let head_ref = resolve_symbolic_head(root).await?;
        Ok::<_, anyhow::Error>((head, head_ref))
    }
    .await;
    let (head, head_ref) = match checked {
        Ok(v) => v,
        Err(e) => {
            return Some(RecoveryOutcome {
                synced: false,
                new_sha: Some(marker.new),
                dropped: None,
                error: Some(format!("{e:#}")),
            })
        }
    };
    // Legacy (v1) markers carry no ref: only the HEAD check applies.
    let ref_ok = match &marker.head_ref {
        None => true,
        Some(r) => *r == head_ref,
    };
    if head.as_deref() != Some(marker.new.as_str()) || !ref_ok {
        let _ = tokio::fs::remove_file(&marker_path).await;
        let on = match &marker.head_ref {
            Some(r) => format!(" on {}", r.as_deref().unwrap_or("(detached)")),
            None => String::new(),
        };
        return Some(RecoveryOutcome {
            synced: false,
            new_sha: Some(marker.new.clone()),
            dropped: Some(format!("HEAD is no longer {}{on}; index left untouched", marker.new)),
            error: None,
        });
    }

    let result = async {
        let parent_entries = tree_entries(root, marker.parent.as_deref()).await?;
        let new_entries = tree_entries(root, Some(&marker.new)).await?;
        let paths = differing_paths(&parent_entries, &new_entries);
        sync_real_index(root, git_dir, &marker.new, &parent_entries, &paths).await
    }
    .await;

    match result {
        Ok(_) => {
            let _ = tokio::fs::remove_file(&marker_path).await;
            Some(RecoveryOutcome { synced: true, new_sha: Some(marker.new), dropped: None, error: None })
        }
        Err(e) => Some(RecoveryOutcome {
            synced: false,
            new_sha: Some(marker.new),
            dropped: None,
            error: Some(format!("{e:#}")),
        }),
    }
}

/// One commit attempt. Errors are explicit (locked index, CAS race, not a
/// repo, etc.) and never silently swallowed into `Ok(NoOp)`. A committed-
/// but-sync-pending result is `Ok`, not `Err` — HEAD has already moved and
/// this is not a failed commit.
pub async fn try_commit(root: &Path, bus: &Arc<EventBus>) -> Result<AutocommitOutcome> {
    match run_autocommit_report(root).await {
        Ok(report) => {
            if let Some(r) = &report.recovered {
                if let Some(reason) = &r.dropped {
                    warn!("git_autocommit: dropped pending index sync marker: {reason}");
                    bus.publish(Envelope::log(
                        "warn",
                        "git_autocommit",
                        format!("dropped stale pending index sync marker: {reason}"),
                    ));
                } else if r.synced {
                    info!("git_autocommit: recovered pending index sync");
                }
            }
            if !report.skipped.is_empty() {
                debug!(
                    "git_autocommit: skipped vault paths (user-staged/flagged/secret): {}",
                    report.skipped.join(", ")
                );
            }
            match report.outcome {
                AutocommitOutcome::Committed => {
                    info!("git_autocommit: committed vault/");
                    bus.publish(Envelope::log(
                        "info",
                        "git_autocommit",
                        "committed vault/ via isolated index",
                    ));
                }
                AutocommitOutcome::CommittedIndexSyncPending => {
                    info!("git_autocommit: committed vault/ but index sync is pending");
                    bus.publish(Envelope::log(
                        "warn",
                        "git_autocommit",
                        "committed vault/ but real-index sync is pending; will retry next tick",
                    ));
                }
                AutocommitOutcome::NoOp => {}
            }
            Ok(report.outcome)
        }
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

/// Core algorithm (outcome only). See [`run_autocommit_report`].
#[allow(dead_code)] // used by tests; the app goes through try_commit
async fn run_autocommit(root: &Path) -> Result<AutocommitOutcome> {
    Ok(run_autocommit_report(root).await?.outcome)
}

/// Core algorithm, free of `EventBus` so it's directly unit-testable against
/// real temporary git repos. See module docs for the full transaction.
pub(crate) async fn run_autocommit_report(root: &Path) -> Result<AutocommitReport> {
    let vault = root.join("vault");
    if !vault.exists() {
        return Ok(AutocommitReport { outcome: AutocommitOutcome::NoOp, skipped: Vec::new(), recovered: None });
    }

    let git_dir = resolve_git_dir(root).await.context("not a git repository")?;

    // Step 0: finish (or safely discard) an interrupted sync first.
    let recovered = recover_pending_sync(root, &git_dir).await;
    if let Some(r) = &recovered {
        if !r.synced && r.dropped.is_none() {
            bail!(
                "pending index sync for {} still unresolved ({}); skipping autocommit",
                r.new_sha.as_deref().unwrap_or("?"),
                r.error.as_deref().unwrap_or("unknown error")
            );
        }
    }

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
    let head_ref = resolve_symbolic_head(root).await?;

    let temp_index =
        git_dir.join(format!("skippy-autocommit-index-{}", uuid::Uuid::new_v4()));
    // Always clean up the temp index file, whatever the outcome.
    let result = run_autocommit_inner(root, &git_dir, &temp_index, head.as_deref(), head_ref.as_deref()).await;
    let _ = tokio::fs::remove_file(&temp_index).await;
    let (outcome, skipped) = result?;
    Ok(AutocommitReport { outcome, skipped, recovered })
}

async fn run_autocommit_inner(
    root: &Path,
    git_dir: &Path,
    temp_index: &Path,
    head: Option<&str>,
    head_ref: Option<&str>,
) -> Result<(AutocommitOutcome, Vec<String>)> {
    let env = [("GIT_INDEX_FILE", temp_index.as_os_str())];

    let head_entries = tree_entries(root, head).await?;
    let snapshot = real_index_snapshot(root).await?;
    let owned = user_owned_paths(&snapshot, &head_entries);

    if let Some(head) = head {
        git(root, &["read-tree", head], &env)
            .await
            .context("git read-tree HEAD into temp index failed")?;
    }
    // -A so deletions are captured; .gitignore respected; vault/ only.
    git(root, &["add", "-A", "--", VAULT_PATHSPEC], &env)
        .await
        .context("git add -A -- vault into temp index failed")?;
    let preliminary_tree = git(root, &["write-tree"], &env)
        .await
        .context("git write-tree from temp index failed")?;
    let prelim_entries = tree_entries(root, Some(&preliminary_tree)).await?;
    let all_changed = differing_paths(&head_entries, &prelim_entries);

    let flagged_hits: Vec<BPath> = all_changed.iter().filter(|p| snapshot.flagged.contains(*p)).cloned().collect();
    let owned_hits: Vec<BPath> = all_changed
        .iter()
        .filter(|p| !snapshot.flagged.contains(*p) && owned.contains(*p))
        .cloned()
        .collect();
    let candidates: Vec<BPath> = all_changed
        .iter()
        .filter(|p| !snapshot.flagged.contains(*p) && !owned.contains(*p))
        .cloned()
        .collect();
    let name_hits: Vec<BPath> = candidates.iter().filter(|p| matches_secret_filename(p)).cloned().collect();
    let blob_of = |p: &BPath| -> Option<String> {
        let entry = prelim_entries.get(p)?;
        let (mode, oid) = entry.split_once(' ')?;
        (mode != "160000").then(|| oid.to_string()) // gitlinks have no content here
    };
    let to_scan: Vec<(BPath, String)> = candidates
        .iter()
        .filter(|p| !name_hits.contains(p))
        .filter_map(|p| blob_of(p).map(|oid| (p.clone(), oid)))
        .collect();
    let hit_oids =
        scan_blobs_for_secrets(root, &to_scan.iter().map(|(_, o)| o.clone()).collect::<Vec<_>>()).await?;
    let content_hits: Vec<BPath> = to_scan
        .iter()
        .filter(|(_, oid)| hit_oids.contains(oid))
        .map(|(p, _)| p.clone())
        .collect();

    let mut excluded: Vec<BPath> = flagged_hits;
    excluded.extend(owned_hits);
    excluded.extend(name_hits);
    excluded.extend(content_hits);
    let excluded_set: BTreeSet<&BPath> = excluded.iter().collect();
    let commit_paths: Vec<BPath> = all_changed.iter().filter(|p| !excluded_set.contains(p)).cloned().collect();
    let skipped: Vec<String> = excluded.iter().map(|p| display_path(p)).collect();

    if commit_paths.is_empty() {
        return Ok((AutocommitOutcome::NoOp, skipped));
    }

    let tree = if excluded.is_empty() {
        preliminary_tree
    } else {
        let zero = "0".repeat(preliminary_tree.len());
        let mut info: Vec<u8> = Vec::new();
        for p in &excluded {
            match head_entries.get(p) {
                Some(entry) => info.extend_from_slice(entry.as_bytes()),
                None => info.extend_from_slice(format!("0 {zero}").as_bytes()),
            }
            info.push(b'\t');
            info.extend_from_slice(p);
            info.push(0);
        }
        git_raw(root, &["update-index", "-z", "--index-info"], &env, Some(&info))
            .await
            .context("git update-index --index-info failed while restoring excluded vault paths")?;
        git(root, &["write-tree"], &env)
            .await
            .context("git write-tree (post-exclusion) from temp index failed")?
    };
    let head_tree = match head {
        Some(h) => git(root, &["rev-parse", &format!("{h}^{{tree}}")], &[]).await?,
        None => EMPTY_TREE.to_string(),
    };
    if tree == head_tree {
        return Ok((AutocommitOutcome::NoOp, skipped));
    }

    let stamp = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let message = format!("chore(vault): auto-commit {stamp}");

    let new_commit = commit_and_advance_head(root, &tree, head, &message).await?;

    match sync_real_index(root, git_dir, &new_commit, &head_entries, &commit_paths).await {
        Ok(_) => Ok((AutocommitOutcome::Committed, skipped)),
        Err(e) => {
            // HEAD already advanced — this is NOT a failed commit.
            debug!("git_autocommit: real-index sync failed: {e:#}");
            write_pending_marker(git_dir, head_ref, &new_commit, head).await?;
            Ok((AutocommitOutcome::CommittedIndexSyncPending, skipped))
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
        let env = [("GIT_INDEX_FILE", temp_index.as_os_str())];
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
        write_pending_marker(&git_dir, Some("refs/heads/main"), &new_sha, Some(&parent_sha)).await.unwrap();

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

    // --- E5-8: shared secret list self-test (same vectors as the Node suite).

    fn utf16(s: &str, big_endian: bool, bom: bool) -> Vec<u8> {
        let mut v = Vec::new();
        if bom {
            v.extend_from_slice(if big_endian { &[0xfe, 0xff] } else { &[0xff, 0xfe] });
        }
        for u in s.encode_utf16() {
            v.extend_from_slice(&if big_endian { u.to_be_bytes() } else { u.to_le_bytes() });
        }
        v
    }

    #[test]
    fn shared_secret_patterns_pass_their_self_test_vectors() {
        let v: serde_json::Value = serde_json::from_str(SECRET_PATTERNS_JSON).unwrap();
        let list = |k: &str| -> Vec<String> {
            v["selfTest"][k].as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_string()).collect()
        };
        for s in list("filenameHits") {
            assert!(matches_secret_filename(s.as_bytes()), "filename should be a secret: {s}");
        }
        for s in list("filenameMisses") {
            assert!(!matches_secret_filename(s.as_bytes()), "filename false positive: {s}");
        }
        for s in list("contentHits") {
            assert!(matches_secret_content(s.as_bytes()), "content should be a secret: {s}");
            for (be, bom) in [(false, true), (false, false), (true, true), (true, false)] {
                assert!(matches_secret_content(&utf16(&s, be, bom)), "UTF-16 (be={be}, bom={bom}) content missed: {s}");
            }
        }
        for s in list("contentMisses") {
            assert!(!matches_secret_content(s.as_bytes()), "content false positive: {s}");
            assert!(!matches_secret_content(&utf16(&s, false, true)), "UTF-16 content false positive: {s}");
        }
    }
}

/// Round-3 red-team regressions (E5-1 .. E5-9). Self-contained on purpose:
/// it only uses `run_autocommit` / `AutocommitOutcome` plus the git CLI, so
/// the exact same module also compiles against the pre-fix implementation
/// (baseline verification that every case fails there).
#[cfg(test)]
mod e5_regression_tests {
    use super::{run_autocommit, AutocommitOutcome};
    use std::path::{Path, PathBuf};
    use std::process::Command;

    const CAFE: &str = "vault/caf\u{e9}.md";
    const RESUME: &str = "vault/r\u{e9}sum\u{e9}.md";
    const UBER: &str = "vault/\u{fc}ber.md";
    const KANJI: &str = "vault/\u{79c1}.md";

    struct Repo {
        dir: PathBuf,
    }

    impl Repo {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("skippy-e5-{name}-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            let r = Self { dir };
            r.ok(&["init", "-q", "-b", "main"]);
            r.ok(&["config", "user.name", "Skippy Test"]);
            r.ok(&["config", "user.email", "skippy-test@example.invalid"]);
            r.ok(&["config", "commit.gpgsign", "false"]);
            r.ok(&["config", "core.hooksPath", ".no-hooks"]);
            r
        }

        fn path(&self) -> &Path {
            &self.dir
        }

        fn run(&self, args: &[&str]) -> std::process::Output {
            Command::new("git")
                .arg("-C")
                .arg(&self.dir)
                .args(["-c", "core.quotepath=false"])
                .args(args)
                .output()
                .expect("git spawn")
        }

        fn ok(&self, args: &[&str]) -> String {
            let out = self.run(args);
            assert!(out.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&out.stderr));
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        }

        fn write(&self, rel: &str, contents: impl AsRef<[u8]>) {
            let p = self.dir.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, contents).unwrap();
        }

        fn remove(&self, rel: &str) {
            std::fs::remove_file(self.dir.join(rel)).unwrap();
        }

        fn commit_all(&self, msg: &str) {
            self.ok(&["add", "-A", "."]);
            self.ok(&["commit", "-q", "-m", msg]);
        }

        fn head_tree(&self) -> Vec<String> {
            let out = self.run(&["ls-tree", "-r", "-z", "--name-only", "HEAD"]);
            String::from_utf8_lossy(&out.stdout)
                .split('\0')
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect()
        }

        fn show(&self, spec: &str) -> String {
            self.ok(&["show", spec])
        }

        fn status(&self) -> String {
            self.ok(&["status", "--porcelain", "-uno"])
        }

        fn marker(&self) -> PathBuf {
            self.dir.join(".git").join("skippy-autocommit-pending")
        }

        fn lock(&self) -> PathBuf {
            self.dir.join(".git").join("index.lock")
        }

        /// A reference-transaction hook that grabs the index lock right after
        /// our update-ref lands, so the real-index sync fails (pending-sync).
        fn arm_lock_after_ref_update(&self) {
            let hooks = self.dir.join(".hooks");
            std::fs::create_dir_all(&hooks).unwrap();
            let lock = self.lock().to_string_lossy().replace('\\', "/");
            let hook = hooks.join("reference-transaction");
            std::fs::write(
                &hook,
                format!("#!/bin/sh\ncat >/dev/null\nif [ \"$1\" = \"committed\" ]; then : > \"{lock}\"\nfi\nexit 0\n"),
            )
            .unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
            self.ok(&["config", "core.hooksPath", ".hooks"]);
        }

        fn disarm(&self) {
            self.ok(&["config", "core.hooksPath", ".no-hooks"]);
            let _ = std::fs::remove_file(self.lock());
        }

        /// Seed `vault/n.md` = v1 plus `a`, then autocommit a v2 edit whose
        /// real-index sync fails (marker left behind), then disarm.
        async fn pending_commit_of(&self, path: &str, v2: &str) {
            self.write(path, "v1\n");
            self.write("a", "a\n");
            self.commit_all("init");
            self.arm_lock_after_ref_update();
            self.write(path, v2);
            let outcome = run_autocommit(self.path()).await.expect("autocommit ok");
            assert_eq!(outcome, AutocommitOutcome::CommittedIndexSyncPending);
            assert!(self.marker().exists(), "pending marker must be written");
            self.disarm();
        }
    }

    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn utf16le_with_bom(s: &str) -> Vec<u8> {
        let mut v = vec![0xff, 0xfe];
        for u in s.encode_utf16() {
            v.extend_from_slice(&u.to_le_bytes());
        }
        v
    }

    fn utf16be_no_bom(s: &str) -> Vec<u8> {
        s.encode_utf16().flat_map(|u| u.to_be_bytes()).collect()
    }

    // --- E5-1: non-ASCII paths must not bypass any exclusion. -------------

    #[tokio::test]
    async fn e5_1_non_ascii_path_with_secret_content_is_not_committed() {
        let r = Repo::new("na-secret");
        r.write("a", "a\n");
        r.commit_all("init");
        r.write(CAFE, "my aws key AKIAABCDEFGHIJKLMNOP\n");
        r.write("vault/n.md", "x\n");
        assert_eq!(run_autocommit(r.path()).await.unwrap(), AutocommitOutcome::Committed);
        let tree = r.head_tree();
        assert!(tree.contains(&"vault/n.md".to_string()));
        assert!(!tree.contains(&CAFE.to_string()), "AKIA key in a non-ASCII path was committed: {tree:?}");
    }

    #[tokio::test]
    async fn e5_1_non_ascii_skip_worktree_path_is_not_committed_as_deleted_and_keeps_its_flag() {
        let r = Repo::new("na-skipwt");
        r.write("vault/keep.md", "k\n");
        r.write(RESUME, "s\n");
        r.commit_all("init");
        r.ok(&["update-index", "--skip-worktree", "--", RESUME]);
        r.remove(RESUME);
        r.write("vault/keep.md", "k2\n");
        assert_eq!(run_autocommit(r.path()).await.unwrap(), AutocommitOutcome::Committed);
        assert!(r.head_tree().contains(&RESUME.to_string()), "skip-worktree file committed as deleted");
        let flag = r.ok(&["ls-files", "-v", "--", RESUME]);
        assert!(flag.starts_with("S "), "skip-worktree flag lost: {flag}");
    }

    #[tokio::test]
    async fn e5_1_non_ascii_assume_unchanged_edit_is_not_committed_and_keeps_its_flag() {
        let r = Repo::new("na-au");
        r.write(KANJI, "orig\n");
        r.write("vault/n.md", "x\n");
        r.commit_all("init");
        r.ok(&["update-index", "--assume-unchanged", "--", KANJI]);
        r.write(KANJI, "LOCAL PRIVATE EDIT\n");
        r.write("vault/n.md", "y\n");
        assert_eq!(run_autocommit(r.path()).await.unwrap(), AutocommitOutcome::Committed);
        assert_eq!(r.show(&format!("HEAD:{KANJI}")), "orig");
        let flag = r.ok(&["ls-files", "-v", "--", KANJI]);
        assert!(flag.starts_with("h "), "assume-unchanged flag lost: {flag}");
    }

    #[tokio::test]
    async fn e5_1_non_ascii_partially_staged_path_is_left_alone() {
        let r = Repo::new("na-partial");
        r.write(UBER, "v1\n");
        r.commit_all("init");
        r.write(UBER, "STAGED\n");
        r.ok(&["add", "--", UBER]);
        r.write(UBER, "WORKTREE\n");
        let _ = run_autocommit(r.path()).await;
        assert_eq!(r.show(&format!("HEAD:{UBER}")), "v1");
        assert_eq!(r.show(&format!(":{UBER}")), "STAGED", "user's staged blob was lost");
    }

    #[tokio::test]
    async fn e5_1_non_ascii_pending_sync_recovery_really_syncs_the_index() {
        let r = Repo::new("na-pending");
        r.pending_commit_of(CAFE, "v2\n").await;
        run_autocommit(r.path()).await.expect("recovery tick ok");
        assert!(!r.marker().exists(), "marker must be cleared after recovery");
        assert_eq!(r.status(), "", "index must match HEAD after recovery");
        r.write("a", "user\n");
        r.ok(&["add", "a"]);
        r.ok(&["commit", "-q", "-m", "user"]);
        assert_eq!(r.show(&format!("HEAD:{CAFE}")), "v2", "user's next commit reverted the vault change");
    }

    // --- E5-2: a stale pending marker must never re-stage anything. -------

    #[tokio::test]
    async fn e5_2_marker_is_dropped_after_reset_hard_without_touching_the_index() {
        let r = Repo::new("stale-reset");
        r.pending_commit_of("vault/n.md", "v2 DISCARD ME\n").await;
        r.ok(&["reset", "-q", "--hard", "HEAD~1"]);
        run_autocommit(r.path()).await.expect("tick ok");
        assert!(!r.marker().exists(), "stale marker must be dropped");
        assert_eq!(r.status(), "");
        assert_eq!(r.show(":vault/n.md"), "v1", "discarded content was re-staged");
    }

    #[tokio::test]
    async fn e5_2_marker_is_dropped_after_switching_branches() {
        let r = Repo::new("stale-branch");
        // `other` holds the same vault blob as the autocommit's parent, so a
        // marker that isn't validated against HEAD would look "safe" there.
        r.write("vault/n.md", "v1\n");
        r.commit_all("pre");
        r.ok(&["branch", "other"]);
        r.pending_commit_of("vault/n.md", "v2 main-only\n").await;
        r.ok(&["checkout", "-q", "-f", "other"]);
        run_autocommit(r.path()).await.expect("tick ok");
        assert!(!r.marker().exists(), "stale marker must be dropped");
        assert_eq!(r.status(), "", "main's vault change was staged into other's index");
        assert_eq!(r.ok(&["rev-list", "--count", "other"]), "1");
    }

    // --- E5-3: secret-named paths the user staged keep their staged blob. --

    #[tokio::test]
    async fn e5_3_user_staged_edit_to_a_secret_named_path_is_preserved() {
        let r = Repo::new("env-staged");
        r.write("vault/.env", "OLD=1\n");
        r.write("vault/n.md", "x\n");
        r.commit_all("init");
        r.write("vault/.env", "NEW=2\n");
        r.ok(&["add", "vault/.env"]);
        r.write("vault/n.md", "y\n");
        assert_eq!(run_autocommit(r.path()).await.unwrap(), AutocommitOutcome::Committed);
        assert_eq!(r.show("HEAD:vault/.env"), "OLD=1");
        assert_eq!(r.show("HEAD:vault/n.md"), "y");
        assert_eq!(r.show(":vault/.env"), "NEW=2", "user's staged .env edit was wiped");
    }

    // --- E5-4: paths are literal, never pathspec magic. -------------------

    #[tokio::test]
    async fn e5_4_glob_like_vault_path_is_matched_literally() {
        let r = Repo::new("glob");
        r.write("vault/a.md", "a1\n");
        r.write("vault/[ab].md", "x1\n");
        r.commit_all("init");
        r.write("vault/[ab].md", "x2\n");
        r.ok(&["add", "--", ":(literal)vault/[ab].md"]);
        r.write("vault/[ab].md", "x3\n");
        r.write("vault/a.md", "a2\n");
        assert_eq!(run_autocommit(r.path()).await.unwrap(), AutocommitOutcome::Committed);
        assert_eq!(r.show("HEAD:vault/a.md"), "a2");
        assert_eq!(r.show(":vault/a.md"), "a2", "index lags HEAD; the user's next commit would revert");
        assert_eq!(r.show(":vault/[ab].md"), "x2", "user's staged blob was lost");
    }

    // --- E5-5: no per-path command-line arguments. ------------------------

    #[tokio::test]
    async fn e5_5_many_skip_worktree_paths_do_not_overflow_the_command_line() {
        let r = Repo::new("many");
        for i in 0..1200 {
            r.write(&format!("vault/archive/some-long-archived-note-name-number-{i:05}.md"), format!("n{i}\n"));
        }
        r.write("vault/live.md", "l\n");
        r.commit_all("init");
        r.ok(&["sparse-checkout", "set", "--no-cone", "/vault/live.md"]);
        r.write("vault/live.md", "l2\n");
        assert_eq!(run_autocommit(r.path()).await.unwrap(), AutocommitOutcome::Committed);
        assert!(!r.marker().exists());
        assert_eq!(r.show("HEAD:vault/live.md"), "l2");
        assert_eq!(r.show(":vault/live.md"), "l2");
        assert_eq!(r.head_tree().len(), 1201, "sparse (skip-worktree) files were committed as deleted");
        let flag = r.ok(&["ls-files", "-v", "--", "vault/archive/some-long-archived-note-name-number-00007.md"]);
        assert!(flag.starts_with("S "), "skip-worktree flag lost: {flag}");
    }

    // --- E5-6 / E5-7: user-staged vault paths are user-owned. -------------

    #[tokio::test]
    async fn e5_6_rm_cached_vault_path_stays_staged_for_removal() {
        let r = Repo::new("rm-cached");
        r.write("vault/x.md", "x\n");
        r.write("vault/n.md", "n\n");
        r.commit_all("init");
        r.ok(&["rm", "-q", "--cached", "vault/x.md"]);
        r.write("vault/n.md", "n2\n");
        assert_eq!(run_autocommit(r.path()).await.unwrap(), AutocommitOutcome::Committed);
        assert_eq!(r.show("HEAD:vault/n.md"), "n2");
        assert!(r.head_tree().contains(&"vault/x.md".to_string()));
        let status = r.status();
        assert!(status.lines().any(|l| l == "D  vault/x.md"), "staged rm --cached was undone: {status}");
    }

    #[tokio::test]
    async fn e5_6_intent_to_add_and_fully_staged_vault_paths_are_user_owned() {
        let r = Repo::new("ita");
        r.write("vault/m.md", "m1\n");
        r.write("vault/o.md", "o1\n");
        r.commit_all("init");
        r.write("vault/new.md", "n\n");
        r.ok(&["add", "-N", "vault/new.md"]);
        r.write("vault/m.md", "m2 staged\n");
        r.ok(&["add", "vault/m.md"]);
        r.write("vault/o.md", "o2\n");
        assert_eq!(run_autocommit(r.path()).await.unwrap(), AutocommitOutcome::Committed);
        assert_eq!(r.show("HEAD:vault/o.md"), "o2");
        assert_eq!(r.show("HEAD:vault/m.md"), "m1");
        assert!(!r.head_tree().contains(&"vault/new.md".to_string()));
        let status = r.status();
        assert!(status.lines().any(|l| l == "M  vault/m.md"), "{status}");
        assert!(status.lines().any(|l| l == " A vault/new.md"), "intent-to-add lost: {status}");
    }

    #[tokio::test]
    async fn e5_7_staged_rename_with_unstaged_edit_is_left_alone() {
        let r = Repo::new("rename");
        r.write("vault/a.md", "line1\nline2\nline3\nline4\nline5\n");
        r.commit_all("init");
        r.ok(&["mv", "vault/a.md", "vault/b.md"]);
        r.write("vault/b.md", "line1\nline2\nline3\nline4\nline5\nline6 unstaged\n");
        let before = r.status();
        assert_eq!(run_autocommit(r.path()).await.unwrap(), AutocommitOutcome::NoOp);
        assert_eq!(r.head_tree(), vec!["vault/a.md".to_string()], "half of the rename was committed");
        assert_eq!(r.status(), before, "the user's staged rename changed");
    }

    // --- E5-8: secret guard gaps and false positives. ---------------------

    #[tokio::test]
    async fn e5_8_secret_filenames_match_case_insensitively() {
        let r = Repo::new("case");
        r.write("a", "a\n");
        r.commit_all("init");
        r.write("vault/.ENV", "API_KEY=plain-no-marker\n");
        r.write("vault/ID_RSA", "not a pem header\n");
        r.write("vault/server.PEM", "x\n");
        r.write("vault/Prod.Key", "x\n");
        r.write("vault/n.md", "x\n");
        assert_eq!(run_autocommit(r.path()).await.unwrap(), AutocommitOutcome::Committed);
        assert_eq!(r.head_tree(), vec!["a".to_string(), "vault/n.md".to_string()]);
    }

    #[tokio::test]
    async fn e5_8_env_lookalike_and_secrets_notes_are_not_false_positives() {
        let r = Repo::new("false-pos");
        r.write("a", "a\n");
        r.commit_all("init");
        r.write("vault/sub/.env.local", "K=1\n");
        r.write("vault/.envelope.md", "# Envelope design note\n");
        r.write("vault/secrets.md", "# Secrets of the Magnificent (a normal note)\n");
        assert_eq!(run_autocommit(r.path()).await.unwrap(), AutocommitOutcome::Committed);
        let tree = r.head_tree();
        assert!(!tree.contains(&"vault/sub/.env.local".to_string()));
        assert!(tree.contains(&"vault/.envelope.md".to_string()), "{tree:?}");
        assert!(tree.contains(&"vault/secrets.md".to_string()), "{tree:?}");
        assert_eq!(r.status(), "", "false-positive notes must be committed and synced");
    }

    #[tokio::test]
    async fn e5_8_content_scan_catches_pgp_utf16_openai_and_aws_secret_keys() {
        let r = Repo::new("content-gaps");
        r.write("a", "a\n");
        r.commit_all("init");
        r.write("vault/key.asc", "-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBF\n-----END PGP PRIVATE KEY BLOCK-----\n");
        r.write("vault/utf16le.md", utf16le_with_bom("aws AKIAABCDEFGHIJKLMNOP\n"));
        r.write("vault/utf16be.md", utf16be_no_bom("aws AKIAABCDEFGHIJKLMNOP\n"));
        let mut bin = vec![0u8, 1, 2, 0xff, 0];
        bin.extend_from_slice(b"AKIAABCDEFGHIJKLMNOP");
        bin.extend_from_slice(&[0, 0xfe]);
        r.write("vault/blob.bin", bin);
        r.write("vault/.aws/credentials", "[default]\naws_secret_access_key = wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY\n");
        r.write("vault/openai.md", "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789\n");
        r.write("vault/n.md", "x\n");
        assert_eq!(run_autocommit(r.path()).await.unwrap(), AutocommitOutcome::Committed);
        assert_eq!(r.head_tree(), vec!["a".to_string(), "vault/n.md".to_string()]);
    }

    // --- E5-9: documented pending window heals on the next tick. ----------

    #[tokio::test]
    async fn e5_9_user_commit_inside_the_pending_window_is_healed_next_tick() {
        let r = Repo::new("window");
        r.pending_commit_of("vault/n.md", "v2\n").await;
        r.write("a", "user\n");
        r.ok(&["add", "a"]);
        r.ok(&["commit", "-q", "-m", "user commit before next tick"]);
        // Known window: the user's commit recorded the parent blob.
        assert_eq!(r.show("HEAD:vault/n.md"), "v1");
        assert_eq!(run_autocommit(r.path()).await.unwrap(), AutocommitOutcome::Committed);
        assert!(!r.marker().exists());
        assert_eq!(r.show("HEAD:vault/n.md"), "v2", "next tick must re-commit the vault change");
        assert_eq!(r.status(), "");
    }
}
