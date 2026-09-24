$ErrorActionPreference = 'Stop'

$scriptPath = Join-Path $PSScriptRoot 'install-tunnel-task.ps1'
$raw = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scriptPath `
  -DryRun -SshHost 'ecs.example.test' -IdentityFile 'E:\secure\wecom-tunnel\id_ed25519'
if ($LASTEXITCODE -ne 0) { throw 'Scheduled-task dry-run failed.' }

$plan = $raw | ConvertFrom-Json
if ($plan.taskName -ne 'Rag-WeCom-Reverse-Tunnel') { throw 'Unexpected task name.' }
if (-not [IO.Path]::IsPathRooted($plan.program) -or $plan.program -notmatch 'node\.exe$') {
  throw 'Node executable was not resolved to an absolute path.'
}
if ($plan.arguments -notmatch '--remote-port 18788') { throw 'Remote port is not fixed.' }
if ($plan.arguments -notmatch '--local-port 8788') { throw 'Local gateway port is not fixed.' }
if ($plan.arguments -notmatch '--identity-file "E:\\secure\\wecom-tunnel\\id_ed25519"') {
  throw 'Identity file was not resolved and quoted.'
}
if ($plan.arguments -match '0\.0\.0\.0') { throw 'Public bind is forbidden.' }
if ($plan.arguments -match 'password|secret|token') { throw 'Task arguments contain a secret field.' }

$source = Get-Content -Raw -LiteralPath $scriptPath
if ($source -notmatch 'New-ScheduledTaskTrigger\s+-AtStartup') {
  throw 'Startup trigger is missing.'
}
if ($source -notmatch 'New-ScheduledTaskTrigger\s+-AtLogOn') {
  throw 'Logon trigger is missing.'
}
if ($source -notmatch 'RestartCount\s+999' -or $source -notmatch 'RestartInterval') {
  throw 'Restart-on-failure settings are missing.'
}
if ($source -match 'Register-ScheduledTask[^\r\n]*(?:-Password|-User)') {
  throw 'Task registration must not store credentials.'
}

Write-Output 'wecom tunnel scheduled-task contract passed'
