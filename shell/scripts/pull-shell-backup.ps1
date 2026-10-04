# Off-site shell database backup pull for Windows Task Scheduler.
# Reads scripts\.env.shell-backup (SHELL_URL, BACKUP_PULL_TOKEN, BACKUP_DIR, optional KEEP and BACKUP_DOCKER), runs pull-shell-backup.mjs and appends to pull.log.
# Keep .env.shell-backup out of git (it holds the pull token). Make sure the BACKUP_DIR folder exists.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Get-Content (Join-Path $here ".env.shell-backup") | ForEach-Object {
  if ($_ -match '^\s*([^#=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($Matches[1].Trim(), $Matches[2].Trim(), "Process") }
}
if (-not $env:BACKUP_DIR) { $env:BACKUP_DIR = Join-Path $HOME "founderos-shell-backups" }
New-Item -ItemType Directory -Force -Path $env:BACKUP_DIR | Out-Null
$log = Join-Path $env:BACKUP_DIR "pull.log"
"=== $(Get-Date -Format s) ===" | Out-File -Append -Encoding utf8 $log
& node (Join-Path $here "pull-shell-backup.mjs") *>> $log
exit $LASTEXITCODE
