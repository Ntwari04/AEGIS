#!/bin/sh
# Runs once, on first start of an empty data volume. Creates one least-privilege
# role + database per service. Passwords come from the container environment
# (infra/.env), never from this file.
set -eu

: "${AEGISOPS_DB_PASSWORD:?}" "${KEYCLOAK_DB_PASSWORD:?}"

# Passwords are passed as psql variables and quoted by psql (:'var') so no
# value is ever spliced into SQL by the shell.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v aegis_pw="$AEGISOPS_DB_PASSWORD" -v kc_pw="$KEYCLOAK_DB_PASSWORD" <<'SQL'
CREATE ROLE aegisops LOGIN PASSWORD :'aegis_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE keycloak LOGIN PASSWORD :'kc_pw'    NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE DATABASE aegisops OWNER aegisops;
CREATE DATABASE keycloak OWNER keycloak;
REVOKE ALL ON DATABASE aegisops FROM PUBLIC;
REVOKE ALL ON DATABASE keycloak FROM PUBLIC;
SQL
