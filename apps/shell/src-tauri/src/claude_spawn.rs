//! Eligibility gate + argument builder for `claude_code_spawn` (PRD §6.2
//! FR-SEC-01 "an incapable adapter is ineligible"; handoff T10).
//!
//! The PTY-spawned `claude` CLI has NO enforced charter policy in M0: the
//! Rust shell cannot run the runtime's `canUseTool` / `PreToolUse` broker
//! inside a foreign process, so whatever the user's own `~/.claude`
//! permissions, hooks and MCP servers allow would apply instead of the
//! charter (red-team N3). Until the proper Claude CLI adapter lands (T10) this
//! lane is therefore *ineligible* and refuses to run.
//!
//! A developer may opt in explicitly with `SKIPPY_ALLOW_UNGATED_CLAUDE_SPAWN=1`
//! (any other value, including "true", is NOT an opt-in). Even then the spawn
//! carries the strongest native flags the installed CLI offers — verified
//! against the bundled `claude.exe --help` (Claude Code 2.1.162) and the Agent
//! SDK's own flag serialisation in `sdk.mjs`:
//!
//! * `--permission-mode default`   (choices: acceptEdits, auto,
//!   bypassPermissions, default, dontAsk, plan) — never bypassPermissions.
//! * `--setting-sources=`          — empty list; the SDK serialises
//!   `settingSources: []` as exactly this, so ambient user/project/local
//!   `permissions.allow` rules and hooks do not load.
//! * `--strict-mcp-config`         — "Only use MCP servers from --mcp-config,
//!   ignoring all other MCP configurations"; we pass no --mcp-config, so none.
//! * no `--dangerously-skip-permissions`, no `--allow-dangerously-skip-permissions`.
//! * `--` before the brief — `-p`/`--print` is a boolean flag and the prompt is
//!   the positional argument, so a brief beginning with `-` used to be parsed
//!   as an option: `-p --dangerously-skip-permissions` produced
//!   `permissionMode=bypassPermissions` in the real CLI's init message
//!   (red-team F2 D4). Verified live against the bundled claude.exe 2.1.162:
//!   `-p <flags> -- --dangerously-skip-permissions` reports
//!   `permissionMode=default` and a brief such as `-p --help -- the real
//!   brief` is accepted verbatim as the prompt. The brief is never an argv
//!   token before `--`, and `--model` only ever receives a validated id.
//!
//! The working directory of the spawned CLI is validated by `validate_cwd`
//! with the same rules as the runtime's TypeScript `rootRejection`
//! (FR-SEC-02): absolute, no UNC/verbatim/device forms, no `..`/8.3 segments,
//! not a drive root, not the home directory or an ancestor of it, not a
//! dot-directory directly under home or the `AppData` profile directories,
//! not a well-known credential directory (`.ssh`, `.aws`, …) or inside one —
//! checked on the literal path AND on its canonical real path; and it must
//! be an existing directory. The default (`.git` walk-up from the shell's own
//! cwd) is validated the same way.
//!
//! Everything here is a pure function so it can be unit-tested without Tauri.

use std::path::{Component, Path, PathBuf, Prefix};

use serde::Serialize;

/// Environment variable that opts a developer into the ungated lane.
pub const OPT_IN_ENV: &str = "SKIPPY_ALLOW_UNGATED_CLAUDE_SPAWN";

/// Stable error code for the refusal; the renderer keys its tooltip on it.
pub const INELIGIBLE_CODE: &str = "ineligible";

/// Structured refusal returned to the renderer instead of a bare string.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SpawnRefusal {
    pub code: &'static str,
    pub message: String,
}

/// Availability of the spawn lane, queried by the UI to disable the slot.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SpawnAvailability {
    pub available: bool,
    /// Human-readable reason when unavailable (or a loud notice when the
    /// ungated opt-in is active).
    pub reason: Option<String>,
    /// True when the developer opt-in is active.
    #[serde(rename = "ungatedOptIn")]
    pub ungated_opt_in: bool,
}

/// The refusal message. Kept as one constant so the UI, logs and tests agree.
pub const INELIGIBLE_MESSAGE: &str =
    "ineligible: no enforced charter policy — the PTY claude lane cannot enforce a charter (FR-SEC-01); see T10. Developer override: SKIPPY_ALLOW_UNGATED_CLAUDE_SPAWN=1";

