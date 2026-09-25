Set-StrictMode -Version Latest

$script:OpsRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$script:ProjectRoot = (Resolve-Path (Join-Path $script:OpsRoot '..')).Path

function Get-PlatformPaths {
  $ragRoot = Join-Path $script:ProjectRoot 'Rag'
  return [pscustomobject]@{
    ProjectRoot = $script:ProjectRoot
    RagRoot = $ragRoot
    BackendRoot = Join-Path $ragRoot 'rag-server'
    FrontendRoot = Join-Path $ragRoot 'platform-web'
    GatewayRoot = Join-Path $script:ProjectRoot 'wehook'
    MySqlRoot = Join-Path $ragRoot 'docker\mysql'
    MySqlImageArchive = Join-Path $ragRoot 'docker\mysql\images\mysql-8.0.46-amd64.tar'
    RedisRoot = Join-Path $ragRoot 'docker\redis'
    RedisImageArchive = Join-Path $ragRoot 'docker\redis\images\redis-7.4.11-alpine-amd64.tar'
    CoreLauncher = Join-Path $ragRoot 'tools\local-deploy\start-local-platform.ps1'
  }
}

function Test-DockerImage([string]$DockerPath, [string]$ImageName) {
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'SilentlyContinue'
    & $DockerPath image inspect $ImageName *> $null
    return $LASTEXITCODE -eq 0
  } catch {
    return $false
  } finally {
    $ErrorActionPreference = $previousPreference
  }
}

function Test-DockerContainerRunning([string]$DockerPath, [string]$ContainerName) {
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'SilentlyContinue'
    $state = & $DockerPath inspect --format '{{.State.Running}}' $ContainerName 2>$null
    return $LASTEXITCODE -eq 0 -and ($state | Out-String).Trim() -eq 'true'
  } catch {
    return $false
  } finally {
    $ErrorActionPreference = $previousPreference
  }
}

function Test-PlatformPort([int]$Port) {
  return $null -ne (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
    Select-Object -First 1)
}

function Wait-PlatformPort([string]$Name, [int]$Port, [int]$TimeoutSeconds = 60) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    if (Test-PlatformPort $Port) { return }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  throw "$Name did not listen on port $Port within $TimeoutSeconds seconds."
}

function Read-DotEnvValue([string]$Path, [string]$Name) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  $pattern = '^\s*' + [regex]::Escape($Name) + '\s*=\s*(.*)\s*$'
  foreach ($line in Get-Content -LiteralPath $Path) {
    if ($line -match $pattern) {
      $value = $matches[1].Trim()
      if (($value.StartsWith('"') -and $value.EndsWith('"')) -or
          ($value.StartsWith("'") -and $value.EndsWith("'"))) {
        return $value.Substring(1, $value.Length - 2)
      }
      return $value
    }
  }
  return $null
}

function New-PlatformSecret([int]$ByteCount = 32, [switch]$Base64) {
  $bytes = New-Object byte[] $ByteCount
  $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $generator.GetBytes($bytes)
  } finally {
    $generator.Dispose()
  }

  $value = [Convert]::ToBase64String($bytes)
  if ($Base64) { return $value }
  return $value.TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Set-DotEnvValue([string]$Path, [string]$Name, [string]$Value) {
  $content = [System.IO.File]::ReadAllText($Path)
  $line = "$Name=$Value"
  $pattern = '(?m)^' + [regex]::Escape($Name) + '=.*$'
  if ([regex]::IsMatch($content, $pattern)) {
    $content = [regex]::Replace($content, $pattern, [System.Text.RegularExpressions.MatchEvaluator]{ param($match) $line })
  } else {
    $content = $content.TrimEnd() + [Environment]::NewLine + $line + [Environment]::NewLine
  }
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $content, $encoding)
}

function Initialize-BackendEnvironment([string]$BackendRoot) {
  $target = Join-Path $BackendRoot '.env'
  if (Test-Path -LiteralPath $target) { return $false }

  $template = Join-Path $BackendRoot '.env.example'
  Assert-PlatformFile $template 'Backend environment template'
  Copy-Item -LiteralPath $template -Destination $target

  Set-DotEnvValue $target 'DB_PASSWORD' (New-PlatformSecret 24)
  Set-DotEnvValue $target 'JWT_SECRET' (New-PlatformSecret 48)
  Set-DotEnvValue $target 'PLATFORM_CREDENTIAL_KEY' (New-PlatformSecret 32 -Base64)
  Set-DotEnvValue $target 'ENCRYPTION_KEY' (New-PlatformSecret 24)
  return $true
}

function Initialize-GatewayAuthToken([string]$GatewayRoot) {
  $dataRoot = Join-Path $GatewayRoot 'data'
  $target = Join-Path $dataRoot 'gateway-auth-token.txt'
  if (Test-Path -LiteralPath $target) { return $false }

  New-Item -ItemType Directory -Force -Path $dataRoot | Out-Null
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($target, (New-PlatformSecret 32), $encoding)
  return $true
}

function Assert-PlatformFile([string]$Path, [string]$Description) {
  if (-not (Test-Path -LiteralPath $Path)) {
    throw "$Description is missing: $Path"
  }
}

function Test-DockerEngine([string]$DockerPath) {
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'SilentlyContinue'
    $version = & $DockerPath info --format '{{.ServerVersion}}' 2>$null
    return $LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace(($version | Out-String))
  } catch {
    return $false
  } finally {
    $ErrorActionPreference = $previousPreference
  }
}

function Resolve-DockerDesktopPath {
  $candidates = @(
    (Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'),
    (Join-Path $env:LOCALAPPDATA 'Docker\Docker Desktop.exe')
  )
  return $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}

function Wait-DockerEngine([string]$DockerPath, [int]$TimeoutSeconds = 180) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    if (Test-DockerEngine $DockerPath) { return }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)
  throw "Docker Desktop did not become ready within $TimeoutSeconds seconds. Open Docker Desktop and review its status."
}

function Get-PlatformStatus {
  $definitions = @(
    [pscustomobject]@{ Name = 'mysql'; Port = 3306; Url = '127.0.0.1:3306' },
    [pscustomobject]@{ Name = 'redis'; Port = 6379; Url = '127.0.0.1:6379' },
    [pscustomobject]@{ Name = 'gateway-ws'; Port = 8787; Url = 'ws://127.0.0.1:8787' },
    [pscustomobject]@{ Name = 'gateway-health'; Port = 8788; Url = 'http://127.0.0.1:8788/healthz' },
    [pscustomobject]@{ Name = 'backend'; Port = 3001; Url = 'http://127.0.0.1:3001' },
    [pscustomobject]@{ Name = 'frontend'; Port = 3003; Url = 'http://127.0.0.1:3003' }
  )

  foreach ($definition in $definitions) {
    $connection = Get-NetTCPConnection -State Listen -LocalPort $definition.Port -ErrorAction SilentlyContinue |
      Select-Object -First 1
    [pscustomobject]@{
      Name = $definition.Name
      Port = $definition.Port
      Running = $null -ne $connection
      Pid = if ($connection) { $connection.OwningProcess } else { $null }
      Url = $definition.Url
    }
  }
}
