$ErrorActionPreference = 'Stop'

$scriptPath = Join-Path $PSScriptRoot 'start-local-platform.ps1'
if (-not (Test-Path -LiteralPath $scriptPath)) {
  throw "Deployment script is missing: $scriptPath"
}

$raw = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scriptPath `
  -DryRun `
  -FrontendHost '192.168.1.25'
$plan = $raw | ConvertFrom-Json

if ($plan.projectRoot -ne (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path) {
  throw 'Dry-run plan did not resolve the Rag project root relative to the script.'
}

$services = @($plan.services)
if (($services.name -join ',') -ne 'redis,gateway,backend,frontend') {
  throw 'Services are not declared in the required startup order.'
}

$redis = $services | Where-Object name -eq 'redis'
if ($redis.host -ne '127.0.0.1' -or $redis.port -ne 6379) {
  throw 'Redis must only listen on 127.0.0.1:6379.'
}
if (($redis.arguments -join ' ') -notmatch '--appendonly yes') {
  throw 'Redis persistence must be enabled.'
}

$gateway = $services | Where-Object name -eq 'gateway'
if ($gateway.host -ne '127.0.0.1' -or $gateway.port -ne 8787) {
  throw 'Gateway WebSocket must remain local-only.'
}

$frontend = $services | Where-Object name -eq 'frontend'
if ($frontend.host -ne '192.168.1.25' -or $frontend.port -ne 3003) {
  throw 'Frontend must bind to the selected LAN address on port 3003.'
}

$allPaths = @($services.program) + @($services.workingDirectory)
if (($allPaths -join "`n") -match '^[A-Z]:\\project' -and $plan.projectRoot -notmatch '^[A-Z]:\\project') {
  throw 'Deployment plan contains an unrelated hard-coded project root.'
}

Write-Output 'local deployment dry-run contract passed'