/// Is `value` (the raw env var) an explicit opt-in? Only the literal `1`.
pub fn is_opted_in(value: Option<&str>) -> bool {
    matches!(value.map(str::trim), Some("1"))
}

/// Decide whether the lane may run. `Err` carries the structured refusal.
pub fn gate(opt_in_value: Option<&str>) -> Result<(), SpawnRefusal> {
    if is_opted_in(opt_in_value) {
        Ok(())
    } else {
        Err(SpawnRefusal {
            code: INELIGIBLE_CODE,
            message: INELIGIBLE_MESSAGE.to_string(),
        })
    }
}

/// Availability as the UI sees it.
pub fn availability(opt_in_value: Option<&str>) -> SpawnAvailability {
    match gate(opt_in_value) {
        Ok(()) => SpawnAvailability {
            available: true,
            reason: Some(format!(
                "UNGATED developer lane ({OPT_IN_ENV}=1): the charter policy is NOT enforced; only native CLI flags apply"
            )),
            ungated_opt_in: true,
        },
        Err(r) => SpawnAvailability {
            available: false,
            reason: Some(r.message),
            ungated_opt_in: false,
        },
    }
}

/// A model id the CLI's `--model` may receive: a plain token (letters, digits,
/// `.`, `_`, `-`, `:`), never starting with `-`, so it can never be read as a
/// flag.
pub fn model_rejection(model: &str) -> Option<String> {
    let m = model.trim();
    if m.is_empty() {
        return Some("model must not be empty".to_string());
    }
    if m.starts_with('-') {
        return Some(format!("model {m:?} starts with '-' (would be parsed as a flag)"));
    }
    if !m
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':'))
    {
        return Some(format!("model {m:?} contains characters outside [A-Za-z0-9._:-]"));
    }
    None
}

/// Build the structured argument vector for `claude`. Pure; no shell.
///
/// `-p` (one-shot print mode), `--model <id>`, `--output-format stream-json`
/// (+ `--verbose`, which the CLI requires with stream-json in print mode),
/// the native restriction flags described in the module docs, then `--` and
/// the brief as the positional prompt. The brief is only ever the token after
/// `--`, so it cannot become an option (F2 D4). Refuses an empty brief (the
/// CLI would fall back to reading stdin) or an unsafe model id.
pub fn build_args(task_brief: &str, model: &str) -> Result<Vec<String>, SpawnRefusal> {
    let refusal = |message: String| SpawnRefusal {
        code: "spawn_failed",
        message,
    };
    if task_brief.trim().is_empty() {
        return Err(refusal("task_brief must not be empty".to_string()));
    }
    if let Some(why) = model_rejection(model) {
        return Err(refusal(format!("model rejected: {why}")));
    }
    Ok(vec![
        "-p".to_string(),
        "--model".to_string(),
        model.trim().to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--permission-mode".to_string(),
        "default".to_string(),
        "--setting-sources=".to_string(),
        "--strict-mcp-config".to_string(),
        "--".to_string(),
        task_brief.to_string(),
    ])
}

// ---------- working directory validation (F2 D4; FR-SEC-02) ----------

/// Directory names that are credential stores wherever they appear (mirrors
/// `CREDENTIAL_DIR_SEGMENTS` in the runtime's tool-policy.ts).
const CREDENTIAL_DIR_SEGMENTS: &[&str] = &[".ssh", ".aws", ".gnupg", ".kube", ".azure", ".docker"];

/// Profile directories directly under the home directory that are never a
/// working directory by themselves (mirrors `HOME_PROFILE_DIRS`).
const HOME_PROFILE_DIRS: &[&str] = &["appdata", "appdata/local", "appdata/roaming", "appdata/locallow"];

fn segment_key(s: &str) -> String {
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s.to_string()
    }
}

