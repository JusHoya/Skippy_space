# Quantization and local-fit techniques

Researched 2026-09-26 for [PRD v0.2](../PRD.md) decisions D-02/D-04 and the [model plan](../MODEL-AND-CLUSTER-PLAN.md). Hardware: **Alcyone** (DGX Spark, GB10/sm_121, 128 GB unified, ~273 GB/s; ~90 GB budget for one consolidated server) and **Atlas** (RTX 5070 Ti 16 GB/sm_120, ~896 GB/s, 64 GB DDR5, i9-14900K, Intel iGPU). GB10 software support changes monthly: re-check version-specific claims. "Unverified" marks single community reports or claims not confirmed from a primary source. Sources are numbered at the end.

## 0. Bottom line

- **Alcyone:** standardize on **vLLM + NVFP4** from a Spark-targeted (sm_121) build, pinned. Stock upstream images do not target sm_121 [1][2]. Use MXFP4 only for natively-MXFP4 models (gpt-oss). INT4 AWQ/GPTQ (Marlin) is the fallback; on GB10 native NVFP4 still does not beat Marlin INT4 decode [3]. llama.cpp + GGUF is the secondary runtime for ~3 bpw fits of 150–200B MoE. Sweet spot: **MoE ≈100–130B total, ≤12B active**. Dense >~30B is too slow at 273 GB/s.
- **Atlas:** standardize on **llama.cpp / LM Studio CUDA runtime + imatrix or Unsloth Dynamic GGUF**. Dense ~24–27B fits in VRAM at ~3.5–4.5 bpw; MoE up to ~120B total runs with routed experts in system RAM via `--n-cpu-moe`. ExLlamaV3 is optional for dense models that fit entirely in VRAM.
- **Rule for both:** on bandwidth-bound hardware, **active parameters decide speed; total parameters decide fit.**

## 1. Weight formats

| Format | Bits/weight | Quality evidence | Atlas (sm_120) | Alcyone (GB10/sm_121) | Verdict |
|---|---|---|---|---|---|
| FP8 E4M3 | ~8 | Near-lossless; ~0.8% long-context loss [4] | vLLM; early RTX50 W8A8 bug [5] (status unverified) | vLLM after a family-guard fix [6] | Too big for "biggest model" goals |
| **NVFP4** | ~4.5 (16-value blocks, E4M3 + FP32 scale) [7] | ≤1% drop on DeepSeek-R1 vs FP8 [7]; 99.1% recovery at 70B, 95.7% at 8B [8] | llama.cpp native MMQ since b8967 (+57% prefill, decode unchanged) [9][10] | vLLM native SM120/121 CUTLASS GEMM merged 2026-05-20 [1]; prefill regression + workaround [11]; W4A4 immature, MoE FP4 often falls back to Marlin [3][12] | **Alcyone standard** |
| MXFP4 | ~4.25 (32-value blocks, E8M0 scale) [7][13] | PTQ ~10% relative drop; MR-GPTQ within 1–2% of NVFP4 [8] | llama.cpp native MMA (+26–31% prefill) [14] | Same llama.cpp PR; vLLM gpt-oss slower than llama.cpp/SGLang on GB10 [15] | Only for QAT-native models |
| INT4 AWQ / GPTQ (Marlin W4A16) | ~4.1–4.25 | AWQ −1.8%, GPTQ −2.7% long-context [4]; NVFP4 ≈ INT4 [8] | vLLM Marlin (sm_120 specifics unverified) | Fastest 4-bit decode on GB10 per forum [3] | **Alcyone fallback** |
| GPTQv2 / GPTAQ | as GPTQ | Better at low bits via asymmetric calibration [16] | GPTQ-format | GPTQ-format | Use when producing our own INT4 |
| GGUF k-quants | Q8_0 8.5, Q6_K 6.56, Q5_K_M 5.70, Q4_K_M 4.89, Q3_K_M 3.76, Q2_K 3.16 [17] | Q4_K_M+ is the safe tier [17] | Mature | Mature; gpt-oss-120b 60.6 tg / 1956 pp tok/s [18] | Universal, CPU/GPU split |
| GGUF i-quants + imatrix | IQ4_XS 4.46, IQ3_M 3.76, IQ3_XXS 3.25, IQ2_XXS 2.38 [17] | Beat k-quants below 4 bpw [17] | Yes | Yes | **Atlas standard** (below 4 bpw) |
| Unsloth Dynamic (UD-Q2/Q3/Q4_K_XL) | mixed ~2–5 | DeepSeek-V3.1 Aider: 2-bit 65.8, 3-bit 68.4, 4-bit 69.7, full 71.6 [19]; UD-IQ2_S tool calling "unreliable" [20] | Yes | Yes | Best sub-4-bit GGUF (vendor-reported) |
| EXL3 (QTIP trellis) | ~1.6–8 | QTIP 2-bit beats QuIP#/AQLM [21]; EXL3 curves unverified [22] | ExLlamaV3/TabbyAPI, Windows, `TORCH_CUDA_ARCH_LIST=12.0` [22][23] | Unverified | Optional for dense-in-VRAM on Atlas |
| EXL2, HQQ, AQLM/QuIP# | various | Superseded or research-only [21][24] | — | — | Skip |
| bitsandbytes NF4 | ~4.1–4.5 | Worst 4-bit on long context (−6.9% avg, −59% OneRuler at 70B) [4]; slow, not bit-exact on sm_120 [25] | Works, slow | Unverified | **Avoid** |
| QAT: gpt-oss MXFP4 | 4.25 on MoE weights [13] | Native: no PTQ loss | llama.cpp native | ~60 tok/s llama.cpp / ~59 vLLM [15][18] | Ideal class for both |
| QAT: Gemma Q4_0 | ~4.5 | 54% less perplexity drop than PTQ Q4_0 [26] | Yes | Yes | Prefer vendor QAT when offered |

