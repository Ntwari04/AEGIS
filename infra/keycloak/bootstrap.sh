#!/bin/sh
#
# AegisOps — Keycloak day-2 operations (Phase 2, PRD 6.1 / 8.1).
#
# The realm, roles, MFA flow and the OIDC client are DECLARATIVE: they live in
# realm-aegisops.json and are imported when Keycloak first starts on an empty
# database. To tear down and recreate everything:
#     docker compose down keycloak && docker exec aegisops-postgres \
#       psql -U postgres -c 'DROP DATABASE keycloak' -c 'CREATE DATABASE keycloak OWNER keycloak'
#     docker compose up -d keycloak
#
# This script covers the parts that must NOT be in a committed file: people.
# It runs inside the container, which already has KC_BOOTSTRAP_ADMIN_* set:
#
#   docker cp infra/keycloak/bootstrap.sh aegisops-keycloak:/tmp/bootstrap.sh
#   docker exec -e INITIAL_ADMIN_USERNAME=you -e INITIAL_ADMIN_EMAIL=you@corp.com \
#               -e INITIAL_ADMIN_PASSWORD='temp-password-12+chars' \
#               aegisops-keycloak sh /tmp/bootstrap.sh create-admin
#   docker exec -e MASTER_ADMIN_USERNAME=you -e MASTER_ADMIN_PASSWORD='...' \
#               aegisops-keycloak sh /tmp/bootstrap.sh rotate-bootstrap-admin
#
# Commands: create-admin | rotate-bootstrap-admin | seed-dev-users (local only)

set -eu
KCADM=/opt/keycloak/bin/kcadm.sh
REALM=aegisops

login() {
  : "${KC_BOOTSTRAP_ADMIN_USERNAME:?}" "${KC_BOOTSTRAP_ADMIN_PASSWORD:?}"
  "$KCADM" config credentials --server http://localhost:8080 --realm master \
    --user "${LOGIN_USER:-$KC_BOOTSTRAP_ADMIN_USERNAME}" --password "${LOGIN_PASSWORD:-$KC_BOOTSTRAP_ADMIN_PASSWORD}" >/dev/null
}

# create_user <username> <email> <password> <role> [temporary: true|false]
create_user() {
  u=$1; e=$2; p=$3; role=$4; temp=${5:-true}
  if "$KCADM" get users -r "$REALM" -q "username=$u" --fields username --format csv --noquotes | grep -qx "$u"; then
    echo "   user '$u' already exists, skipping"; return
  fi
  "$KCADM" create users -r "$REALM" -s "username=$u" -s "email=$e" -s enabled=true -s emailVerified=true
  "$KCADM" set-password -r "$REALM" --username "$u" --new-password "$p" $([ "$temp" = true ] && echo --temporary)
  "$KCADM" add-roles -r "$REALM" --uusername "$u" --rolename "$role"
  echo "   created '$u' with role $role"
}

case "${1:-}" in
  create-admin)
    : "${INITIAL_ADMIN_USERNAME:?}" "${INITIAL_ADMIN_EMAIL:?}" "${INITIAL_ADMIN_PASSWORD:?}"
    login
    # Temporary password: the user must change it, and (as platform_admin) enrol TOTP, at first login.
    create_user "$INITIAL_ADMIN_USERNAME" "$INITIAL_ADMIN_EMAIL" "$INITIAL_ADMIN_PASSWORD" platform_admin true
    ;;

  rotate-bootstrap-admin)
    # KC 26's bootstrap admin is meant to be temporary: create a real master-realm admin, then delete it.
    : "${MASTER_ADMIN_USERNAME:?}" "${MASTER_ADMIN_PASSWORD:?}"
    login
    "$KCADM" create users -r master -s "username=$MASTER_ADMIN_USERNAME" -s enabled=true || true
    "$KCADM" set-password -r master --username "$MASTER_ADMIN_USERNAME" --new-password "$MASTER_ADMIN_PASSWORD"
    "$KCADM" add-roles -r master --uusername "$MASTER_ADMIN_USERNAME" --rolename admin
    LOGIN_USER=$MASTER_ADMIN_USERNAME LOGIN_PASSWORD=$MASTER_ADMIN_PASSWORD login
    BOOT_ID=$("$KCADM" get users -r master -q "username=$KC_BOOTSTRAP_ADMIN_USERNAME" --fields id --format csv --noquotes | tail -n1)
    [ -n "$BOOT_ID" ] && "$KCADM" delete "users/$BOOT_ID" -r master && echo "   deleted bootstrap admin"
    echo "Now remove KC_BOOTSTRAP_ADMIN_* from infra/.env or set them to throwaway values."
    ;;

  seed-dev-users)
    [ "${KEYCLOAK_DEV_SEED:-}" = "true" ] || { echo "refusing: set KEYCLOAK_DEV_SEED=true (local development only)"; exit 1; }
    : "${DEV_USER_PASSWORD:?}"
    login
    create_user dev-devops  dev-devops@example.test  "$DEV_USER_PASSWORD" devops_engineer false
    create_user dev-dev     dev-dev@example.test     "$DEV_USER_PASSWORD" developer false
    create_user dev-dev2    dev-dev2@example.test    "$DEV_USER_PASSWORD" developer false
    create_user dev-auditor dev-auditor@example.test "$DEV_USER_PASSWORD" auditor false
    ;;

  *) sed -n '2,27p' "$0"; exit 2 ;;
esac
