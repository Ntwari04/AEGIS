# AegisOps: Phase 5, Backups, Databases & Infrastructure

## What exists

| Capability | Where | Who |
|---|---|---|
| Nightly encrypted backups of the AegisOps DB, Keycloak and every provisioned database, stored off the server | `data-worker` | automatic |
| Weekly restore drill (restore to a scratch DB, verify exact row counts, measure against the RTO) | `data-worker` | automatic; `platform_admin` can run it now |
| Provision a PostgreSQL database + a least-privilege role from the dashboard | project page → Databases | `platform_admin`, project `devops_engineer` |
| On-demand backup, history, restore to a NEW database | database page | `platform_admin`, project `devops_engineer`; auditors read |
| Overwrite a live database | database page → Restore… | `platform_admin` only, name typed back + reason |
| Servers, container start/stop/restart, log search and a live log view | Infrastructure page, project page | see "Roles" |
| Cordon, uncordon, drain | Infrastructure page | `platform_admin` only, name typed back + reason |

## Recovery objectives (PRD 7)

**RTO 4 hours, RPO 24 hours.** RPO follows from the nightly schedule: you can lose up to a day of data. Take an on-demand backup before risky changes
(manual backups are kept 30 days). The RTO is *measured*, not assumed: every drill records how long a restore took, the dashboard shows it, and
`RestoreSlowerThanRto` alerts if a drill exceeds the objective. On the development data set a full restore takes about 1-2 seconds; on production
volumes the number will grow with database size, so read it from the drill rather than from this page.

## How a backup works

1. One REPEATABLE READ snapshot is exported. Row counts per table and `pg_dump` both use it, so the **manifest describes exactly what was dumped**.
2. `pg_dump` (plain SQL) is streamed through gzip, then **chunked AES-256-GCM** (every 64 KiB is its own authenticated message with its index and a
   final-flag as additional data), then uploaded. Nothing is written to the local disk.
3. The stored size is checked against the bytes sent; a non-zero `pg_dump` exit means a partial dump and the backup is marked FAILED with its object deleted.
4. The record keeps the SHA-256 of the stored object and the manifest. Failures are recorded with a reason and alert (`BackupFailed`).

Why chunked encryption: a restore pipes the decrypted stream into `psql`. With one big GCM message the tag is only checked at the very end, so a tampered
archive would already have executed attacker-chosen SQL. Here no byte of a chunk is released before that chunk authenticates, and dropped, reordered or
truncated chunks are detected.

## How a restore works (and why it is safe)

Restore always goes into a **new** database (`restore_<target>_<time>`):

1. the stored archive is hashed and compared with the checksum recorded at backup time (catches a replaced or corrupted object) **before anything runs**;
2. the new database is created, owned by the database's own role when it is a provisioned database;
3. the archive is decrypted (per-chunk authentication), decompressed and applied in **one transaction** (`ON_ERROR_STOP`);
4. exact table and row counts are compared with the manifest. Any difference fails the restore and drops the new database.

## Runbooks

### Restore a database to a new copy (to inspect, or to recover a few rows)

Dashboard: project → Databases → Backups → pick a backup → **Restore to a NEW database**. The live database is untouched.
The copy appears as `restore_...` on the server; the history shows its integrity result. A `platform_admin` can then connect to it, or copy data out.

### Overwrite a live database with a backup

Dashboard (`platform_admin`): Restore… → *Overwrite the live database*: type the database name and a reason (at least 10 characters). Then, automatically:
1. a **safety backup of the current state** is taken first. If it fails the overwrite is refused and nothing changes;
2. the chosen backup is restored into a new database and fully verified;
3. connections to the live database are closed, and the two are swapped by renaming. The previous data is kept as `<name>_old_<time>`, closed to connections.

To get the old data back: `ALTER DATABASE <name>_old_<time> WITH ALLOW_CONNECTIONS true;` and connect, or run another overwrite from the safety backup.
Drop `<name>_old_<time>` yourself when you are sure (`DROP DATABASE`); AegisOps never deletes it.

### Disaster recovery: the server is gone

You need: the object-storage bucket and its credentials, and **`BACKUP_ENCRYPTION_KEY`** (kept off the server). Without the key the backups cannot be read by anyone.
1. Rebuild the stack from the repository (Phase 1 scripts + `docker compose up -d`), with the same `BACKUP_ENCRYPTION_KEY` and storage settings in `infra/.env`.
2. The AegisOps database is empty and cannot show you the backup list, so use the recovery tool. It reads only the bucket and the key, never an AegisOps record.
   Create two EMPTY databases (`keycloak`, `aegisops`) on the new Postgres, then run it from this image (every command reads secrets from the environment, never arguments):
   ```
   # S3_* and BACKUP_ENCRYPTION_KEY as in infra/.env; RECOVER_DB_HOST / _PORT / _USER / _PASSWORD point at the empty Postgres
   node dist/backup/recover-cli.js list
   node dist/backup/recover-cli.js restore --target keycloak --database keycloak
   node dist/backup/recover-cli.js restore --target aegisops --database aegisops
   ```
   It picks the newest archive (or `--object <key>` for an older one), refuses a database that already has tables, authenticates every chunk, and applies the
   dump in one transaction: a damaged archive or a wrong key changes nothing. It prints the tables and rows it restored. Run it with the same compose service,
   e.g. `docker compose run --rm --no-deps -e RECOVER_DB_HOST=... -e RECOVER_DB_USER=... -e RECOVER_DB_PASSWORD=... --entrypoint node data-worker dist/backup/recover-cli.js list`.
   Connect as the role the service will use (`keycloak` for Keycloak) so objects are owned correctly; the dumps carry no owners.
