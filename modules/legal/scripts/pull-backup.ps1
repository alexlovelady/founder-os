# Off-site backup pull for Windows Task Scheduler. Reads scripts\.env.backup (BACKUP_URL, BACKUP_TOKEN, BACKUP_DIR).
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Get-Content (Join-Path $here ".env.backup") | ForEach-Object {
  if ($_ -match '^\s*([^#=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($Matches[1].Trim(), $Matches[2].Trim(), "Process") }
}
& (Join-Path $here "..\.venv\Scripts\python.exe") (Join-Path $here "pull_backup.py") *>> (Join-Path $env:BACKUP_DIR "pull.log")
exit $LASTEXITCODE
