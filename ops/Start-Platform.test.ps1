$ErrorActionPreference = 'Stop'

$scriptPath = Join-Path $PSScriptRoot 'Start-Platform.ps1'
$commonPath = Join-Path $PSScriptRoot 'Platform.Common.ps1'
. $commonPath
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
if ($plan.Database.Local -and -not (Test-Path -LiteralPath $plan.Database.ImageArchive)) {
  throw 'The offline MySQL image archive is missing.'
}
if ($plan.Cache.Startup -ne 'local-image-compose-if-needed') {
  throw 'Local cache startup policy is invalid.'
}
if (-not (Test-Path -LiteralPath $plan.Cache.ImageArchive)) {
  throw 'The offline Redis image archive is missing.'
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
