# Model portfolio and Pleiades integration plan

Revised 2026-09-26 for [PRD v0.2](PRD.md) decisions D-01–D-04. Supersedes the 2026-09-25 draft, which kept a 9B model at the center and treated larger models and a coding specialist as deferred. Evidence: [quantization research](research/09-quantization-2026-09-26.md), [cloud cost research](research/10-cloud-orchestration-cost-2026-09-26.md) and the model-fit survey summarized below. No downloads, service changes or live probes were performed; every speed and memory figure is a community or vendor report or an estimate until our own qualification reproduces it.

## 1. Role split

| Role (PRD schema) | Where | Primary | Challenger / fallback | Why |
|---|---|---|---|---|
| **Skippy + board captains** (plan, decompose, route, monitor, synthesize) | Cloud (D-01) | Claude Sonnet 5 via capped API key, 1-hour prompt cache | Opus 5.5 for replanning, cross-board conflict and high-risk plans; GPT-6 Sol A/B | Low volume, high judgment. Metered per turn so the cheapest sustaining tier can be chosen (OQ-08, [research 10](research/10-cloud-orchestration-cost-2026-09-26.md)) |
| **Local big brain** (Hermes + local heavy lifting + future orchestration port) | Alcyone, one consolidated vLLM server (D-02) | `nvidia/Qwen3.5-122B-A10B-NVFP4` | `nvidia/Qwen3.8-27B-NVFP4`; speed option `openai/gpt-oss-120b` | Largest model that fits cleanly with 4×64K sequences and mature Qwen tool parsing |
| **Coding task agents** (Coding/Engineering implementation volume) | Atlas (D-04) | `unsloth/Qwen3.6-35B-A3B-GGUF` UD-Q4_K_XL + expert offload | `unsloth/Qwen3.8-27B-GGUF` UD-Q3_K_XL fully in VRAM; experiment `unsloth/Qwen3-Coder-Next-GGUF` Q4_K_M; baseline `openai/gpt-oss-20b` | Best agentic-coding score that runs fast in 16 GB VRAM + 64 GB RAM |
| **Coding escalation** | Cloud | Claude Code (Sonnet 5 / Opus 5.5) on the owner's plan | Codex app-server (GPT-6 Sol/Astra) as implementer or cross-vendor reviewer | After one bounded local attempt fails, or directly for high-risk work (FR-ROUTE-03) |
| **Typed triage** | Hosted Jev, shadow mode | `jev-1.13.0` | Deterministic rules | Board assignment, routing, escalation and evidence checks at near-zero cost (PRD §9) |
| **Retrieval** | Atlas CPU/GPU, bounded batches | `Qwen/Qwen3-Embedding-0.6B` | `Qwen/Qwen3-Reranker-0.6B` when a retrieval baseline exists | Unchanged from the 2026-09-25 draft |

Board identity does not select hardware: eight logical boards share these routes through each charter's `execution_profile` (FR-BOARD-01). Skippy never implements (Iron Law); the local coder is a task-agent route.

**Correction to the 2026-09-25 review.** It proposed `Qwen3-Coder-30B-A3B` for Atlas and `gpt-oss-120b` as the Alcyone target. Newer releases outscore both: Qwen3.6-35B-A3B (SWE-bench Verified 73.4, Terminal-Bench 2.0 51.5) and Qwen3.5-122B-A10B (SWE-bench Verified 72.0, BFCL-V4 72.2) versus gpt-oss-120b (SWE-bench Verified 62.4). Qwen3-Coder-Next (80B-A3B) is larger but scores below Qwen3.6-35B-A3B on Terminal-Bench 2.0 (36.2). Vendors use different harnesses; our own suite decides.

## 2. Alcyone: consolidated server (D-02)

**Budget.** 128 GB unified minus OS/services (~10 GB) and the factory's 24 GB limit when Money Printer resumes leaves about **90 GB** for one server (weights + KV + ~5 GB activations/CUDA graphs). Money Printer is paused (D-03), so qualification can run on a quiet host, but capacity must be proven with the factory's limit reserved.

