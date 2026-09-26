#!/usr/bin/env bash
# alcyone-inventory.sh — READ-ONLY inventory of Alcyone (DGX Spark) for
# docs/ops/ALCYONE-INVENTORY.md (PRD OQ-01, FR-CLUSTER-01/02).
#
# Run ON alcyone as the normal user (no sudo):
#   bash alcyone-inventory.sh            # writes ./alcyone-inventory-<UTC stamp>.txt
#
# This script never starts, stops, pulls, removes or edits anything. It does
# not print container environment variables (they can hold HF/API tokens).
# Review the output file for secrets before copying it off the host.

set -u
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${1:-./alcyone-inventory-${STAMP}.txt}"
HF_CACHE="${HF_HOME:-$HOME/.cache/huggingface}/hub"

section() { printf '\n===== %s =====\n' "$1"; }
run() {
  printf '\n$ %s\n' "$*"
  if command -v "${1}" >/dev/null 2>&1; then "$@" 2>&1; else echo "(not installed: $1)"; fi
}

{
  section "0. Capture metadata"
  echo "utc: ${STAMP}"
  echo "host: $(hostname)  user: $(id -un)"
  echo "script: alcyone-inventory.sh (read-only)"

  section "1. Host, OS, CPU, memory"
  run uname -a
  run cat /etc/os-release
  run uptime
  run lscpu
  run free -g
  run grep -E 'MemTotal|MemAvailable|Cached|SwapTotal|SwapFree' /proc/meminfo

  section "2. GPU, driver, CUDA"
  run nvidia-smi
  run nvidia-smi --query-gpu=name,driver_version,memory.total,memory.used,temperature.gpu,power.draw --format=csv
  run nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv
  run nvcc --version
  run nvidia-ctk --version

  section "3. Storage"
  run df -h -x tmpfs -x devtmpfs -x overlay
  run lsblk -o NAME,SIZE,TYPE,MOUNTPOINT,FSTYPE

  section "4. Docker"
  run docker version --format '{{.Server.Version}} (client {{.Client.Version}})'
  run docker compose version
  run docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
  run docker images --digests --format 'table {{.Repository}}\t{{.Tag}}\t{{.Digest}}\t{{.Size}}\t{{.CreatedSince}}'
  run docker system df
  for c in $(docker ps -a --format '{{.Names}}' 2>/dev/null); do
    printf '\n$ docker inspect %s (selected fields; Env omitted)\n' "$c"
    docker inspect "$c" --format \
'image_ref={{.Config.Image}}
image_id={{.Image}}
status={{.State.Status}} started={{.State.StartedAt}} finished={{.State.FinishedAt}} exit={{.State.ExitCode}}
restart_policy={{.HostConfig.RestartPolicy.Name}}
network_mode={{.HostConfig.NetworkMode}}
ports={{json .HostConfig.PortBindings}}
mounts={{range .Mounts}}{{.Source}}->{{.Destination}}({{.Mode}}) {{end}}
memory_limit={{.HostConfig.Memory}} cpuset={{.HostConfig.CpusetCpus}}
cmd={{json .Config.Cmd}}
args={{json .Args}}' 2>&1
  done

  section "5. Model caches"
  echo "HF cache: ${HF_CACHE}"
  if [ -d "${HF_CACHE}" ]; then
    for d in "${HF_CACHE}"/models--*; do
      [ -d "$d" ] || continue
      size="$(du -sh "$d" 2>/dev/null | cut -f1)"
      rev="$(cat "$d/refs/main" 2>/dev/null || echo 'no refs/main')"
      snaps="$(ls "$d/snapshots" 2>/dev/null | tr '\n' ' ')"
      printf '%s\t%s\trefs/main=%s\tsnapshots=%s\n' "$size" "$(basename "$d")" "$rev" "$snaps"
    done
    printf '\nincomplete downloads: '
    find "${HF_CACHE}" -name '*.incomplete' 2>/dev/null | wc -l
  else
    echo "(no HF cache at ${HF_CACHE})"
  fi
  for p in "$HOME/.lmstudio/models" "$HOME/.cache/lm-studio/models" "$HOME/.ollama/models"; do
    [ -d "$p" ] && { printf '\n$ du -sh %s/*\n' "$p"; du -sh "$p"/* 2>/dev/null; }
  done

  section "6. Listeners (expect loopback-only model services)"
  run ss -ltnH
  echo
  for port in 8000 8001 8002 18000 1234 8050; do
    if ss -ltnH "sport = :${port}" 2>/dev/null | grep -q .; then echo "port ${port}: IN USE"; else echo "port ${port}: free"; fi
  done

  section "7. Hermes and sessions"
  run tmux ls
  run hermes --version
  echo "(Hermes config: record endpoint, model id, context and max output by hand; do not paste keys)"

  section "8. Money Printer schedule (must be paused per D-03)"
  run systemctl --user list-timers --all
  run systemctl list-timers --all --no-pager
  run systemctl list-units --all --no-pager 'mp-*'
  run crontab -l

  section "9. Toolchains"
  run python3 --version
  run git --version
  if [ -d "$HOME/projects/money_printer/.git" ]; then
    run git -C "$HOME/projects/money_printer" log -1 --format='%h %ci %s'
    run git -C "$HOME/projects/money_printer" status --short --branch
  fi

  section "10. Idle baseline (after everything above)"
  run free -g
  run nvidia-smi --query-gpu=memory.used,utilization.gpu,power.draw --format=csv
} > "${OUT}" 2>&1

echo "Wrote ${OUT}"
echo "Review it for secrets before copying it off alcyone."
