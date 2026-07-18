# Openship installer (Windows) — https://get.openship.io
#
#   irm https://raw.githubusercontent.com/oblien/openship/main/scripts/install.ps1 | iex
#
# Installs the Openship CLI, which sets up and runs the self-hosted server
# (`openship init`, `openship server`). No Node or npm required — Openship runs
# on Bun, and this installs Bun for you if it's missing.
#
# Env overrides:
#   $env:OPENSHIP_VERSION = "0.1.9"   # pin a specific CLI version

$ErrorActionPreference = "Stop"
function Info($m) { Write-Host "==> $m" -ForegroundColor Cyan }

# 1. Ensure Bun (the runtime; no Node/npm needed).
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  Info "Installing the Bun runtime..."
  Invoke-RestMethod https://bun.sh/install.ps1 | Invoke-Expression
  $env:Path = "$env:USERPROFILE\.bun\bin;$env:Path"
}

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  Write-Error "Bun installed but 'bun' is not on PATH. Open a new terminal and re-run."
  exit 1
}

# 2. Install the Openship CLI globally (Bun fetches it from the registry —
#    the npm CLI itself is never invoked).
$pkg = "openship"
if ($env:OPENSHIP_VERSION) { $pkg = "openship@$($env:OPENSHIP_VERSION)" }
Info "Installing the Openship CLI ($pkg)..."
bun add -g $pkg

Write-Host ""
Write-Host "Openship installed." -ForegroundColor Green
Write-Host "  openship init      # configure your self-hosted server"
Write-Host "  openship server    # run it"
Write-Host "  openship --help"
Write-Host ""
Write-Host "If 'openship' isn't found, restart your terminal (PATH was updated)."