3. Restore Keycloak first (logins), then AegisOps, then each provisioned database from its newest backup (once AegisOps is back, from the dashboard).
4. Redeploy applications from GitHub: their images are in GHCR and their secrets are in the restored AegisOps database (encrypted with `SECRETS_ENCRYPTION_KEY`,
   which must also be restored from your off-server copy).

**Rehearsed 2026-11-05** against the real Cloudflare R2 bucket and a brand-new empty Postgres 16, with nothing from AegisOps but the bucket credentials and the key:
listing, restoring Keycloak (89 tables, 1,878 rows) and restoring AegisOps (15 tables, 310 rows) took **10 seconds in total**. Row counts matched the manifests recorded at
backup time exactly. The RTO is 4 hours; this data set is tiny, so read the real figure from your own drill as the data grows. Not rehearsed: bringing the whole stack
up on a new server (DNS, certificates, Keycloak and the application against the recovered databases). Repeat the rehearsal after big changes and after changing storage.

## Production setup

1. `node infra/scripts/ensure-secrets.mjs` adds `AEGIS_BACKUP_DB_PASSWORD`, `AEGIS_PROVISIONER_DB_PASSWORD` and `BACKUP_ENCRYPTION_KEY` to `infra/.env`.
   **Copy `BACKUP_ENCRYPTION_KEY` somewhere that is not this server** (a password manager).
2. Create the Postgres roles in an existing database (a fresh install does it on first start):
   `docker exec aegisops-postgres sh /docker-entrypoint-initdb.d/02-data-roles.sh`
3. Create an access-controlled bucket (DigitalOcean Spaces or any S3-compatible service) and set `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`
   in `infra/.env`. Use a key limited to that bucket. Until this is set, backups **fail loudly and alert**; they are never kept on the server's disk.
4. `docker compose up -d` (migrations first: `docker compose --profile tools run --rm migrate`).
5. Run a drill once: Backups page → *Run restore drill now*, and confirm it verifies.

Local development with the usual `docker-compose.local-https.yml` uses the real `S3_*` settings from `infra/.env`. To develop without a bucket, add
`-f docker-compose.local-s3.yml`: it brings an unauthenticated throwaway S3 store (`s3-local`) and points the data worker at it. It must never be used on a server.
For Cloudflare R2: the endpoint is `https://<account-id>.r2.cloudflarestorage.com` (`.eu.` for an EU-jurisdiction bucket), `S3_REGION=auto`, and the token must be Object Read & Write limited to the bucket.

## Retention (FR-BACKUP-3)

Scheduled backups: the newest of each of the last **14 days**, **8 weeks** and **12 months** are kept; the newest backup of a target is never pruned. Manual backups are
kept **30 days** and are never displaced by a nightly one. Pruning deletes the archive and keeps the history row. Defaults, tune in `retention.ts` once real storage cost is known.

## Roles

| | developer | auditor | devops_engineer (own projects) | platform_admin |
|---|---|---|---|---|
| Provision a database | no | no | yes | yes |
| Backup history | no | yes | yes | yes |
| On-demand backup, restore to a new DB | no | no | yes | yes |
| **Overwrite** a live database | no | no | **no** | **yes** (typed name + reason) |
| System DB backups, drills, restore history | no | read | no | yes |
| Container start/stop/restart (non-production) | yes | no | yes | yes |
| Container controls (production) | no | no | yes | yes |
| Platform containers | no | no | no | yes (typed reason; critical services restart-only) |
| Logs of a project | own projects | yes | own projects | yes |
| Servers: view | no | yes | yes | yes |
| Cordon, uncordon, drain, register server | no | no | no | yes (typed name + reason) |

## Design decisions worth knowing

- **The API never holds the backup role, the key or the storage credentials.** It only enqueues; the data worker (no port, no Docker socket) does the work.
  The deployer (the only holder of Docker access) re-validates container actions and resolves targets from the database and the `aegisops.managed` label, never from a request.
- **Least-privilege roles:** `aegis_backup` reads everything but cannot write to an existing database; `aegis_provisioner` can create roles and databases but is not a superuser.
  A provisioned application role owns exactly one private database, cannot create databases or roles, and cannot connect to any other database (including `postgres` and `template1`).
- **A provisioned database's password** goes to Postgres and into the encrypted `DATABASE_URL` environment secret. It is never stored in an AegisOps table, the audit log or an error.
- **Cordon** blocks new deployments on every path (manual, rollback, CI key, webhook, and again when the engine starts a queued job). **Drain** refuses unless the server is cordoned.

## Verified live (2026-11-04)

Nightly run backed up all three targets; the drill restored all three into scratch databases with exact row counts and left nothing behind; a database was provisioned
through the real queue (the role refused every other database); a container was restarted through the deployer with its logs found in Loki; a drain on a non-cordoned
server, a foreign container and "stop redis" were all refused and audited. The integration suites run the real `pg_dump`/`psql` against Postgres 16 and a real S3-compatible store.

## Known gaps

- Deprovisioning (dropping a provisioned database and its role) is deliberately not offered from the dashboard; do it by hand once you are sure.
- Rotating a provisioned role's password is not offered yet (re-provision into a new database, or `ALTER ROLE` by hand and update `DATABASE_URL`).
- Point-in-time recovery (WAL archiving) is not provided; RPO is the backup interval.
- Backups are encrypted with a symmetric key held on the server (so drills can run unattended). A compromise of the server exposes that key. Public-key encryption
  (server holds only the public key) would remove that, at the cost of unattended drills; see `docs/secrets-review.md`.
- The empty-database disaster path is a tool plus a runbook (see above), rehearsed for the databases only. A full rebuild on a new server has not been rehearsed.
