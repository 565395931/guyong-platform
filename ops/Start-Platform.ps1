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
Assert-PlatformFile $backendEnv 'Backend environment file'
Assert-PlatformFile $mysqlCompose 'MySQL compose file'
Assert-PlatformFile $redisCompose 'Redis compose file'
Assert-PlatformFile (Join-Path $paths.BackendRoot 'node_modules') 'Backend dependencies'
Assert-PlatformFile (Join-Path $paths.FrontendRoot 'node_modules') 'Frontend dependencies'
Assert-PlatformFile (Join-Path $paths.GatewayRoot 'node_modules') 'Gateway dependencies'

$dbHost = Read-DotEnvValue $backendEnv 'DB_HOST'
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
    Services = @('mysql', 'redis', 'gateway-ws', 'gateway-health', 'backend', 'frontend')
  } | ConvertTo-Json -Depth 4
  return
}

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
  if (-not (Test-DockerImage $docker.Source $mysqlImage)) {
    Assert-PlatformFile $paths.MySqlImageArchive 'Offline MySQL image archive'
    Write-Host '[1/3] Loading MySQL from the project offline image...' -ForegroundColor Cyan
    & $docker.Source load --input $paths.MySqlImageArchive
    if ($LASTEXITCODE -ne 0) { throw 'The offline MySQL image could not be loaded.' }
    if (-not (Test-DockerImage $docker.Source $mysqlImage)) {
      throw "The offline archive loaded, but Docker image '$mysqlImage' is still unavailable."
    }
  }

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
  if (-not (Test-DockerImage $docker.Source $redisImage)) {
    Assert-PlatformFile $paths.RedisImageArchive 'Offline Redis image archive'
    Write-Host '[2/3] Loading Redis from the project offline image...' -ForegroundColor Cyan
    & $docker.Source load --input $paths.RedisImageArchive
    if ($LASTEXITCODE -ne 0) { throw 'The offline Redis image could not be loaded.' }
    if (-not (Test-DockerImage $docker.Source $redisImage)) {
      throw "The offline archive loaded, but Docker image '$redisImage' is still unavailable."
    }
  }

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
