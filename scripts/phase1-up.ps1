#!/usr/bin/env pwsh
# phase1-up.ps1 — boot the Phase 1 telemetry plane in dependency order.
#
# Prerequisites:
#   - Docker Desktop installed and running.
#       winget install Docker.DockerDesktop
#   - This script is PowerShell 5.1-compatible: no `&&`, no `||`, no
#     ternary operators. We chain commands via `if ($?)` instead.
#
# Boot order:
#   1. Langfuse (Postgres + server)
#   2. OTel Collector (depends on `langfuse-server` being resolvable)
#   3. Letta (independent — bring up last)
#
# Exits 1 on the first docker failure.

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$langfuse = Join-Path $root 'infra/langfuse/docker-compose.yml'
$otel     = Join-Path $root 'infra/otel-collector/docker-compose.yml'
$letta    = Join-Path $root 'infra/letta/docker-compose.yml'

function Invoke-ComposeUp {
    param(
        [Parameter(Mandatory = $true)][string] $Label,
        [Parameter(Mandatory = $true)][string] $File,
        [Parameter(Mandatory = $true)][string] $Profile
    )
    Write-Host "[$Label] docker compose --profile $Profile -f $File up -d"
    & docker compose --profile $Profile -f $File up -d
    if (-not $?) {
        Write-Error "[$Label] docker compose up failed (see output above)."
        exit 1
    }
    Write-Host "[$Label] up."
}

Write-Host '== Phase 1 telemetry plane: boot =='

Invoke-ComposeUp -Label 'langfuse' -File $langfuse -Profile 'langfuse'
Invoke-ComposeUp -Label 'otel'     -File $otel     -Profile 'otel'
Invoke-ComposeUp -Label 'letta'    -File $letta    -Profile 'letta'

Write-Host ''
Write-Host '== Up =='
Write-Host '  Langfuse UI:    http://localhost:3000'
Write-Host '  OTLP HTTP in:   http://localhost:4319/v1/traces  (collector)'
Write-Host '  OTLP gRPC in:   localhost:4317                   (collector)'
Write-Host '  Letta MCP:      http://localhost:8283'
