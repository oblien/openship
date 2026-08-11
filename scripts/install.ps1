# Openship installer (Windows) — https://get.openship.io
#
#   irm https://git.openship.io/windows | iex
#
# Installs the Openship CLI as a self-contained, sha256-verified payload that
# runs under NODE. Node is the shipped runtime: this prefers a system `node`
# >= 22 and otherwise vendors an official Node 22 from nodejs.org into
# ~\.openship\runtime — it NEVER installs, pins, or gates a global runtime (the
# source of the Bun-vs-ssh2 crash class, oven-sh/bun#18546).
#
# After install: `openship` (interactive) or `openship up` runs Openship locally
# (API + dashboard); `openship install` fetches the desktop app.
#
# Env overrides:
#   $env:OPENSHIP_VERSION = "0.5.0"        pin a CLI version (default: latest)
#   $env:OPENSHIP_HOME    = "..."          install root (data dir, runtime, launcher)
#   $env:OPENSHIP_CLI_ASSET_URL = "..."    download the payload tarball from here
#                                          instead of GitHub (its .sha256 sidecar
#                                          must sit beside it); for testing a build

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"  # PS5.1's progress bar cripples downloads
function Info($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Fail($m) { Write-Error $m; exit 1 }

$Repo      = "oblien/openship"
$NodeMajor = 22
$NodeDist  = "https://nodejs.org/dist"

$HomeDir    = if ($env:OPENSHIP_HOME) { $env:OPENSHIP_HOME } else { Join-Path $env:USERPROFILE ".openship" }
$CliDir     = Join-Path $HomeDir "cli"
$RuntimeDir = Join-Path $HomeDir "runtime"
$BinDir     = Join-Path $HomeDir "bin"
$Launcher   = Join-Path $BinDir "openship.cmd"

if (-not (Get-Command tar -ErrorAction SilentlyContinue)) {
  Fail "tar is required (Windows 10 1803+ ships it). Update Windows, or install Git for Windows."
}

$Tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("openship-" + [System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Force -Path $Tmp | Out-Null

function Sha256($path) { (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLower() }

# Repoint a directory junction (no admin/dev-mode needed, unlike symlinks). The
# .Delete() on a junction removes only the reparse point, never the target.
function Repoint($link, $target) {
  if (Test-Path $link) { (Get-Item $link -Force).Delete() }
  New-Item -ItemType Junction -Path $link -Target $target | Out-Null
}

try {
  # ── 1. Resolve the release tag ──────────────────────────────────────────────
  if ($env:OPENSHIP_VERSION) {
    $Tag = if ($env:OPENSHIP_VERSION.StartsWith("v")) { $env:OPENSHIP_VERSION } else { "v$($env:OPENSHIP_VERSION)" }
  } else {
    Info "Resolving the latest release..."
    $rel = Invoke-RestMethod -Headers @{ "User-Agent" = "openship-cli" } "https://api.github.com/repos/$Repo/releases/latest"
    $Tag = $rel.tag_name
    if (-not $Tag) { Fail "could not resolve the latest release tag from GitHub" }
  }

  # ── 2. Download + verify + extract the payload → cli\<tag> ───────────────────
  $Asset = "openship-cli-$Tag.tar.gz"
  $AssetUrl = if ($env:OPENSHIP_CLI_ASSET_URL) { $env:OPENSHIP_CLI_ASSET_URL } else { "https://github.com/$Repo/releases/download/$Tag/$Asset" }

  Info "Downloading the Openship CLI ($Tag)..."
  $AssetTmp = Join-Path $Tmp $Asset
  Invoke-WebRequest -UseBasicParsing -Uri $AssetUrl -OutFile $AssetTmp
  # Fail-closed: no sidecar → refuse to install an unverified payload.
  $Expect = $null
  try { $Expect = (Invoke-WebRequest -UseBasicParsing -Uri "$AssetUrl.sha256").Content.Trim().Split()[0].ToLower() } catch {}
  if (-not $Expect) { Fail "no .sha256 sidecar for $Asset — refusing an unverified install" }
  $Actual = Sha256 $AssetTmp
  if ($Expect -ne $Actual) { Fail "payload checksum mismatch (expected $Expect, got $Actual)" }

  $Target = Join-Path $CliDir $Tag
  if (Test-Path $Target) { Remove-Item -Recurse -Force $Target }
  New-Item -ItemType Directory -Force -Path $Target | Out-Null
  tar -xzf $AssetTmp -C $Target
  if (-not (Test-Path (Join-Path $Target "dist\index.js"))) { Fail "payload extracted but dist\index.js is missing (bad tarball)" }
  New-Item -ItemType File -Force -Path (Join-Path $Target ".extracted") | Out-Null
  Repoint (Join-Path $CliDir "current") $Target

  # Prune old payloads, keeping current + the newest 2 (the in-use one survives).
  Get-ChildItem -Directory $CliDir |
    Where-Object { $_.Name -ne "current" -and $_.Name -ne $Tag } |
    Sort-Object LastWriteTime -Descending | Select-Object -Skip 1 |
    ForEach-Object { Remove-Item -Recurse -Force $_.FullName }

  # ── 3. Resolve Node: system >= NodeMajor, else vendor from nodejs.org ────────
  $NodeSource = "system"
  $sysNodeOk = $false
  if (Get-Command node -ErrorAction SilentlyContinue) {
    try {
      $maj = (& node -e "process.stdout.write(String(process.versions.node.split('.')[0]))").Trim()
      if ([int]$maj -ge $NodeMajor) { $sysNodeOk = $true }
    } catch {}
  }
  if ($sysNodeOk) {
    Info "Using system Node $(node --version)."
  } else {
    $NodeSource = "vendored"
    switch ($env:PROCESSOR_ARCHITECTURE) {
      "AMD64" { $NodeArch = "x64" }
      "ARM64" { $NodeArch = "arm64" }
      default { Fail "unsupported CPU arch for vendored Node: $($env:PROCESSOR_ARCHITECTURE) — install Node $NodeMajor+ and re-run" }
    }
    Info "No system Node >= $NodeMajor — fetching an official Node $NodeMajor from nodejs.org..."
    $idx = Invoke-RestMethod -Headers @{ "User-Agent" = "openship-cli" } "$NodeDist/index.json"
    $NodeVer = ($idx | Where-Object { $_.version -like "v$NodeMajor.*" -and $_.lts } | Select-Object -First 1).version
    if (-not $NodeVer) { $NodeVer = ($idx | Where-Object { $_.version -like "v$NodeMajor.*" } | Select-Object -First 1).version }
    if (-not $NodeVer) { Fail "could not resolve a Node $NodeMajor.x version from nodejs.org" }

    $NodeName = "node-$NodeVer-win-$NodeArch"
    $NodeZip  = "$NodeName.zip"
    $NodeZipTmp = Join-Path $Tmp $NodeZip
    Invoke-WebRequest -UseBasicParsing -Uri "$NodeDist/$NodeVer/$NodeZip" -OutFile $NodeZipTmp
    $shas = (Invoke-WebRequest -UseBasicParsing -Uri "$NodeDist/$NodeVer/SHASUMS256.txt").Content
    $NodeExpect = ($shas -split "`n" | Where-Object { $_.Trim().EndsWith(" $NodeZip") } | Select-Object -First 1)
    $NodeExpect = if ($NodeExpect) { $NodeExpect.Trim().Split()[0].ToLower() } else { $null }
    if (-not $NodeExpect) { Fail "no checksum for $NodeZip in SHASUMS256.txt" }
    if ($NodeExpect -ne (Sha256 $NodeZipTmp)) { Fail "Node download checksum mismatch" }

    New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
    $Unpacked = Join-Path $RuntimeDir $NodeName
    if (Test-Path $Unpacked) { Remove-Item -Recurse -Force $Unpacked }
    Expand-Archive -LiteralPath $NodeZipTmp -DestinationPath $RuntimeDir -Force
    if (-not (Test-Path (Join-Path $Unpacked "node.exe"))) { Fail "vendored Node unpacked but node.exe is missing" }
    Repoint (Join-Path $RuntimeDir "current") $Unpacked
  }

  # ── 4. Write the stable launcher shim (POSIX twin: scripts/install.sh) ───────
  # Location-independent: resolves ~\.openship from its own path, prefers a
  # system node >= 22, falls back to the vendored runtime. ASCII, no BOM (a BOM
  # breaks .cmd parsing). Regenerated on install; manual edits are overwritten.
  New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
  $LauncherBody = @'
@echo off
setlocal enabledelayedexpansion
for %%I in ("%~dp0..") do set "HOME_DIR=%%~fI"
set "CLI=%HOME_DIR%\cli\current\dist\index.js"
set "VENDORED=%HOME_DIR%\runtime\current\node.exe"
set "NMAJOR=0"
for /f "tokens=1 delims=." %%a in ('node -v 2^>nul') do set "NMAJOR=%%a"
set "NMAJOR=!NMAJOR:v=!"
if not "!NMAJOR!"=="" if !NMAJOR! GEQ 22 (
  node "%CLI%" %*
  exit /b !errorlevel!
)
if exist "%VENDORED%" (
  "%VENDORED%" "%CLI%" %*
  exit /b !errorlevel!
)
echo openship: no Node ^>= 22 found ^(system or vendored^). Reinstall: irm https://git.openship.io/windows ^| iex 1>&2
exit /b 127
'@
  Set-Content -Path $Launcher -Value $LauncherBody -Encoding ASCII

  # ── 5. Record the distribution marker (read by `openship update`) ────────────
  $marker = [ordered]@{ method = "tarball"; tag = $Tag; launcher = $Launcher; runtime = $NodeSource }
  ($marker | ConvertTo-Json) | Set-Content -Path (Join-Path $HomeDir "cli-install.json") -Encoding UTF8

  # ── 6. Migrate off any previous Bun-global install (never touch the user's Bun) ─
  if (Get-Command bun -ErrorAction SilentlyContinue) {
    try { bun remove -g openship 2>$null | Out-Null } catch {}
  }
  foreach ($f in @("openship", "openship.cmd", "openship.exe", "openship.ps1")) {
    $p = Join-Path $env:USERPROFILE ".bun\bin\$f"
    if (Test-Path $p) { Remove-Item -Force $p -ErrorAction SilentlyContinue }
  }

  # ── 7. Put openship on PATH (user scope) ─────────────────────────────────────
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if (-not (($userPath -split ";") -contains $BinDir)) {
    $newPath = if ($userPath) { "$BinDir;$userPath" } else { $BinDir }
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
  }
  $env:Path = "$BinDir;$env:Path"

  Write-Host ""
  Write-Host "Openship installed ($Tag, running under $NodeSource Node)." -ForegroundColor Green
  Write-Host ""
  Write-Host "  openship            # set up + deploy Openship (interactive)"
  Write-Host "  openship up         # or launch directly with defaults"
  Write-Host "  openship --help     # all commands"
  Write-Host ""
  Write-Host "If 'openship' isn't found, restart your terminal (PATH was updated)."
}
finally {
  Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
}
