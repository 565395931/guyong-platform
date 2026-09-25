[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ManifestPath
)

$ErrorActionPreference = 'Stop'

function Assert-Manifest([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw "Invalid update manifest: $Message" }
}

$resolvedPath = (Resolve-Path -LiteralPath $ManifestPath).Path
$manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $resolvedPath | ConvertFrom-Json
$semanticVersionPattern = '^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$'

Assert-Manifest ($manifest.schemaVersion -eq 1) 'schemaVersion must be 1.'
Assert-Manifest ($manifest.product -eq 'guyong-platform') 'product must be guyong-platform.'
Assert-Manifest ($manifest.channel -in @('test', 'stable')) 'channel must be test or stable.'
Assert-Manifest ($manifest.version -match $semanticVersionPattern) 'version must use semantic versioning.'
Assert-Manifest (-not $manifest.minimumUpdaterVersion -or $manifest.minimumUpdaterVersion -match $semanticVersionPattern) 'minimumUpdaterVersion must use semantic versioning.'

$publishedAt = [DateTimeOffset]::MinValue
Assert-Manifest ([DateTimeOffset]::TryParse([string]$manifest.publishedAt, [ref]$publishedAt)) 'publishedAt must be an ISO date-time.'

$packageUrl = $null
Assert-Manifest ([Uri]::TryCreate([string]$manifest.package.url, [UriKind]::Absolute, [ref]$packageUrl)) 'package.url must be an absolute URL.'
Assert-Manifest ($packageUrl.Scheme -eq 'https') 'package.url must use HTTPS.'
Assert-Manifest ([long]$manifest.package.size -gt 0) 'package.size must be greater than zero.'
Assert-Manifest ([string]$manifest.package.sha256 -match '^[0-9a-fA-F]{64}$') 'package.sha256 must be a SHA-256 hex digest.'
Assert-Manifest ($manifest.signature.algorithm -eq 'ed25519') 'signature.algorithm must be ed25519.'
Assert-Manifest (-not [string]::IsNullOrWhiteSpace([string]$manifest.signature.keyId)) 'signature.keyId is required.'

try {
  $signatureBytes = [Convert]::FromBase64String([string]$manifest.signature.value)
} catch {
  throw 'Invalid update manifest: signature.value must be Base64.'
}
Assert-Manifest ($signatureBytes.Length -eq 64) 'signature.value must contain a 64-byte Ed25519 signature.'

[pscustomobject]@{
  Valid = $true
  Product = $manifest.product
  Channel = $manifest.channel
  Version = $manifest.version
  PackageUrl = $packageUrl.AbsoluteUri
  Sha256 = ([string]$manifest.package.sha256).ToLowerInvariant()
  KeyId = $manifest.signature.keyId
} | ConvertTo-Json -Depth 3
