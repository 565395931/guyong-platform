[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$Status,
  [string]$FrontendHost = ''
)

$ErrorActionPreference = 'Stop'

function Quote-Argument([string]$Value) {
  if ($Value -match '[\s"]') {
    return '"' + ($Value -replace '"', '\"') + '"'
  }
  return $Value
}

function Resolve-FrontendHost {
  $address = Get-NetIPConfiguration -ErrorAction SilentlyContinue |
    Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } |
    ForEach-Object { $_.IPv4Address.IPAddress } |
    Where-Object { $_ -and $_ -notlike '127.*' -and $_ -notlike '169.254.*' } |
    Select-Object -First 1

  if (-not $address) {
    throw 'No active LAN IPv4 address was found. Pass -FrontendHost explicitly.'
  }
  return $address
}

function Test-ListeningPort([int]$Port) {
  return $null -ne (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
    Select-Object -First 1)
}

function Wait-ListeningPort([string]$Name, [int]$Port, [int]$TimeoutSeconds = 30) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    if (Test-ListeningPort $Port) {
      return
    }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)

  throw "$Name did not listen on port $Port within $TimeoutSeconds seconds."
}

function Test-FrontendBuildRequired([string]$Root) {
  $artifact = Join-Path $Root 'dist\index.html'
  if (-not (Test-Path -LiteralPath $artifact)) { return $true }

  $inputs = @(
    (Join-Path $Root 'package.json'),
    (Join-Path $Root 'package-lock.json'),
    (Join-Path $Root 'vite.config.js')
  ) | Where-Object { Test-Path -LiteralPath $_ }
  $sourceRoot = Join-Path $Root 'src'
  if (Test-Path -LiteralPath $sourceRoot) {
    $inputs += Get-ChildItem -LiteralPath $sourceRoot -Recurse -File | Select-Object -ExpandProperty FullName
  }

  $artifactTime = (Get-Item -LiteralPath $artifact).LastWriteTimeUtc
  return $null -ne ($inputs | Where-Object {
    (Get-Item -LiteralPath $_).LastWriteTimeUtc -gt $artifactTime
  } | Select-Object -First 1)
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = (Resolve-Path (Join-Path $scriptDir '..\..')).Path
$gatewayRoot = (Resolve-Path (Join-Path $projectRoot '..\wehook')).Path
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source

if (-not $FrontendHost) {
  $FrontendHost = Resolve-FrontendHost
}

$logDir = Join-Path $projectRoot 'logs'
$backendRoot = Join-Path $projectRoot 'rag-server'
$frontendRoot = Join-Path $projectRoot 'platform-web'

$services = @(
  [pscustomobject]@{
    name = 'gateway'
    host = '127.0.0.1'
    advertisedHost = '127.0.0.1'
    localUrl = 'ws://127.0.0.1:8787'
    lanUrl = ''
    port = 8787
    program = $nodePath
    arguments = @((Quote-Argument (Join-Path $gatewayRoot 'src\index.js')))
    workingDirectory = $gatewayRoot
  },
  [pscustomobject]@{
    name = 'backend'
    host = '0.0.0.0'
    advertisedHost = $FrontendHost
    localUrl = 'http://127.0.0.1:3001'
    lanUrl = "http://${FrontendHost}:3001"
    port = 3001
    program = $nodePath
    arguments = @((Quote-Argument (Join-Path $backendRoot 'src\app.js')))
    workingDirectory = $backendRoot
  },
  [pscustomobject]@{
    name = 'frontend'
    host = '0.0.0.0'
    advertisedHost = $FrontendHost
    localUrl = 'http://127.0.0.1:3003'
    lanUrl = "http://${FrontendHost}:3003"
    port = 3003
    program = $nodePath
    arguments = @(
      (Quote-Argument (Join-Path $frontendRoot 'node_modules\vite\bin\vite.js')),
      'preview', '--host', '0.0.0.0', '--port', '3003', '--strictPort'
    )
    workingDirectory = $frontendRoot
  }
)

if ($DryRun) {
  [pscustomobject]@{
    projectRoot = $projectRoot
    services = $services
  } | ConvertTo-Json -Depth 6
  exit 0
}

if ($Status) {
  $services | ForEach-Object {
    [pscustomobject]@{
      name = $_.name
      host = $_.host
      advertisedHost = $_.advertisedHost
      port = $_.port
      running = Test-ListeningPort $_.port
    }
  } | ConvertTo-Json -Depth 3
  exit 0
}

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$requiredFiles = @(
  (Join-Path $backendRoot 'src\app.js'),
  (Join-Path $gatewayRoot 'src\index.js'),
  (Join-Path $frontendRoot 'node_modules\vite\bin\vite.js')
)
foreach ($requiredFile in $requiredFiles) {
  if (-not (Test-Path -LiteralPath $requiredFile)) {
    throw "Required deployment file is missing: $requiredFile"
  }
}

if (Test-FrontendBuildRequired $frontendRoot) {
  Write-Host 'Frontend source changed; rebuilding the workbench...' -ForegroundColor Cyan
  Push-Location $frontendRoot
  try {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) {
      throw 'Frontend production build failed.'
    }
  } finally {
    Pop-Location
  }
}

$started = @()
foreach ($service in $services) {
  if (Test-ListeningPort $service.port) {
    $started += [pscustomobject]@{
      name = $service.name
      status = 'already-running'
      host = $service.host
      localUrl = $service.localUrl
      lanUrl = $service.lanUrl
      port = $service.port
      pid = (Get-NetTCPConnection -State Listen -LocalPort $service.port |
        Select-Object -First 1 -ExpandProperty OwningProcess)
    }
    continue
  }

  $previousGatewayHost = $env:GATEWAY_HOST
  $previousGatewayToken = $env:GATEWAY_AUTH_TOKEN
  if ($service.name -eq 'gateway') {
    $tokenPath = Join-Path $gatewayRoot 'data\gateway-auth-token.txt'
    if (-not (Test-Path -LiteralPath $tokenPath)) {
      throw "Gateway authentication token file is missing: $tokenPath"
    }
    $env:GATEWAY_HOST = '127.0.0.1'
    $env:GATEWAY_AUTH_TOKEN = (Get-Content -Raw -LiteralPath $tokenPath).Trim()
  }

  try {
    $process = Start-Process `
      -FilePath $service.program `
      -ArgumentList $service.arguments `
      -WorkingDirectory $service.workingDirectory `
      -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $logDir ($service.name + '.out.log')) `
      -RedirectStandardError (Join-Path $logDir ($service.name + '.err.log')) `
      -PassThru
  } finally {
    if ($service.name -eq 'gateway') {
      $env:GATEWAY_HOST = $previousGatewayHost
      $env:GATEWAY_AUTH_TOKEN = $previousGatewayToken
    }
  }

  Wait-ListeningPort $service.name $service.port
  $started += [pscustomobject]@{
    name = $service.name
    status = 'started'
    host = $service.host
    localUrl = $service.localUrl
    lanUrl = $service.lanUrl
    port = $service.port
    pid = $process.Id
  }
}

$started | ConvertTo-Json -Depth 3
