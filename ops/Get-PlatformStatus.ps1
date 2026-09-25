[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Platform.Common.ps1')

Get-PlatformStatus | Format-Table Name, Running, Port, Pid, LocalUrl, LanUrl -AutoSize