**GB10 gaps.** sm_120/121 is not datacenter Blackwell: no `tcgen05`/TMEM, warp-level block-scaled MMA, a third kernel path [27]. B200-sized CUTLASS FP4 tiles exceed GB10's 99 KiB shared memory, so TensorRT-LLM FP4 GEMMs fail [28]; CUTLASS DSL restricts block-scaled FP4 to sm_100a [29]. SGLang on Spark is largely untested (unverified) [30]. FP4 tensor cores mainly accelerate **prefill**; decode is bandwidth-bound, so FP4's decode gain is fewer bytes, not faster math [9][14].

## 2. MoE-specific techniques

- **Expert offload.** `--n-cpu-moe N` keeps routed-expert tensors of N layers on CPU while attention, KV, router and shared experts stay on GPU [31]; `-ot` gives regex control [32]. Use large `-b/-ub` (≈4096). Official gpt-oss 16 GB recipe: `--n-cpu-moe 32 -ub 4096 -b 4096 --ctx-size 32768` [33]. Community: gpt-oss-120b ≈25 tok/s decode on a 12 GB card + DDR5-6000; decode tripled after enabling XMP [34]. **System-RAM bandwidth is the offload bottleneck.**
- **Per-tensor mixed precision.** Keep attention, shared experts, embeddings/output and early layers higher; quantize routed experts hardest (Unsloth Dynamic [20], gpt-oss native [13]).
- **Expert pruning (REAP, ICLR 2026).** 50% expert removal on Qwen3-Coder-480B keeps 97.6% coding and 96.7% SWE-Bench [35][36], but factual recall and non-English collapse under code-only calibration (community) [38]. Coding boards only; stacking with 4-bit compounds loss.
- **Bandwidth math.** Decode tok/s ≲ BW ÷ (active_params × bpw/8 + KV read). Spark: gpt-oss-120b (5.1B active) ≈60 tok/s [18]; Nemotron-3-Super-120B-A12B NVFP4 ≈23 tok/s [2]; dense 70B at 4.5 bpw bounded below ~7 tok/s.

## 3. KV cache

- **Size:** 2 × layers × kv_heads × head_dim × tokens × bytes. Llama-3.1-70B FP16 = 320 KiB/token → 128K ≈ 40 GiB; FP8 halves it. MLA, hybrid linear-attention and sliding-window models are far smaller: read the config.
- **vLLM FP8 KV:** ≤1–2 points on reasoning, 94–98% long-context AUC with uncalibrated scales [40][41]; only pays off above ~7–8K context; the vLLM Spark blog warns of a noticeable Spark cost for some workloads [2]. A/B it.
- **llama.cpp:** q8_0/q8_0 is nearly lossless; **K is the sensitive half** — q4_0 on K collapses answers, q4_0 on V barely matters [42]. Quantized V requires flash attention [43]. Default CUDA builds only have FA kernels for matched f16/bf16/q8_0/q4_0; mixed K/V silently falls back to CPU attention (up to 7.9× slower) unless built with `GGML_CUDA_FA_ALL_QUANTS=ON` [44].
- **Concurrency on Spark:** keep ≤4 decode streams; beyond that the bandwidth tax outweighs batching [2]. Matches the PRD's conservative admission.

## 4. Speculative decoding

