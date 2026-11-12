# AegisOps: incident response (PRD 8.9)

A short runbook for the first hour. It assumes one server running the Compose stack in `infra/`. Commands marked **tested** were run against a live stack; the rest follow the
documented design. Run Docker commands from `infra/` on the server, with the same `-f` files the stack was started with.

## 0. Who to contact (fill this in before go-live)

| Role | Name | Phone / channel |
|---|---|---|
| Incident lead (decides, communicates) | | |
| Platform admin on call | | |
| Keycloak / identity owner | | |
| Legal / compliance (anything touching personal data, PRD 8.4) | | |
| Cloudflare, GitHub and storage account owners | | |

Alerts arrive in the Slack channel `AegisOps Alerts`. If you are reading this because of an alert, say in the channel that you have it, so nobody else starts the same work.

## 1. First ten minutes: decide, contain, preserve

1. **Say what you think is happening in one line** in the channel: what, since when, what you have not checked yet.
2. **Contain before you investigate** when data or credentials may be exposed (section 2). A short outage is cheaper than a leak.
3. **Preserve evidence before changing anything it describes:** export the audit log (Audit log page → Export CSV, which is itself recorded) and note the time. Container logs stay in
   Loki (Infrastructure → logs, or Grafana → Explore) for the retention period.
4. Do not delete containers, volumes, logs or the audit log. Stop and disable instead.

## 2. Pulling something offline fast

Pick the smallest action that stops the harm.

| Goal | How |
|---|---|
| Stop one application | Project page → environment → **Stop** (audited). Or `docker stop <aegis-project-env-container>`. |
| Stop it being reachable without touching the app | Remove its Nginx route and reload: `docker exec aegisops-nginx sh -c 'rm /etc/nginx/conf.d/managed/project-<slug>-<env>.conf && nginx -s reload'` (**tested**). The next deploy recreates it, so cordon or stop first. |
| Stop all new deployments | Infrastructure → **Cordon** the server (platform admin, typed name and reason). Every path honours it: dashboard, rollback, CI key, webhook. |
| Stop the whole platform from the internet | Pause the site in Cloudflare, or on the server `sudo ufw deny 443` (UFW already allows only 22/80/443). Undo with `sudo ufw allow 443`. |
| Stop one service of the platform | `docker compose stop <service>` (for example `web`, `api`, `deployer`). The data worker, deployer and API can each be stopped without losing data. |
| Stop a leaked CI key at once | Project page → API keys → **Revoke**. It stops working immediately. |

Never `docker compose down -v`: that deletes the database volumes.

## 3. A person's account is compromised, or they have left

1. **Easiest (platform admin): Users → find them → Disable.** It disables the account in Keycloak, ends their Keycloak sessions and makes the API refuse every token
   they hold, at once (not within a minute). *Sign out everywhere* does the sign-out without disabling, and *Reset password* gives a new temporary password and also ends
   their sessions. Each action is in the audit log (`admin.user.*`). You cannot disable yourself, and the last enabled platform admin cannot be disabled or demoted.
   If the Users screen is unavailable (Keycloak admin client not set up, or you are locked out), use the command line below.

   Command line (**tested**), from `infra/`:
   ```
   docker exec -it aegisops-keycloak sh
   /opt/keycloak/bin/kcadm.sh config credentials --server http://localhost:8080 --realm master --user "$KC_BOOTSTRAP_ADMIN_USERNAME" --password "$KC_BOOTSTRAP_ADMIN_PASSWORD"
   /opt/keycloak/bin/kcadm.sh get users -r aegisops -q username=<name> --fields id,username
   /opt/keycloak/bin/kcadm.sh update users/<id> -r aegisops -s enabled=false
   /opt/keycloak/bin/kcadm.sh create users/<id>/logout -r aegisops -s realm=aegisops
   ```
2. Keycloak reports the change in its log, and the API then refuses every token issued to that person before it: typically **within a minute** (a 30-second poll plus log
   shipping), not the 15 minutes a token would otherwise last. Check it worked: Audit log, filter *Who* by their username, action `auth.token_revoked`. If you cannot wait, stop
   `web` and `api` (section 2) or restart `api`, which also catches up on events it missed. The alert `AuthEventsNotCopied` means this path is not working: until it is fixed,
   assume a token lives its full 15 minutes.
