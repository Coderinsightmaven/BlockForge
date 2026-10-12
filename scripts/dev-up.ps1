# Starts the local control plane and (optionally) the SSH reverse tunnel to the test node as detached
# processes that outlive the current terminal. Logs: .data/control-plane.log, .data/tunnel.log.
# Stop with: scripts/dev-down.ps1
param([switch]$Tunnel)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$data = Join-Path $root ".data"
New-Item -ItemType Directory -Force $data | Out-Null

$env:DATABASE_URL = "postgres://blockforge:blockforge-dev-only@127.0.0.1:55432/blockforge"
$env:VICTORIA_METRICS_URL = "http://127.0.0.1:58428"
$env:AGENT_URL = "http://127.0.0.1:18080"
$env:LOG_LEVEL = "info"

$cp = Start-Process -FilePath "cmd.exe" -WindowStyle Hidden -PassThru `
  -WorkingDirectory (Join-Path $root "apps\control-plane") `
  -ArgumentList "/c", "npx tsx --conditions=@blockforge/source src/main.ts > `"$data\control-plane.log`" 2>&1"
Set-Content -Path (Join-Path $data "control-plane.pid") -Value $cp.Id

if ($Tunnel) {
  $t = Start-Process -FilePath "ssh.exe" -WindowStyle Hidden -PassThru `
    -RedirectStandardError (Join-Path $data "tunnel.log") `
    -ArgumentList "-N", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15", `
      "-o", "ServerAliveCountMax=3", "-R", "127.0.0.1:18080:127.0.0.1:8080", "game@10.10.10.240"
  Set-Content -Path (Join-Path $data "tunnel.pid") -Value $t.Id
}
Write-Output "control plane pid $($cp.Id)$(if ($Tunnel) { ", tunnel pid $($t.Id)" })"