/// Normal (non-prefix, non-root) segments of an absolute path, lower-cased on
/// Windows. `None` when the path has a prefix form that cannot be reasoned
/// about (UNC, verbatim `\\?\`, device) or contains `.`/`..` segments.
fn normal_segments(p: &Path) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for c in p.components() {
        match c {
            Component::Prefix(pre) => match pre.kind() {
                Prefix::Disk(_) => {}
                Prefix::VerbatimDisk(_) => return Err("verbatim (\\\\?\\) paths are not permitted".to_string()),
                Prefix::UNC(_, _) | Prefix::VerbatimUNC(_, _) => return Err("UNC paths are not permitted".to_string()),
                Prefix::Verbatim(_) | Prefix::DeviceNS(_) => return Err("device/verbatim paths are not permitted".to_string()),
            },
            Component::RootDir => {}
            Component::CurDir => return Err("'.' segments are not permitted".to_string()),
            Component::ParentDir => return Err("'..' segments are not permitted".to_string()),
            Component::Normal(s) => {
                let s = s.to_str().ok_or_else(|| "non-UTF-8 path segment".to_string())?;
                if s.contains('~') && s.chars().zip(s.chars().skip(1)).any(|(a, b)| a == '~' && b.is_ascii_digit()) {
                    return Err(format!("segment {s:?} looks like an 8.3 short name"));
                }
                if s.ends_with('.') || s.ends_with(' ') {
                    return Err(format!("segment {s:?} ends in a dot or space"));
                }
                out.push(segment_key(s));
            }
        }
    }
    Ok(out)
}

/// Why `cwd` may not be the working directory of a spawned CLI, or `None`.
/// Pure: `home` is injected. Mirrors the runtime's `rootRejection`.
pub fn cwd_rejection(cwd: &Path, home: Option<&Path>) -> Option<String> {
    if !cwd.is_absolute() {
        return Some("cwd must be an absolute path".to_string());
    }
    let segs = match normal_segments(cwd) {
        Ok(s) => s,
        Err(why) => return Some(why),
    };
    if segs.is_empty() {
        return Some("a drive or filesystem root may not be the cwd".to_string());
    }
    if let Some(seg) = segs.iter().find(|s| CREDENTIAL_DIR_SEGMENTS.contains(&s.as_str())) {
        return Some(format!("{seg} is a credential store directory"));
    }
    if let Some(home) = home {
        if let Ok(hsegs) = normal_segments(home) {
            let same_drive = drive_key(cwd) == drive_key(home);
            if same_drive && !hsegs.is_empty() {
                if segs.len() <= hsegs.len() && hsegs[..segs.len()] == segs[..] {
                    return Some(if segs.len() == hsegs.len() {
                        "the user home directory may not be the cwd".to_string()
                    } else {
                        "an ancestor of the user home directory may not be the cwd".to_string()
                    });
                }
                if segs.len() > hsegs.len() && segs[..hsegs.len()] == hsegs[..] {
                    let rel = &segs[hsegs.len()..];
                    if rel[0].starts_with('.') {
                        return Some(format!("a dot-directory under the user home directory ({}) may not be the cwd", rel[0]));
                    }
                    let rel_key = rel.join("/");
                    if HOME_PROFILE_DIRS.contains(&rel_key.as_str()) {
                        return Some(format!("the profile directory {rel_key} may not be the cwd"));
                    }
                }
            }
        }
    }
    None
}

fn drive_key(p: &Path) -> Option<String> {
    match p.components().next() {
        Some(Component::Prefix(pre)) => Some(segment_key(&pre.as_os_str().to_string_lossy())),
        _ => None,
    }
}

/// Strip the `\\?\` verbatim prefix `std::fs::canonicalize` adds on Windows so
/// the canonical path can be re-validated (and shown) as an ordinary path.
fn strip_verbatim(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix("\\\\?\\") {
        if !rest.starts_with("UNC\\") {
            return PathBuf::from(rest);
        }
    }
    p
}

