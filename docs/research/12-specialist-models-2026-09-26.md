# Specialist model portfolio and memory residency

Researched 2026-09-26 for [PRD v0.2](../PRD.md) decision D-06 and OQ-12. **[est.]** = engineering estimate; **[unverified]** = not confirmed from a primary source; **NC** = non-commercial or revenue-capped license. Sources at the end.

## 0. Findings that change the plan

1. **The resident LLM covers most vision.** Qwen3.5 and later are natively multimodal (early fusion); Qwen3.5-9B alone scores OCRBench 89.2 / OmniDocBench 87.7 [V1]. A resident Qwen3.8-27B can likely review UI screenshots without a separate VLM — **verify the NVFP4 build keeps the vision tower**. Specialists are needed for bulk OCR and for Atlas when the coder holds the GPU.
2. **Tiny OCR models beat general VLMs on documents:** GLM-OCR 0.9B (MIT weights) 94.62 on OmniDocBench v1.5; PaddleOCR-VL-1.5 94.5, 1.6 96.33 on v1.6; DeepSeek-OCR-2 90.25; dots.ocr 88.4; olmOCR 2 85.7 [V2–V4].
3. **vLLM sleep level 1 likely frees little on GB10.** It moves weights to CPU RAM, which is the same physical pool on unified memory; level 2 (discard weights, reload on wake) is what frees memory [R3][R4] [est., test on Alcyone].
4. **Many strong 2026 image models are NC or revenue-capped** (FLUX.2 [dev] and [klein] 9B, Qwen-Image-2.1, Ideogram 4, Krea 2, HunyuanImage 3). The permissive core is Qwen-Image-2512, Qwen-Image-Edit-2511, Z-Image and FLUX.2 [klein] 4B.

## 1. Capability portfolio

| Capability | Primary | Alternatives | Size at quant [est.] | License | Machine | Residency |
|---|---|---|---|---|---|---|
| Fast text-to-image + edit | FLUX.2 [klein] 4B (FP8/NVFP4, 4 steps) [I1][I2] | Z-Image-Turbo 6B [I3] | ~6–8 GB | Apache | Atlas | On-demand GPU lease |
| Text/logo/UI-mockup images | Qwen-Image-2512 [I4][I5] | Ideogram 4 (**NC**) [I6], Krea 2 (capped) [I7] | GGUF Q4–Q5 ~12–14 GB + encoder in RAM; ~30 GB FP8 on Alcyone | Apache | Atlas or Alcyone | On-demand |
| Image edit / inpaint | Qwen-Image-Edit-2511 [I8] | FLUX.2 klein 4B edit; Qwen-Image-2.1 RGBA layers (**NC**) [I9] | as above | Apache | Atlas / Alcyone | On-demand |
| PDF → Markdown OCR | PaddleOCR-VL-1.6 (official GGUF + vLLM recipe) [V3][V5] | GLM-OCR [V2]; DeepSeek-OCR-2 | ~2–3 GB | Apache / MIT | Alcyone; Atlas CPU fallback | On-demand, short TTL |
| Screenshot / UI review | Resident multimodal LLM | Qwen3.5-9B / 4B [V1][V6] | 9B Q4 ~7 GB; 4B ~3.5 GB | Apache | Alcyone; Atlas | Resident LLM / on-demand |
| Speech-to-text (batch) | Qwen3-ASR-1.7B (52 languages, 5.76% WER) [S1] | Parakeet TDT 0.6B v3 (CC-BY), Whisper-v3-turbo (MIT) | ~4 / ~2 GB | Apache | Alcyone or Atlas CPU | Resident |
| Speech-to-text (streaming) | Voxtral Mini 4B Realtime [S1] | Kyutai STT 1B (CC-BY) | ~9 GB BF16 | Apache | Alcyone | Resident (27B variant) |
| Skippy's voice (TTS) | Qwen3-TTS 1.7B/0.6B: VoiceDesign → clone [S2][S3] | Chatterbox Turbo 350M (tags, watermark) [S4]; Kokoro-82M CPU fallback [S5] | 4–8 / ~2 GB / CPU | Apache / MIT / Apache | Alcyone; Atlas CPU fallback | Resident |
| Routing / classification / JSON | Qwen3.5-4B non-thinking [V6] | Gemma 4 E4B (text+image+audio) [T1]; Granite 4.2 3B [T2] | ~4–5 GB | Apache | Alcyone | Resident |
| FIM autocomplete | Qwen2.5-Coder-1.5B base Q8 [T3] | Qwen2.5-Coder-7B base | ~1.7 / ~5 GB | Apache | Atlas GPU | Resident beside the coder |
| Embeddings | Qwen3-Embedding-0.6B [E1] | KaLM-Embedding-V2 (license unverified) [E2]; Qwen3-VL-Embedding for figures/PDFs [E3] | ~1.2 GB | Apache | Alcyone (+ Atlas CPU copy) | Resident |
| Reranker | Qwen3-Reranker-0.6B [E1] | Qwen3-VL-Reranker [E3] | ~1.2 GB | Apache | Alcyone | Resident |
| Output safety | Qwen3Guard-Stream-0.6B + Gen-0.6B [G1] | Gen-4B for disputes | ~1.5 GB each | Apache | Alcyone | Resident |
| Prompt-injection screen | ProtectAI deberta-v3-prompt-injection-v2 [G2] | Llama Prompt Guard 2 86M (Llama license) [G3] | < 0.5 GB | Apache | Atlas CPU (harness) | Resident |
| Music | ACE-Step 1.5 [O1] | ACE-Step 1.5 XL | ~4 / 12+ GB | MIT | Alcyone | On-demand |
| Short video | Wan 2.2 TI2V-5B [O2] | LTX-2.5 (capped) [O3] | 16+ GB | Apache | Alcyone | On-demand batch |
| 3D assets | TRELLIS.2-4B [O4] | Hunyuan3D 2.1 (community) | ~24 GB | MIT | Alcyone (27B variant) | On-demand batch |

