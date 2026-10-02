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

## Railway
* **Database.** Enable Railway's Postgres backups in the dashboard, and additionally run `backup.py` from your PC against the
  public TCP proxy URL of the Postgres service (Railway → Postgres → Connect → public URL; needs `pg_dump` 16+ installed locally).
* **Document volume.** The volume is mounted only in the `api` service. Use Railway's volume backups where your plan has them,
  and periodically copy `/data/storage` out (`railway ssh -s api` then `tar czf - /data/storage`). `verify` compares the archive
  with the database, so a stale archive is caught.
* **Cadence.** Daily database backup, weekly full backup, and a `verify` of the newest backup at least monthly.
* **Not automated.** Nothing runs these on a schedule yet; put `backup.py` in Task Scheduler or a Railway cron if you want that.
