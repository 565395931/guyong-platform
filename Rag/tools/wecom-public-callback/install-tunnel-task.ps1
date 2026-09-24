[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$SshHost,

  [ValidateRange(1, 65535)]
  [int]$SshPort = 22,

  [string]$SshUser = 'wecom-tunnel',

  [Parameter(Mandatory = $true)]
  [string]$IdentityFile,

  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$taskName = 'Rag-WeCom-Reverse-Tunnel'

if ($SshHost -notmatch '^[A-Za-z0-9.-]+$') {
  throw 'SshHost is invalid.'
}
if ($SshUser -notmatch '^[A-Za-z_][A-Za-z0-9_-]*$') {
  throw 'SshUser is invalid.'
}
if ([string]::IsNullOrWhiteSpace($IdentityFile)) {
  throw 'IdentityFile is invalid.'
}

$nodeCommand = Get-Command node.exe -ErrorAction Stop
$nodePath = [IO.Path]::GetFullPath($nodeCommand.Source)
$tunnelScript = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'reverse-tunnel.js'))
$resolvedIdentity = [IO.Path]::GetFullPath($IdentityFile)

if (-not (Test-Path -LiteralPath $tunnelScript -PathType Leaf)) {
  throw 'Reverse-tunnel supervisor is missing.'
}

$arguments = @(
  ('"' + $tunnelScript + '"'),
  '--ssh-host', $SshHost,
  '--ssh-port', [string]$SshPort,
  '--ssh-user', $SshUser,
  '--identity-file', ('"' + $resolvedIdentity + '"'),
  '--remote-port', '18788',
  '--local-port', '8788'
) -join ' '

$plan = [pscustomobject]@{
  taskName = $taskName
  program = $nodePath
  arguments = $arguments
}

if ($DryRun) {
  $plan | ConvertTo-Json -Compress
  exit 0
}

if (-not (Test-Path -LiteralPath $resolvedIdentity -PathType Leaf)) {
  throw 'Identity file does not exist.'
}
Get-Command ssh.exe -ErrorAction Stop | Out-Null

$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute $nodePath -Argument $arguments
$triggers = @(
  (New-ScheduledTaskTrigger -AtStartup),
  (New-ScheduledTaskTrigger -AtLogOn -User $currentUser)
)
$principal = New-ScheduledTaskPrincipal `
  -UserId $currentUser `
  -LogonType Interactive `
  -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0)

Register-ScheduledTask `
  -TaskName $taskName `
  -Description 'Maintains the local-only Enterprise WeCom callback reverse tunnel.' `
  -Action $action `
  -Trigger $triggers `
  -Principal $principal `
  -Settings $settings `
  -Force | Out-Null

[pscustomobject]@{
  taskName = $taskName
  status = 'registered'
} | ConvertTo-Json -Compress