**Avoid for product use:** VibeVoice (research-only, code pulled) [S6]; Higgs Audio v2/v3 (user cap / NC) [S7]; Orpheus 3B until its Llama-derived license is confirmed; LFM2.5 until the LFM Open License revenue terms are checked [T4]. **Skippy's voice must be an original designed voice**, not a clone of a real narrator.

**Diffusion speed.** The Spark is bandwidth-bound for diffusion: independent diffusers BF16 tests at 50 steps measured FLUX.2-klein-9B 95 s / 66 GB and Qwen-Image-2512 212 s / 63 GB (overstated for distilled models) [I10]; NVIDIA quotes FLUX.1 FP4 TensorRT ~2.6 s per 1K image [I11]. A 16 GB Blackwell card at NVFP4/FP8 should be several times faster per image; klein 4B NVFP4 on a 5070 Ti ≈ 3–6 s [est.]. **Interactive image work belongs on Atlas; large or batch jobs on Alcyone.** Nunchaku SVDQuant (W4A4/NVFP4) gives ~3× speed on Blackwell but has uneven tool support [I12][I13]; stable-diffusion.cpp supports most listed models but lacks an OpenAI-style API [I14].

## 2. Memory budgets [est.]

**Alcyone, Variant A — resident Qwen3.8-27B NVFP4 (recommended default), ~90 GB usable:**

| Slot | Contents | GB |
|---|---|---|
| Resident LLM | Qwen3.8-27B NVFP4 + KV (4×64K) | 40 |
| Resident small tier | Qwen3.5-4B router 5, embed 1.5, rerank 1.5, guard-stream 1.5, guard-gen 1.5, Qwen3-ASR 4, Qwen3-TTS-1.7B 7 | 22 |
| On-demand pool (one or two at a time) | Qwen-Image-2512/Edit FP8 (~30) **or** PaddleOCR-VL + Qwen3.5-9B (~15) **or** Voxtral (9) **or** Wan/TRELLIS batch (~24) | 28 |
| Headroom | page cache, CUDA graphs | 0–5 |

**Alcyone, Variant B — resident Qwen3.5-122B-A10B:** capped to ~75 GB (shorter context, lower KV concurrency) leaves ~11.5 GB for embed/rerank/guard/2B router/TTS-0.6B and ~3 GB for OCR. All image, video, 3D and heavy speech moves to Atlas or to scheduled windows where the 122B enters level-2 sleep (wake requires weight reload; seconds for large models vs 20–100 s cold starts; sleep endpoints need `VLLM_SERVER_DEV_MODE=1`, trusted network only) [R3].

**Atlas (both variants):**

