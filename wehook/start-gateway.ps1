param(
  [switch]$Check
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $root

function Find-NodeExecutable {
  $candidates = @(
    $env:GATEWAY_NODE_EXE,
    $(try { (Get-Command node.exe -ErrorAction SilentlyContinue).Source } catch { $null }),
    $(if ($env:NVM_SYMLINK) { Join-Path $env:NVM_SYMLINK 'node.exe' }),
    $(if ($env:ProgramFiles) { Join-Path $env:ProgramFiles 'nodejs\node.exe' }),
    $(if ($env:USERPROFILE) { Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' })
  ) | Where-Object { $_ } | Select-Object -Unique

  foreach ($candidate in $candidates) {
    try {
      if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
      $resolved = (Resolve-Path -LiteralPath $candidate).Path
      & $resolved --version *> $null
      if ($LASTEXITCODE -eq 0) { return $resolved }
    } catch {
      continue
    }
  }
  return $null
}

function Get-Port([string]$Name, [int]$Default) {
  $raw = [Environment]::GetEnvironmentVariable($Name)
  if (-not $raw) { return $Default }
  $value = 0
  if (-not [int]::TryParse($raw, [ref]$value) -or $value -lt 1 -or $value -gt 65535) {
    throw "$Name must be an integer between 1 and 65535."
  }
  return $value
}

function Test-PortInUse([int]$Port) {
  $listeners = [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
  return [bool]($listeners | Where-Object Port -eq $Port | Select-Object -First 1)
}

try {
  $node = Find-NodeExecutable
  if (-not $node) {
    throw 'Node.js was not found. Install Node.js or set GATEWAY_NODE_EXE in gateway.local.cmd.'
  }

  & $node -e "require.resolve('ws')" *> $null
  if ($LASTEXITCODE -ne 0) {
    throw "The ws dependency is missing. Run pnpm install or npm install in $root first."
  }
  if ($env:GATEWAY_STORE_DRIVER -eq 'mysql') {
    & $node -e "require.resolve('mysql2/promise')" *> $null
    if ($LASTEXITCODE -ne 0) {
      throw "The mysql2 dependency is missing. Run pnpm install in $root first."
    }
  }

  $gatewayPort = Get-Port 'GATEWAY_PORT' 8787
  $healthPort = Get-Port 'HEALTH_PORT' 8788
  if (Test-PortInUse $gatewayPort) {
    throw "WebSocket port $gatewayPort is already in use. The gateway may already be running."
  }
  if (Test-PortInUse $healthPort) {
    throw "Health port $healthPort is already in use. Change HEALTH_PORT in gateway.local.cmd."
  }

  if (-not $env:NODE_ENV) { $env:NODE_ENV = 'development' }
  if (-not $env:GATEWAY_HOST) { $env:GATEWAY_HOST = '127.0.0.1' }
  $env:GATEWAY_PORT = [string]$gatewayPort
  $env:HEALTH_PORT = [string]$healthPort
  if (-not $env:GATEWAY_STORE_PATH) {
    $env:GATEWAY_STORE_PATH = Join-Path $root 'data\gateway-store.json'
  }

  $tokenDirectory = Join-Path $root 'data'
  $tokenFile = Join-Path $tokenDirectory 'gateway-auth-token.txt'
  if (-not $env:GATEWAY_AUTH_TOKEN -and (Test-Path -LiteralPath $tokenFile -PathType Leaf)) {
    $env:GATEWAY_AUTH_TOKEN = (Get-Content -Raw -LiteralPath $tokenFile).Trim()
  }

  if ($Check) {
    Write-Host '[OK] Gateway launcher check passed.' -ForegroundColor Green
    Write-Host "     Node: $node"
    Write-Host "     WebSocket port: $gatewayPort (available)"
    Write-Host "     Health port: $healthPort (available)"
    if ($env:GATEWAY_AUTH_TOKEN) {
      Write-Host '     Local service token: configured'
    } else {
      Write-Host '     Local service token: will be generated on first start'
    }
    exit 0
  }

  if (-not $env:GATEWAY_AUTH_TOKEN) {
    New-Item -ItemType Directory -Path $tokenDirectory -Force | Out-Null
    $env:GATEWAY_AUTH_TOKEN = [guid]::NewGuid().ToString('N')
    [IO.File]::WriteAllText($tokenFile, $env:GATEWAY_AUTH_TOKEN, [Text.UTF8Encoding]::new($false))
  }

  Write-Host ''
  Write-Host '============================================================'
  Write-Host '  Cloud Channel Gateway'
  Write-Host '============================================================'
  Write-Host "  WebSocket : ws://$($env:GATEWAY_HOST):$gatewayPort"
  Write-Host "  Health   : http://$($env:GATEWAY_HOST):$healthPort/healthz"
  Write-Host "  Metrics  : http://$($env:GATEWAY_HOST):$healthPort/metrics"
  Write-Host "  Store    : $($env:GATEWAY_STORE_PATH)"
  Write-Host "  Token    : $tokenFile"
  Write-Host '============================================================'
  Write-Host ''
  Write-Host 'Keep this window open. Press Ctrl+C to stop the gateway.'
  Write-Host 'This starts only the gateway, not Rag port 3001 or any real platform.'
  Write-Host ''

  & $node (Join-Path $root 'src\index.js')
  exit $LASTEXITCODE
} catch {
  Write-Host ''
  Write-Host "[ERROR] $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
