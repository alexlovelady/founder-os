# Backups and restore testing

An unverified backup is not a backup. `scripts/backup.py` makes both steps one command each.

```bash
# 1. back up the database and the document files
python scripts/backup.py backup --out backups                # uses $DATABASE_URL and $STORAGE_DIR
# 2. prove it restores
python scripts/backup.py verify backups/backup-20261002-120000
```

`backup` writes `db.dump` (pg_dump custom format), `storage.tar.gz`, and `manifest.json` (hashes of both files plus row
counts of the key tables). `verify` restores the dump into a scratch database, compares every row count with the manifest,
extracts the archive, checks **every stored document against the SHA-256 recorded in the database**, and drops the scratch
database. Exit code 0 only when all of that matches. It was tested here against the dev database, including a deliberately
tampered file (correctly reported as a hash mismatch).

Local dev (Postgres in Docker): add `--docker legalai-db-1`.

## Scheduled server-side backups (Railway)
Set `BACKUP_ENABLED=true` on the API service (the image includes `pg_dump` 16). Each day the worker writes `db.dump` and a manifest
under `/data/backups`, restores it into a scratch database, compares every row count, checks every document file against its recorded
SHA-256, records the verdict in the manifest, and applies retention (7 daily + 4 weekly). The Settings page lists backups and shows
"restore verified". `/api/admin/health` turns red if the newest backup is older than two intervals or failed verification.
Variables: `BACKUP_ENABLED`, `BACKUP_INTERVAL_HOURS` (24), `BACKUP_INCLUDE_STORAGE` (false; true also tars the documents, doubling
volume use), `BACKUP_VERIFY` (true), `BACKUP_DIR`, `BACKUP_TOKEN`.

## Off-site copy on your own computer
These server backups sit on the same volume as the data, so also pull a copy to your PC. Set `BACKUP_TOKEN` (a long random value) on
the server, then on your PC:
```powershell
$env:BACKUP_URL="https://<your app>.up.railway.app"; $env:BACKUP_TOKEN="<token>"; $env:BACKUP_DIR="D:\legalai-backups"
python scripts/pull_backup.py
```
It downloads the latest dump, mirrors every document file, and checks each against its hash (it self-heals corrupt local copies). The
token can only read backups. Run it daily from Task Scheduler.

## Restoring
`pg_restore -d <new database> --no-owner db.dump`, then copy the mirrored `files/` tree to the new volume's `storage` directory. Use
`python scripts/backup.py verify <backup dir>` first to prove the backup is good.
