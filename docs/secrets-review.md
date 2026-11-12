# AegisOps: Secrets management review (PRD 8.3, Phase 5)

Run the audit any time. It never prints a secret, only names and verdicts:

```
node infra/scripts/check-secrets.mjs
```

It fails on a missing or placeholder secret, a weak or common value, the same value used for two secrets, an encryption key that is not a valid 32-byte key,
`infra/.env` (or the GitHub App key) tracked by git, and on a server (Linux) a `.env` readable by other users.

## Inventory

| Secret | Lives in | Read by | If it leaks | Rotation |
|---|---|---|---|---|
| `POSTGRES_SUPERUSER_PASSWORD` | `.env`, postgres container | postgres only | full database control | `ALTER ROLE postgres PASSWORD …`, update `.env`, restart postgres |
| `AEGISOPS_DB_PASSWORD`, `KEYCLOAK_DB_PASSWORD` | `.env` | api / deployer / data-worker, keycloak | that service's database | `ALTER ROLE …`, update `.env`, recreate services |
| `AEGIS_BACKUP_DB_PASSWORD` | `.env` | data-worker | read of every database | rerun `02-data-roles.sh` after changing `.env`, recreate data-worker |
| `AEGIS_PROVISIONER_DB_PASSWORD` | `.env` | data-worker | create roles/databases | as above |
| `BACKUP_ENCRYPTION_KEY` | `.env` + **a copy off the server** | data-worker | with the archives: every backup readable | see "Keys" below |
| `SECRETS_ENCRYPTION_KEY` | `.env` + **a copy off the server** | api (write), deployer + data-worker (read) | with the database: every environment secret readable | see "Keys" below |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | `.env` | data-worker | read/delete of the backup archives (still encrypted) | rotate in the provider, update `.env`, restart data-worker |
| `REDIS_PASSWORD` | `.env` | api, deployer, data-worker | queue tampering: could enqueue jobs | change in `.env`, recreate redis and its clients |
| `KEYCLOAK_ADMIN_CLIENT_SECRET` | `.env`, Keycloak (`aegisops-admin` client) | api | create users, assign any role, reset any password: **effectively every account** (Keycloak's `manage-users` can map any realm role; the API only ever offers the four platform roles, but the secret itself is not limited that way) | `bootstrap.sh add-admin-client`, update `.env`, restart `api` |
| `KEYCLOAK_CLIENT_SECRET`, `GRAFANA_OAUTH_SECRET` | `.env`, Keycloak | web / grafana, keycloak | impersonate that client | `bootstrap.sh` / Keycloak admin, update `.env` |
| `AUTH_SECRET` | `.env` | web | forge session cookies | change, restart web (signs everyone out) |
| `KC_BOOTSTRAP_ADMIN_*` | `.env` | keycloak | Keycloak admin | replace with `rotate-bootstrap-admin` (Phase 2 runbook), then remove |
| `GITHUB_WEBHOOK_SECRET` | `.env` + GitHub App | api | forge deployments (HMAC) | rotate in the App and `.env` together |
| GitHub App private key | `infra/secrets/github-app.pem` | api, deployer (read-only mount) | act as the App on its repositories | generate a new key in GitHub, replace the file, restart |
| `GHCR_TOKEN` | `.env` | deployer | read of private images | rotate PAT, update `.env` |
| `GRAFANA_ADMIN_PASSWORD` | `.env` | grafana (break-glass only; login form is off) | local Grafana admin | change, restart grafana |
| Environment secrets (app `DATABASE_URL` etc.) | Postgres, **AES-256-GCM** | deployer (decrypt at deploy) | that app's credentials | re-enter the value; provisioned DB: see Phase 5 doc |

Nothing above is in the repository: `.env`, `infra/secrets/` and `*.pem` are gitignored, CI runs gitleaks, and compose-invariant tests fail if a credential-like variable is a literal.

## Findings and what was done

| # | Finding | Action |
|---|---|---|
| 1 | An append to a `.env` without a trailing newline glued a new secret onto the previous line (this happened once and corrupted `GHCR_TOKEN`) | `ensure-secrets.mjs` writes each secret on its own line and never prints values; the audit script would have flagged the result |
| 2 | Nothing detected reused, weak or placeholder secrets | `check-secrets.mjs`, with tests |
| 3 | Backup encryption and environment-secret encryption use symmetric keys held on the server | Accepted for v1 (unattended drills). Risk and the alternative are below |
| 4 | The Docker socket is root-equivalent | Only the deployer (no port, no capabilities, read-only) and a **read-only** proxy mount it; tests enforce this |
| 5 | A provisioned application role could list other databases through `postgres` / `template1` | `PUBLIC` connect revoked on both; verified live |
| 6 | The Keycloak bootstrap admin lingers | Phase 2 runbook to replace it; still on your checklist |
| 7 | Secret values in container logs | Out of reach for the platform: an app that prints its own secrets will have them in Loki. Documented on the log page |

## Keys: custody and rotation

- **Keep an off-server copy of both encryption keys.** Losing `BACKUP_ENCRYPTION_KEY` makes every backup unreadable; losing `SECRETS_ENCRYPTION_KEY` makes every stored
  environment secret unreadable (re-enter them). A password manager is enough. `node infra/scripts/export-keys.mjs` helps: with no arguments it prints a fingerprint of each
  key (safe to write down), `--reveal` prints the keys in your own terminal only (it refuses to write to a pipe or file), and `--verify NAME` checks a pasted copy against the
  key in use without printing either. Verify each copy once after saving it.
- **Rotation is re-encryption:** secrets are bound to their environment and name, so a new key means re-entering each environment secret. For backups, a new key applies to NEW
  archives; keep the old key until the last archive written under it has aged out of retention, or you lose those.
- **Symmetric vs public-key backups:** with a symmetric key on the server, someone who takes over the server and reaches the bucket can read the backups. With a public key
  on the server and the private key held offline, they cannot, but unattended restore drills could not run. For a multi-tenant or regulated production, consider the public-key
  design and a manual quarterly drill.

## Before production launch (PRD 8.3: "before launch rather than after")

1. Run `node infra/scripts/check-secrets.mjs` on the server; fix every FAIL; `chmod 600 infra/.env`.
2. Keep off-server copies of `BACKUP_ENCRYPTION_KEY` and `SECRETS_ENCRYPTION_KEY`.
3. Replace the Keycloak bootstrap admin.
4. Use a bucket-scoped storage key, and enable the bucket's own versioning or object lock if you want protection against deletion by a compromised key.
5. Consider a real secrets manager (Infisical self-hosted, or Doppler) so secrets are not in a file on the host at all; the services read them only through `${VAR}` in compose, so that is a change in how `.env` is produced, not in the code.
6. Calendar: rotate the Keycloak client secrets and database passwords on a defined schedule, and at once on offboarding or suspected compromise (also revoke the person's CI API keys: a key keeps working after its creator leaves a project).
