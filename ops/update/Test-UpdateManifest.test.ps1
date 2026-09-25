$ErrorActionPreference = 'Stop'

$validator = Join-Path $PSScriptRoot 'Test-UpdateManifest.ps1'
$example = Join-Path $PSScriptRoot 'update-manifest.example.json'
$result = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $validator -ManifestPath $example | ConvertFrom-Json

if (-not $result.Valid -or $result.Product -ne 'guyong-platform' -or $result.Channel -ne 'test') {
  throw 'The example update manifest did not pass the expected contract.'
}
if ($result.PackageUrl -notlike 'https://*') {
  throw 'The validated update package URL must use HTTPS.'
}

$temporaryManifest = [System.IO.Path]::GetTempFileName()
try {
  $invalid = Get-Content -Raw -Encoding UTF8 -LiteralPath $example | ConvertFrom-Json
  $invalid.package.url = 'http://updates.example.invalid/unsafe.zip'
  $invalid | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $temporaryManifest -Encoding UTF8
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $validator -ManifestPath $temporaryManifest 2>$null | Out-Null
  $validatorExitCode = $LASTEXITCODE
  $ErrorActionPreference = $previousPreference
  if ($validatorExitCode -eq 0) { throw 'An insecure update URL was accepted.' }
} finally {
  Remove-Item -LiteralPath $temporaryManifest -Force -ErrorAction SilentlyContinue
}

Write-Output 'update manifest contract passed'
