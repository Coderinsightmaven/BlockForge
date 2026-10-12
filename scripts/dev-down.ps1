# Stops the processes started by scripts/dev-up.ps1.
$root = Split-Path -Parent $PSScriptRoot
foreach ($name in "control-plane", "tunnel", "web") {
  $pidFile = Join-Path $root ".data\$name.pid"
  if (Test-Path $pidFile) {
    $id = [int](Get-Content $pidFile)
    # /T also stops the node child process started through cmd.exe/npx.
    taskkill /PID $id /T /F 2>$null | Out-Null
    Remove-Item $pidFile
    Write-Output "stopped $name ($id)"
  }
}
# npx/tsx can leave the node process running when its cmd.exe parent is killed first. Stop any
# remaining BlockForge control-plane process (identified by its command line) still holding :8080.
$listener = Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
  if ($proc.CommandLine -like "*BlockForge*tsx*" -or $proc.CommandLine -like "*src/main.ts*") {
    taskkill /PID $proc.ProcessId /T /F 2>$null | Out-Null
    Write-Output "stopped orphaned control-plane process ($($proc.ProcessId))"
  }
}