3. **Revoke their API keys.** A key keeps working after its owner leaves: platform admin sees all keys under each project's page.
4. Remove them from projects (Members → Remove).
5. If they could read environment secrets or a database connection string, treat those as exposed and rotate them (section 4).
6. Review what they did: Audit log, filter **Who** by their username, export if needed.

## 4. A secret may have leaked: rotate it

The full inventory, with blast radius per secret, is in [secrets-review.md](secrets-review.md). The quick version:

| Secret | What to do |
|---|---|
| An application's environment secret (`DATABASE_URL`, API tokens) | Change it at its source, then enter the new value on the environment page and redeploy. |
| A provisioned database's password | `ALTER ROLE <role> PASSWORD '...'` in Postgres, update the `DATABASE_URL` secret, redeploy. The role is named on the database page. |
| `POSTGRES_SUPERUSER_PASSWORD`, `AEGISOPS_DB_PASSWORD`, `KEYCLOAK_DB_PASSWORD`, `AEGIS_BACKUP_DB_PASSWORD`, `AEGIS_PROVISIONER_DB_PASSWORD` | `ALTER ROLE ...` then update `infra/.env` and recreate the services that use it. |
| `AUTH_SECRET` | Change it and restart `web`. Everybody is signed out. |
| `KEYCLOAK_CLIENT_SECRET`, `GRAFANA_OAUTH_SECRET` | Change in Keycloak and `.env` together, restart the client. |
| `KEYCLOAK_ADMIN_CLIENT_SECRET` (the Users screen's service account) | **Treat a leak as a full compromise of every account**: it can create users, assign roles and reset passwords. Generate a new one (`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`), put it in `infra/.env`, run `bootstrap.sh add-admin-client` with it (this updates the client's secret), restart `api`. Then review `admin.user.*` in the audit log and the user list for accounts or roles nobody made. To switch the screen off entirely, disable the `aegisops-admin` client in Keycloak. |
| `GITHUB_WEBHOOK_SECRET`, the GitHub App private key | Rotate in the GitHub App settings and `.env` / `infra/secrets/github-app.pem` together; restart `api` and `deployer`. |
| `GHCR_TOKEN`, `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`, `ALERT_SLACK_WEBHOOK_URL` | Create a new one at the provider, update `.env`, restart the service, then delete the old one. For the Slack webhook, recreate the incoming webhook in Slack. |
| `BACKUP_ENCRYPTION_KEY` | A new key applies to new backups only. **Keep the old key** until the last backup made under it has aged out of retention. |
| `SECRETS_ENCRYPTION_KEY` | Changing it makes every stored environment secret unreadable: re-enter them all. Only rotate with a plan. |

After any rotation run `node infra/scripts/check-secrets.mjs` and confirm the stack is healthy on the dashboard. Update your off-server key copies if a key changed
(`node infra/scripts/export-keys.mjs --verify NAME` checks a copy).

## 5. Data loss or a damaged server

- **A database was damaged or deleted:** Databases → pick a backup → *Restore to a NEW database*, inspect it, then copy data across, or use the separate *Overwrite* step
  (platform admin; it takes a safety backup first).
- **The server or the AegisOps database is gone:** follow *Disaster recovery* in [phase5-data.md](phase5-data.md). You need the bucket credentials and `BACKUP_ENCRYPTION_KEY` from your
  off-server copy. Rehearsed on 2026-11-05: Keycloak and AegisOps restored from the bucket in 10 seconds (RTO 4 h, RPO 24 h). Restore Keycloak first, then AegisOps.

## 6. After the incident (within a week)

1. Write down the timeline from the audit log and Loki, what was exposed, and what was done. Keep the exported CSV with it.
2. Rotate anything that might have been seen, even if you think it was not.
3. Tell the people who must be told. Anything that touched personal or insurance data goes to legal/compliance first (PRD 8.4 leaves the regulatory regime open).
4. Fix the cause, and add the alert, test or control that would have caught it sooner.
5. Update this runbook where it was wrong or slow.
