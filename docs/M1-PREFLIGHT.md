# M1 pre-flight (M0-G01, M0-G12, M0-G06)

Branch `m1/preflight`, cut from the pivot trunk `m0/foundation` (`10f6654`). Goal: close the three M0 issues that blocked enabling live execution or autonomous writes. See [M0-CLOSEOUT.md](M0-CLOSEOUT.md) for the original issue list.

**Result:** M0-G01 and M0-G12 are closed as originally reported. M0-G06 (git command execution) is closed for the executor. The follow-up hardening the verifiers asked for (prototype-pollution immunity, the `.gitattributes` rule, the multi-view attribute check) found new, narrower gaps, which are listed below as PF issues. Everything was verified adversarially and the M0-era scenarios run live against the real bundled Claude CLI 2.1.162. **Live execution and autonomous autocommit must stay off until PF-01, PF-02, PF-08 … PF-11 are closed.**

## Closed and verified

| Issue | What changed | Commit |
|---|---|---|
| M0-G01 (+G02, G03, G05) | Main-thread `<synthetic>` errors and the `StopFailure` hook go into the run-failure ledger, including inside segments that have no `result`. Overtaken turns are judged against the normal stop reasons. Non-streamed tool turns are tracked. A tool call rejected as invalid does not count as executed. A `succeeded` record that carries a failure reason is a violation (TypeScript and Rust). The 207-scenario live rerun changed only the intended outcomes. | `fe82c2f` |
| M0-G12, M0-G15 | Autocommit refuses any path with a `working-tree-encoding` attribute (`encoded-path`). A file git cannot convert now withholds only itself instead of stalling the tick. | `1b9487d` |
| M0-G12 residual D1–D3, M0-G13 | Autocommit never adds, changes or deletes an attributes file (`attributes-file`; git's NTFS and HFS name rules on every OS). The snapshot is built from git's own `ls-files` walk, so it covers junctions and tracked nested repos. A conversion attribute is refused if it is set in any view a reader applies. New `path-conflict` reason. | `f1ae2cb`, `679f9af` |
| M0-G06 (git execution) | Board writes to git metadata are denied: `.git` in any form, gitdir/commondir targets, `.gitattributes`, `.gitmodules`, hooks, and bare-repo layouts. The executor's git runs with no system or global config and with pinned `core.fsmonitor=false`, an empty `core.hooksPath`, and `safe.bareRepository=explicit`. The CLI's startup git status is switched off. The only git the CLI spawns is `git config --get remote.origin.url`. | `4766ed3`, `53d4f8e` |
| M0-G06 (config surface) | Each run gets a fresh, private config directory (`mkdtemp`) that is removed afterwards and that no tool root can contain. The executor gets an allowlisted environment with the embedded rg forced. Stale state is swept. | `2e9f778`, `8b9600d`, `4766ed3` |
| M0-G07 (observers, wrappers) | Wrappers fail closed on any error. Observers receive frozen null-prototype snapshots. Every tool-authority decision reads its inputs as own properties; a 212k-case pollution fuzz shows 0 decision flips. | `8b9600d`, `53d4f8e`, `14aa789` |

Threat model (OQ-22): code running inside the sidecar process is trusted. Neither agent-supplied data nor Object/Array/Function prototype pollution may change a decision. Replacing built-in methods, and engine-level gadgets, are out of scope without process isolation.

## Open issues

| ID | Sev | Area | Issue | Suggested fix |
|---|---|---|---|---|
| PF-01 | Critical, needs in-process pollution | Runtime | The SDK's internal transport object reads `assistant` and `channels` through the prototype chain, so one polluted data property adds CLI arguments. The verifier started a process outside every root with no tool calls. | Pass explicit own `assistant`/`channels` values if the SDK copies them. Otherwise validate the CLI argv at `spawnExecutorProcess` against an allowlist and refuse unknown flags. Extend the command-line test to the SDK's internal object. |
| PF-02 | High, needs in-process pollution | Runtime | `execution-gate.ts` reads `SKIPPY_DEMO_MODE`, `PHASE3_AGENTS_ENABLED` and `ANTHROPIC_API_KEY` through the prototype chain, so pollution can switch live execution on. | Use own-property reads (a three-line change) and add a test. |
| PF-03 | Medium | Runtime | The SDK decides child env values (`CLAUDE_CODE_ENTRYPOINT`, `DEBUG`) through the prototype chain. No change in authority was observed. | Set these explicitly in the executor env. |
| PF-04 | Low | Runtime | Startup-time env reads through the prototype chain: `index.ts` and `memory-jobs.ts` (their own `resolveVaultRoot` copies), `skippy.ts`, and `board.ts` deps. | Reuse `vault-root.ts` and use own reads. |
| PF-05 | Low, usability | Runtime | The bare-repo `HEAD` rule also matches directories and any case. A React `Head/` folder, or a root file named `head`, makes its siblings unwritable. | Deny only when `HEAD` sits beside `objects/` and `refs/`, or only for files named exactly `HEAD`. |
| PF-06 | Low | Runtime | Pairing drift between synthetic messages and `StopFailure`: a parse give-up hook without a synthetic message can drop an earlier segment's failure detail, and in one fake-SDK case the outcome became `interrupted` instead of `failed`. Always non-success. | Pair by segment and error kind instead of by order. |
| PF-07 | Low, fails closed | Runtime | A cut turn whose tool ran but returned a runtime error is judged truncated (a false failure). | Count a runtime tool error as executed; keep refusing invalid-input rejections. |
| PF-08 | High | Autocommit | Clone-view and alias-view repos don't set `core.ignorecase`, so a Windows or macOS clone can apply a case-insensitive rule the views missed and decode a note. Leaks on the pre-flight baseline too. | Evaluate every view with both `core.ignorecase=true` and `false`. |
| PF-09 | High | Autocommit | Aliases are swapped in one at a time, so a macro defined in one alias and used in another is never evaluated together. A re-checkout decodes. | Evaluate the combined set of committed aliases, or refuse any note under a directory that has a committed non-canonical alias. |
| PF-10 | High | Autocommit | A case-sensitive (Linux) autocommitter does not model case-insensitive cloners: directory-name case aliases (`Vault/`) and case-differing patterns. Verified with WSL → Windows. | Same as PF-08, plus enumerate directory case aliases. |
| PF-11 | Critical, pre-existing | Autocommit | With a case-variant `Vault/` directory in HEAD on Windows, `git add -A -- vault` stages new files as `Vault/*`, outside the byte-exact pathspec. An unscanned secret and `.env` are committed with no report. The post-write-tree invariant only runs when there are exclusions, and only within the vault pathspec. | Run the invariant on every commit over the whole tree diff (HEAD vs new tree), and refuse any path outside the scanned candidate set. Refuse to run while HEAD has a case alias of the vault directory. |
| PF-12 | Residual | Autocommit | M0-G14: a flip-and-flip-back of an attribute source between snapshots stores a re-encoded blob in up to about a third of new HEADs under a fast toggler. No clone decodes it, because the rule is never committed by autocommit. | Read attributes only from the committed tree, or override conversions during autocommit's own add. |
| PF-13 | Low | Autocommit | Ticks with changes are 13–27% slower (extra views). | Acceptable against a 300 s interval. |
| PF-14 | Low, pre-existing | Autocommit | An untracked nested repo with no commit fails every tick explicitly. | Skip it with a report. |
| PF-15 | Follow-up | Shell | `sidecar.rs` still launches the sidecar with the full parent environment. The executor env is the enforced boundary. | Allowlist the sidecar env once runtime configuration is enumerated. |

Still open from M0: G04 (task-agent truncation has no signal), G08 (OneDrive-style reparse dirs), G09–G11, G14 (now PF-12), G16–G19. See [M0-CLOSEOUT.md](M0-CLOSEOUT.md).

## Verification record

Adversarial verifiers ran for every change; the live mock harness uses the real bundled Claude CLI. Final local results at `679f9af` (Windows 11):
- typecheck and lint: pass.
- memory tests: 187 pass, 2 skipped.
- runtime tests: 227 pass, 42 skipped (opt-in live).
- runtime with the live CLI mock: 263 pass, 6 skipped.
- `test:scripts`: 99 pass, 1 skipped.
- `cargo test`: 116/116.
- pollution fuzz (full mode): 14/14.