| Candidate | Total / active | Weights | Est. at 4×64K | Reported Spark decode | Agentic evidence | vLLM parsers |
|---|---|---|---|---|---|---|
| **Qwen3.5-122B-A10B NVFP4** | 122B / 10B | ~76 GB (with MTP) | ~84 GB | 15 tok/s; 25–31 with MTP | SWE-V 72.0, TB2 49.4, BFCL-V4 72.2, TAU2 79.5 | `qwen3_coder` / `qwen3` |
| Qwen3.8-27B NVFP4 (dense hybrid) | 27B | ~26 GiB | ~40 GB | 25–50 tok/s (stack-dependent) | TB2.1 73.0, SWE-Pro 61.7 | `qwen3_xml` / `qwen3` |
| gpt-oss-120b MXFP4 | 117B / 5.1B | ~61 GB | ~75 GB | 38 stock; up to 69 patched + EAGLE-3 | SWE-V 62.4 | harmony (qualify) |
| Nemotron-3-Super-120B-A12B NVFP4 | 120B / 12B | ~75 GB | ~82 GB | ~23 flat to 100K | TB-hard 25.8 | `qwen3_xml` / `nemotron_v3` |

**Decision rule.** Qualify the 122B first (largest model that fits) and the 27B as head-to-head challenger. If the 27B matches the 122B on the Hermes suite and our harness evaluations, prefer it: roughly 45 GB of freed memory becomes concurrency or a second on-demand service. Otherwise keep the 122B. Record the outcome in OQ-09.

