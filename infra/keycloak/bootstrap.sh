#!/bin/sh
#
# AegisOps — Keycloak realm/client/role bootstrap (Phase 2, PRD Section 5.2/6.1)
#
# Run this INSIDE the Keycloak container after it's up, from your host:
#   docker cp infra/keycloak/bootstrap.sh aegisops-keycloak:/tmp/bootstrap.sh
#   docker exec -it aegisops-keycloak sh /tmp/bootstrap.sh
#
# Safe to re-run: steps that fail because the thing already exists just
# print a note and continue instead of aborting the whole script.

set -e
KCADM=/opt/keycloak/bin/kcadm.sh
REALM=aegisops
CLIENT_ID=aegisops-web
ADMIN_USER=${KC_BOOTSTRAP_ADMIN_USERNAME:-admin}
ADMIN_PASS=${KC_BOOTSTRAP_ADMIN_PASSWORD:-admin}

echo "==> Authenticating kcadm against the master realm"
$KCADM config credentials --server http://localhost:8080 --realm master --user "$ADMIN_USER" --password "$ADMIN_PASS"

echo "==> Creating realm: $REALM"
$KCADM create realms -s realm=$REALM -s enabled=true || echo "   (realm may already exist, continuing)"

echo "==> Creating roles: platform_admin, devops_engineer, developer, auditor"
for ROLE in platform_admin devops_engineer developer auditor; do
  $KCADM create roles -r $REALM -s name=$ROLE || echo "   (role $ROLE may already exist)"
done

echo "==> Creating client: $CLIENT_ID (confidential, standard flow + PKCE)"
$KCADM create clients -r $REALM \
  -s clientId=$CLIENT_ID \
  -s enabled=true \
  -s publicClient=false \
  -s standardFlowEnabled=true \
  -s directAccessGrantsEnabled=false \
  -s 'redirectUris=["http://localhost:3000/*"]' \
  -s 'webOrigins=["http://localhost:3000"]' \
  -s 'attributes={"pkce.code.challenge.method":"S256"}' \
  || echo "   (client may already exist)"

echo ""
echo "==> Client secret — put this in apps/web/.env as KEYCLOAK_CLIENT_SECRET (never commit it):"
CLIENT_UUID=$($KCADM get clients -r $REALM -q clientId=$CLIENT_ID --fields id --format csv --noquotes | tail -n1)
$KCADM get clients/$CLIENT_UUID/client-secret -r $REALM

echo ""
echo "=================================================================="
echo " Bootstrap complete."
echo " Realm '$REALM' with roles platform_admin/devops_engineer/developer/auditor"
echo " and client '$CLIENT_ID' are ready."
echo ""
echo " Create your first login user with (replace <you> / pick a real password):"
echo "   $KCADM create users -r $REALM -s username=<you> -s enabled=true \\"
echo "     -s email=<you>@inclusivitysolutions.com -s emailVerified=true"
echo "   $KCADM set-password -r $REALM --username <you> --new-password '<pick one>'"
echo "   $KCADM add-roles -r $REALM --uusername <you> --rolename platform_admin"
echo ""
echo " Per PRD FR-IAM-2, MFA is required for platform_admin/devops_engineer in"
echo " production — add that as a required action once you're past local testing:"
echo "   $KCADM update users/<user-id> -r $REALM -s 'requiredActions=[\"CONFIGURE_TOTP\"]'"
echo "=================================================================="
