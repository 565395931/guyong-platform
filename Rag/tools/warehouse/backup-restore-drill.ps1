$ErrorActionPreference = 'Stop'

function Read-DotEnvValue([string]$path, [string]$key) {
  $line = Get-Content -LiteralPath $path | Where-Object { $_ -match "^\s*$([regex]::Escape($key))\s*=" } | Select-Object -First 1
  if (-not $line) { return $null }
  return ($line -replace "^\s*$([regex]::Escape($key))\s*=\s*", '').Trim().Trim("'").Trim('"')
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$envPath = Join-Path $repoRoot 'rag-server\.env'
$mysql = (Get-Command mysql -ErrorAction Stop).Source
$mysqldump = (Get-Command mysqldump -ErrorAction Stop).Source
$hostName = Read-DotEnvValue $envPath 'DB_HOST'
$port = Read-DotEnvValue $envPath 'DB_PORT'
$user = Read-DotEnvValue $envPath 'DB_USER'
$password = Read-DotEnvValue $envPath 'DB_PASSWORD'
if (-not $hostName) { $hostName = '127.0.0.1' }
if (-not $port) { $port = '3306' }
if (-not $user -or $null -eq $password) { throw 'DB_USER and DB_PASSWORD are required' }

$suffix = '{0}_{1}' -f (Get-Date -Format 'yyyyMMddHHmmss'), ([guid]::NewGuid().ToString('N').Substring(0, 6))
$sourceDb = "backup_it_$suffix"
$restoreDb = "restore_it_$suffix"
$artifactDir = Join-Path $repoRoot 'artifacts\backup-restore'
$dumpPath = Join-Path $artifactDir "$sourceDb.sql"
$mysqlDumpPath = $dumpPath.Replace('\', '/')
New-Item -ItemType Directory -Force -Path $artifactDir | Out-Null

$env:MYSQL_PWD = $password
try {
  & $mysql --protocol=TCP --host=$hostName --port=$port --user=$user -e "CREATE DATABASE $sourceDb CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; CREATE TABLE $sourceDb.backup_drill_marker (id INT PRIMARY KEY, marker VARCHAR(160) NOT NULL); INSERT INTO $sourceDb.backup_drill_marker VALUES (1, '$sourceDb');"
  if ($LASTEXITCODE -ne 0) { throw 'failed to create backup drill source database' }

  & $mysqldump --protocol=TCP --host=$hostName --port=$port --user=$user --single-transaction --routines --events $sourceDb --result-file=$dumpPath
  if ($LASTEXITCODE -ne 0) { throw 'mysqldump failed' }

  & $mysql --protocol=TCP --host=$hostName --port=$port --user=$user -e "DROP DATABASE $sourceDb; CREATE DATABASE $restoreDb CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
  if ($LASTEXITCODE -ne 0) { throw 'failed to prepare restore database' }
  & $mysql --protocol=TCP --host=$hostName --port=$port --user=$user $restoreDb -e "SOURCE $mysqlDumpPath;"
  if ($LASTEXITCODE -ne 0) { throw 'mysql restore failed' }

  $verification = & $mysql --protocol=TCP --host=$hostName --port=$port --user=$user --batch --skip-column-names $restoreDb -e 'SELECT marker FROM backup_drill_marker WHERE id=1;'
  if ($LASTEXITCODE -ne 0 -or $verification.Trim() -ne $sourceDb) { throw "backup restore verification failed: $verification" }
  Write-Output "BACKUP_RESTORE_PASS source=$sourceDb restore=$restoreDb artifact=$dumpPath"
}
finally {
  & $mysql --protocol=TCP --host=$hostName --port=$port --user=$user -e "DROP DATABASE IF EXISTS $sourceDb; DROP DATABASE IF EXISTS $restoreDb;" 2>$null | Out-Null
  Remove-Item Env:MYSQL_PWD -ErrorAction SilentlyContinue
}
