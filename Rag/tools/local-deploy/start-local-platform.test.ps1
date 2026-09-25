$ErrorActionPreference = 'Stop'

$scriptPath = Join-Path $PSScriptRoot 'start-local-platform.ps1'
if (-not (Test-Path -LiteralPath $scriptPath)) {
  throw "Deployment script is missing: $scriptPath"
}

$scriptSource = Get-Content -Raw -LiteralPath $scriptPath
if ($scriptSource -notmatch 'function Test-FrontendBuildRequired') {
  throw 'Deployment script must detect stale frontend build output after a source update.'
}
if ($scriptSource -notmatch 'LastWriteTimeUtc') {
  throw 'Frontend freshness detection must compare source and artifact timestamps.'
}

$raw = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scriptPath `
  -DryRun `
  -FrontendHost '192.168.1.25'
$plan = $raw | ConvertFrom-Json

if ($plan.projectRoot -ne (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path) {
  throw 'Dry-run plan did not resolve the Rag project root relative to the script.'
}

$services = @($plan.services)
if (($services.name -join ',') -ne 'gateway,backend,frontend') {
  throw 'Services are not declared in the required startup order.'
}

$gateway = $services | Where-Object name -eq 'gateway'
if ($gateway.host -ne '127.0.0.1' -or $gateway.port -ne 8787) {
  throw 'Gateway WebSocket must remain local-only.'
}

$frontend = $services | Where-Object name -eq 'frontend'
if ($frontend.host -ne '0.0.0.0' -or $frontend.port -ne 3003) {
  throw 'Frontend must bind to all IPv4 interfaces on port 3003.'
}
if ($frontend.advertisedHost -ne '192.168.1.25') {
  throw 'Frontend must advertise the selected LAN address.'
}
if ($frontend.localUrl -ne 'http://127.0.0.1:3003' -or $frontend.lanUrl -ne 'http://192.168.1.25:3003') {
  throw 'Frontend access URLs are incorrect.'
}
if (($frontend.arguments -join ' ') -notmatch '--host 0\.0\.0\.0') {
  throw 'Vite preview is not configured for local and LAN access.'
}

$allPaths = @($services.program) + @($services.workingDirectory)
if (($allPaths -join "`n") -match '^[A-Z]:\\project' -and $plan.projectRoot -notmatch '^[A-Z]:\\project') {
  throw 'Deployment plan contains an unrelated hard-coded project root.'
}

Write-Output 'local deployment dry-run contract passed'
