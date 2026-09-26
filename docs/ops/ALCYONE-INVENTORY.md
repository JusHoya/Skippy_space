# Alcyone inventory checklist

Resolves PRD OQ-01 and is the first step of the Hermes consolidation procedure ([model plan](../MODEL-AND-CLUSTER-PLAN.md) §2). Money Printer is paused and the model service is down (D-03), so this is a **quiet-host** inventory. Nothing in this checklist changes the host.

## Ground rules

- **Read-only.** Do not start, stop, pull, remove or edit containers, units, caches or configs. Do **not** run `money_printer/deploy/spark/hermes_model_swap.sh`: it executes `docker rm -f mp-vllm`.
- **No secrets in the record.** `docker inspect` without a format prints container `Env`, which can include tokens. The script omits it. Redact keys, tokens and hostnames you don't want in Git before committing.
- **Date everything.** Each result carries a UTC time and a host. The September 1/2 Money Printer survey is history, not current state.

## How to run

1. From Atlas, copy the script: `scp scripts/ops/alcyone-inventory.sh alcyone:~/` (use whatever host alias you use; the Money Printer docs name it `spark-87a1.local`).
2. On Alcyone: `bash ~/alcyone-inventory.sh`. It writes `alcyone-inventory-<UTC>.txt` in the current directory.
3. Review the file for secrets, then copy it back: `scp alcyone:~/alcyone-inventory-*.txt docs/ops/inventory/`.
4. Fill in the record below and commit both.

## Checklist

### A. Host
- [ ] OS release, kernel, uptime.
- [ ] CPU layout (Grace cores); total and available memory at idle; swap.
- [ ] `nvidia-smi`: driver, CUDA version, GPU memory in use at idle. There should be no compute processes while paused.
- [ ] `nvcc`, NVIDIA container toolkit versions.

### B. Storage
- [ ] Free space on the filesystem holding `~/.cache/huggingface`.
  - Needed: Qwen3.8-27B NVFP4 ~27 GB; Qwen3.5-122B NVFP4 ~76–82 GB if qualified.
  - Specialist tier ~40–60 GB.
  - Keep headroom for the retained 9B rollback artifact.
- [ ] Other large directories (Docker images and volumes via `docker system df`).

### C. Containers and images
- [ ] `mp-vllm`: status, restart policy, image reference **and image ID/digest**, port binding (expect `127.0.0.1:8000`), mounts, full launch args.
  - The documented launch used unpinned `vllm/vllm-openai:latest`, so the digest is the only record of what actually ran.
  - With `--restart unless-stopped`, a container stopped by hand stays stopped across reboots. Confirm it is `exited`, not restarting.
- [ ] Money Printer lab/factory images and containers: `network_mode` should be `none`, and the memory limit should be 24 GB with the recorded cpuset.
- [ ] Any NGC (`nvcr.io`) or Spark-targeted vLLM images already present. They save a download for qualification.

### D. Model cache
- [ ] Every `models--*` entry: size, `refs/main` revision, snapshots. Expected, from history:
  - `ykarout/Qwen3.5-9B-NVFP4`: current Hermes model, **the rollback artifact**.
  - `nvidia/Qwen3.6-35B-A3B-NVFP4`: prior model, possibly still cached.
- [ ] Count of `*.incomplete` files (interrupted downloads).
- [ ] LM Studio / Ollama model directories, if present (the Pleiades plan preferred LM Studio in August).

### E. Network boundary
- [ ] All listeners. Model services must be loopback-only; nothing on `0.0.0.0` for inference.
- [ ] Candidate ports for the qualification server (8001/8002) and the Atlas tunnel port are free.
- [ ] From Atlas: `ssh alcyone hostname` works with a verified host key. Only test the tunnel (`ssh -N -L 18000:127.0.0.1:8000 alcyone`, then `curl http://127.0.0.1:18000/v1/models`) once a server is intentionally running.

### F. Hermes
- [ ] tmux sessions and Hermes version.
- [ ] Record by hand: model endpoint URL, served model id, context (**65,536 floor**; Hermes refuses less), max output (8,192), and the tool plugin list. No keys.

### G. Money Printer paused (D-03)
- [ ] `mp-factory-reconcile.timer` and `mp-ladder-capture.timer`: enabled or disabled, and next trigger time. The reconcile timer is weekly, Monday 14:30 UTC.
- [ ] No `mp-factory@*` unit running. Any cron entries.
- [ ] Money Printer checkout: commit and dirty state.
- If a timer is still enabled, note it and ask the owner. Disabling it is a Money Printer change, not part of this inventory.

### H. Idle baseline
- [ ] Final `free -g` and GPU memory/power after the script. This is the zero point for the mixed-load gates.

## Record (fill in, then commit to `docs/ops/inventory/`)

| Field | Value |
|---|---|
| Captured (UTC) / by | |
| OS / kernel | |
| Driver / CUDA / container toolkit | |
| Memory total / available at idle | |
| GPU memory used at idle | |
| Disk free on HF cache filesystem | |
| `mp-vllm` state / restart policy | |
| `mp-vllm` image digest | |
| `mp-vllm` args (model, util, max-model-len, max-num-seqs, parsers) | |
| Cached models (id @ revision, size) | |
| Rollback artifact present (9B NVFP4) | yes / no |
| Spark-targeted vLLM image available | |
| Listeners on 0.0.0.0 (should be none for inference) | |
| Free candidate ports | |
| Hermes endpoint / model / context / max output | |
| Money Printer timers state | |
| Anomalies / follow-ups | |

## After the inventory

1. Update PRD OQ-01 with the record's date and link.
2. Pick the qualification image: a pinned Spark-targeted vLLM build. The stock `:latest` tag is not reproducible ([research 09](../research/09-quantization-2026-09-26.md) §6).
3. Write download manifests for Qwen3.8-27B NVFP4 (default) and, if disk allows, the 122B challenger. Downloading is a separate, owner-approved step (FR-CLUSTER-02).