| Mode | VRAM | RAM / CPU |
|---|---|---|
| Coding (default) | Qwen3.6-35B-A3B with partial expert offload ~12–13 GB + FIM 1.5B ~1.7 GB | Offloaded experts ~8–10 GB; always-on CPU services: Kokoro, prompt-injection screen, whisper.cpp/Parakeet ONNX, embedding copy |
| Image lease | Coder unloaded; ComfyUI with FLUX.2 klein 4B (~6–8 GB) or Qwen-Image-Edit GGUF Q4 (~12 GB), text encoder in RAM | Coder GGUF stays in the Windows file cache → reload ≈ 5–15 s [est., measure] |
| Vision/OCR (Variant B) | Qwen3.5-9B Q4 or PaddleOCR-VL beside FIM | — |

## 3. Runtimes and multiplexing

- **Alcyone:** vLLM for the resident LLM with a fixed GB reservation (`--gpu-memory-utilization-gb`) [R4]; small residents as capped vLLM instances or `llama-server` router mode (per-model processes, `/models` load/unload, LRU at `--models-max`, `--sleep-idle-seconds`) [R2]; **llama-swap** as the front door with a `persistent` resident group and `exclusive` on-demand groups with per-model `ttl` — it can launch vLLM or llama.cpp commands [R1]. Diffusion in ComfyUI (NVIDIA Spark playbook [I15]); release memory after jobs with `POST /free {"unload_models":true,"free_memory":true}` (route location unverified). Triton is unnecessary at this scale.
- **Atlas:** `llama-server` router mode or llama-swap for text (coder + FIM persistent); ComfyUI as a separate process. **A GPU lease broker in the agent-runtime sidecar** grants an image lease by unloading the coder, running ComfyUI, calling `/free`, reloading the coder, and emitting spans for each transition. LM Studio (JIT load, TTL auto-evict) [R5] and Ollama (`keep_alive`) [R6] are acceptable fallbacks with weaker co-residency control. CPU services run as ONNX/whisper.cpp processes.
- **Lease defaults (OQ-12):** the coder lease wins; image jobs queue unless Atlas has been idle N minutes or the owner explicitly asks; Alcyone's on-demand pool is first-come with a 10-minute TTL; NC models are gated behind `license_class: noncommercial` in the deployment catalog.

## 4. Board mapping

