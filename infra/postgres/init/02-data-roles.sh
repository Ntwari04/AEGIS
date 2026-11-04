#!/bin/sh
# Creates (or updates) the two non-superuser roles the data worker uses. Idempotent, so it serves both:
#   - a fresh install: Postgres runs this once from /docker-entrypoint-initdb.d, and
#   - an existing install: docker exec aegisops-postgres sh /docker-entrypoint-initdb.d/02-data-roles.sh
# Passwords come from the container environment (infra/.env), never from this file, and reach SQL as psql variables.
set -eu

: "${AEGIS_BACKUP_DB_PASSWORD:?set AEGIS_BACKUP_DB_PASSWORD in infra/.env}"
: "${AEGIS_PROVISIONER_DB_PASSWORD:?set AEGIS_PROVISIONER_DB_PASSWORD in infra/.env}"

psql -v ON_ERROR_STOP=1 --username "${POSTGRES_USER:-postgres}" --dbname postgres \
  -v bk_pw="$AEGIS_BACKUP_DB_PASSWORD" -v pv_pw="$AEGIS_PROVISIONER_DB_PASSWORD" <<'SQL'
-- aegis_backup: reads every database (pg_read_all_data) to dump it, and may CREATE databases (restore targets and drill scratch
-- databases, which it then owns and drops). It cannot write to any existing database and is NOT a superuser.
SELECT format('CREATE ROLE aegis_backup LOGIN NOSUPERUSER NOCREATEROLE CREATEDB PASSWORD %L', :'bk_pw')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aegis_backup') \gexec
SELECT format('ALTER ROLE aegis_backup LOGIN NOSUPERUSER NOCREATEROLE CREATEDB PASSWORD %L', :'bk_pw') \gexec
GRANT pg_read_all_data TO aegis_backup;
-- Lets the confirmed overwrite swap close connections to a live database before renaming it. Not a superuser privilege.
GRANT pg_signal_backend TO aegis_provisioner;

-- aegis_provisioner: creates the least-privilege role and database for a project (FR-DB-1). CREATEROLE + CREATEDB, no superuser.
-- createrole_self_grant lets it SET ROLE to the roles it creates, which is what allows it to hand a new database to its owner.
SELECT format('CREATE ROLE aegis_provisioner LOGIN NOSUPERUSER CREATEROLE CREATEDB PASSWORD %L', :'pv_pw')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aegis_provisioner') \gexec
SELECT format('ALTER ROLE aegis_provisioner LOGIN NOSUPERUSER CREATEROLE CREATEDB PASSWORD %L', :'pv_pw') \gexec
ALTER ROLE aegis_provisioner SET createrole_self_grant = 'set, inherit';

-- Nobody but the data roles may connect to the default databases. By default PUBLIC can, which would let ANY provisioned
-- application role connect to `postgres` and list every database and role on the server.
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;
GRANT CONNECT ON DATABASE postgres TO aegis_backup, aegis_provisioner;

-- The system databases revoke PUBLIC access (init script 01), so grant the backup role CONNECT explicitly.
GRANT CONNECT ON DATABASE aegisops TO aegis_backup;
GRANT CONNECT ON DATABASE keycloak TO aegis_backup;
SQL
echo "data roles ready: aegis_backup, aegis_provisioner"
