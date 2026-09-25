$ErrorActionPreference = 'Stop'

$scriptPath = Join-Path $PSScriptRoot 'Start-Platform.ps1'
$commonPath = Join-Path $PSScriptRoot 'Platform.Common.ps1'
. $commonPath
$scriptSource = Get-Content -Raw -LiteralPath $scriptPath
if ($scriptSource -match '(?i)docker\.Source\s+pull|docker\s+pull') {
  throw 'Start-Platform must not download Docker images from the network.'
}
if ($scriptSource -notmatch 'Import-OfflineDockerImage') {
  throw 'Start-Platform no longer enforces the offline image import path.'
}
$raw = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scriptPath -DryRun
if ($LASTEXITCODE -ne 0) { throw 'Start-Platform dry run failed.' }

$plan = $raw | ConvertFrom-Json
$expectedRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if ($plan.ProjectRoot -ne $expectedRoot) {
  throw 'Start-Platform resolved the wrong project root.'
}
if (($plan.Services -join ',') -ne 'mysql,redis,gateway-ws,gateway-health,backend,frontend') {
  throw 'Start-Platform service order changed unexpectedly.'
}
if (-not (Test-Path -LiteralPath $plan.CoreLauncher)) {
  throw 'Start-Platform points to a missing core launcher.'
}
if ($plan.Database.Local -and $plan.Database.Startup -ne 'local-image-compose-if-needed') {
  throw 'Local database startup policy is invalid.'
}
if ($plan.Cache.Startup -ne 'local-image-compose-if-needed') {
  throw 'Local cache startup policy is invalid.'
}
if (-not $plan.Database.ImageArchive.EndsWith('mysql-8.0.46-amd64.tar')) { throw 'The MySQL image archive path is invalid.' }
if (-not $plan.Cache.ImageArchive.EndsWith('redis-7.4.11-alpine-amd64.tar')) { throw 'The Redis image archive path is invalid.' }
if ($plan.Database.ImageArchiveSha256 -ne '16854BA553167FAF52D7D216F4C7EDE695C3AE657F01F8E7A6FB7D26B878F3D2') { throw 'The MySQL image checksum changed unexpectedly.' }
if ($plan.Cache.ImageArchiveSha256 -ne '3454E32D6907281D2C092ECCC2ED63089CC6DD59FCDA5A978995E666744360A5') { throw 'The Redis image checksum changed unexpectedly.' }
if (-not $plan.DockerInstaller.EndsWith('offline\docker\Docker Desktop Installer.exe')) { throw 'The Docker installer path is invalid.' }
if (($plan.LocalPackageBuildOrder -join ',') -ne 'commerce-protocol,commerce-projection-ledger,rag-server') {
  throw 'The local package build order changed unexpectedly.'
}

$statusRows = @(Get-PlatformStatus)
$frontendStatus = $statusRows | Where-Object Name -eq 'frontend'
if ($frontendStatus.LocalUrl -ne 'http://127.0.0.1:3003') {
  throw 'Frontend status does not expose the localhost workbench URL.'
}
if (-not $frontendStatus.PSObject.Properties['LanUrl']) {
  throw 'Frontend status does not expose a LAN URL field.'
}

$startupSource = Get-Content -Raw -LiteralPath $scriptPath
foreach ($requiredBuildStep in @('Build-LocalNodePackage $paths.CommerceProtocolRoot', 'Build-LocalNodePackage $paths.CommerceProjectionLedgerRoot')) {
  if (-not $startupSource.Contains($requiredBuildStep)) { throw "Missing local package build step: $requiredBuildStep" }
}
if (-not $startupSource.Contains("Assert-PlatformFile `$installedLedgerArtifact")) {
  throw 'Startup does not verify the installed projection ledger artifact.'
}

$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('guyong-startup-test-' + [guid]::NewGuid().ToString('N'))
try {
  $temporaryBackend = Join-Path $temporaryRoot 'rag-server'
  $temporaryGateway = Join-Path $temporaryRoot 'wehook'
  New-Item -ItemType Directory -Force -Path $temporaryBackend, $temporaryGateway | Out-Null
  Copy-Item -LiteralPath (Join-Path $expectedRoot 'Rag\rag-server\.env.example') -Destination (Join-Path $temporaryBackend '.env.example')

  if (-not (Initialize-BackendEnvironment $temporaryBackend)) { throw 'First-run backend environment was not created.' }
  if (Initialize-BackendEnvironment $temporaryBackend) { throw 'Existing backend environment was overwritten.' }
  $generatedEnvironment = Join-Path $temporaryBackend '.env'
  if ((Read-DotEnvValue $generatedEnvironment 'DB_PASSWORD').Length -lt 16) { throw 'Generated database password is too short.' }
  if ((Read-DotEnvValue $generatedEnvironment 'JWT_SECRET').Length -lt 32) { throw 'Generated JWT secret is too short.' }
  $platformKey = [Convert]::FromBase64String((Read-DotEnvValue $generatedEnvironment 'PLATFORM_CREDENTIAL_KEY'))
  if ($platformKey.Length -ne 32) { throw 'Generated platform credential key has the wrong size.' }
  if ((Read-DotEnvValue $generatedEnvironment 'ENCRYPTION_KEY').Length -ne 32) { throw 'Generated encryption key has the wrong size.' }

  if (-not (Initialize-GatewayAuthToken $temporaryGateway)) { throw 'First-run gateway token was not created.' }
  if (Initialize-GatewayAuthToken $temporaryGateway) { throw 'Existing gateway token was overwritten.' }
} finally {
  if (Test-Path -LiteralPath $temporaryRoot) { Remove-Item -LiteralPath $temporaryRoot -Recurse -Force }
}

$dockerCommand = Get-Command docker.exe -ErrorAction SilentlyContinue
if ($dockerCommand) {
  $engineState = Test-DockerEngine $dockerCommand.Source
  if ($engineState -isnot [bool]) { throw 'Docker engine readiness check did not return a boolean.' }
  if ($engineState) {
    $imageState = Test-DockerImage $dockerCommand.Source $plan.Database.Image
    if ($imageState -isnot [bool]) { throw 'Docker image readiness check did not return a boolean.' }
    $redisImageState = Test-DockerImage $dockerCommand.Source $plan.Cache.Image
    if ($redisImageState -isnot [bool]) { throw 'Redis image readiness check did not return a boolean.' }
    $redisContainerState = Test-DockerContainerRunning $dockerCommand.Source 'rag-redis'
    if ($redisContainerState -isnot [bool]) { throw 'Redis container readiness check did not return a boolean.' }
  }
}
$dockerDesktop = Resolve-DockerDesktopPath
if ($dockerCommand -and [string]::IsNullOrWhiteSpace($dockerDesktop)) {
  throw 'Docker CLI is installed but Docker Desktop could not be located.'
}

$batchPath = Join-Path $expectedRoot 'start-all.bat'
if (-not (Test-Path -LiteralPath $batchPath)) { throw 'The one-click BAT launcher is missing.' }
Push-Location $expectedRoot
try {
  & cmd.exe /d /c 'call start-all.bat --dry-run' | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw 'The one-click CMD launcher could not execute its dry run.'
  }
} finally {
  Pop-Location
}

Write-Output 'platform startup dry-run contract passed'
