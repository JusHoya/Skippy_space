#!/usr/bin/env pwsh
# phase1-down.ps1 — gracefully tear down the Phase 1 telemetry plane.
#
# Prerequisites:
#   - Docker Desktop installed and running.
#       winget install Docker.DockerDesktop
#   - PowerShell 5.1-compatible (no `&&`, no `||`, no ternaries).
#
# Teardown order is the inverse of boot:
#   1. Letta       (independent — drop first)
#   2. OTel        (releases :4317/:4319 before Langfuse goes)
#   3. Langfuse    (last; volume `langfuse-pgdata` survives unless you
#                    add `-v` manually)
#
# Volumes are preserved by default — pass `-Volumes` to also drop them.

[CmdletBinding()]
param(
    [switch] $Volumes
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$langfuse = Join-Path $root 'infra/langfuse/docker-compose.yml'
$otel     = Join-Path $root 'infra/otel-collector/docker-compose.yml'
$letta    = Join-Path $root 'infra/letta/docker-compose.yml'

function Invoke-ComposeDown {
    param(
        [Parameter(Mandatory = $true)][string] $Label,
        [Parameter(Mandatory = $true)][string] $File,
        [Parameter(Mandatory = $true)][string] $Profile
    )
    $extra = @()
    if ($Volumes) { $extra += '-v' }
    Write-Host "[$Label] docker compose --profile $Profile -f $File down $($extra -join ' ')"
    & docker compose --profile $Profile -f $File down @extra
    if (-not $?) {
        Write-Warning "[$Label] docker compose down reported a failure (continuing)."
    }
    Write-Host "[$Label] down."
}

Write-Host '== Phase 1 telemetry plane: teardown =='

Invoke-ComposeDown -Label 'letta'    -File $letta    -Profile 'letta'
Invoke-ComposeDown -Label 'otel'     -File $otel     -Profile 'otel'
Invoke-ComposeDown -Label 'langfuse' -File $langfuse -Profile 'langfuse'

Write-Host ''
Write-Host '== Down =='
