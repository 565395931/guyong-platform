[CmdletBinding()]
param(
  [string]$FrontendHost = '',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Platform.Common.ps1')

$paths = Get-PlatformPaths
$backendEnv = Join-Path $paths.BackendRoot '.env'
$mysqlCompose = Join-Path $paths.MySqlRoot 'docker-compose.yml'
$redisCompose = Join-Path $paths.RedisRoot 'docker-compose.yml'
$mysqlImage = 'mysql:8.0'
$redisImage = 'redis:7-alpine'

Assert-PlatformFile $paths.CoreLauncher 'Core platform launcher'
Assert-PlatformFile $mysqlCompose 'MySQL compose file'
Assert-PlatformFile $redisCompose 'Redis compose file'

$dbHost = if (Test-Path -LiteralPath $backendEnv) { Read-DotEnvValue $backendEnv 'DB_HOST' } else { $null }
$localDatabase = [string]::IsNullOrWhiteSpace($dbHost) -or $dbHost -in @('localhost', '127.0.0.1', '::1')

if ($DryRun) {
  [pscustomobject]@{
    ProjectRoot = $paths.ProjectRoot
    Database = [pscustomobject]@{
      Host = if ([string]::IsNullOrWhiteSpace($dbHost)) { '127.0.0.1' } else { $dbHost }
      Local = $localDatabase
      Startup = if ($localDatabase) { 'local-image-compose-if-needed' } else { 'external' }
      Image = $mysqlImage
      ImageArchive = $paths.MySqlImageArchive
    }
    Cache = [pscustomobject]@{
      Host = '127.0.0.1'
      Startup = 'local-image-compose-if-needed'
      Image = $redisImage
      ImageArchive = $paths.RedisImageArchive
    }
    CoreLauncher = $paths.CoreLauncher
    FirstRunRequired = -not (Test-Path -LiteralPath $backendEnv)
    Services = @('mysql', 'redis', 'gateway-ws', 'gateway-health', 'backend', 'frontend')
  } | ConvertTo-Json -Depth 4
  return
}

function Install-NodeDependencies([string]$Root, [string]$Name, [ValidateSet('npm', 'pnpm')] [string]$Manager) {
  if (Test-Path -LiteralPath (Join-Path $Root 'node_modules')) { return }

  Write-Host "[First run] Installing $Name dependencies..." -ForegroundColor Cyan
  Push-Location $Root
  try {
    if ($Manager -eq 'npm') {
      & npm.cmd ci
    } else {
      $pnpm = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
      $corepack = Get-Command corepack.cmd -ErrorAction SilentlyContinue
      if ($pnpm) {
        & $pnpm.Source install --frozen-lockfile
      } elseif ($corepack) {
        & $corepack.Source pnpm install --frozen-lockfile
      } else {
        Write-Host '[First run] pnpm/Corepack is unavailable; using npm without creating a lock file.' -ForegroundColor Yellow
        & npm.cmd install --no-package-lock
      }
    }
    if ($LASTEXITCODE -ne 0) { throw "$Name dependency installation failed." }
  } finally {
    Pop-Location
  }
}

function Import-Or-PullDockerImage([string]$Image, [string]$Archive, [string]$Name) {
  if (Test-DockerImage $docker.Source $Image) { return }

  if (Test-Path -LiteralPath $Archive) {
    Write-Host "Loading $Name from the local offline image..." -ForegroundColor Cyan
    & $docker.Source load --input $Archive
  } else {
    Write-Host "The offline $Name image is not in this Git clone. Downloading $Image..." -ForegroundColor Cyan
    & $docker.Source pull $Image
  }
  if ($LASTEXITCODE -ne 0 -or -not (Test-DockerImage $docker.Source $Image)) {
    throw "$Name Docker image '$Image' could not be prepared. Check the network or copy the offline image archive to $Archive"
  }
}

$createdBackendEnvironment = Initialize-BackendEnvironment $paths.BackendRoot
if ($createdBackendEnvironment) {
  Write-Host '[First run] Created a private backend .env with new machine-local secrets.' -ForegroundColor Green
}
$createdGatewayToken = Initialize-GatewayAuthToken $paths.GatewayRoot
if ($createdGatewayToken) {
  Write-Host '[First run] Created a private gateway authentication token.' -ForegroundColor Green
}

Install-NodeDependencies $paths.BackendRoot 'backend' 'npm'
Install-NodeDependencies $paths.FrontendRoot 'frontend' 'npm'
Install-NodeDependencies $paths.GatewayRoot 'gateway' 'pnpm'

$dbHost = Read-DotEnvValue $backendEnv 'DB_HOST'
$localDatabase = [string]::IsNullOrWhiteSpace($dbHost) -or $dbHost -in @('localhost', '127.0.0.1', '::1')

$startMySql = $localDatabase -and -not (Test-PlatformPort 3306)
$docker = Get-Command docker.exe -ErrorAction Stop

if (-not (Test-DockerEngine $docker.Source)) {
  $dockerDesktop = Resolve-DockerDesktopPath
  if ([string]::IsNullOrWhiteSpace($dockerDesktop)) {
    throw 'Docker Desktop is required to start local MySQL and Redis, but Docker Desktop.exe was not found.'
  }
  if (-not (Get-Process -Name 'Docker Desktop' -ErrorAction SilentlyContinue)) {
    Write-Host '[Docker] Docker engine is stopped. Starting Docker Desktop...' -ForegroundColor Cyan
    Start-Process -FilePath $dockerDesktop -WindowStyle Hidden | Out-Null
  } else {
    Write-Host '[Docker] Waiting for the Docker Desktop engine...' -ForegroundColor Cyan
  }
  Wait-DockerEngine $docker.Source 180
}

$redisContainerRunning = Test-DockerContainerRunning $docker.Source 'rag-redis'
if ((Test-PlatformPort 6379) -and -not $redisContainerRunning) {
  throw 'Port 6379 is occupied by a non-Docker Redis process. Stop the old Memurai/Redis process, then run start-all.bat again.'
}
$startRedis = -not $redisContainerRunning

if ($startMySql) {
  Import-Or-PullDockerImage $mysqlImage $paths.MySqlImageArchive 'MySQL'

  $dbPassword = Read-DotEnvValue $backendEnv 'DB_PASSWORD'
  if ([string]::IsNullOrWhiteSpace($dbPassword)) {
    throw 'DB_PASSWORD is missing in Rag\rag-server\.env; local MySQL cannot be initialized.'
  }

  Write-Host '[1/3] Starting local MySQL...' -ForegroundColor Cyan
  $previousPassword = $env:MYSQL_ROOT_PASSWORD
  try {
    $env:MYSQL_ROOT_PASSWORD = $dbPassword
    & $docker.Source compose --project-directory $paths.MySqlRoot -f $mysqlCompose up -d --pull never
    if ($LASTEXITCODE -ne 0) { throw 'MySQL Docker Compose startup failed.' }
  } finally {
    if ($null -eq $previousPassword) {
      Remove-Item Env:MYSQL_ROOT_PASSWORD -ErrorAction SilentlyContinue
    } else {
      $env:MYSQL_ROOT_PASSWORD = $previousPassword
    }
  }
  Wait-PlatformPort 'mysql' 3306 90
} elseif ($localDatabase) {
  Write-Host '[1/3] MySQL is already listening on port 3306.' -ForegroundColor DarkGray
} else {
  Write-Host "[1/3] Backend uses external MySQL host '$dbHost'; local MySQL startup skipped." -ForegroundColor DarkGray
}

if ($startRedis) {
  Import-Or-PullDockerImage $redisImage $paths.RedisImageArchive 'Redis'

  Write-Host '[2/3] Starting local Redis...' -ForegroundColor Cyan
  & $docker.Source compose --project-directory $paths.RedisRoot -f $redisCompose up -d --pull never
  if ($LASTEXITCODE -ne 0) { throw 'Redis Docker Compose startup failed.' }
  Wait-PlatformPort 'redis' 6379 60
} else {
  Wait-PlatformPort 'redis' 6379 60
  Write-Host '[2/3] Redis is already listening on port 6379.' -ForegroundColor DarkGray
}

Write-Host '[3/3] Starting gateway, backend and workbench...' -ForegroundColor Cyan
$launcherArguments = @()
if (-not [string]::IsNullOrWhiteSpace($FrontendHost)) {
  $launcherArguments += @('-FrontendHost', $FrontendHost)
}
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $paths.CoreLauncher @launcherArguments
if ($LASTEXITCODE -ne 0) { throw 'Core platform startup failed.' }

Write-Host ''
Write-Host 'Platform startup completed.' -ForegroundColor Green
Get-PlatformStatus | Format-Table Name, Running, Port, Pid, Url -AutoSize
Write-Host ''
Write-Host "Logs: $($paths.RagRoot)\logs" -ForegroundColor DarkGray
