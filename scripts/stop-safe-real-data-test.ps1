$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$runDir = Join-Path $repoRoot ".temp\safe-real-data-test"
$pidFiles = @(
  (Join-Path $runDir "backend.pid"),
  (Join-Path $runDir "frontend.pid")
)

foreach ($pidFile in $pidFiles) {
  if (-not (Test-Path $pidFile)) {
    continue
  }

  $pidValue = Get-Content $pidFile | Select-Object -First 1
  $parsedPid = 0
  if ([int]::TryParse($pidValue, [ref]$parsedPid)) {
    $process = Get-Process -Id $parsedPid -ErrorAction SilentlyContinue
    if ($process) {
      Stop-Process -Id $process.Id -Force
      Write-Host "Stopped process $($process.Id) from $(Split-Path -Leaf $pidFile)."
    }
  }

  Remove-Item $pidFile -Force
}
