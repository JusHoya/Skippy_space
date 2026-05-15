#!/usr/bin/env pwsh
# phase1-status.ps1 — report whether each Phase 1 stack is currently up.
#
# Prerequisites:
#   - Docker Desktop installed and running.
#       winget install Docker.DockerDesktop
#   - PowerShell 5.1-compatible (no `&&`, no `||`, no ternaries).
#
# Output is one section per stack: the raw `docker compose ps` table,
# followed by a one-line summary. Exits 0 always — this is informational.

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$stacks = @(
    @{ Label = 'langfuse'; File = (Join-Path $root 'infra/langfuse/docker-compose.yml');       Profile = 'langfuse' }
    @{ Label = 'otel';     File = (Join-Path $root 'infra/otel-collector/docker-compose.yml'); Profile = 'otel' }
    @{ Label = 'letta';    File = (Join-Path $root 'infra/letta/docker-compose.yml');           Profile = 'letta' }
)

Write-Host '== Phase 1 telemetry plane: status =='

foreach ($s in $stacks) {
    Write-Host ''
    Write-Host "[$($s.Label)] $($s.File)"
    & docker compose --profile $($s.Profile) -f $($s.File) ps
    if (-not $?) {
        Write-Warning "[$($s.Label)] docker compose ps failed (is Docker Desktop running?)."
    }
}
