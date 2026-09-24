$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$scriptPath = Join-Path $projectRoot 'Rag\rag-server\scripts\reset-owner-password.js'
$serverRoot = Join-Path $projectRoot 'Rag\rag-server'

$username = Read-Host '管理员账号（直接回车使用 admin）'
if ([string]::IsNullOrWhiteSpace($username)) { $username = 'admin' }
$first = Read-Host '请输入新密码（至少 8 个字符）' -AsSecureString
$second = Read-Host '请再次输入新密码' -AsSecureString

function Convert-SecureValue([Security.SecureString]$Value) {
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

$password = Convert-SecureValue $first
$confirmation = Convert-SecureValue $second
if ($password -cne $confirmation) { throw '两次输入的密码不一致。' }

$previousUsername = $env:LOCAL_OWNER_RESET_USERNAME
$previousPassword = $env:LOCAL_OWNER_RESET_PASSWORD
try {
  $env:LOCAL_OWNER_RESET_USERNAME = $username.Trim()
  $env:LOCAL_OWNER_RESET_PASSWORD = $password
  Push-Location $serverRoot
  try {
    & node.exe $scriptPath
    if ($LASTEXITCODE -ne 0) { throw '管理员密码重置失败。' }
  } finally { Pop-Location }
} finally {
  $password = $null
  $confirmation = $null
  if ($null -eq $previousUsername) { Remove-Item Env:LOCAL_OWNER_RESET_USERNAME -ErrorAction SilentlyContinue } else { $env:LOCAL_OWNER_RESET_USERNAME = $previousUsername }
  if ($null -eq $previousPassword) { Remove-Item Env:LOCAL_OWNER_RESET_PASSWORD -ErrorAction SilentlyContinue } else { $env:LOCAL_OWNER_RESET_PASSWORD = $previousPassword }
}
