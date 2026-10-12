# Stops the processes started by scripts/dev-up.ps1.
$root = Split-Path -Parent $PSScriptRoot
foreach ($name in "control-plane", "tunnel") {
  $pidFile = Join-Path $root ".data\$name.pid"
  if (Test-Path $pidFile) {
    $id = [int](Get-Content $pidFile)
    # /T also stops the node child process started through cmd.exe/npx.
    taskkill /PID $id /T /F 2>$null | Out-Null
    Remove-Item $pidFile
    Write-Output "stopped $name ($id)"
  }
}