**Watch list, not candidates yet:** Qwen3.8-Flash-Next 125B-A6B (NVFP4 ≈125 GiB; fits only with unmerged vLLM patches that stream its n-gram table from NVMe); DeepSeek-V4-Flash 284B-A13B (needs a Q2 GGUF and a non-standard engine/tool format); MiniMax-M2.7 229B-A10B (~80 GB at IQ3_XXS, untested quality). **Rejected:** Mistral Small 4 (context capped at 40K on Spark, below Hermes' 65,536), dense Mistral Medium 3.5 128B (~3–4 tok/s), anything needing 2+ Sparks.

**Serving standard** (details in [research 09](research/09-quantization-2026-09-26.md) §6): Spark-targeted, pinned vLLM (NGC or sm_121 build; not stock upstream images); NVFP4 checkpoints from NVIDIA where available, Marlin INT4 fallback; `--max-model-len 65536` (131072 only if measured), `--max-num-seqs ≤4`, `--kv-cache-dtype fp8` only after an A/B on Spark, MTP with one speculative token, `--enable-auto-tool-choice` with the model's parser. Compute `gpu-memory-utilization` from the 90 GB budget rather than copying 0.18 or a recipe's 0.90. Apply known GB10 kernel workarounds per pinned version. Never 262K context on the 122B (reported OOM). Loopback bind only.

**Hermes consolidation procedure.**

1. **Inventory the quiet host** (OQ-01): image digests, launch arguments, cached weights (including the prior 35B), disk, driver/CUDA, Hermes configuration. Record time and host.
2. **Preserve rollback:** keep the 9B NVFP4 artifact and its exact launch configuration; the [prepared swap script](../../money_printer/deploy/spark/hermes_model_swap.sh) documents the prior mechanics but is Money Printer's to run.
3. **Stand up the candidate on a separate loopback port**, run Hermes' tool/65,536-context suite and our 60-task suite against it.
4. **Mixed-load test** with the factory workload reproduced at its 24 GB limit and Skippy active; gates in §5.
5. **Switch Hermes** to the new endpoint only after gates pass, with the 9B config retained as the rollback target. Money Printer restarts afterwards.

Money Printer isolation is unchanged: networkless factory, sealed holdouts, promotion gates and owner approvals (FR-CLUSTER-05).

## 3. Atlas: coding worker (D-04)

Atlas is DESKTOP-HOYA: RTX 5070 Ti 16 GB, 64 GB DDR5, i9-14900K, Intel UHD 770 iGPU. Budget ~1 GB VRAM for Windows/WDDM.

| Candidate | Artifact | Fit | Reported speed on 16 GB cards | Agentic evidence |
|---|---|---|---|---|
| **Qwen3.6-35B-A3B** | UD-Q4_K_XL 22.4 GB (UD-IQ3_S 13.7 GB fits fully) | Partial expert offload, 64K, q8 KV | 53–121 tok/s depending on quant/offload | SWE-V 73.4, SWE-Pro 49.5, TB2 51.5 |
| Qwen3.8-27B | UD-Q3_K_XL 13.1 GB | Fully in VRAM at 32–64K | 20–42 tok/s | TB2.1 73.0, SWE-Pro 61.7 (3-bit quality untested) |
| Qwen3-Coder-Next 80B-A3B | Q4_K_M 48.5 GB | `--cpu-moe`, ~40 GB in RAM | Unmeasured; est. 20–35 | SWE-V 70.6, TB2 36.2, Aider 66.2 |
| gpt-oss-20b | MXFP4 ~13 GB | Fully in VRAM | very fast | SWE-V 60.7 |

**Runtime standard:** llama.cpp native Windows CUDA build (or LM Studio's CUDA 12.8+ llama.cpp runtime), pinned. Starting flags for the primary: `--jinja -c 65536 -ctk q8_0 -ctv q8_0 --flash-attn on --n-cpu-moe <tune from ~20 down>`, large `-b/-ub`, MTP if the build supports it. KV types stay matched (q8_0/q8_0 or f16); never q4_0 on K. Avoid Qwen3.5-122B on Atlas (reported `--cpu-moe` + `-ngl` KV corruption).

**One-time machine setup (owner action, reversible):** enable XMP/EXPO so DDR5 runs at rated speed (offload decode is RAM-bandwidth-bound); NVIDIA Control Panel → CUDA Sysmem Fallback Policy → *Prefer No Sysmem Fallback*; optionally drive the display from the iGPU in "worker mode"; pin the inference process to P-cores. Keep an idle/gaming toggle that drains the worker (FR-CLUSTER-04).

Tool execution stays in Skippy's Windows worktree; the Atlas endpoint returns proposals and binds to localhost.

## 4. Routing examples

| Task | First route | Escalation / validation |
|---|---|---|
| Decompose a mission into board tasks | Cloud orchestrator (Sonnet 5) | Opus 5.5 if replanning after failure or high risk |
| Which board owns this? Retry or escalate? | Rules, then Jev (shadow) | Orchestrator on low confidence |
| Add a small TypeScript utility and tests | Atlas coder | One bounded retry, then Claude Code / Codex; tests decide success |
| Multi-file refactor with clear tests | Atlas coder or Alcyone big brain | Cloud escalation after a failed attempt |
| Diagnose a cross-module orchestration failure | Alcyone big brain when capacity permits | Direct to Opus/Codex when risk merits it |
| Schema migration, permission boundaries | Opus 5.5 / Codex Astra | Human-visible plan, regression tests, cross-vendor review |
| Find the wiki decision behind a service limit | Lexical + embeddings (+ reranker) | Return source spans; generation optional |
| Money Printer promotion/capital decision | Existing deterministic gates and owner | Skippy may summarize approved reports only |

## 5. Qualification and promotion

**Manifest before any download:** `candidate_id`, upstream repo, exact revision, file/format, checksum, license, quantizer, intended machine, runtime/image version, tool and reasoning parser, context/output caps, measured peak memory, measured latency, qualification status, rollback target. Download only the chosen artifact; check disk first. Acquisition never starts or replaces a service (FR-CLUSTER-02).

**Suite:** 60 versioned tasks — 20 small code/test changes, 10 multi-file fixes, 10 wiki questions, 10 structured/tool-use tasks, 10 boundary cases (bad paths, cancellation, unavailable endpoint, prompt injection, insufficient evidence) — plus a separate holdout for route policy. Add Hermes' own tool suite at 65,536 context for Alcyone candidates. Measure accepted-task rate, tool/schema validity, cited-evidence correctness, TTFT, wall time, throughput, peak memory, load time, retries and human corrections; concurrency 1 then 2.

**Quantization check:** for any sub-4-bit artifact (e.g. Qwen3.8-27B UD-Q3_K_XL) run the tool-use subset against a ≥4-bit or NVFP4 reference of the same model; reject if tool-call validity or accepted-task rate drops materially.

**Promotion gates:** zero crashes/OOMs and permission violations; Hermes p95 latency and factory throughput within 10% of their baseline under mixed load (product target; operator may tighten); route passes its task-family threshold (PRD G3). A failed gate keeps the previous qualified route. Model or runtime updates return a route to candidate status.

## 6. Cloud metering (D-01)

Run orchestration on a dedicated, capped Anthropic API workspace for two weeks; log every turn's input, cache-read, cache-write and output tokens, model and effort to the local ledger keyed by run/attempt/board. Then apply the switching thresholds in [research 10](research/10-cloud-orchestration-cost-2026-09-26.md) §5: stay on API, move to a $20 tier, a $100 tier, or port orchestration to the Alcyone big brain once it is qualified. Subscription sessions remain for the owner's interactive Claude Code / Codex use (OQ-10).

## 7. Open items

- OQ-09: 122B vs 27B consolidated choice (decided by the suite above).
- Qualify Qwen3.8-27B at 3-bit before trusting it on Atlas.
- Check the qwen-community-1.0 license before ever adopting Qwen3.8-Flash-Next.
- Re-verify every repo revision, tokenizer fix (e.g. early `unsloth/Qwen3.8-27B-NVFP4` truncated input at 2,048 tokens) and parser name at download time.