| Board | Specialists |
|---|---|
| Engineering | Resident LLM, multimodal screenshot/diagram review, embed + rerank over code/ADRs |
| Coding | Atlas coder, FIM, prompt-injection screen on tool output, reranker |
| Design | FLUX.2 klein 4B ideation, Qwen-Image-2512 mockups/logos, Qwen-Image-Edit-2511 iteration, multimodal critic, TRELLIS.2 (optional), costume/sprite layers (Qwen-Image-2.1 only if NC acceptable) |
| Marketing | Qwen-Image-2512 ads, Qwen3-TTS/Chatterbox voiceover, ACE-Step jingles, Wan 2.2 clips, Qwen3Guard brand safety |
| Finance | PaddleOCR-VL/GLM-OCR for statements, Qwen3.5-4B / Granite extraction, guard |
| Research | OCR → vault pipeline (fixes assessment A04's lossy ingest), embed + rerank, Qwen3-VL-Embedding, resident LLM synthesis, Qwen3-ASR |
| Publishing | OCR/Markdown normalizer, Qwen-Image covers, Qwen3-TTS narration, guard |
| DevOps | Qwen3.5-2B/4B log triage, structured parsers, the residency broker, guards |
| Skippy | Router, Qwen3-ASR/Voxtral listening, Skippy voice (Qwen3-TTS → Kokoro fallback), Qwen3Guard-Stream |

## 5. Verify before relying

NVFP4 LLM builds keep the vision tower; real memory freed by vLLM sleep level 1 on GB10; llama-swap proxying ComfyUI; 5070 Ti per-image timings; licenses for KaLM-V2, Orpheus, MinerU, dots.ocr, SD3.5 and LFM; FIM quality of Qwen3.6-35B-A3B.

## Sources

- V1 https://huggingface.co/Qwen/Qwen3.5-9B · V2 https://huggingface.co/zai-org/GLM-OCR · V3 https://arxiv.org/pdf/2601.21957 ; https://arxiv.org/pdf/2606.03264 ; https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.6 · V4 https://regolo.ai/deepseek-ocr-vs-glm-ocr-vs-paddleocr-benchmark-2026/ · V5 https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.6-GGUF ; https://recipes.vllm.ai/PaddlePaddle/PaddleOCR-VL-1.6 · V6 https://artificialanalysis.ai/articles/qwen3-5-small-models ; https://codersera.com/blog/qwen-3-8-model-lineup-2026/
- I1 https://huggingface.co/black-forest-labs/FLUX.2-klein-4B · I2 https://bfl.ai/blog/flux2-klein-towards-interactive-visual-intelligence · I3 https://huggingface.co/Tongyi-MAI/Z-Image-Turbo ; https://github.com/Tongyi-MAI/Z-Image · I4 https://www.thundercompute.com/blog/best-open-source-image-generation-models · I5 https://qwen-image-2512.com/blog/qwen-image-2512-gguf-complete-guide ; https://byteshape.com/blogs/Qwen-Image-2512/ · I6 https://ideogram.ai/blog/ideogram-4.0/ · I7 https://venturebeat.com/technology/enterprise-grade-ai-image-generation-in-2-seconds-is-here-krea-2-raw-and-turbo-available-as-open-weights-under-custom-license · I8 https://huggingface.co/Qwen/Qwen-Image-Edit-2511 ; https://huggingface.co/unsloth/Qwen-Image-Edit-2511-GGUF · I9 https://huggingface.co/Qwen/Qwen-Image-2.1 · I10 https://www.haruni.net/en/blog/dgx-spark · I11 https://developer.nvidia.com/blog/how-nvidia-dgx-sparks-performance-enables-intensive-ai-tasks · I12 https://github.com/nunchaku-ai/nunchaku ; https://huggingface.co/blog/nunchaku-diffusers · I13 https://github.com/Acly/krita-ai-diffusion/discussions/2081 · I14 https://github.com/leejet/stable-diffusion.cpp/blob/master/README.md · I15 https://build.nvidia.com/spark/comfyui ; FLUX.2 [dev] fit: https://tinytiny.tools/en/blog/flux-2-self-hosting ; klein 9B: https://huggingface.co/black-forest-labs/FLUX.2-klein-9B
- S1 https://www.marktechpost.com/2026/07/23/best-open-speech-recognition-asr-models-in-2026-wer-languages-latency-and-license-compared/ · S2 https://qwen.ai/blog?id=qwen3tts-0115 ; https://arxiv.org/html/2601.15621v1 · S3 https://betterstack.com/community/guides/ai/qwen3-tts/ · S4 https://huggingface.co/ResembleAI/chatterbox-turbo · S5 https://huggingface.co/hexgrad/Kokoro-82M · S6 https://huggingface.co/microsoft/VibeVoice-Realtime-0.5B ; https://byteiota.com/microsoft-vibevoice-the-voice-ai-microsoft-pulled-back/ · S7 https://huggingface.co/bosonai/higgs-audio-v2-generation-3B-base/blob/main/LICENSE
- T1 https://huggingface.co/google/gemma-4-E4B-it · T2 https://www.orcarouter.ai/blog/granite-4-2-3b-vs-lfm2-5-2-6b-base · T3 https://localaimaster.com/blog/best-local-autocomplete-models ; https://arxiv.org/html/2603.00729v1 · T4 https://venturebeat.com/technology/liquid-ais-smallest-model-yet-lfm2-5-230m-beats-models-4x-its-size-at-data-extraction-can-run-anywhere
- E1 https://qwen.ai/blog?id=qwen3-embedding · E2 https://arxiv.org/pdf/2506.20923 · E3 https://arxiv.org/pdf/2601.04720
- G1 https://github.com/QwenLM/Qwen3Guard · G2 https://github.com/vaporif/parry-guard · G3 https://huggingface.co/meta-llama/Llama-Prompt-Guard-2-86M
- O1 https://github.com/ace-step/ACE-Step-1.5 · O2 https://huggingface.co/Wan-AI/Wan2.2-TI2V-5B · O3 https://www.therundown.ai/tools/ltx-2 · O4 https://trellis2.com/blog/trellis-2-vs-hunyuan3d-image-to-3d
- R1 https://github.com/mostlygeek/llama-swap · R2 https://huggingface.co/blog/ggml-org/model-management-in-llamacpp · R3 https://vllm.ai/blog/2025-10-26-sleep-mode ; https://docs.vllm.ai/en/latest/features/sleep_mode/ · R4 https://vllm.ai/blog/2026-06-01-vllm-dgx-spark · R5 https://lmstudio.ai/docs/app/api/ttl-and-auto-evict · R6 https://docs.ollama.com/faq
