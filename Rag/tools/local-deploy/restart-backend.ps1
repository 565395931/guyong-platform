[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateRange(1, 2147483647)]
  [int]$CurrentPid,
  [ValidateRange(1, 65535)]
  [int]$Port = 3001,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function Quote-Argument([string]$Value) {
  if ($Value -match '[\s"]') {
    return '"' + ($Value -replace '"', '\"') + '"'
  }
  return $Value
}

function Test-ListeningPort([int]$Port) {
  return $null -ne (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
    Select-Object -First 1)
}

function Wait-PortState([int]$Port, [bool]$Listening, [int]$TimeoutSeconds) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    if ((Test-ListeningPort $Port) -eq $Listening) { return }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  throw "Port $Port did not reach listening=$Listening within $TimeoutSeconds seconds."
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ragRoot = (Resolve-Path (Join-Path $scriptDir '..\..')).Path
$backendRoot = (Resolve-Path (Join-Path $ragRoot 'rag-server')).Path
$entryPath = Join-Path $backendRoot 'src\app.js'
$logDir = Join-Path $ragRoot 'logs'
$restartLog = Join-Path $logDir 'backend.restart.log'
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source

if (-not (Test-Path -LiteralPath $entryPath)) {
  throw "Backend entry file is missing: $entryPath"
}

if ($DryRun) {
  [pscustomobject]@{
    currentPid = $CurrentPid
    backendRoot = $backendRoot
    entryPath = $entryPath
    nodePath = $nodePath
    port = $Port
  } | ConvertTo-Json -Depth 3
  exit 0
}

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

try {
  Add-Content -LiteralPath $restartLog -Value "[$(Get-Date -Format o)] Restart requested for PID $CurrentPid."
  try {
    Wait-Process -Id $CurrentPid -Timeout 20 -ErrorAction Stop
  } catch [Microsoft.PowerShell.Commands.ProcessCommandException] {
    # The old process may already be gone by the time this helper starts.
  }
  Wait-PortState -Port $Port -Listening $false -TimeoutSeconds 20

  $process = Start-Process `
    -FilePath $nodePath `
    -ArgumentList @((Quote-Argument $entryPath)) `
    -WorkingDirectory $backendRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logDir 'backend.out.log') `
    -RedirectStandardError (Join-Path $logDir 'backend.err.log') `
    -PassThru

  Wait-PortState -Port $Port -Listening $true -TimeoutSeconds 90
  Add-Content -LiteralPath $restartLog -Value "[$(Get-Date -Format o)] Backend started as PID $($process.Id)."
} catch {
  Add-Content -LiteralPath $restartLog -Value "[$(Get-Date -Format o)] Restart failed: $($_.Exception.Message)"
  throw
}