EAGLE-3 reports up to 6.5× on dense models [45]. For MoE at small batch, verification reads the union of drafted tokens' experts; speedup plateaus near 2.3× [46][47]. On GB10: Hy3-295B optimal at one MTP token [39]; Nemotron-Super MTP gives little over no-speculation and crashes with FlashInfer at MTP≥2 (use Triton) [2][48]. **Policy:** native MTP with 1 token, benchmarked; EAGLE-3 only for dense models with a trained head. On Atlas, draft models cost scarce VRAM — dense-in-VRAM only.

## 5. Rules of thumb

1. **Memory:** weights ≈ params(B) × bpw/8 GB + unquantized tensors + KV + 1–3 GB runtime overhead. Alcyone ~90 GB → ~70–75 GB weights + 15–20 GB KV → ~120–130B at NVFP4, or ~170–190B at ~3.2 bpw GGUF. Atlas VRAM → ~24–27B dense at IQ3/UD-Q3–IQ4_XS (Qwen3.8-27B UD-Q3_K_XL 12.76 GB, UD-Q4_K_XL 15.64 GB [20]).
2. **Bigger-at-lower-bits usually wins** down to ~4 bits (RTN era [50]) and ~3 bits with modern quantizers (DeepSeek-V3.1 3-bit −3.2 Aider points [19]).
3. **Size tolerates quantization; small heavily-trained models do not** [51][8]. Floors: ~4.5 bpw under 15B, ~3.5 bpw for 20–70B, ~2.5–3 bpw only for 200B+ MoE with dynamic quants.
4. **Coding, tool calling and long context are fragile.** Skippy agent/tool routes stay at Q3-class dynamic or higher, preferably ≥4-bit [4][20].
5. **Prefer vendor QAT/native checkpoints** over third-party PTQ [13][26][52]. Record quantizer provenance per the model plan's manifest.

## 6. Standard configurations

**Alcyone.** vLLM from NGC or a pinned sm_121 build; NVFP4 first, native MXFP4 for gpt-oss, Marlin INT4 fallback. `--max-num-seqs ≤4`; compute `gpu-memory-utilization` explicitly for the ~90 GB budget (some GB10 configs fail at 0.92 on boot [39]). Apply `VLLM_DISABLED_KERNELS=FlashInferCuteDslNvFp4W4A16LinearKernel` on affected versions [11]; Triton attention if MTP ≥2 [48]; FP8 KV only above ~8K context after an A/B [2][40]. llama.cpp + UD-Q3_K_XL for 150–200B MoE. **Avoid:** TensorRT-LLM as primary [28], stock upstream vLLM images [1], dense >32B, FP8 weights for large models, bitsandbytes, PTQ-MXFP4 of non-native models, REAP models for knowledge boards.

**Atlas.** llama.cpp native Windows CUDA (`120f`) or LM Studio CUDA 12.8+ runtime [14]; imatrix/Unsloth UD GGUF. Tiers: dense ~24–27B in VRAM with 8–16K q8_0 KV; MoE ≤~120B total via `--n-cpu-moe` (start 20–32, tune down) [31][33]. **Machine setup:** enable XMP/EXPO [34]; NVIDIA "CUDA Sysmem Fallback Policy" → Prefer No Sysmem Fallback [53]; drive the display from the iGPU; pin inference to P-cores [34]. KV: matched q8_0/q8_0 or f16 only; never q4_0 on K [42][44]. Optional ExLlamaV3 for dense-in-VRAM [22][23]; vLLM/SGLang under WSL2 only for batched ≤14B serving [54]. **Avoid:** NF4, sub-2-bit quants for tool agents, mismatched KV types, assuming NVFP4 GGUF beats Q4_K_M [10].

## Not independently verified

EXL3 numeric quality; HQQ at ≤3 bits; ExLlamaV3 on GB10; RTX50 FP8 bug status [5]; gpt-oss-120b speed on Atlas; iGPU VRAM savings; NVFP4-GGUF vs Q4_K_M quality; all single-user forum performance numbers. Treat them as qualification hypotheses (PRD G3), not results.

## Sources

