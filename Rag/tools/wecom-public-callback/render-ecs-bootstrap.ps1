param(
  [string]$ProjectRoot = 'E:\project\project\Rag',
  [string]$OutputPath = 'E:\project\project\Rag\tools\wecom-public-callback\generated\ecs-bootstrap-wecom.sh'
)

$ErrorActionPreference = 'Stop'

$templatePath = Join-Path $ProjectRoot 'tools\wecom-public-callback\ecs-bootstrap.sh'
$tunnelPublicKeyPath = Join-Path $ProjectRoot 'data\wecom-tunnel\id_ed25519.pub'
$probePublicKeyPath = Join-Path $ProjectRoot 'data\wecom-probe\id_ed25519.pub'

foreach ($path in @($templatePath, $tunnelPublicKeyPath, $probePublicKeyPath)) {
  if (-not (Test-Path -LiteralPath $path)) {
    throw "Required file is missing: $path"
  }
}

$tunnelPublicKey = (Get-Content -Raw -LiteralPath $tunnelPublicKeyPath).Trim()
$probePublicKey = (Get-Content -Raw -LiteralPath $probePublicKeyPath).Trim()

if ($tunnelPublicKey -notmatch '^ssh-ed25519 ') {
  throw 'Tunnel public key is not an Ed25519 public key.'
}
if ($probePublicKey -notmatch '^ssh-ed25519 ') {
  throw 'Probe public key is not an Ed25519 public key.'
}

$outputDirectory = Split-Path -Parent $OutputPath
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null

$template = Get-Content -Raw -LiteralPath $templatePath
$rendered = $template.
  Replace('__WECOM_TUNNEL_PUBKEY__', $tunnelPublicKey).
  Replace('__WECOM_PROBE_PUBKEY__', $probePublicKey)

Set-Content -LiteralPath $OutputPath -Value $rendered -NoNewline -Encoding ascii

[pscustomobject]@{
  outputPath = $OutputPath
  containsPrivateKey = $rendered -match 'OPENSSH PRIVATE KEY'
  tunnelPublicKeyComment = ($tunnelPublicKey -split '\s+')[-1]
  probePublicKeyComment = ($probePublicKey -split '\s+')[-1]
} | ConvertTo-Json -Compress
