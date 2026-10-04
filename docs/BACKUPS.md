# Shell database backups

What the code does, what you must do, and how to restore. Written from the code on 2026-10-04. Things only the live Railway project can show are marked **not verified**. For the LegalAI database see modules/legal/docs/backup.md; the general runbook is docs/OPERATIONS.md.

## How it works
1. **Scheduled, in the shell.** Once a day (UTC, the first scheduler tick after midnight) the `shell_backup` job (`shell/src/lib/ops/backup.ts`) writes a `pg_dump -Fc` of the shell database to `BACKUP_DIR`, then proves it: `pg_restore --list` must read the whole archive, and with `BACKUP_VERIFY_RESTORE=1` the dump is restored into a throw-away database on the same server and every table's row count is compared with the source (a live table can change while it is dumped, so a count between the before and after numbers passes). Only dumps that pass are used. Older dumps beyond `BACKUP_KEEP` (default 7) are deleted. Every attempt is a row in `shell_backups` (file, size, sha256, tables, verified, error) and shows on **/admin/backups**. A manual **Run backup now** button there takes the same lock as the job and is audited.
2. **Off-site pull, by your PC.** A copy on the Railway volume does not survive losing the Railway project. `shell/scripts/pull-shell-backup.mjs` runs on your computer, downloads the newest verified dump over the public shell URL with a token that can do nothing else, checks the sha256, keeps the newest N and checks the archive with `pg_restore --list` when a client exists.
3. **Alarm.** /admin/backups shows a red banner when backups are not configured, when no verified backup exists, or when the newest one is older than 36 hours, with the setup steps.

