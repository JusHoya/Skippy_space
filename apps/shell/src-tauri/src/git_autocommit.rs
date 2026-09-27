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
//!    validate it first (E5-2, D5): recover only if its version is known
//!    (absent/1 = legacy without `ref`, 2 = current, which must carry `ref`),
//!    HEAD is still symbolically on `ref` and resolves to exactly `new`, `new`
//!    exists as a commit, and `parent` is `new`'s first parent (null <=> `new`
//!    is a root commit) and exists as a commit. Otherwise (reset --hard,
//!    checkout of another branch, a user commit on top, a corrupt/unknown/
//!    forged marker) drop it WITHOUT touching the index and report it as
//!    dropped — a bad marker never wedges the tick. If recovery is attempted
//!    and fails (e.g. a held `index.lock`), the tick stops with an explicit
//!    error rather than stacking a commit on an unsynced index. See
//!    [`recover_pending_sync`].
//! 1. Resolve `HEAD` (or note it's unborn) and the symbolic ref it names.
//! 2. Fail fast, without touching anything, if `<git-dir>/index.lock`
//!    already exists (someone else holds the real index lock).
//! 3. Snapshot the real index's vault entries (`ls-files -s -v -z`) and
//!    HEAD's (`ls-tree -r -z`). A vault path is USER-OWNED (E5-6/E5-7) if
//!    its real-index entry differs from HEAD in any way: staged add/modify/
//!    delete, `rm --cached`, either side of a rename or copy, intent-to-add,
//!    or unmerged. Skip-worktree / assume-unchanged paths are FLAGGED.
//!    Neither is ever committed or re-synced.
//! 4. Seed a throwaway index (`GIT_INDEX_FILE=<tmp> git read-tree HEAD`; a
//!    copy of it is kept as the SEED index), snapshot every attribute source
//!    (A1, below), then `add -A -- vault` into the throwaway index and
//!    `write-tree` -> preliminary tree. The candidate list is every vault
//!    path whose (mode, oid) differs between HEAD and that tree. In a sparse
//!    checkout `add` refuses (and fails on) out-of-cone paths; if it fails
//!    while `core.sparseCheckout` is on, the throwaway index is reset to the
//!    seed and the add is redone with `--sparse`, so a sparse checkout never
//!    fails every tick (out-of-cone paths are then flagged, step 5). The
//!    throwaway index lives in a fresh private directory in the OS temp dir
//!    (`<tmp>/skippy-ac-<16 hex>/`, D1) — never under the git dir, so a long
//!    repo/worktree path can't push `<index>.lock` past MAX_PATH — and the
//!    directory (with any `.lock`) is removed in every case. It only ever
//!    holds index files and pathspec lists (paths + object ids), never vault
//!    file content. Every tick first sweeps `<tmp>/skippy-ac-<16 hex>`
//!    directories older than one hour (left by a killed tick; exact name
//!    match, real directories only, never through a symlink/junction, best
//!    effort): [`sweep_stale_temp_dirs`].
//! 5. Exclusions, each restored to its HEAD state in the temp index (or
//!    removed if HEAD lacks it) with ONE `update-index -z --index-info`. Each
//!    excluded path gets exactly one [`SkipReason`] (first match wins):
//!      * `flagged` — skip-worktree / assume-unchanged (step 3), or — when
//!        `core.sparseCheckout` is on — outside the sparse-checkout
//!        definition (`sparse-checkout check-rules`; no loadable patterns =
//!        inside, as git itself treats it);
//!      * `user-staged` — user-owned (step 3);
//!      * `gitlink` — a new or changed mode-160000 entry on either side
//!        (nested repo, submodule pointer bump, D4); gitlinks already in
//!        HEAD are left exactly as they are;
//!      * `secret-filename` — shared filename rules;
//!      * `attributes-changed` — an attribute source changed during the tick
//!        (A1 != A2, below): EVERY remaining candidate is deferred to the
//!        next tick;
//!      * `filtered-path` — the path has a `filter` attribute (any value:
//!        `lfs`, a custom driver, even an unconfigured one) in EITHER
//!        evaluation — `check-attr` against the seed index (the pre-add
//!        attribute state; the working-tree side is pinned by A1 == A2) or
//!        against the post-add temp index. The vault is Markdown and needs no
//!        clean filter; a filter can turn any content into bytes the blob
//!        scan cannot judge (an LFS pointer, rot13), so filtered paths are
//!        never autocommitted (OQ-19);
//!      * `too-large-to-scan` — blob larger than `limits.maxScanBytes`
//!        (64 MiB, D3), never read, fail closed;
//!      * `lfs-pointer` — the blob holds a git-lfs pointer version line
//!        (shared `lfsPointer.versionLines`, all v1 spec aliases git-lfs 3.x
//!        accepts, matched anywhere in the blob: a superset of what git-lfs
//!        decodes as a pointer), whatever the attributes say. `git push`
//!        uploads the object a committed pointer names, so a pointer to a
//!        secret an earlier tick excluded (but whose `add` already stored it
//!        under `.git/lfs/objects`) must never reach history;
//!      * `secret-content` — shared content rules hit the exact blob the
//!        commit would contain (`cat-file --batch`, fetched in batches of at
//!        most `maxScanBytes`; one char per byte and again with NULs stripped
//!        for UTF-16).
//!
//!    With filtered paths refused, every committed blob is exactly the
//!    scanned blob: the scan needs no proof step. Mode-120000 entries are
//!    scanned the same way (`core.symlinks=false`: the blob IS the file's
//!    bytes; a real symlink: the blob is the link target). eol/autocrlf,
//!    `working-tree-encoding` and `ident` stay exactly as git applies them:
//!    they are fixed, public transforms (CR/LF, re-encoding of the same
//!    characters, the blob's own id) that cannot turn a clean blob into a
//!    secret on checkout, and the blob they produce is what gets scanned.
//!
//!    Attribute snapshots A1 (before the add) and A2 (after the scans and
//!    both `check-attr` runs) cover every source git reads: the in-tree
//!    `.gitattributes` at the repo root and anywhere under `vault/` (walked
//!    without following links; nested repositories skipped),
//!    `$GIT_COMMON_DIR/info/attributes`, the global file (`git var
//!    GIT_ATTR_GLOBAL`: `core.attributesFile` or the XDG default) and the
//!    system file (`git var GIT_ATTR_SYSTEM`), each recorded as its path plus
//!    its full content (or absent / a link / unreadable). Only a flip AND
//!    flip-back entirely inside the window between two observations can go
//!    unseen (see OQ-19); a flip that is still in place at A2 defers the
//!    tick.
//!
//!    All are reported back as `skipped` paths (byte order) plus
//!    `skipped_detail` (path, reason).
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
//! The temp index / pathspec files (and their private temp directories) are
//! removed in all cases.
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
//! Matches are skipped — left exactly as HEAD has them, or absent. The guard
//! scans exactly the committed blobs, and refuses every path whose committed
//! bytes could differ from what the user wrote (`filtered-path`) or could make
//! `git push` upload something else (`lfs-pointer`), so neither a clean
//! filter nor git-lfs can smuggle a secret into history.
//!
//! Test seam: [`run_autocommit_report_with`] calls its hook with
//! [`TickPhase::Added`] after step 4's add/write-tree and
//! [`TickPhase::Scanned`] after the blob scan and both `check-attr` runs,
//! before the closing attribute snapshot A2 (Node:
//! `runAutocommit(root, now, { onPhase })`). Production passes `None`.

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
const GITLINK_MODE: &str = "160000";
const GITATTRIBUTES: &str = ".gitattributes";
/// Prefix of every private temp dir a tick creates (and the sweep removes);
/// the full name is this plus exactly 16 lowercase hex digits.
const TEMP_DIR_PREFIX: &str = "skippy-ac-";
/// A `skippy-ac-*` dir untouched for this long belongs to a killed tick.
pub(crate) const STALE_TEMP_DIR_AGE: Duration = Duration::from_secs(60 * 60);

/// Test-seam checkpoints of one tick (see the module docs).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TickPhase {
    /// Step 4's `add -A` / `write-tree` into the temp index are done.
    Added,
    /// The blob scan and both `check-attr` runs are done; the closing
    /// attribute snapshot (A2) has not been taken yet.
    Scanned,
}

/// Optional per-phase callback (tests only; production passes `None`).
pub(crate) type PhaseHook<'a> = Option<&'a (dyn Fn(TickPhase) + Sync)>;

/// Why a changed vault path was withheld from the autocommit. The string
/// forms are identical to the Node twin's `skippedDetail[].reason`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipReason {
    Flagged,
    UserStaged,
    Gitlink,
    SecretFilename,
    AttributesChanged,
    FilteredPath,
    TooLargeToScan,
    LfsPointer,
    SecretContent,
}

impl SkipReason {
    pub fn as_str(self) -> &'static str {
        match self {
            SkipReason::Flagged => "flagged",
            SkipReason::UserStaged => "user-staged",
            SkipReason::Gitlink => "gitlink",
            SkipReason::SecretFilename => "secret-filename",
            SkipReason::AttributesChanged => "attributes-changed",
            SkipReason::FilteredPath => "filtered-path",
            SkipReason::TooLargeToScan => "too-large-to-scan",
            SkipReason::LfsPointer => "lfs-pointer",
            SkipReason::SecretContent => "secret-content",
        }
    }
}

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
    /// Largest blob the guard will scan (and so commit).
    max_scan_bytes: u64,
    /// git-lfs pointer version lines (`lfsPointer.versionLines`).
    lfs_pointer_lines: Vec<Vec<u8>>,
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
    let max_scan_bytes = v["limits"]["maxScanBytes"]
        .as_u64()
        .filter(|&n| n > 0 && n <= (1u64 << 53) - 1)
        .expect("limits.maxScanBytes must be a positive integer");
    // One byte per char, exactly like the Node twin's latin1 byte strings.
    let lfs_pointer_lines: Vec<Vec<u8>> = v["lfsPointer"]["versionLines"]
        .as_array()
        .expect("lfsPointer.versionLines must be a non-empty list of strings")
        .iter()
        .map(|l| {
            let s = l.as_str().filter(|s| !s.is_empty()).expect("lfsPointer.versionLines entry");
            s.chars()
                .map(|c| u8::try_from(u32::from(c)).expect("lfsPointer.versionLines must be latin1"))
                .collect()
        })
        .collect();
    assert!(!lfs_pointer_lines.is_empty(), "lfsPointer.versionLines must be a non-empty list of strings");
    SecretRules { filename, content, max_scan_bytes, lfs_pointer_lines }
});

fn max_scan_bytes() -> u64 {
    SECRET_RULES.max_scan_bytes
}

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

