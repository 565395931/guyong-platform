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
$mysqlArchiveSha256 = '16854BA553167FAF52D7D216F4C7EDE695C3AE657F01F8E7A6FB7D26B878F3D2'
$redisArchiveSha256 = '3454E32D6907281D2C092ECCC2ED63089CC6DD59FCDA5A978995E666744360A5'

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
      ImageArchiveSha256 = $mysqlArchiveSha256
    }
    Cache = [pscustomobject]@{
      Host = '127.0.0.1'
      Startup = 'local-image-compose-if-needed'
      Image = $redisImage
      ImageArchive = $paths.RedisImageArchive
      ImageArchiveSha256 = $redisArchiveSha256
    }
    CoreLauncher = $paths.CoreLauncher
    DockerInstaller = $paths.DockerInstaller
    LocalPackageBuildOrder = @('commerce-protocol', 'commerce-projection-ledger', 'rag-server')
    FirstRunRequired = -not (Test-Path -LiteralPath $backendEnv)
    Services = @('mysql', 'redis', 'gateway-ws', 'gateway-health', 'backend', 'frontend')
  } | ConvertTo-Json -Depth 4
  return
}

function Install-NodeDependencies(
  [string]$Root,
  [string]$Name,
  [ValidateSet('npm', 'pnpm')] [string]$Manager,
  [switch]$Force
) {
  if (-not $Force -and (Test-Path -LiteralPath (Join-Path $Root 'node_modules'))) { return }

  $action = if ($Force) { 'Refreshing' } else { 'Installing' }
  Write-Host "[First run] $action $Name dependencies..." -ForegroundColor Cyan
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

function Test-NodePackageBuildRequired([string]$Root) {
  $artifact = Join-Path $Root 'dist\index.js'
  if (-not (Test-Path -LiteralPath $artifact)) { return $true }

  $inputs = @(
    (Join-Path $Root 'package.json'),
    (Join-Path $Root 'tsconfig.json')
  )
  $sourceRoot = Join-Path $Root 'src'
  if (Test-Path -LiteralPath $sourceRoot) {
    $inputs += Get-ChildItem -LiteralPath $sourceRoot -File -Recurse | Select-Object -ExpandProperty FullName
  }
  $artifactTime = (Get-Item -LiteralPath $artifact).LastWriteTimeUtc
  return $null -ne ($inputs | Where-Object { (Get-Item -LiteralPath $_).LastWriteTimeUtc -gt $artifactTime } | Select-Object -First 1)
}

function Build-LocalNodePackage(
  [string]$Root,
  [string]$Name,
  [switch]$ForceBuild,
  [switch]$ForceDependencies
) {
  $needsBuild = $ForceBuild -or (Test-NodePackageBuildRequired $Root)
  if (-not $needsBuild) { return }

  Install-NodeDependencies $Root $Name 'npm' -Force:$ForceDependencies
  Write-Host "[First run] Building local package $Name..." -ForegroundColor Cyan
  Push-Location $Root
  try {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw "$Name build failed." }
  } finally {
    Pop-Location
  }
  Assert-PlatformFile (Join-Path $Root 'dist\index.js') "$Name build artifact"
}

function Import-OfflineDockerImage([string]$Image, [string]$Archive, [string]$ExpectedSha256, [string]$Name) {
  if (Test-DockerImage $docker.Source $Image) { return }

  Assert-PlatformFile $Archive "$Name offline Docker image archive"
  Write-Host "Verifying the $Name offline image..." -ForegroundColor Cyan
  $actualSha256 = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash
  if ($actualSha256 -ne $ExpectedSha256) {
    throw "$Name offline image checksum mismatch. Download the file again: $Archive"
  }
  Write-Host "Loading $Name from the specified offline image..." -ForegroundColor Cyan
  & $docker.Source load --input $Archive
  if ($LASTEXITCODE -ne 0 -or -not (Test-DockerImage $docker.Source $Image)) {
    throw "$Name offline archive was found but did not provide Docker image '$Image': $Archive"
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

$protocolNeedsBuild = Test-NodePackageBuildRequired $paths.CommerceProtocolRoot
Build-LocalNodePackage $paths.CommerceProtocolRoot '@rag/commerce-protocol' -ForceBuild:$protocolNeedsBuild

$ledgerNeedsBuild = $protocolNeedsBuild -or (Test-NodePackageBuildRequired $paths.CommerceProjectionLedgerRoot)
$ledgerProtocolArtifact = Join-Path $paths.CommerceProjectionLedgerRoot 'node_modules\@rag\commerce-protocol\dist\index.js'
$refreshLedgerDependencies = $protocolNeedsBuild -or -not (Test-Path -LiteralPath $ledgerProtocolArtifact)
Build-LocalNodePackage $paths.CommerceProjectionLedgerRoot '@rag/commerce-projection-ledger' `
  -ForceBuild:$ledgerNeedsBuild `
  -ForceDependencies:$refreshLedgerDependencies

$installedProtocolArtifact = Join-Path $paths.BackendRoot 'node_modules\@rag\commerce-protocol\dist\index.js'
$installedLedgerArtifact = Join-Path $paths.BackendRoot 'node_modules\@rag\commerce-projection-ledger\dist\index.js'
$refreshBackendDependencies = $protocolNeedsBuild -or $ledgerNeedsBuild -or `
  -not (Test-Path -LiteralPath $installedProtocolArtifact) -or `
  -not (Test-Path -LiteralPath $installedLedgerArtifact)
Install-NodeDependencies $paths.BackendRoot 'backend' 'npm' -Force:$refreshBackendDependencies
Assert-PlatformFile $installedProtocolArtifact 'Installed commerce protocol package'
Assert-PlatformFile $installedLedgerArtifact 'Installed commerce projection ledger package'
Install-NodeDependencies $paths.FrontendRoot 'frontend' 'npm'
Install-NodeDependencies $paths.GatewayRoot 'gateway' 'pnpm'

$dbHost = Read-DotEnvValue $backendEnv 'DB_HOST'
$localDatabase = [string]::IsNullOrWhiteSpace($dbHost) -or $dbHost -in @('localhost', '127.0.0.1', '::1')

$startMySql = $localDatabase -and -not (Test-PlatformPort 3306)
$docker = Get-Command docker.exe -ErrorAction SilentlyContinue
if (-not $docker) {
  if (Test-Path -LiteralPath $paths.DockerInstaller) {
    throw "Docker Desktop is not installed. Run the installer first, then start Docker Desktop and retry: $($paths.DockerInstaller)"
  }
  throw "Docker Desktop is not installed. Download its installer and place it at: $($paths.DockerInstaller)"
}

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
  Import-OfflineDockerImage $mysqlImage $paths.MySqlImageArchive $mysqlArchiveSha256 'MySQL'

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
  Import-OfflineDockerImage $redisImage $paths.RedisImageArchive $redisArchiveSha256 'Redis'

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
