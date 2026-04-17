param(
  [string]$OrgId = "",
  [int]$BackendPort = 3000,
  [int]$FrontendPort = 5173
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$backendDir = Join-Path $repoRoot "backend"
$frontendDir = Join-Path $repoRoot "frontend"
$runDir = Join-Path $repoRoot ".temp\safe-real-data-test"
$backendLog = Join-Path $runDir "backend.log"
$backendErrLog = Join-Path $runDir "backend.err.log"
$frontendLog = Join-Path $runDir "frontend.log"
$frontendErrLog = Join-Path $runDir "frontend.err.log"
$backendPidPath = Join-Path $runDir "backend.pid"
$frontendPidPath = Join-Path $runDir "frontend.pid"
$metadataPath = Join-Path $runDir "metadata.json"

if ([string]::IsNullOrWhiteSpace($OrgId)) {
  throw "OrgId is required. Pass -OrgId <uuid>."
}

New-Item -ItemType Directory -Force -Path $runDir | Out-Null

$portsToCheck = @($BackendPort, $FrontendPort)
foreach ($port in $portsToCheck) {
  $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  if ($listener) {
    throw "Port $port is already in use. Stop the existing process or choose a different port."
  }
}

$backendCommand = @'
$env:DEFAULT_ORG_ID = '__ORG_ID__'
$env:PORT = '__BACKEND_PORT__'
Set-Location '__BACKEND_DIR__'
npm.cmd run start
'@
$backendCommand = $backendCommand.
  Replace('__ORG_ID__', $OrgId).
  Replace('__BACKEND_PORT__', [string]$BackendPort).
  Replace('__BACKEND_DIR__', $backendDir)

$frontendCommand = @'
$env:VITE_API_BASE_URL = '/api'
$env:VITE_PROXY_TARGET = 'http://127.0.0.1:__BACKEND_PORT__'
Set-Location '__FRONTEND_DIR__'
npm.cmd run dev -- --host 127.0.0.1 --port __FRONTEND_PORT__
'@
$frontendCommand = $frontendCommand.
  Replace('__BACKEND_PORT__', [string]$BackendPort).
  Replace('__FRONTEND_DIR__', $frontendDir).
  Replace('__FRONTEND_PORT__', [string]$FrontendPort)

$backendProcess = Start-Process powershell `
  -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $backendCommand) `
  -RedirectStandardOutput $backendLog `
  -RedirectStandardError $backendErrLog `
  -PassThru

$frontendProcess = Start-Process powershell `
  -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $frontendCommand) `
  -RedirectStandardOutput $frontendLog `
  -RedirectStandardError $frontendErrLog `
  -PassThru

Set-Content -Path $backendPidPath -Value $backendProcess.Id
Set-Content -Path $frontendPidPath -Value $frontendProcess.Id

$metadata = [ordered]@{
  orgId = $OrgId
  backendPort = $BackendPort
  frontendPort = $FrontendPort
  backendUrl = "http://127.0.0.1:$BackendPort"
  frontendUrl = "http://127.0.0.1:$FrontendPort"
  startedAt = (Get-Date).ToString("o")
  backendLog = $backendLog
  backendErrorLog = $backendErrLog
  frontendLog = $frontendLog
  frontendErrorLog = $frontendErrLog
}
$metadata | ConvertTo-Json | Set-Content -Path $metadataPath

Write-Host "Started safe real-data test environment."
Write-Host "Backend:  http://127.0.0.1:$BackendPort"
Write-Host "Frontend: http://127.0.0.1:$FrontendPort"
Write-Host "Org:      $OrgId"
Write-Host "Logs:     $runDir"