/// True if the exact blob bytes contain a git-lfs pointer version line
/// anywhere (a superset of what git-lfs 3.x decodes as a pointer: its decoder
/// needs `version <alias>` verbatim on a line).
fn matches_lfs_pointer(bytes: &[u8]) -> bool {
    SECRET_RULES
        .lfs_pointer_lines
        .iter()
        .any(|l| bytes.windows(l.len()).any(|w| w == l.as_slice()))
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
    /// Vault paths withheld from the commit, in byte order.
    #[allow(dead_code)] // mirrors the Node twin's `skipped`; read by tests/harness
    pub skipped: Vec<String>,
    /// `skipped` with the reason for each path (Node: `skippedDetail`).
    pub skipped_detail: Vec<(String, SkipReason)>,
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

/// A fresh private directory in the OS temp dir: `<tmp>/skippy-ac-<16 hex>`.
/// Removed (with everything in it, e.g. a stray `index.lock`) on drop.
struct PrivateTempDir(PathBuf);

impl PrivateTempDir {
    fn new() -> Result<Self> {
        let hex = uuid::Uuid::new_v4().simple().to_string();
        let dir = std::env::temp_dir().join(format!("{TEMP_DIR_PREFIX}{}", &hex[..16]));
        // Non-recursive: fails rather than reuse an existing directory.
        std::fs::create_dir(&dir).with_context(|| format!("failed to create temp dir {}", dir.display()))?;
        Ok(Self(dir))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for PrivateTempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// True for exactly `skippy-ac-<16 lowercase hex>`.
fn is_temp_dir_name(name: &OsStr) -> bool {
    name.to_str()
        .and_then(|n| n.strip_prefix(TEMP_DIR_PREFIX))
        .is_some_and(|hex| hex.len() == 16 && hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

/// Best-effort sweep of `<tmp>/skippy-ac-<16 hex>` directories not modified
/// for [`STALE_TEMP_DIR_AGE`] (left behind by a killed tick). Exact name
/// match only; `symlink_metadata` must report a real directory, so a symlink
/// or junction with that name is never followed (nor removed), and
/// `remove_dir_all` never follows links inside. A live tick's directory is
/// always younger than the threshold. Returns the names removed.
pub(crate) fn sweep_stale_temp_dirs() -> Vec<String> {
    let mut removed = Vec::new();
    let tmp = std::env::temp_dir();
    let Ok(entries) = std::fs::read_dir(&tmp) else {
        return removed;
    };
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        let name = entry.file_name();
        if !is_temp_dir_name(&name) {
            continue;
        }
        let path = tmp.join(&name);
        let Ok(meta) = std::fs::symlink_metadata(&path) else { continue };
        if !meta.file_type().is_dir() || meta.file_type().is_symlink() {
            continue;
        }
        let stale = meta
            .modified()
            .ok()
            .and_then(|m| now.duration_since(m).ok())
            .is_some_and(|age| age >= STALE_TEMP_DIR_AGE);
        if stale && std::fs::remove_dir_all(&path).is_ok() {
            removed.push(name.to_string_lossy().into_owned());
        }
    }
    removed
}

/// Blob sizes by oid (`cat-file --batch-check`); errors on a missing object.
async fn blob_sizes(root: &Path, oids: &[String]) -> Result<BTreeMap<String, u64>> {
    let mut sizes = BTreeMap::new();
    if oids.is_empty() {
        return Ok(sizes);
    }
    let input: String = oids.iter().map(|o| format!("{o}\n")).collect();
    let out = git_raw(root, &["cat-file", "--batch-check"], &[], Some(input.as_bytes()))
        .await
        .context("git cat-file --batch-check failed")?;
    let text = latin1(&out);
    let lines: Vec<&str> = text.split('\n').filter(|l| !l.is_empty()).collect();
    if lines.len() != oids.len() {
        bail!("cat-file --batch-check: truncated output");
    }
    for (oid, line) in oids.iter().zip(lines) {
        let f: Vec<&str> = line.split(' ').collect();
        if f.get(1) == Some(&"missing") {
            bail!("cat-file --batch-check: blob {oid} missing");
        }
        let size: u64 = f
            .get(2)
            .and_then(|s| s.parse().ok())
            .ok_or_else(|| anyhow!("cat-file --batch-check: unexpected header"))?;
        if f[0] != oid {
            bail!("cat-file --batch-check: unexpected header");
        }
        sizes.insert(oid.clone(), size);
    }
    Ok(sizes)
}

/// Content-scan blobs by oid. Returns the verdict for every blob that must
/// not be committed (`TooLargeToScan` / `LfsPointer` / `SecretContent`; an
/// LFS pointer wins over a content hit). Blobs over
/// `maxScanBytes` are never read (D3); the rest are fetched with
/// `cat-file --batch` in groups of at most `maxScanBytes` total, so memory
/// stays bounded however big the vault is (same grouping as the Node twin).
async fn scan_blobs_for_secrets(root: &Path, oids: &[String]) -> Result<BTreeMap<String, SkipReason>> {
    let unique: Vec<String> = oids.iter().cloned().collect::<BTreeSet<_>>().into_iter().collect();
    let mut verdicts = BTreeMap::new();
    let sizes = blob_sizes(root, &unique).await?;
    let cap = max_scan_bytes();
    let mut groups: Vec<Vec<String>> = Vec::new();
    let mut group: Vec<String> = Vec::new();
    let mut group_bytes = 0u64;
    for oid in &unique {
        let size = sizes[oid];
        if size > cap {
            verdicts.insert(oid.clone(), SkipReason::TooLargeToScan);
            continue;
        }
        if !group.is_empty() && group_bytes + size > cap {
            groups.push(std::mem::take(&mut group));
            group_bytes = 0;
        }
        group.push(oid.clone());
        group_bytes += size;
    }
    if !group.is_empty() {
        groups.push(group);
    }
    for g in &groups {
        let input: String = g.iter().map(|o| format!("{o}\n")).collect();
        let out = git_raw(root, &["cat-file", "--batch"], &[], Some(input.as_bytes()))
            .await
            .context("git cat-file --batch failed")?;
        let mut pos = 0usize;
        for oid in g {
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
            if fields[0] != oid || size as u64 != sizes[oid] || pos + size > out.len() {
                bail!("cat-file --batch: unexpected header");
            }
            let blob = &out[pos..pos + size];
            if matches_lfs_pointer(blob) {
                verdicts.insert(oid.clone(), SkipReason::LfsPointer);
            } else if matches_secret_content(blob) {
                verdicts.insert(oid.clone(), SkipReason::SecretContent);
            }
            pos += size + 1; // trailing LF
        }
    }
    Ok(verdicts)
}

/// The subset of `paths` with a `filter` attribute set to anything (`set` or
/// any driver name, e.g. `lfs`, configured or not); `unspecified` / `unset`
/// mean no filter. One `check-attr -z --stdin` call, raw byte paths on stdin;
/// `env` selects the index git falls back to for a `.gitattributes` missing
/// from the working tree (the seed index = the pre-add state, or the temp
/// index = the post-add state).
async fn filtered_paths(root: &Path, paths: &[BPath], env: &[(&str, &OsStr)]) -> Result<BTreeSet<BPath>> {
    let mut filtered = BTreeSet::new();
    if paths.is_empty() {
        return Ok(filtered);
    }
    let mut input = Vec::new();
    for p in paths {
        input.extend_from_slice(p);
        input.push(0);
    }
    let out = git_raw(root, &["check-attr", "-z", "--stdin", "filter"], env, Some(&input))
        .await
        .context("git check-attr filter failed")?;
    let fields: Vec<&[u8]> = out.split(|&b| b == 0).collect();
    if fields.len() != paths.len() * 3 + 1 || !fields[fields.len() - 1].is_empty() {
        bail!("check-attr: unexpected output");
    }
    let mut i = 0;
    while i + 2 < fields.len() {
        if fields[i + 1] != b"filter" {
            bail!("check-attr: unexpected output");
        }
        let value = fields[i + 2];
        if value != b"unspecified" && value != b"unset" {
            filtered.insert(fields[i].to_vec());
        }
        i += 3;
    }
    Ok(filtered)
}

/// One attribute source per key (A1 / A2): path and/or state bytes.
type AttrSnapshot = BTreeMap<String, Vec<u8>>;

/// State of one attribute file: its full content, or absent / a link /
/// another non-regular entry / unreadable. `follow_links` is false for
/// in-tree `.gitattributes` (git refuses to read those through a symlink) and
/// true for the info/global/system files (git opens them normally).
fn attribute_file_state(path: &Path, follow_links: bool) -> Vec<u8> {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return b"absent".to_vec(),
        Err(e) => return format!("error:{:?}", e.kind()).into_bytes(),
    };
    if meta.file_type().is_symlink() {
        let target = std::fs::read_link(path)
            .map(|t| t.to_string_lossy().into_owned())
            .unwrap_or_default();
        let mut state = format!("link:{target}").into_bytes();
        if follow_links {
            state.push(b':');
            match std::fs::read(path) {
                Ok(bytes) => state.extend_from_slice(&bytes),
                Err(e) => state.extend_from_slice(format!("error:{:?}", e.kind()).as_bytes()),
            }
        }
        return state;
    }
    if !meta.is_file() {
        return b"other".to_vec();
    }
    match std::fs::read(path) {
        Ok(bytes) => {
            let mut state = b"file:".to_vec();
            state.extend_from_slice(&bytes);
            state
        }
        Err(e) => format!("error:{:?}", e.kind()).into_bytes(),
    }
}

/// Every `.gitattributes` under `root/rel` (keys `wt:vault/.../.gitattributes`
/// -> state), walked without following links; a directory holding `.git` (a
/// nested repository or the vault's own submodule checkout) is not entered —
/// git reads no superproject attributes there.
fn walk_vault_attributes(root: &Path, rel: &str, out: &mut AttrSnapshot) {
    let entries: Vec<std::fs::DirEntry> = match std::fs::read_dir(root.join(rel)) {
        Ok(rd) => rd.flatten().collect(),
        Err(e) => {
            out.insert(format!("dir:{rel}"), format!("error:{:?}", e.kind()).into_bytes());
            return;
        }
    };
    if entries.iter().any(|e| e.file_name() == ".git") {
        return;
    }
    for e in entries {
        let name = e.file_name();
        let child = format!("{rel}/{}", name.to_string_lossy());
        if name == GITATTRIBUTES {
            out.insert(format!("wt:{child}"), attribute_file_state(&e.path(), false));
        } else if e.file_type().is_ok_and(|t| t.is_dir() && !t.is_symlink()) {
            walk_vault_attributes(root, &child, out);
        }
    }
}

/// Resolve `git var <name>`; `None` if git cannot say.
async fn git_var_path(root: &Path, name: &str) -> Option<String> {
    git(root, &["var", name], &[]).await.ok().filter(|p| !p.is_empty())
}

/// A1 / A2: every attribute source git reads for a vault path — the in-tree
/// `.gitattributes` at the root and anywhere under `vault/`, the repo's
/// `info/attributes`, and the global and system files (paths re-resolved on
/// every call, so a `core.attributesFile` change is seen too). Two snapshots
/// are equal iff no source changed.
async fn attribute_snapshot(root: &Path) -> AttrSnapshot {
    let info = git(root, &["rev-parse", "--git-path", "info/attributes"], &[])
        .await
        .ok()
        .map(|p| {
            let p = PathBuf::from(p);
            if p.is_absolute() {
                p
            } else {
                root.join(p)
            }
        });
    let global = git_var_path(root, "GIT_ATTR_GLOBAL").await;
    let system = git_var_path(root, "GIT_ATTR_SYSTEM").await;
    let root = root.to_path_buf();
    let snapshot = tokio::task::spawn_blocking(move || {
        let mut snap = AttrSnapshot::new();
        snap.insert(format!("wt:{GITATTRIBUTES}"), attribute_file_state(&root.join(GITATTRIBUTES), false));
        match std::fs::symlink_metadata(root.join(VAULT_PATHSPEC)) {
            Ok(m) if m.file_type().is_dir() && !m.file_type().is_symlink() => {
                walk_vault_attributes(&root, VAULT_PATHSPEC, &mut snap)
            }
            Ok(_) => {
                snap.insert("dir:vault".into(), b"not-a-directory".to_vec());
            }
            Err(_) => {
                snap.insert("dir:vault".into(), b"absent".to_vec());
            }
        }
        let with_path = |p: &Path| {
            let mut state = p.to_string_lossy().into_owned().into_bytes();
            state.push(0);
            state.extend_from_slice(&attribute_file_state(p, true));
            state
        };
        snap.insert(
            "info".into(),
            info.as_deref().map_or_else(|| b"unresolved".to_vec(), |p| with_path(p)),
        );
        for (name, p) in [("GIT_ATTR_GLOBAL", global), ("GIT_ATTR_SYSTEM", system)] {
            snap.insert(
                name.into(),
                p.map_or_else(|| b"unresolved".to_vec(), |p| with_path(Path::new(&p))),
            );
        }
        snap
    })
    .await;
    // A panicked walk is recorded as a unique state, so it never compares
    // equal to a real snapshot (fail closed: the tick is deferred).
    snapshot.unwrap_or_else(|_| {
        AttrSnapshot::from([("panic".to_string(), uuid::Uuid::new_v4().as_bytes().to_vec())])
    })
}

/// Effective `core.sparseCheckout` (default false).
async fn sparse_checkout_enabled(root: &Path) -> Result<bool> {
    let v = git(root, &["config", "--type=bool", "--default=false", "--get", "core.sparseCheckout"], &[])
        .await
        .context("git config core.sparseCheckout failed")?;
    Ok(v == "true")
}

/// The subset of `paths` outside the sparse-checkout definition, when
/// `core.sparseCheckout` is on (`sparse-checkout check-rules -z`, which
/// prints the paths inside). If the patterns cannot be loaded, every path
/// counts as inside — exactly how git itself treats a sparse checkout
/// without patterns.
async fn outside_sparse_checkout(root: &Path, paths: &[BPath]) -> Result<BTreeSet<BPath>> {
    if paths.is_empty() || !sparse_checkout_enabled(root).await? {
        return Ok(BTreeSet::new());
    }
    let mut input = Vec::new();
    for p in paths {
        input.extend_from_slice(p);
        input.push(0);
    }
    let Ok(out) = git_raw(root, &["sparse-checkout", "check-rules", "-z"], &[], Some(&input)).await else {
        return Ok(BTreeSet::new());
    };
    let inside: BTreeSet<&[u8]> = split_z(&out).collect();
    Ok(paths.iter().filter(|p| !inside.contains(p.as_slice())).cloned().collect())
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
        let dir = PrivateTempDir::new()?;
        let spec_file = dir.path().join("pathspec");
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
        drop(dir);
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
    // Known versions only (D5): absent or 1 = legacy (no `ref`), 2 = current.
    // Compared as f64 so `2` and `2.0` behave exactly like JS `=== 2`.
    let version = match obj.get("version") {
        None => None,
        Some(v) => match v.as_f64() {
            Some(n) if n == 1.0 || n == PENDING_MARKER_VERSION as f64 => Some(n),
            _ => return None,
        },
    };
    if version == Some(PENDING_MARKER_VERSION as f64) && !obj.contains_key("ref") {
        return None;
    }
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

/// Parent oids of commit `oid` (header order), or `None` if it isn't a commit.
async fn commit_parents(root: &Path, oid: &str) -> Option<Vec<String>> {
    if git(root, &["cat-file", "-t", oid], &[]).await.ok()? != "commit" {
        return None;
    }
    let raw = git_raw(root, &["cat-file", "commit", oid], &[], None).await.ok()?;
    let text = latin1(&raw);
    let header = text.split("\n\n").next().unwrap_or("");
    Some(
        header
            .split('\n')
            .filter_map(|l| l.strip_prefix("parent "))
            .map(str::to_string)
            .collect(),
    )
}

/// D5: `new` must be a commit whose first parent is exactly `parent` (or a
/// root commit when `parent` is `None`), and `parent` must exist as a
/// commit. `None` if the marker is consistent, else the reason to drop it.
async fn marker_objects_problem(root: &Path, marker: &PendingMarker) -> Option<String> {
    let Some(parents) = commit_parents(root, &marker.new).await else {
        return Some(format!("{} is not an existing commit", marker.new));
    };
    let first = parents.first().cloned();
    if first != marker.parent {
        return Some(format!(
            "recorded parent {} is not the first parent of {} ({})",
            marker.parent.as_deref().unwrap_or("(none)"),
            marker.new,
            first.as_deref().unwrap_or("root commit")
        ));
    }
    if let Some(parent) = &marker.parent {
        if commit_parents(root, parent).await.is_none() {
            return Some(format!("parent {parent} is not an existing commit"));
        }
    }
    None
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

    if let Some(problem) = marker_objects_problem(root, &marker).await {
        let _ = tokio::fs::remove_file(&marker_path).await;
        return Some(RecoveryOutcome {
            synced: false,
            new_sha: Some(marker.new.clone()),
            dropped: Some(format!("inconsistent pending marker: {problem}; index left untouched")),
            error: None,
        });
    }

    let result = async {
        let parent_entries = tree_entries(root, marker.parent.as_deref()).await?;
        let new_entries = tree_entries(root, Some(&marker.new)).await?;
        let paths = differing_paths(&parent_entries, &new_entries);
        sync_real_index(root, &marker.new, &parent_entries, &paths).await
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
            if !report.skipped_detail.is_empty() {
                debug!(
                    "git_autocommit: skipped vault paths: {}",
                    report
                        .skipped_detail
                        .iter()
                        .map(|(p, r)| format!("{p} ({})", r.as_str()))
                        .collect::<Vec<_>>()
                        .join(", ")
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
    run_autocommit_report_with(root, None).await
}

/// [`run_autocommit_report`] with the test seam: `hook` (if any) is called
/// at each [`TickPhase`].
pub(crate) async fn run_autocommit_report_with(root: &Path, hook: PhaseHook<'_>) -> Result<AutocommitReport> {
    let vault = root.join("vault");
    if !vault.exists() {
        return Ok(AutocommitReport {
            outcome: AutocommitOutcome::NoOp,
            skipped: Vec::new(),
            skipped_detail: Vec::new(),
            recovered: None,
        });
    }

    let _ = tokio::task::spawn_blocking(sweep_stale_temp_dirs).await;
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

    // D1: the temp index lives in a private dir under the OS temp dir (never
    // the git dir); the dir, index and any `.lock` go away whatever happens.
    let temp_dir = PrivateTempDir::new()?;
    let result = run_autocommit_inner(root, &git_dir, temp_dir.path(), head.as_deref(), head_ref.as_deref(), hook).await;
    drop(temp_dir);
    let (outcome, skipped_detail) = result?;
    let skipped = skipped_detail.iter().map(|(p, _)| p.clone()).collect();
    Ok(AutocommitReport { outcome, skipped, skipped_detail, recovered })
}

async fn run_autocommit_inner(
    root: &Path,
    git_dir: &Path,
    temp_dir: &Path,
    head: Option<&str>,
    head_ref: Option<&str>,
    hook: PhaseHook<'_>,
) -> Result<(AutocommitOutcome, Vec<(String, SkipReason)>)> {
    let temp_index = temp_dir.join("index");
    // The temp index as it was before `add` (absent for an unborn HEAD,
    // which git reads as an empty index): the pre-add attribute evaluation
    // uses it.
    let seed_index = temp_dir.join("seed-index");
    let env = [("GIT_INDEX_FILE", temp_index.as_os_str())];
    let seed_env = [("GIT_INDEX_FILE", seed_index.as_os_str())];

    let head_entries = tree_entries(root, head).await?;
    let snapshot = real_index_snapshot(root).await?;
    let owned = user_owned_paths(&snapshot, &head_entries);

    if let Some(head) = head {
        git(root, &["read-tree", head], &env)
            .await
            .context("git read-tree HEAD into temp index failed")?;
        tokio::fs::copy(&temp_index, &seed_index)
            .await
            .context("failed to snapshot the seeded temp index")?;
    }
    let attrs_before = attribute_snapshot(root).await; // A1
    // -A so deletions are captured; .gitignore respected; vault/ only.
    if let Err(e) = git(root, &["add", "-A", "--", VAULT_PATHSPEC], &env).await {
        // A sparse checkout makes `add` refuse (and fail on) out-of-cone
        // paths: redo it from the seed with --sparse; those paths are then
        // flagged below, so the tick never fails for that reason.
        if !sparse_checkout_enabled(root).await? {
            return Err(e.context("git add -A -- vault into temp index failed"));
        }
        if head.is_some() {
            tokio::fs::copy(&seed_index, &temp_index)
                .await
                .context("failed to reset the temp index to the seed")?;
        } else {
            let _ = tokio::fs::remove_file(&temp_index).await;
        }
        git(root, &["add", "-A", "--sparse", "--", VAULT_PATHSPEC], &env)
            .await
            .context("git add -A --sparse -- vault into temp index failed")?;
    }
    let preliminary_tree = git(root, &["write-tree"], &env)
        .await
        .context("git write-tree from temp index failed")?;
    if let Some(h) = hook {
        h(TickPhase::Added);
    }
    let prelim_entries = tree_entries(root, Some(&preliminary_tree)).await?;
    let all_changed = differing_paths(&head_entries, &prelim_entries);

    let mode_of = |entries: &Entries, p: &BPath| -> Option<String> {
        entries.get(p).and_then(|e| e.split_once(' ')).map(|(m, _)| m.to_string())
    };
    let blob_of = |p: &BPath| -> Option<String> {
        prelim_entries.get(p).and_then(|e| e.split_once(' ')).map(|(_, oid)| oid.to_string())
    };
    let outside_sparse = outside_sparse_checkout(root, &all_changed).await?;

    // Reasons decided before the attribute check (same order as the Node twin).
    let mut early: BTreeMap<BPath, SkipReason> = BTreeMap::new();
    for p in &all_changed {
        let reason = if snapshot.flagged.contains(p) || outside_sparse.contains(p) {
            Some(SkipReason::Flagged)
        } else if owned.contains(p) {
            Some(SkipReason::UserStaged)
        } else if mode_of(&head_entries, p).as_deref() == Some(GITLINK_MODE)
            || mode_of(&prelim_entries, p).as_deref() == Some(GITLINK_MODE)
        {
            Some(SkipReason::Gitlink)
        } else if matches_secret_filename(p) {
            Some(SkipReason::SecretFilename)
        } else {
            None
        };
        if let Some(r) = reason {
            early.insert(p.clone(), r);
        }
    }

    // filtered-path: a `filter` attribute in the pre-add (seed index) OR the
    // post-add (temp index) evaluation. Deletions carry no blob.
    let mut late: BTreeMap<BPath, SkipReason> = BTreeMap::new();
    let present: Vec<(BPath, String)> = all_changed
        .iter()
        .filter(|p| !early.contains_key(*p))
        .filter_map(|p| blob_of(p).map(|oid| (p.clone(), oid)))
        .collect();
    let present_paths: Vec<BPath> = present.iter().map(|(p, _)| p.clone()).collect();
    let filtered_before = filtered_paths(root, &present_paths, &seed_env).await?;
    let filtered_after = filtered_paths(root, &present_paths, &env).await?;
    for p in &present_paths {
        if filtered_before.contains(p) || filtered_after.contains(p) {
            late.insert(p.clone(), SkipReason::FilteredPath);
        }
    }

    // The exact blobs the commit would contain: size cap, LFS pointer, secrets.
    let to_scan: Vec<(BPath, String)> = present.into_iter().filter(|(p, _)| !late.contains_key(p)).collect();
    let verdicts =
        scan_blobs_for_secrets(root, &to_scan.iter().map(|(_, o)| o.clone()).collect::<Vec<_>>()).await?;
    for (p, oid) in &to_scan {
        if let Some(v) = verdicts.get(oid) {
            late.insert(p.clone(), *v);
        }
    }
    if let Some(h) = hook {
        h(TickPhase::Scanned);
    }

    // A2: any attribute source changed since A1 -> defer the whole tick.
    let attrs_changed = attrs_before != attribute_snapshot(root).await;
    // path -> reason; first match wins.
    let mut reasons: BTreeMap<BPath, SkipReason> = BTreeMap::new();
    for p in &all_changed {
        let reason = early.get(p).copied().or_else(|| {
            if attrs_changed {
                Some(SkipReason::AttributesChanged)
            } else {
                late.get(p).copied()
            }
        });
        if let Some(r) = reason {
            reasons.insert(p.clone(), r);
        }
    }
    let excluded: Vec<BPath> = all_changed.iter().filter(|p| reasons.contains_key(*p)).cloned().collect();
    let commit_paths: Vec<BPath> = all_changed.iter().filter(|p| !reasons.contains_key(*p)).cloned().collect();
    let skipped: Vec<(String, SkipReason)> = excluded.iter().map(|p| (display_path(p), reasons[p])).collect();

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

    match sync_real_index(root, &new_commit, &head_entries, &commit_paths).await {
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

    // --- EC5 final round: every skip reason, byte-ordered, same strings as
    // the Node twin's `skippedDetail` (Node: "F5 skip reasons ..."). --------

    #[tokio::test]
    async fn skip_reasons_match_the_node_twin() {
        let repo = TempRepo::new("reasons");
        repo.write(".gitattributes", "vault/rot/*.md filter=rot\nvault/pid/*.md filter=pid\n");
        repo.git_ok(&["config", "filter.rot.clean", "tr A-Za-z N-ZA-Mn-za-m"]);
        repo.git_ok(&["config", "filter.rot.smudge", "tr A-Za-z N-ZA-Mn-za-m"]);
        // Non-deterministic clean filter (appends its own PID): refused like
        // any other filtered path, never a permanent stall for its neighbours.
        repo.git_ok(&["config", "filter.pid.clean", "cat; echo $$"]);
        repo.git_ok(&["config", "filter.pid.smudge", "cat"]);
        repo.write("vault/flag.md", "f1\n");
        repo.write("vault/mine.md", "m1\n");
        repo.write("vault/n.md", "x\n");
        seed_initial_commit(&repo); // adds README.md only
        repo.git_ok(&["add", "-A", "."]);
        repo.git_ok(&["commit", "-q", "-m", "seed vault"]);
        repo.git_ok(&["update-index", "--assume-unchanged", "vault/flag.md"]);
        repo.write("vault/flag.md", "f2\n");
        repo.write("vault/mine.md", "m2\n");
        repo.git_ok(&["add", "vault/mine.md"]);
        repo.write("vault/.env", "K=1\n");
        repo.write("vault/leak.md", "AKIAABCDEFGHIJKLMNOP\n");
        repo.write("vault/rot/leak.md", "AKIAABCDEFGHIJKLMNOP\n");
        repo.write("vault/pid/p.md", "plain\n");
        repo.write("vault/ptr.bin", LFS_POINTER);
        let line = b"the magnificent skippy\n";
        let big: Vec<u8> = line.iter().copied().cycle().take(max_scan_bytes() as usize + 1).collect();
        repo.write("vault/big.bin", String::from_utf8(big).unwrap().as_str());
        let inner = repo.dir.join("vault").join("sub");
        std::fs::create_dir_all(&inner).unwrap();
        assert!(StdCommand::new("git").arg("-C").arg(&inner).args(["init", "-q"]).status().unwrap().success());
        assert!(StdCommand::new("git")
            .arg("-C")
            .arg(&inner)
            .args(["-c", "user.name=x", "-c", "user.email=x@x", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "x"])
            .status()
            .unwrap()
            .success());
        repo.write("vault/n.md", "y\n");

        let report = run_autocommit_report(repo.path()).await.expect("autocommit ok");
        assert_eq!(report.outcome, AutocommitOutcome::Committed);
        let got: Vec<(String, &str)> = report.skipped_detail.iter().map(|(p, r)| (p.clone(), r.as_str())).collect();
        let want: Vec<(String, &str)> = [
            ("vault/.env", "secret-filename"),
            ("vault/big.bin", "too-large-to-scan"),
            ("vault/flag.md", "flagged"),
            ("vault/leak.md", "secret-content"),
            ("vault/mine.md", "user-staged"),
            ("vault/pid/p.md", "filtered-path"),
            ("vault/ptr.bin", "lfs-pointer"),
            ("vault/rot/leak.md", "filtered-path"),
            ("vault/sub", "gitlink"),
        ]
        .into_iter()
        .map(|(p, r)| (p.to_string(), r))
        .collect();
        assert_eq!(got, want);
        assert_eq!(report.skipped, want.iter().map(|(p, _)| p.clone()).collect::<Vec<_>>());
        let files = repo.git_ok(&["ls-tree", "-r", "--name-only", "HEAD"]);
        assert_eq!(repo.git_ok(&["show", "HEAD:vault/n.md"]), "y");
        for (p, _) in &want {
            if p != "vault/flag.md" && p != "vault/mine.md" {
                assert!(!files.lines().any(|l| l == p), "{p} was committed");
            }
        }
    }

    const LFS_POINTER: &str = "version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 12345\n";

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
        for s in list("lfsPointerHits") {
            assert!(matches_lfs_pointer(s.as_bytes()), "LFS pointer missed: {s:?}");
        }
        for s in list("lfsPointerMisses") {
            assert!(!matches_lfs_pointer(s.as_bytes()), "LFS pointer false positive: {s}");
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

    /// Intent-to-add is user-owned BY DESIGN (E5-6): the `git add -N` entry
    /// differs from HEAD, so the autocommit never commits it and leaves the
    /// i-t-a entry exactly as the user made it (an earlier red-team
    /// expectation that it be committed was stale).
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

/// Final-round red-team regressions (EC5 D1..D5). Mirrors the Node suite's
/// `F5-*` cases. Self-contained on purpose (only `run_autocommit_report` and
/// its `outcome`/`skipped`/`recovered` fields plus the git CLI), so the same
/// module also compiles against a24234e, where every case fails. The skip
/// *reasons* are asserted in `tests::skip_reasons_match_the_node_twin`.
#[cfg(test)]
mod f5_regression_tests {
    use super::{run_autocommit_report, AutocommitOutcome, AutocommitReport};
    use std::path::{Path, PathBuf};
    use std::process::Command;

    const SCAN_CAP: usize = 64 * 1024 * 1024; // limits.maxScanBytes
    const SECRET_BODY: &str = "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789\naws AKIAABCDEFGHIJKLMNOP\n";

    struct Repo {
        dir: PathBuf,
    }

    impl Repo {
        fn at(dir: PathBuf) -> Self {
            std::fs::create_dir_all(&dir).unwrap();
            let r = Self { dir };
            r.ok(&["init", "-q", "-b", "main"]);
            r.ok(&["config", "user.name", "Skippy Test"]);
            r.ok(&["config", "user.email", "skippy-test@example.invalid"]);
            r.ok(&["config", "commit.gpgsign", "false"]);
            r.ok(&["config", "core.hooksPath", ".no-hooks"]);
            r
        }

        fn new(name: &str) -> Self {
            Self::at(std::env::temp_dir().join(format!("skippy-f5-{name}-{}", uuid::Uuid::new_v4())))
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

        fn write_marker(&self, json: &str) {
            std::fs::write(self.marker(), json).unwrap();
        }

        async fn tick(&self) -> AutocommitReport {
            run_autocommit_report(self.path()).await.expect("autocommit ok")
        }

        /// c1 (n=A) -> c2 (n=B) -> c3 (n=C); real index n.md reset to `reset_to`'s blob.
        fn marker_chain(&self, reset_to: usize) -> Vec<String> {
            let mut shas = Vec::new();
            for (name, body) in [("c1", "A\n"), ("c2", "B\n"), ("c3", "C\n")] {
                self.write("vault/n.md", body);
                self.commit_all(name);
                shas.push(self.ok(&["rev-parse", "HEAD"]));
            }
            self.ok(&["reset", "-q", &shas[reset_to], "--", "vault/n.md"]);
            shas
        }
    }

    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn nested_repo(dir: &Path) {
        std::fs::create_dir_all(dir).unwrap();
        let git = |args: &[&str]| {
            let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        };
        git(&["init", "-q"]);
        git(&["-c", "user.name=x", "-c", "user.email=x@x", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "x"]);
    }

    fn skippy_files_in(dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains("skippy"))
            .collect()
    }

    // --- D1: temp index lives in the OS temp dir, not the git dir. ---------

    #[tokio::test]
    async fn f5_d1_repo_at_a_190_char_root_commits_and_leaves_nothing_in_the_git_dir() {
        // Build on the canonical long temp path: an 8.3 short temp dir (as on CI
        // runners) is expanded by git past MAX_PATH, which is not what this test probes.
        let canon = std::fs::canonicalize(std::env::temp_dir()).unwrap();
        let canon = canon.to_string_lossy();
        let base = std::path::PathBuf::from(canon.strip_prefix(r"\\?\").unwrap_or(&canon));
        let pre = base
            .join(format!("skippy-f5-lp-{}-", &uuid::Uuid::new_v4().simple().to_string()[..8]))
            .to_string_lossy()
            .into_owned();
        if pre.len() + 8 > 190 {
            eprintln!("SKIP f5_d1: OS temp dir is too long to build a 190-char repo root");
            return;
        }
        let dir = PathBuf::from(format!("{pre}{}", "a".repeat(190 - pre.len())));
        let r = Repo::at(dir);
        r.ok(&["config", "core.longpaths", "false"]); // the default; pin it against global config
        r.write("vault/n.md", "x\n");
        r.commit_all("init");
        r.write("vault/n.md", "y\n");
        let rep = run_autocommit_report(r.path()).await;
        assert!(matches!(&rep, Ok(x) if x.outcome == AutocommitOutcome::Committed), "{:?}", rep.map(|x| x.outcome));
        assert_eq!(r.show("HEAD:vault/n.md"), "y");
        assert_eq!(r.status(), "");
        assert!(skippy_files_in(&r.dir.join(".git")).is_empty(), "temp files must never be created in the git dir");
    }

    // --- D2 (OQ-19): paths with a `filter` attribute are never autocommitted.

    fn detail(rep: &AutocommitReport) -> Vec<(String, &'static str)> {
        rep.skipped_detail.iter().map(|(p, r)| (p.clone(), r.as_str())).collect()
    }

    #[tokio::test]
    async fn f5_d2_paths_behind_an_lfs_style_clean_filter_are_refused_as_filtered_path_secret_or_not() {
        let r = Repo::new("fakelfs");
        // Simulated git-lfs: the clean filter turns content into a pointer-
        // like hash, so no blob scan could judge what the user wrote.
        r.ok(&["config", "filter.lfs.clean", "git hash-object --stdin"]);
        r.ok(&["config", "filter.lfs.smudge", "cat"]);
        r.ok(&["config", "filter.lfs.required", "true"]);
        r.write(".gitattributes", "vault/*.txt filter=lfs diff=lfs merge=lfs -text\n");
        r.write("vault/n.md", "x\n");
        r.commit_all("init");
        r.write("vault/creds.txt", SECRET_BODY);
        r.write("vault/ok.txt", "harmless payload\n");
        r.write("vault/n.md", "y\n");
        let rep = r.tick().await;
        assert_eq!(rep.outcome, AutocommitOutcome::Committed);
        let tree = r.head_tree();
        assert!(!tree.contains(&"vault/creds.txt".to_string()), "filtered secret reached history: {tree:?}");
        assert!(!tree.contains(&"vault/ok.txt".to_string()), "a filtered path must never be autocommitted, even when clean");
        assert_eq!(
            detail(&rep),
            vec![("vault/creds.txt".to_string(), "filtered-path"), ("vault/ok.txt".to_string(), "filtered-path")]
        );
        assert_eq!(r.show("HEAD:vault/n.md"), "y");
        assert_eq!(r.status(), "", "the committed note must be synced to the real index");
    }

    #[tokio::test]
    async fn f5_d2_secret_behind_a_reversible_rot13_clean_filter_is_refused_as_filtered_path() {
        let r = Repo::new("rot13");
        r.ok(&["config", "filter.rot.clean", "tr A-Za-z N-ZA-Mn-za-m"]);
        r.ok(&["config", "filter.rot.smudge", "tr A-Za-z N-ZA-Mn-za-m"]);
        r.write(".gitattributes", "vault/*.rot filter=rot\n");
        r.write("vault/n.rot", "x\n");
        r.commit_all("init");
        r.write("vault/n.rot", "my aws key AKIAABCDEFGHIJKLMNOP\n");
        r.write("vault/fine.md", "nothing here\n");
        let rep = r.tick().await;
        assert_eq!(rep.outcome, AutocommitOutcome::Committed);
        assert_eq!(detail(&rep), vec![("vault/n.rot".to_string(), "filtered-path")]);
        assert_eq!(r.show("HEAD:vault/n.rot"), "k", "rot13-encoded secret was committed");
        assert!(r.head_tree().contains(&"vault/fine.md".to_string()));
    }

    #[tokio::test]
    async fn f5_d2_secret_stored_through_real_git_lfs_is_not_committed() {
        let has_lfs = Command::new("git").args(["lfs", "version"]).output().is_ok_and(|o| o.status.success());
        if !has_lfs {
            eprintln!("SKIP f5_d2 real-lfs: git-lfs is not installed (the simulated-filter case covers the mechanism)");
            return;
        }
        let r = Repo::new("lfs");
        r.ok(&["lfs", "install", "--local"]);
        r.write(".gitattributes", "vault/*.txt filter=lfs diff=lfs merge=lfs -text\n");
        r.write("vault/n.md", "x\n");
        r.commit_all("init");
        r.write("vault/creds.txt", SECRET_BODY);
        r.write("vault/n.md", "y\n");
        let rep = r.tick().await;
        assert_eq!(rep.outcome, AutocommitOutcome::Committed);
        assert_eq!(detail(&rep), vec![("vault/creds.txt".to_string(), "filtered-path")]);
        assert!(!r.head_tree().contains(&"vault/creds.txt".to_string()));
    }

    #[tokio::test]
    async fn f5_d2_diff_and_text_attributes_alone_never_cause_an_exclusion() {
        let r = Repo::new("attrs");
        r.write(".gitattributes", "vault/*.md diff=foo text\n");
        r.write("vault/n.md", "x\n");
        r.commit_all("init");
        r.write("vault/n.md", "y\n");
        let rep = r.tick().await;
        assert_eq!(rep.outcome, AutocommitOutcome::Committed);
        assert!(rep.skipped.is_empty(), "{:?}", rep.skipped);
    }

    // --- D3: blobs over the scan limit are excluded, never fatal. ----------

    #[tokio::test]
    async fn f5_d3_blob_over_the_scan_limit_is_skipped_and_unrelated_vault_work_still_commits() {
        let r = Repo::new("big");
        r.write("vault/n.md", "x\n");
        r.commit_all("init");
        let line = b"the magnificent skippy thinks monkeys are adorable\n";
        let big: Vec<u8> = line.iter().copied().cycle().take(SCAN_CAP + 1).collect();
        r.write("vault/big.bin", big);
        r.write("vault/n.md", "y\n");
        let rep = r.tick().await;
        assert_eq!(rep.outcome, AutocommitOutcome::Committed);
        assert_eq!(rep.skipped, vec!["vault/big.bin".to_string()]);
        assert!(!r.head_tree().contains(&"vault/big.bin".to_string()), "unscanned blob was committed");
        assert_eq!(r.show("HEAD:vault/n.md"), "y");
    }

    // --- D4: gitlinks are never added or changed. --------------------------

    #[tokio::test]
    async fn f5_d4_nested_repo_inside_the_vault_is_not_committed_as_an_orphan_gitlink() {
        let r = Repo::new("embed");
        r.write("a", "a\n");
        r.commit_all("init");
        nested_repo(&r.dir.join("vault").join("cloned"));
        r.write("vault/n.md", "x\n");
        let rep = r.tick().await;
        assert_eq!(rep.outcome, AutocommitOutcome::Committed);
        assert_eq!(rep.skipped, vec!["vault/cloned".to_string()]);
        assert!(!r.ok(&["ls-tree", "-r", "HEAD"]).lines().any(|l| l.starts_with("160000")), "orphan gitlink committed");
        assert!(r.head_tree().contains(&"vault/n.md".to_string()));
    }

    #[tokio::test]
    async fn f5_d4_vault_submodule_pointer_bump_is_not_autocommitted() {
        let src = Repo::new("vsubsrc");
        src.write("n.md", "v1\n");
        src.commit_all("s");
        let r = Repo::new("vsub");
        r.write("a", "a\n");
        r.commit_all("init");
        let src_dir = src.dir.to_string_lossy().into_owned();
        r.ok(&["-c", "protocol.file.allow=always", "submodule", "add", "-q", &src_dir, "vault"]);
        r.ok(&["commit", "-q", "-m", "add vault submodule"]);
        let before = r.ok(&["rev-parse", "HEAD"]);
        r.write("vault/n.md", "v2\n");
        let inner = Command::new("git")
            .arg("-C")
            .arg(r.dir.join("vault"))
            .args(["-c", "user.name=x", "-c", "user.email=x@x", "-c", "commit.gpgsign=false", "commit", "-q", "-am", "inner"])
            .output()
            .unwrap();
        assert!(inner.status.success());
        let rep = r.tick().await;
        assert_eq!(rep.outcome, AutocommitOutcome::NoOp);
        assert_eq!(rep.skipped, vec!["vault".to_string()]);
        assert_eq!(r.ok(&["rev-parse", "HEAD"]), before, "submodule pointer bump was committed");
    }

    #[tokio::test]
    async fn f5_d4_existing_gitlink_in_head_is_kept_when_its_checkout_disappears() {
        let r = Repo::new("glrm");
        r.write("a", "a\n");
        r.commit_all("init");
        let inner = r.dir.join("vault").join("cloned");
        nested_repo(&inner);
        r.ok(&["add", "vault/cloned"]);
        r.ok(&["commit", "-q", "-m", "user adds a gitlink on purpose"]);
        std::fs::remove_dir_all(&inner).unwrap();
        r.write("vault/n.md", "x\n");
        let rep = r.tick().await;
        assert_eq!(rep.outcome, AutocommitOutcome::Committed);
        assert_eq!(rep.skipped, vec!["vault/cloned".to_string()]);
        assert!(r.ok(&["ls-tree", "HEAD", "vault/cloned"]).starts_with("160000 commit "), "gitlink deletion was committed");
    }

    // --- D5: pending-marker hardening. -------------------------------------

    #[tokio::test]
    async fn f5_d5_marker_with_an_unknown_version_is_dropped_without_touching_the_index() {
        let r = Repo::new("v99");
        let s = r.marker_chain(1);
        let before = r.ok(&["ls-files", "-s"]);
        r.write_marker(&format!(r#"{{"version":99,"ref":"refs/heads/main","new":"{}","parent":"{}"}}"#, s[2], s[1]));
        let rep = r.tick().await;
        assert!(rep.recovered.as_ref().is_some_and(|x| x.dropped.is_some()), "unknown version must be dropped: {:?}", rep.recovered);
        assert!(!r.marker().exists());
        assert_eq!(r.ok(&["ls-files", "-s"]), before, "index was touched by an unknown-version marker");
    }

    #[tokio::test]
    async fn f5_d5_v2_marker_without_a_ref_is_dropped_without_touching_the_index() {
        let r = Repo::new("v2noref");
        let s = r.marker_chain(1);
        let before = r.ok(&["ls-files", "-s"]);
        r.write_marker(&format!(r#"{{"version":2,"new":"{}","parent":"{}"}}"#, s[2], s[1]));
        let rep = r.tick().await;
        assert!(rep.recovered.as_ref().is_some_and(|x| x.dropped.is_some()), "{:?}", rep.recovered);
        assert_eq!(r.ok(&["ls-files", "-s"]), before);
    }

    #[tokio::test]
    async fn f5_d5_marker_whose_parent_is_not_the_first_parent_of_new_is_dropped() {
        let r = Repo::new("forged-parent");
        let s = r.marker_chain(0);
        let before = r.ok(&["ls-files", "-s"]);
        r.write_marker(&format!(r#"{{"version":2,"ref":"refs/heads/main","new":"{}","parent":"{}"}}"#, s[2], s[0]));
        let rep = r.tick().await;
        assert!(rep.recovered.as_ref().is_some_and(|x| x.dropped.is_some()), "forged parent must be dropped: {:?}", rep.recovered);
        assert!(!r.marker().exists());
        assert_eq!(r.ok(&["ls-files", "-s"]), before, "index was synced from a forged parent");
    }

    #[tokio::test]
    async fn f5_d5_marker_whose_parent_object_is_missing_never_wedges_the_tick() {
        let r = Repo::new("missing-parent");
        r.write("vault/n.md", "A\n");
        r.commit_all("c1");
        let c1 = r.ok(&["rev-parse", "HEAD"]);
        r.write_marker(&format!(r#"{{"version":2,"ref":"refs/heads/main","new":"{c1}","parent":"{}"}}"#, "1".repeat(40)));
        r.write("vault/n.md", "B\n");
        let rep = run_autocommit_report(r.path()).await;
        let rep = rep.expect("a bad marker must not wedge the tick");
        assert!(rep.recovered.as_ref().is_some_and(|x| x.dropped.is_some()), "{:?}", rep.recovered);
        assert_eq!(rep.outcome, AutocommitOutcome::Committed);
        assert!(!r.marker().exists(), "bad marker must not survive");
        assert_eq!(r.show("HEAD:vault/n.md"), "B");
    }

    #[tokio::test]
    async fn f5_d5_consistent_v2_and_legacy_v1_markers_are_still_recovered() {
        for legacy in [false, true] {
            let r = Repo::new("consistent");
            let s = r.marker_chain(1);
            let json = if legacy {
                format!(r#"{{"new":"{}","parent":"{}"}}"#, s[2], s[1])
            } else {
                format!(r#"{{"version":2,"ref":"refs/heads/main","new":"{}","parent":"{}"}}"#, s[2], s[1])
            };
            r.write_marker(&json);
            let rep = r.tick().await;
            assert!(rep.recovered.as_ref().is_some_and(|x| x.synced), "legacy={legacy}: {:?}", rep.recovered);
            assert!(!r.marker().exists());
            assert_eq!(r.show(":vault/n.md"), "C", "recovery must sync the index to new");
            assert_eq!(r.status(), "");
        }
    }
}

/// EC5 round-4 red-team regressions (D-A filtered symlink entry, D-B/D-G
/// mid-tick rewrites, D-F CRLF), restated for the OQ-19 fail-closed rule:
/// filtered paths are refused outright, so the scratch-tree proof they once
/// exercised is gone. Mirrors the Node twin's `EC5-D*` cases case for case.
#[cfg(test)]
mod r4_regression_tests {
    use super::{run_autocommit_report, run_autocommit_report_with, AutocommitOutcome, AutocommitReport, SkipReason, TickPhase};
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};
    use std::sync::Mutex;

    const AWS_LINE: &str = "key = AKIAABCDEFGHIJKLMNOP\n";

    struct Repo {
        dir: PathBuf,
    }

    impl Repo {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("skippy-r4-{name}-{}", uuid::Uuid::new_v4()));
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

        fn raw(&self, args: &[&str], input: Option<&[u8]>) -> Vec<u8> {
            let mut child = Command::new("git")
                .arg("-C")
                .arg(&self.dir)
                .args(["-c", "core.quotepath=false"])
                .args(args)
                .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .expect("git spawn");
            if let Some(data) = input {
                use std::io::Write;
                child.stdin.take().unwrap().write_all(data).unwrap();
            }
            let out = child.wait_with_output().unwrap();
            assert!(out.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&out.stderr));
            out.stdout
        }

        fn ok(&self, args: &[&str]) -> String {
            String::from_utf8_lossy(&self.raw(args, None)).trim().to_string()
        }

        /// Exact blob bytes (no trimming).
        fn blob(&self, spec: &str) -> String {
            String::from_utf8_lossy(&self.raw(&["cat-file", "-p", spec], None)).into_owned()
        }

        fn write(&self, rel: &str, contents: impl AsRef<[u8]>) {
            let p = self.dir.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, contents).unwrap();
        }

        fn commit_all(&self, msg: &str) {
            self.ok(&["add", "-A", "."]);
            self.ok(&["commit", "-q", "-m", msg]);
        }

        fn head_tree(&self) -> Vec<String> {
            String::from_utf8_lossy(&self.raw(&["ls-tree", "-r", "-z", "--name-only", "HEAD"], None))
                .split('\0')
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect()
        }

        fn status(&self) -> String {
            self.ok(&["status", "--porcelain", "-uno"])
        }

        async fn tick(&self) -> AutocommitReport {
            run_autocommit_report(self.path()).await.expect("autocommit ok")
        }

        fn rot_filter(&self) {
            self.ok(&["config", "filter.rot.clean", "tr A-Za-z N-ZA-Mn-za-m"]);
            self.ok(&["config", "filter.rot.smudge", "tr A-Za-z N-ZA-Mn-za-m"]);
        }

        /// Commit a mode-120000 entry at `path`, then check it out as a plain
        /// file (core.symlinks=false, the Git for Windows default).
        fn symlink_as_file(&self, path: &str, target: &str) -> String {
            self.ok(&["config", "core.symlinks", "false"]);
            let blob = String::from_utf8_lossy(&self.raw(&["hash-object", "-w", "--stdin"], Some(target.as_bytes())))
                .trim()
                .to_string();
            self.ok(&["update-index", "--add", "--cacheinfo", &format!("120000,{blob},{path}")]);
            self.ok(&["commit", "-q", "-m", &format!("symlink {path}")]);
            self.ok(&["checkout", "--", path]);
            assert!(
                std::fs::symlink_metadata(self.dir.join(path)).unwrap().is_file(),
                "core.symlinks=false must check the link out as a plain file"
            );
            blob
        }
    }

    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn detail(rep: &AutocommitReport) -> Vec<(String, &'static str)> {
        rep.skipped_detail.iter().map(|(p, r)| (p.clone(), r.as_str())).collect()
    }

    fn one(path: &str, reason: SkipReason) -> Vec<(String, &'static str)> {
        vec![(path.to_string(), reason.as_str())]
    }

    #[tokio::test]
    async fn r4_da_filtered_symlink_as_file_entries_are_refused_as_filtered_path() {
        let r = Repo::new("da-rot");
        r.rot_filter();
        r.write(".gitattributes", "vault/*.txt filter=rot\n");
        r.write("vault/n.md", "x\n");
        r.commit_all("init");
        let before = r.symlink_as_file("vault/link.txt", "target.md");
        let fine_before = r.symlink_as_file("vault/fine.txt", "other.md");
        r.write("vault/link.txt", AWS_LINE);
        r.write("vault/fine.txt", "harmless new link body\n");
        r.write("vault/n.md", "y\n");
        let rep = r.tick().await;
        assert_eq!(rep.outcome, AutocommitOutcome::Committed);
        assert_eq!(
            detail(&rep),
            vec![("vault/fine.txt".to_string(), "filtered-path"), ("vault/link.txt".to_string(), "filtered-path")]
        );
        assert_eq!(
            r.ok(&["ls-tree", "HEAD", "--", "vault/link.txt"]),
            format!("120000 blob {before}\tvault/link.txt"),
            "filtered symlink secret reached history"
        );
        assert_eq!(r.ok(&["ls-tree", "HEAD", "--", "vault/fine.txt"]), format!("120000 blob {fine_before}\tvault/fine.txt"));
        assert_eq!(r.ok(&["show", "HEAD:vault/n.md"]), "y");
    }

    #[tokio::test]
    async fn r4_da_lfs_filtered_symlink_as_file_entry_never_reaches_history_or_an_lfs_pointer() {
        let has_lfs = Command::new("git").args(["lfs", "version"]).output().is_ok_and(|o| o.status.success());
        if !has_lfs {
            eprintln!("SKIP r4_da lfs: git-lfs is not installed (the rot13 case covers the mechanism)");
            return;
        }
        let r = Repo::new("da-lfs");
        r.ok(&["lfs", "install", "--local"]);
        r.write(".gitattributes", "vault/*.bin filter=lfs diff=lfs merge=lfs -text\n");
        r.write("vault/n.md", "x\n");
        r.commit_all("init");
        let before = r.symlink_as_file("vault/link.bin", "target.bin");
        r.write("vault/link.bin", format!("bin\0{AWS_LINE}"));
        r.write("vault/n.md", "y\n");
        let rep = r.tick().await;
        assert_eq!(rep.outcome, AutocommitOutcome::Committed);
        assert_eq!(detail(&rep), one("vault/link.bin", SkipReason::FilteredPath));
        assert_eq!(r.ok(&["ls-tree", "HEAD", "--", "vault/link.bin"]), format!("120000 blob {before}\tvault/link.bin"));
        assert!(!r.blob("HEAD:vault/link.bin").contains("oid sha256:"), "HEAD references an LFS object for the secret");
    }

    #[tokio::test]
    async fn r4_da_unfiltered_symlink_as_file_entry_is_scanned_and_still_commits_when_clean() {
        let r = Repo::new("da-nofilter");
        r.write("vault/n.md", "x\n");
        r.commit_all("init");
        r.symlink_as_file("vault/a.txt", "target-a.md");
        r.symlink_as_file("vault/b.txt", "target-b.md");
        r.write("vault/a.txt", "new-target.md");
        r.write("vault/b.txt", AWS_LINE);
        let rep = r.tick().await;
        assert_eq!(rep.outcome, AutocommitOutcome::Committed);
        assert_eq!(detail(&rep), one("vault/b.txt", SkipReason::SecretContent));
        assert_eq!(r.blob("HEAD:vault/a.txt"), "new-target.md");
        assert_eq!(r.blob("HEAD:vault/b.txt"), "target-b.md");
        assert_eq!(r.tick().await.outcome, AutocommitOutcome::NoOp, "the committed symlink-as-file must be stable");
    }

    #[tokio::test]
    async fn r4_da_filtered_real_symlink_is_refused_as_filtered_path() {
        let r = Repo::new("da-real");
        r.rot_filter();
        r.ok(&["config", "core.symlinks", "true"]);
        r.write(".gitattributes", "vault/*.txt filter=rot\n");
        r.write("vault/n.md", "x\n");
        r.commit_all("init");
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_file("n.md", r.dir.join("vault/link.txt"));
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink("n.md", r.dir.join("vault/link.txt"));
        if let Err(e) = made {
            eprintln!("SKIP r4_da real symlink: cannot create a real symlink here ({e}); needs Developer Mode on Windows");
            return;
        }
        r.write("vault/n.md", "y\n");
        let rep = r.tick().await;
        assert_eq!(rep.outcome, AutocommitOutcome::Committed);
        assert_eq!(detail(&rep), one("vault/link.txt", SkipReason::FilteredPath));
        assert!(!r.head_tree().contains(&"vault/link.txt".to_string()));
    }

    #[tokio::test]
    async fn r4_db_bytes_written_after_the_add_never_change_what_is_committed() {
        let r = Repo::new("db-after");
        r.write("vault/s.md", "v0\n");
        r.commit_all("init");
        let file = r.dir.join("vault/s.md");
        std::fs::write(&file, "clean v1\n").unwrap();
        let phases = Mutex::new(Vec::new());
        let hook = |phase: TickPhase| {
            phases.lock().unwrap().push(phase);
            if phase == TickPhase::Added {
                std::fs::write(&file, AWS_LINE).unwrap();
            }
        };
        let rep = run_autocommit_report_with(r.path(), Some(&hook)).await.expect("autocommit ok");
        assert_eq!(*phases.lock().unwrap(), vec![TickPhase::Added, TickPhase::Scanned]);
        assert_eq!(rep.outcome, AutocommitOutcome::Committed);
        assert!(rep.skipped_detail.is_empty(), "{:?}", rep.skipped_detail);
        assert_eq!(r.ok(&["show", "HEAD:vault/s.md"]), "clean v1", "the staged (scanned) bytes must be what was committed");
        let next = r.tick().await;
        assert_eq!(detail(&next), one("vault/s.md", SkipReason::SecretContent), "the later key write is caught next tick");
        assert_eq!(r.ok(&["show", "HEAD:vault/s.md"]), "clean v1");
    }

    #[tokio::test]
    async fn r4_dg_vault_gitattributes_flip_between_add_and_check_attr_defers_the_tick() {
        let r = Repo::new("dg-attrflip");
        r.rot_filter();
        r.write("vault/.gitattributes", "*.txt filter=rot\n");
        r.write("vault/n.md", "x\n");
        r.commit_all("init");
        r.write("vault/s.txt", AWS_LINE); // `add` cleans this through rot13
        let attrs = r.dir.join("vault/.gitattributes");
        let hook = |phase: TickPhase| {
            if phase == TickPhase::Added {
                std::fs::write(&attrs, "# filter removed\n").unwrap(); // check-attr now says "no filter"
            }
        };
        let rep = run_autocommit_report_with(r.path(), Some(&hook)).await.expect("autocommit ok");
        assert_eq!(rep.outcome, AutocommitOutcome::NoOp);
        assert!(!r.head_tree().contains(&"vault/s.txt".to_string()), "rot13 secret reached history via an attribute flip");
        assert_eq!(detail(&rep), one("vault/s.txt", SkipReason::AttributesChanged));
        // Next tick: attributes are stable (no filter), so the raw key is scanned.
        let next = r.tick().await;
        assert_eq!(next.outcome, AutocommitOutcome::Committed);
        assert_eq!(detail(&next), one("vault/s.txt", SkipReason::SecretContent));
        assert_eq!(r.ok(&["show", "HEAD:vault/.gitattributes"]), "# filter removed");
        assert!(!r.head_tree().contains(&"vault/s.txt".to_string()));
    }

    #[tokio::test]
    async fn r4_dg_unfiltered_note_rewritten_mid_tick_commits_the_staged_bytes_then_the_rewrite() {
        let r = Repo::new("dg-defer");
        r.write("vault/n.md", "v0\n");
        r.commit_all("init");
        r.write("vault/n.md", "v1\n");
        let file = r.dir.join("vault/n.md");
        let hook = |phase: TickPhase| {
            if phase == TickPhase::Added {
                std::fs::write(&file, "v2\n").unwrap();
            }
        };
        let rep = run_autocommit_report_with(r.path(), Some(&hook)).await.expect("autocommit ok");
        assert_eq!(rep.outcome, AutocommitOutcome::Committed);
        assert!(rep.skipped_detail.is_empty(), "{:?}", rep.skipped_detail);
        assert_eq!(r.ok(&["show", "HEAD:vault/n.md"]), "v1");
        assert_eq!(r.tick().await.outcome, AutocommitOutcome::Committed);
        assert_eq!(r.ok(&["show", "HEAD:vault/n.md"]), "v2");
        assert_eq!(r.status(), "");
    }

    #[tokio::test]
    async fn r4_df_unchanged_crlf_file_under_autocrlf_commits_on_the_first_tick() {
        let r = Repo::new("df-crlf");
        r.ok(&["config", "core.autocrlf", "false"]);
        r.write("vault/n.md", "line1\r\nline2\r\n");
        r.commit_all("init"); // HEAD blob keeps its CRLFs
        r.ok(&["config", "core.autocrlf", "true"]);
        r.write("vault/n.md", "line1\r\nline2\r\nline3\r\n");
        let rep = r.tick().await;
        assert!(rep.skipped_detail.is_empty(), "{:?}", rep.skipped_detail);
        assert_eq!(rep.outcome, AutocommitOutcome::Committed);
        assert_eq!(r.blob("HEAD:vault/n.md"), "line1\r\nline2\r\nline3\r\n", "blob must match what `git add` stores");
        assert_eq!(r.status(), "");
        assert_eq!(r.tick().await.outcome, AutocommitOutcome::NoOp);
    }
}

/// EC5 round-5 (OQ-19 fail-closed rule): every red-team repro from round 4's
/// re-verification. Mirrors the Node twin's `EC5-R5-*` cases case for case.
/// Self-contained on purpose (only `run_autocommit_report[_with]`,
/// `TickPhase`, the report fields and `SkipReason::as_str` plus the git CLI),
/// so the same module also compiles against b3e9af0, where R5-1 and R5-3
/// leak.
#[cfg(test)]
mod r5_regression_tests {
    use super::{run_autocommit_report, run_autocommit_report_with, AutocommitOutcome, AutocommitReport, TickPhase};
    use std::collections::BTreeSet;
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};
    use std::sync::Mutex;
    use std::time::{Duration, SystemTime};

    const AWS_LINE: &str = "key = AKIAABCDEFGHIJKLMNOP\n";
    const OID_TAIL: &str = "oid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 12\n";

    struct Repo {
        dir: PathBuf,
    }

    impl Repo {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("skippy-r5-{name}-{}", uuid::Uuid::new_v4()));
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

        fn raw(&self, args: &[&str], input: Option<&[u8]>) -> Vec<u8> {
            let mut child = Command::new("git")
                .arg("-C")
                .arg(&self.dir)
                .args(["-c", "core.quotepath=false"])
                .args(args)
                .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .expect("git spawn");
            if let Some(data) = input {
                use std::io::Write;
                child.stdin.take().unwrap().write_all(data).unwrap();
            }
            let out = child.wait_with_output().unwrap();
            assert!(out.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&out.stderr));
            out.stdout
        }

        fn ok(&self, args: &[&str]) -> String {
            String::from_utf8_lossy(&self.raw(args, None)).trim().to_string()
        }

        fn blob(&self, spec: &str) -> String {
            String::from_utf8_lossy(&self.raw(&["cat-file", "-p", spec], None)).into_owned()
        }

        fn write(&self, rel: &str, contents: impl AsRef<[u8]>) {
            let p = self.dir.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, contents).unwrap();
        }

        fn commit_all(&self, msg: &str) {
            self.ok(&["add", "-A", "."]);
            self.ok(&["commit", "-q", "-m", msg]);
        }

        fn head_tree(&self) -> Vec<String> {
            String::from_utf8_lossy(&self.raw(&["ls-tree", "-r", "-z", "--name-only", "HEAD"], None))
                .split('\0')
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect()
        }

        fn status(&self) -> String {
            self.ok(&["status", "--porcelain", "-uno"])
        }

        async fn tick(&self) -> AutocommitReport {
            run_autocommit_report(self.path()).await.expect("autocommit ok")
        }

        fn rot_filter(&self) {
            self.ok(&["config", "filter.rot.clean", "tr A-Za-z N-ZA-Mn-za-m"]);
            self.ok(&["config", "filter.rot.smudge", "tr A-Za-z N-ZA-Mn-za-m"]);
        }
    }

    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn detail(rep: &AutocommitReport) -> Vec<(String, &'static str)> {
        rep.skipped_detail.iter().map(|(p, r)| (p.clone(), r.as_str())).collect()
    }

    fn d(pairs: &[(&str, &'static str)]) -> Vec<(String, &'static str)> {
        pairs.iter().map(|(p, r)| (p.to_string(), *r)).collect()
    }

    fn rot13(s: &str) -> String {
        s.chars()
            .map(|c| match c {
                'a'..='z' => (((c as u8 - b'a') + 13) % 26 + b'a') as char,
                'A'..='Z' => (((c as u8 - b'A') + 13) % 26 + b'A') as char,
                _ => c,
            })
            .collect()
    }

    fn has_git_lfs() -> bool {
        Command::new("git").args(["lfs", "version"]).output().is_ok_and(|o| o.status.success())
    }

    fn strs(v: &[String]) -> Vec<&str> {
        v.iter().map(String::as_str).collect()
    }

    #[tokio::test]
    async fn r5_1_lfs_pointer_passthrough_never_reaches_head_or_a_file_remote() {
        if !has_git_lfs() {
            eprintln!("SKIP r5_1: git-lfs is not installed");
            return;
        }
        let r = Repo::new("lfsptr");
        r.ok(&["config", "--unset", "core.hooksPath"]); // the LFS pre-push hook must run
        r.ok(&["lfs", "install", "--local"]);
        r.write(".gitattributes", "vault/*.bin filter=lfs diff=lfs merge=lfs -text\n");
        r.write("vault/n.md", "x\n");
        r.commit_all("init");
        r.write("vault/k.bin", AWS_LINE);
        let pointer = String::from_utf8(r.raw(&["lfs", "pointer", "--file=vault/k.bin"], None)).unwrap();
        let sha = pointer
            .lines()
            .find_map(|l| l.strip_prefix("oid sha256:"))
            .expect("pointer oid")
            .to_string();
        let t1 = r.tick().await;
        // The user (or a tool) swaps the file for its pointer; the same
        // pointer also lands at a path no filter attribute covers.
        r.write("vault/k.bin", &pointer);
        r.write("vault/p.txt", &pointer);
        r.write("vault/n.md", "y\n");
        let t2 = r.tick().await;
        let bare = std::env::temp_dir().join(format!("skippy-r5-remote-{}", uuid::Uuid::new_v4()));
        let bare_str = bare.to_string_lossy().into_owned();
        assert!(Command::new("git").args(["init", "-q", "--bare", &bare_str]).status().unwrap().success());
        let url = format!("file:///{}", bare_str.replace('\\', "/").trim_start_matches('/'));
        r.ok(&["remote", "add", "origin", &url]);
        r.ok(&["push", "-q", "origin", "main"]);
        let lfs_obj = bare.join("lfs").join("objects").join(&sha[..2]).join(&sha[2..4]).join(&sha);
        let uploaded = lfs_obj.exists();
        let remote_tree = Command::new("git")
            .args(["-C", &bare_str, "ls-tree", "-r", "--name-only", "main"])
            .output()
            .unwrap();
        let _ = std::fs::remove_dir_all(&bare);
        assert!(!uploaded, "git push uploaded the secret LFS object to the remote");
        assert_eq!(String::from_utf8_lossy(&remote_tree.stdout).trim(), ".gitattributes\nvault/n.md");
        assert_eq!(strs(&r.head_tree()), vec![".gitattributes", "vault/n.md"]);
        assert!(!r.ok(&["log", "-p", "--all"]).contains(&sha), "history references the secret LFS object");
        assert_eq!(detail(&t1), d(&[("vault/k.bin", "filtered-path")]));
        assert_eq!(t2.outcome, AutocommitOutcome::Committed);
        assert_eq!(detail(&t2), d(&[("vault/k.bin", "filtered-path"), ("vault/p.txt", "lfs-pointer")]));
    }

    #[tokio::test]
    async fn r5_2_lfs_pointer_text_without_a_filter_attribute_is_refused_as_lfs_pointer() {
        let r = Repo::new("lfsnofilter");
        r.write("vault/n.md", "x\n");
        r.commit_all("init");
        r.write("vault/a.md", format!("version https://git-lfs.github.com/spec/v1\n{OID_TAIL}"));
        r.write("vault/b.md", format!("\r\n  version https://hawser.github.com/spec/v1\r\n{OID_TAIL}"));
        r.write("vault/c.md", format!("version http://git-media.io/v/2\n{OID_TAIL}"));
        r.write(
            "vault/d.md",
            "The magnificent Skippy keeps the monkeys' photos in git-lfs (spec: https://git-lfs.github.com/spec/v1).\n",
        );
        let rep = r.tick().await;
        assert_eq!(rep.outcome, AutocommitOutcome::Committed);
        assert_eq!(
            detail(&rep),
            d(&[("vault/a.md", "lfs-pointer"), ("vault/b.md", "lfs-pointer"), ("vault/c.md", "lfs-pointer")])
        );
        assert_eq!(strs(&r.head_tree()), vec!["vault/d.md", "vault/n.md"]);
    }

    #[tokio::test]
    async fn r5_3_attribute_flip_between_add_and_the_scan_defers_the_tick_and_never_commits_the_filtered_blob() {
        // The red-team repro: a filter active during `add` (here from the
        // local, never-committed info/attributes) is switched off right after
        // it, and the file is rewritten to what the filter produced, so every
        // later look (check-attr, the working tree) says "plain, clean file".
        let r = Repo::new("attrflip");
        r.rot_filter();
        r.ok(&["config", "core.autocrlf", "false"]);
        let info = r.dir.join(".git").join("info").join("attributes");
        std::fs::create_dir_all(info.parent().unwrap()).unwrap();
        std::fs::write(&info, "vault/*.txt filter=rot\n").unwrap();
        r.write("vault/n.md", "x\n");
        r.commit_all("init");
        r.write("vault/s.txt", AWS_LINE); // `add` cleans this into rot13(AWS_LINE)
        r.write("vault/n.md", "y\n");
        let s_txt = r.dir.join("vault/s.txt");
        let hook = |phase: TickPhase| {
            if phase == TickPhase::Added {
                std::fs::write(&info, "# no filter\n").unwrap();
                std::fs::write(&s_txt, rot13(AWS_LINE)).unwrap();
            }
        };
        let rep = run_autocommit_report_with(r.path(), Some(&hook)).await.expect("autocommit ok");
        assert!(!r.head_tree().contains(&"vault/s.txt".to_string()), "the rot13-filtered secret blob reached history");
        assert_eq!(rep.outcome, AutocommitOutcome::NoOp);
        assert_eq!(detail(&rep), d(&[("vault/n.md", "attributes-changed"), ("vault/s.txt", "attributes-changed")]));
        assert_eq!(r.ok(&["show", "HEAD:vault/n.md"]), "x");
        // A flip after both check-attr runs (the Scanned phase) defers too.
        std::fs::write(&info, "vault/*.txt filter=rot\n").unwrap();
        let late_hook = |phase: TickPhase| {
            if phase == TickPhase::Scanned {
                std::fs::write(&info, "# no filter\n").unwrap();
            }
        };
        let late = run_autocommit_report_with(r.path(), Some(&late_hook)).await.expect("autocommit ok");
        assert_eq!(late.outcome, AutocommitOutcome::NoOp);
        assert_eq!(
            late.skipped_detail.iter().map(|(_, x)| x.as_str()).collect::<Vec<_>>(),
            vec!["attributes-changed", "attributes-changed"]
        );
        // Stable attributes again: the note commits; s.txt holds exactly the
        // (non-secret) bytes the user wrote, and no attribute decodes it.
        let next = r.tick().await;
        assert_eq!(next.outcome, AutocommitOutcome::Committed);
        assert!(next.skipped_detail.is_empty(), "{:?}", next.skipped_detail);
        assert_eq!(r.ok(&["show", "HEAD:vault/n.md"]), "y");
        assert_eq!(r.blob("HEAD:vault/s.txt"), rot13(AWS_LINE));
    }

    #[tokio::test]
    async fn r5_3_deleted_gitattributes_still_applied_through_the_index_is_refused_by_the_pre_add_evaluation() {
        let r = Repo::new("idxattr");
        r.rot_filter();
        r.ok(&["config", "core.autocrlf", "false"]);
        r.write("vault/sub/.gitattributes", "*.txt filter=rot\n");
        r.write("vault/sub/s.txt", "v0\n");
        r.commit_all("init");
        std::fs::remove_file(r.dir.join("vault/sub/.gitattributes")).unwrap();
        r.write("vault/sub/s.txt", "clean v1\n");
        let rep = r.tick().await;
        assert_eq!(rep.outcome, AutocommitOutcome::Committed);
        assert_eq!(detail(&rep), d(&[("vault/sub/s.txt", "filtered-path")]));
        assert!(!r.head_tree().contains(&"vault/sub/.gitattributes".to_string()), "the .gitattributes deletion must commit");
        let next = r.tick().await;
        assert_eq!(next.outcome, AutocommitOutcome::Committed);
        assert!(next.skipped_detail.is_empty(), "{:?}", next.skipped_detail);
        assert_eq!(r.blob("HEAD:vault/sub/s.txt"), "clean v1\n");
        assert_eq!(r.status(), "");
    }

    #[tokio::test]
    async fn r5_4_gitignore_negation_of_an_info_exclude_or_excludes_file_rule_never_stalls_unrelated_notes() {
        {
            let r = Repo::new("ignneg");
            r.write("vault/.gitignore", "!keep.log\n");
            r.write("vault/a.md", "a\n");
            r.commit_all("init");
            std::fs::write(r.dir.join(".git").join("info").join("exclude"), "*.log\n").unwrap();
            r.write("vault/keep.log", "log line\n");
            r.write("vault/a.md", "a2\n");
            r.write("vault/b.md", "b\n");
            let rep = r.tick().await;
            assert_eq!(rep.outcome, AutocommitOutcome::Committed);
            assert!(rep.skipped_detail.is_empty(), "{:?}", rep.skipped_detail);
            assert_eq!(strs(&r.head_tree()), vec!["vault/.gitignore", "vault/a.md", "vault/b.md", "vault/keep.log"]);
            assert_eq!(r.tick().await.outcome, AutocommitOutcome::NoOp);
        }
        {
            let r = Repo::new("ignnegg");
            let excludes = r.dir.join(".git").join("global-excludes");
            std::fs::write(&excludes, "*.tmp\n").unwrap();
            r.ok(&["config", "core.excludesFile", &excludes.to_string_lossy()]);
            r.write(".gitignore", "!vault/keep.tmp\n");
            r.write("vault/a.md", "a\n");
            r.commit_all("init");
            r.write("vault/keep.tmp", "x\n");
            r.write("vault/n.md", "n\n");
            let rep = r.tick().await;
            assert_eq!(rep.outcome, AutocommitOutcome::Committed);
            assert!(rep.skipped_detail.is_empty(), "{:?}", rep.skipped_detail);
            assert_eq!(strs(&r.head_tree()), vec![".gitignore", "vault/a.md", "vault/keep.tmp", "vault/n.md"]);
        }
    }

    #[tokio::test]
    async fn r5_5_relative_and_non_deterministic_filters_are_filtered_path_for_their_own_paths_only() {
        let r = Repo::new("relf");
        r.ok(&["config", "filter.rel.clean", "sh tools/clean.sh"]);
        r.ok(&["config", "filter.rel.smudge", "cat"]);
        r.ok(&["config", "filter.rel.required", "true"]);
        r.ok(&["config", "filter.relopt.clean", "sh tools/clean.sh"]);
        r.ok(&["config", "filter.nd.clean", "cat; echo $$"]);
        r.ok(&["config", "filter.nd.smudge", "cat"]);
        r.write("tools/clean.sh", "tr a-z A-Z\n");
        r.write(".gitattributes", "vault/*.up filter=rel\nvault/*.opt filter=relopt\nvault/*.nd filter=nd\n");
        r.write("vault/a.md", "a\n");
        r.commit_all("init");
        r.write("vault/x.up", "hello\n");
        r.write("vault/y.opt", "hello\n");
        r.write("vault/z.nd", "data\n");
        r.write("vault/note.md", "plain note\n");
        let want = d(&[("vault/x.up", "filtered-path"), ("vault/y.opt", "filtered-path"), ("vault/z.nd", "filtered-path")]);
        let rep = r.tick().await;
        assert_eq!(rep.outcome, AutocommitOutcome::Committed);
        assert_eq!(detail(&rep), want);
        assert_eq!(r.ok(&["show", "HEAD:vault/note.md"]), "plain note");
        let again = r.tick().await;
        assert_eq!(again.outcome, AutocommitOutcome::NoOp);
        assert_eq!(detail(&again), want);
    }

    #[tokio::test]
    async fn r5_6_sparse_checkout_never_fails_the_tick_in_cone_notes_commit_out_of_cone_paths_are_flagged() {
        let r = Repo::new("sparse");
        r.write("vault/a/1.md", "1\n");
        r.write("vault/b/2.md", "2\n");
        r.write("vault/c.md", "c\n");
        r.commit_all("init");
        r.ok(&["sparse-checkout", "set", "vault/a"]);
        assert!(!r.dir.join("vault/b/2.md").exists(), "vault/b must be outside the cone");
        r.write("vault/a/1.md", "1b\n");
        r.write("vault/a/n2.md", "new in cone\n");
        r.write("vault/c.md", "c2\n");
        r.write("vault/b/new.md", "new outside the cone\n");
        let want = d(&[("vault/b/2.md", "flagged"), ("vault/b/new.md", "flagged")]);
        let rep = r.tick().await;
        assert_eq!(rep.outcome, AutocommitOutcome::Committed);
        assert_eq!(detail(&rep), want);
        assert_eq!(strs(&r.head_tree()), vec!["vault/a/1.md", "vault/a/n2.md", "vault/b/2.md", "vault/c.md"]);
        assert_eq!(r.ok(&["show", "HEAD:vault/a/1.md"]), "1b");
        assert!(r.ok(&["ls-files", "-v", "--", "vault/b/2.md"]).starts_with("S "), "the skip-worktree flag must survive");
        let again = r.tick().await;
        assert_eq!(again.outcome, AutocommitOutcome::NoOp);
        assert_eq!(detail(&again), want);
    }

    fn hex16() -> String {
        uuid::Uuid::new_v4().simple().to_string()[..16].to_string()
    }

    /// Backdate a directory's mtime (no `filetime` dependency).
    fn set_dir_mtime(dir: &Path, t: SystemTime) {
        #[cfg(windows)]
        let f = {
            use std::os::windows::fs::OpenOptionsExt;
            std::fs::OpenOptions::new()
                .access_mode(0x0100) // FILE_WRITE_ATTRIBUTES
                .custom_flags(0x0200_0000) // FILE_FLAG_BACKUP_SEMANTICS: open a directory
                .open(dir)
                .unwrap()
        };
        #[cfg(not(windows))]
        let f = std::fs::File::open(dir).unwrap();
        f.set_modified(t).unwrap();
    }

    fn make_dir_link(target: &Path, link: &Path) -> bool {
        #[cfg(windows)]
        {
            Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(link)
                .arg(target)
                .stdout(Stdio::null())
                .status()
                .is_ok_and(|s| s.success())
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link).is_ok()
        }
    }

    #[tokio::test]
    async fn r5_7_stale_temp_dirs_are_swept_never_through_a_junction_and_a_tick_writes_no_vault_content_to_temp() {
        let tmp = std::env::temp_dir();
        let stale = tmp.join(format!("skippy-ac-{}", hex16()));
        let fresh = tmp.join(format!("skippy-ac-{}", hex16()));
        let odd = tmp.join(format!("skippy-ac-{}-x", hex16()));
        let link = tmp.join(format!("skippy-ac-{}", hex16()));
        let target = tmp.join(format!("skippy-r5-target-{}", uuid::Uuid::new_v4()));
        let old = SystemTime::now() - Duration::from_secs(2 * 60 * 60);
        for dir in [&stale, &fresh, &odd] {
            std::fs::create_dir_all(dir.join("wt").join("vault")).unwrap();
            std::fs::write(dir.join("wt").join("vault").join("a.md"), "private journal entry\n").unwrap();
        }
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("keep.md"), "not ours\n").unwrap();
        let have_link = make_dir_link(&target, &link);
        for dir in [&stale, &odd] {
            set_dir_mtime(dir, old);
        }
        let names = |dir: &Path| -> BTreeSet<String> {
            std::fs::read_dir(dir)
                .unwrap()
                .flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| n.starts_with("skippy-ac-"))
                .collect()
        };
        let before = names(&tmp);
        let seen: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());
        let r = Repo::new("sweep");
        r.write("vault/a.md", "a\n");
        r.commit_all("init");
        r.write("vault/a.md", "private journal entry, edited\n");
        let hook = |_: TickPhase| {
            for n in names(&tmp).difference(&before) {
                for e in std::fs::read_dir(tmp.join(n)).into_iter().flatten().flatten() {
                    let kind = if e.file_type().is_ok_and(|t| t.is_dir()) { "dir" } else { "file" };
                    seen.lock().unwrap().insert(format!("{kind}:{}", e.file_name().to_string_lossy()));
                }
            }
        };
        let rep = run_autocommit_report_with(r.path(), Some(&hook)).await.expect("autocommit ok");
        let stale_gone = !stale.exists();
        let fresh_kept = fresh.exists();
        let odd_kept = odd.exists();
        let link_kept = std::fs::symlink_metadata(&link).is_ok_and(|m| m.file_type().is_symlink());
        let target_intact = target.join("keep.md").exists();
        for dir in [&stale, &fresh, &odd, &target] {
            let _ = std::fs::remove_dir_all(dir);
        }
        let _ = std::fs::remove_dir(&link);
        assert_eq!(rep.outcome, AutocommitOutcome::Committed);
        assert!(stale_gone, "a stale skippy-ac dir must be swept");
        assert!(fresh_kept, "a fresh skippy-ac dir (a live tick) must be kept");
        assert!(odd_kept, "a dir that only resembles the name must be kept");
        if have_link {
            assert!(link_kept, "a junction named like a temp dir must not be removed");
            assert!(target_intact, "the sweep must never follow a junction");
        } else {
            eprintln!("SKIP r5_7 junction sub-case: cannot create a directory link here");
        }
        let seen = seen.into_inner().unwrap();
        assert!(!seen.is_empty(), "the tick must have created its own temp dir");
        // Other tests run concurrently: their ticks' dirs may also show up
        // (with the sync step's pathspec file, or a transient index.lock).
        let allowed: BTreeSet<String> =
            ["file:index", "file:seed-index", "file:pathspec", "file:index.lock"].iter().map(|s| s.to_string()).collect();
        assert!(seen.is_subset(&allowed), "only index/pathspec files may live in a tick's temp dir: {seen:?}");
    }
}
