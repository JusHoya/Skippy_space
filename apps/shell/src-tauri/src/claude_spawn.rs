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
//!
//! Everything here is a pure function so it can be unit-tested without Tauri.

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

/// Build the structured argument vector for `claude`. Pure; no shell.
///
/// `-p <brief>` one-shot mode, `--model`, `--output-format stream-json`
/// (+ `--verbose`, which the CLI requires with stream-json in print mode),
/// then the native restriction flags described in the module docs.
pub fn build_args(task_brief: &str, model: &str) -> Vec<String> {
    vec![
        "-p".to_string(),
        task_brief.to_string(),
        "--model".to_string(),
        model.to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--permission-mode".to_string(),
        "default".to_string(),
        "--setting-sources=".to_string(),
        "--strict-mcp-config".to_string(),
    ]
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
        let args = build_args("do the thing", "claude-sonnet-4-6");
        assert_eq!(&args[..2], &["-p".to_string(), "do the thing".to_string()]);
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
        let args = build_args(brief, "m");
        assert_eq!(args[1], brief);
        assert_eq!(args.iter().filter(|a| a.contains("pwned")).count(), 1);
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