## Owner steps (once)
1. Railway, service `shell`, Settings, **Volumes**: add a volume mounted at `/data`. (The lead attaches it; **not verified** that it exists yet.)
2. Variables on `shell`:
   | Variable | Value |
   |---|---|
   | `BACKUP_DIR` | `/data/backups` (unset means backups are off and the page says so) |
   | `BACKUP_KEEP` | optional, default `7` |
   | `BACKUP_VERIFY_RESTORE` | optional, `1` to also prove a restore each day. Needs a database user that may `CREATE DATABASE`; if the job's detail says permission denied, leave it off and do the drill below instead |
   | `BACKUP_PULL_TOKEN` | 32+ random characters, for example `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. A **separate** secret from `INTERNAL_PROVISION_TOKEN`. Unset (or shorter than 32) and the pull endpoints answer 404 |
3. Redeploy `shell`. The image contains `pg_dump` (PGDG `postgresql-client-18`, matching the Railway shell database, Postgres 18.6; verified in production on 2026-10-04 that a 16 client is refused with "server version mismatch"). If the database major version changes, raise the version in `shell/Dockerfile` to match. Check with `SHOW server_version;`.
4. Open /admin/backups and press **Run backup now**. A row with "list" (or "list + restore") verified means it works.
5. On your PC create `shell\scripts\.env.shell-backup` (ignored by git) containing:
   ```
   SHELL_URL=https://<your shell domain>
   BACKUP_PULL_TOKEN=<the same value>
   BACKUP_DIR=D:\founderos-shell-backups
   KEEP=14
   ```
   Add `BACKUP_DOCKER=<postgres container name>` if the PC has no PostgreSQL client but has Docker; with neither, the pull still verifies the sha256 and says the archive was not listed.
6. Test it: `powershell -File C:\legalAI\shell\scripts\pull-shell-backup.ps1`, then read `D:\founderos-shell-backups\pull.log` (it ends with `OK: <file>`).
7. Schedule it daily (the shell makes its backup shortly after 00:00 UTC; 09:00 local is fine):
   ```
   schtasks /Create /TN "FounderOS shell backup pull" /SC DAILY /ST 09:00 /RL LIMITED /F /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\legalAI\shell\scripts\pull-shell-backup.ps1"
   ```
   Run it once from Task Scheduler ("Run") and confirm `pull.log`. A missed day is not silent on the server side (the banner) but the PC side only shows in `pull.log`: look at it now and then.

Without a volume the dump would live on the container's disk and vanish at every deploy, so the job refuses to pretend: set `BACKUP_DIR` only to a path on the volume.

## What is verified, and what is not
| Check | Verified when |
|---|---|
| The dump file exists and is not empty | every run |
| The archive is readable end to end (`pg_restore --list`, at least one entry) | every run |
| sha256 recorded, and the downloaded copy matches it | every run / every pull |
| A real restore into a scratch database reproduces every table's row count | only with `BACKUP_VERIFY_RESTORE=1`, and by your drill |
| The data inside the tables is correct, or that the app works against the restored database | **never** automatically: that is what the drill is for |
| The dump is a consistent snapshot | `pg_dump` takes one transaction snapshot, so yes within one dump; row counts taken before and after allow for writes during it |
| Railway's own volume or database backups | **not verified**; see docs/OPERATIONS.md |
| Encryption of the pulled copy | **not done**: the file is a plain dump; keep the folder on an encrypted disk (BitLocker) |

## Restoring
1. Create a new empty Postgres database (a new Railway Postgres service, or a local one). Never restore over the live database.
2. Get a dump: from your PC folder (`D:\founderos-shell-backups\shell-YYYYMMDD-HHMMSS.dump`) or from the volume (`railway ssh -s shell`, `ls /data/backups`).
3. `pg_restore --no-owner --no-privileges --exit-on-error -d "<new database url>" shell-YYYYMMDD-HHMMSS.dump` (with Docker and no client: `docker exec -i <container> pg_restore ... -d <db> < dump` as `shell/scripts/restore-check.mjs --docker` does).
4. Compare row counts with `shell-....dump.json` (`rowCounts`) or with `node shell/scripts/restore-check.mjs <folder>`.
5. Point `DATABASE_URL` of `shell` at the new database, redeploy, sign in, open a business, open /admin/backups.
6. Data written after the dump (up to 24 hours) is lost: that is the recovery point. Tell affected users.

### Restore drill (do it once now, then every quarter)
1. Pull the latest dump to your PC (step 6 above).
2. Start a local Postgres 16 (for example `docker run -d --name restore-drill -e POSTGRES_PASSWORD=drill -p 5460:5432 postgres:16-alpine`).
3. `docker exec -i restore-drill createdb -U postgres drill`, then `docker exec -i restore-drill pg_restore -U postgres --no-owner --no-privileges --exit-on-error -d drill < D:\founderos-shell-backups\<file>.dump`.
4. `docker exec -i restore-drill psql -U postgres drill -c "SELECT count(*) FROM businesses;"` and a few other tables; compare with the manifest and with production.
5. Optionally run the shell against it: `DATABASE_URL=postgresql://postgres:drill@localhost:5460/drill npm run dev --workspace shell`, sign in, look at a business.
6. `docker rm -f restore-drill`. Write the date of the drill in your notes.

## Pull endpoints (for reference)
`GET /api/internal/backups/manifest` and `GET /api/internal/backups/latest` on the shell, header `X-Internal-Token: <BACKUP_PULL_TOKEN>`. 404 when the token is not configured, 401 for a wrong one (constant-time compare), 503 when `BACKUP_DIR` is unset, 404 when there is no verified backup. `latest` streams the dump with `X-Backup-Sha256` and `X-Backup-Name` headers. They are served by the shell itself (not proxied to LegalAI), read-only, and can fetch nothing but backups.

## Standalone scripts
`shell/scripts/backup-shell.mjs` and `restore-check.mjs` are unchanged and still work from any machine with a client or Docker (docs/OPERATIONS.md). `shell/src/lib/ops/backup.ts` is a TypeScript copy of their logic for the server bundle; both are tested (`shell/tests/hardening/backup.test.ts`, `shell/tests/ops/backup.test.ts`).
