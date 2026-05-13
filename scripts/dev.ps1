#!/usr/bin/env pwsh
param([switch]$Install)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
if ($Install -or -not (Test-Path "$root/node_modules")) {
  & pnpm install
}
& pnpm --filter @skippy/agent-runtime build
& pnpm --filter @skippy/shell dev