/// Validate a working directory for the spawned CLI: `cwd_rejection` on the
/// literal path, then on its canonical real path (junctions/symlinks and 8.3
/// names resolved), and it must be an existing directory. Returns the
/// canonical path to spawn in.
pub fn validate_cwd(cwd: &Path, home: Option<&Path>) -> Result<PathBuf, String> {
    if let Some(why) = cwd_rejection(cwd, home) {
        return Err(format!("cwd {} rejected: {why}", cwd.display()));
    }
    let canonical = std::fs::canonicalize(cwd)
        .map(strip_verbatim)
        .map_err(|e| format!("cwd {} rejected: cannot canonicalize: {e}", cwd.display()))?;
    if !canonical.is_dir() {
        return Err(format!("cwd {} rejected: not a directory", cwd.display()));
    }
    if let Some(why) = cwd_rejection(&canonical, home) {
        return Err(format!("cwd {} rejected: resolves to {}: {why}", cwd.display(), canonical.display()));
    }
    Ok(canonical)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_without_the_explicit_opt_in() {
        for v in [None, Some(""), Some("0"), Some("true"), Some("yes"), Some("11"), Some(" ")] {
            let r = gate(v).expect_err("must refuse");
            assert_eq!(r.code, "ineligible");
            assert!(r.message.starts_with("ineligible: no enforced charter policy"), "{}", r.message);
            assert!(r.message.contains("T10"));
            let a = availability(v);
            assert!(!a.available);
            assert!(!a.ungated_opt_in);
            assert_eq!(a.reason.as_deref(), Some(r.message.as_str()));
        }
    }

    #[test]
    fn opts_in_only_on_literal_one() {
        assert!(gate(Some("1")).is_ok());
        assert!(gate(Some(" 1 ")).is_ok());
        let a = availability(Some("1"));
        assert!(a.available);
        assert!(a.ungated_opt_in);
        assert!(a.reason.unwrap().contains("NOT enforced"));
    }

    #[test]
    fn args_carry_the_native_restrictions_and_never_a_bypass() {
        let args = build_args("do the thing", "claude-sonnet-4-6").unwrap();
        assert_eq!(args[0], "-p");
        assert_eq!(&args[args.len() - 2..], &["--".to_string(), "do the thing".to_string()]);
        let joined = args.join("\u{0}");
        assert!(joined.contains("--permission-mode\u{0}default"));
        assert!(args.iter().any(|a| a == "--setting-sources="));
        assert!(args.iter().any(|a| a == "--strict-mcp-config"));
        assert!(args.iter().any(|a| a == "--verbose"));
        assert!(joined.contains("--output-format\u{0}stream-json"));
        assert!(joined.contains("--model\u{0}claude-sonnet-4-6"));
        for forbidden in [
            "--dangerously-skip-permissions",
            "--allow-dangerously-skip-permissions",
            "bypassPermissions",
            "acceptEdits",
            "auto",
        ] {
            assert!(!args.iter().any(|a| a == forbidden), "{forbidden} must not be passed");
        }
        // `--setting-sources` must never be followed by a source name.
        assert!(!args.iter().any(|a| a == "--setting-sources"));
    }

    #[test]
    fn brief_is_a_single_structured_argument_even_with_shell_metacharacters() {
        let brief = "echo pwned > x; rm -rf / && \"quoted\" `tick` $(sub)";
        let args = build_args(brief, "m").unwrap();
        assert_eq!(args[args.len() - 1], brief);
        assert_eq!(args.iter().filter(|a| a.contains("pwned")).count(), 1);
    }

    /// F2 D4: a brief that looks like a flag is still only the positional
    /// prompt after `--` (verified against the real claude.exe: the old
    /// `-p <brief>` order produced `permissionMode=bypassPermissions`).
    #[test]
    fn a_flag_shaped_brief_never_precedes_the_option_terminator() {
        for brief in [
            "--dangerously-skip-permissions",
            "-p --help -- the real brief, monkeys",
            "--permission-mode bypassPermissions",
            "--setting-sources user",
            "-",
        ] {
            let args = build_args(brief, "claude-sonnet-4-6").unwrap();
            let sep = args.iter().position(|a| a == "--").expect("-- present");
            assert_eq!(sep, args.len() - 2, "-- is the second-to-last token");
            assert_eq!(args[sep + 1], brief, "the brief is the single token after --");
            // Every token before `--` is one of ours; the brief text never
            // appears there even when it equals a flag we do pass.
            let before: Vec<&str> = args[..sep].iter().map(String::as_str).collect();
            assert_eq!(
                before,
                [
                    "-p",
                    "--model",
                    "claude-sonnet-4-6",
                    "--output-format",
                    "stream-json",
                    "--verbose",
                    "--permission-mode",
                    "default",
                    "--setting-sources=",
                    "--strict-mcp-config"
                ]
            );
        }
        assert_eq!(build_args("", "m").unwrap_err().code, "spawn_failed");
        assert_eq!(build_args("   ", "m").unwrap_err().code, "spawn_failed");
    }

    #[test]
    fn model_ids_that_could_be_parsed_as_flags_are_refused() {
        for bad in ["", " ", "--dangerously-skip-permissions", "-x", "a b", "m;rm", "m\u{0}"] {
            assert!(model_rejection(bad).is_some(), "{bad:?}");
            assert_eq!(build_args("brief", bad).unwrap_err().code, "spawn_failed");
        }
        for good in ["claude-sonnet-4-6", "claude-opus-4.1", "sonnet", "m:1", " claude-sonnet-4-6 "] {
            assert!(model_rejection(good).is_none(), "{good:?}");
            let args = build_args("brief", good).unwrap();
            assert_eq!(args[2], good.trim());
        }
    }

    // ---------- cwd validation (F2 D4) ----------

    fn p(s: &str) -> PathBuf {
        PathBuf::from(s)
    }

    #[cfg(windows)]
    #[test]
    fn cwd_rejects_drive_roots_home_ancestors_profile_and_credential_dirs() {
        let home = p(r"C:\Users\Someone");
        for bad in [
            r"C:\",
            r"D:\",
            r"C:\Users",
            r"C:\Users\Someone",
            r"C:\users\someone",
            r"C:\Users\Someone\.ssh",
            r"C:\Users\Someone\.claude",
            r"C:\Users\Someone\.config\x",
            r"C:\Users\Someone\AppData",
            r"C:\Users\Someone\AppData\Local",
            r"C:\Users\Someone\AppData\Roaming",
            r"C:\Users\Someone\AppData\LocalLow",
            r"C:\Users\Someone\Projects\x\.aws",
            r"C:\Users\Someone\Projects\x\.ssh\keys",
            r"C:\Users\Someone\PROJEC~1\x",
            r"C:\Users\Someone\Projects\..\x",
            r"C:\Users\Someone\Projects\x.",
            r"\\server\share\x",
            r"\\?\C:\Users\Someone\Projects\x",
            r"\\.\pipe\x",
            r"Projects\x",
            r"C:Projects\x",
        ] {
            assert!(cwd_rejection(&p(bad), Some(&home)).is_some(), "{bad} must be rejected");
        }
        for good in [
            r"C:\Users\Someone\Projects\x",
            r"C:\Users\Someone\AppData\Local\Temp\wt",
            r"W:\Hoya_Space\Projects\Skippy_space",
            r"C:\Users\Other\Projects",
            // `Path::components()` folds an interior `.` away: a lexical no-op.
            r"C:\Users\Someone\Projects\.\x",
        ] {
            assert_eq!(cwd_rejection(&p(good), Some(&home)), None, "{good} must be accepted");
        }
        // No home known: the structural rules still apply.
        assert!(cwd_rejection(&p(r"C:\"), None).is_some());
        assert!(cwd_rejection(&p(r"C:\x\.ssh"), None).is_some());
        assert_eq!(cwd_rejection(&p(r"C:\x\y"), None), None);
    }

    #[test]
    fn validate_cwd_requires_an_existing_directory_and_rechecks_the_real_path() {
        let tmp = std::env::temp_dir().join(format!("skippy-cwd-{}", uuid::Uuid::new_v4()));
        let work = tmp.join("work");
        std::fs::create_dir_all(&work).unwrap();
        let file = work.join("f.txt");
        std::fs::write(&file, "x").unwrap();
        let home = tmp.join("nohome");
        // Existing directory passes and comes back canonical (no \\?\ prefix).
        let ok = validate_cwd(&work, Some(&home)).unwrap();
        assert!(ok.is_dir());
        assert!(!ok.to_string_lossy().starts_with(r"\\?\"), "{}", ok.display());
        // Missing directory and a file are refused.
        assert!(validate_cwd(&tmp.join("missing"), Some(&home)).is_err());
        assert!(validate_cwd(&file, Some(&home)).is_err());
        // A junction/symlink whose real path is a credential directory is
        // refused even though the literal name is innocent (D3-style).
        let cred = tmp.join(".aws");
        std::fs::create_dir_all(&cred).unwrap();
        let link = tmp.join("lnk");
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_dir(&cred, &link).is_ok();
        #[cfg(not(windows))]
        let linked = std::os::unix::fs::symlink(&cred, &link).is_ok();
        if linked {
            let err = validate_cwd(&link, Some(&home)).unwrap_err();
            assert!(err.contains("resolves to"), "{err}");
            assert!(err.contains(".aws"), "{err}");
        }
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn refusal_serialises_as_a_structured_object() {
        let r = gate(None).unwrap_err();
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["code"], "ineligible");
        assert!(v["message"].as_str().unwrap().contains("no enforced charter policy"));
        let a = serde_json::to_value(availability(None)).unwrap();
        assert_eq!(a["available"], false);
        assert_eq!(a["ungatedOptIn"], false);
    }
}