1. https://blog.kubesimplify.com/day-3-the-dgx-spark-unpacked-gb10-unified-memory-sm-121-and-the-one-reason-this-hardware-exists ; https://github.com/Sggin1/DGX-SPARK/tree/main/nvfp4-guide ; https://vlaicu.io/posts/dgx-vllm/
2. https://vllm.ai/blog/2026-06-01-vllm-dgx-spark
3. https://forums.developer.nvidia.com/t/state-of-native-nvfp4-kernel-support-on-gb10/372559
4. https://arxiv.org/abs/2505.20276
5. https://github.com/vllm-project/vllm/issues/19605
6. https://github.com/eugr/spark-vllm-docker/issues/143
7. https://developer.nvidia.com/blog/introducing-nvfp4-for-efficient-and-accurate-low-precision-inference/
8. https://arxiv.org/abs/2509.23202
9. https://forums.developer.nvidia.com/t/llama-cpp-nvfp4-native-support-on-blackwell/368430
10. https://insiderllm.com/guides/fp4-inference-llamacpp-nvfp4-mxfp4/ (secondary)
11. https://github.com/vllm-project/vllm/issues/55397
12. https://github.com/tonyd2wild/Hy3-295B-NVFP4-MTP-2x-DGX-Spark
13. https://arxiv.org/abs/2508.10925
14. https://github.com/ggml-org/llama.cpp/pull/17906
15. https://forums.developer.nvidia.com/t/vllm-on-gb10-gpt-oss-120b-mxfp4-slower-than-sglang-llama-cpp-what-s-missing/356651
16. https://arxiv.org/abs/2504.02692
17. https://github.com/ggml-org/llama.cpp/blob/master/tools/quantize/README.md
18. https://github.com/ggml-org/llama.cpp/discussions/16578
19. https://unsloth.ai/docs/basics/dynamic-3.0-ggufs/unsloth-dynamic-ggufs-on-aider-polyglot
20. https://unsloth.ai/docs/basics/dynamic-3.0-ggufs
21. https://arxiv.org/abs/2406.11235 ; https://arxiv.org/abs/2402.04396 ; https://arxiv.org/abs/2401.06118
22. https://github.com/turboderp-org/exllamav3
23. https://github.com/21tesla/exllamav3_TabbyAPI_Qwen-code
24. https://github.com/mobiusml/hqq
25. https://github.com/bitsandbytes-foundation/bitsandbytes/issues/1851
26. https://developers.googleblog.com/en/gemma-3-quantized-aware-trained-state-of-the-art-ai-to-consumer-gpus/
27. https://research.colfax-intl.com/cutlass-tutorial-nvfp4-blockscaled-gemm-on-nvidia-rtx-pro-blackwell-gpus-sm12x/ ; https://github.com/NVIDIA/cutlass/issues/2947
28. https://github.com/NVIDIA/TensorRT-LLM/issues/11368 ; https://github.com/NVIDIA/TensorRT-LLM/issues/11799
29. https://github.com/NVIDIA/cutlass/issues/2800
30. https://medium.com/@michael.hannecke/four-inference-engines-one-box-when-to-use-which-on-the-dgx-spark-6b32a53db768 (secondary)
31. https://aliteq.com/n-cpu-moe-llama-cpp-what-it-actually-does (secondary)
32. https://gist.github.com/DocShotgun/a02a4c0c0a57e43ff4f038b46ca66ae0
33. https://github.com/ggml-org/llama.cpp/discussions/15396
34. https://carteakey.dev/blog/optimizing-gpt-oss-120b-local-inference/
35. https://www.cerebras.ai/blog/reap
36. https://github.com/CerebrasResearch/reap
37. https://arxiv.org/abs/2510.13999
38. https://huggingface.co/brandonmusic/GLM-5.2-NVFP4-REAP-Recall-N172/blob/main/README.md (community)
39. https://github.com/tonyd2wild/Hy3-295B-NVFP4-MTP-2x-DGX-Spark
40. https://vllm.ai/blog/2026-04-22-fp8-kvcache
41. https://docs.vllm.ai/en/v0.9.2/features/quantization/quantized_kvcache.html
42. https://github.com/ggml-org/llama.cpp/discussions/23470
43. https://dev.to/dreamdeck/v-cache-quantization-requires-flashattn-the-llamacpp-error-that-quietly-halves-your-context-1kdb (secondary)
44. https://github.com/ggml-org/llama.cpp/issues/28455
45. https://arxiv.org/abs/2503.01840
46. https://arxiv.org/html/2609.22156
47. https://arxiv.org/html/2505.19645v3
48. https://github.com/vllm-project/vllm/issues/37754
49. https://forums.developer.nvidia.com/t/minimax-m3-428b-moe-vision-at-14-15-tok-s-on-2x-dgx-spark-eagle3-speculative-decoding-is-the-unlock/375475
50. https://arxiv.org/abs/2212.09720
51. https://arxiv.org/abs/2411.17691
52. https://research.nvidia.com/labs/nemotron/files/NVFP4-QAD-Report.pdf
53. https://nvidia.custhelp.com/app/answers/detail/a_id/5490/~/system-memory-fallback-for-stable-diffusion
54. https://github.com/vllm-project/vllm/issues/41614
