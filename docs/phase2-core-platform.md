# AegisOps — Phase 2: Core Platform

What Phase 2 adds on top of the Phase 1 foundation: Postgres, Redis, Keycloak, the NestJS API,
the Next.js dashboard, Identity & Access (PRD 6.1) and Project Management (PRD 6.3).

## Layout

| Path | What |
|---|---|
| `apps/api` | NestJS API (`/api/v1`), Prisma schema + migrations, unit + integration tests |
| `apps/web` | Next.js dashboard (Auth.js → Keycloak, OIDC code + PKCE) |
| `packages/shared-types` | Roles and DTO types shared by api and web |
| `e2e` | Playwright tests (real browser, real Keycloak) |
| `infra/` | Compose services, realm file, Nginx template, Postgres init |

## First-time setup (droplet)

```bash
cd infra
cp .env.example .env && chmod 600 .env     # fill every CHANGE_ME with: openssl rand -base64 36 | tr -d '/+=' | cut -c1-40
docker compose up -d postgres redis keycloak
docker compose --profile tools run --rm migrate          # explicit migration step (never "sync on boot")
docker compose up -d --build api web nginx
```

Keycloak imports `infra/keycloak/realm-aegisops.json` on first start (empty DB). The realm,
roles, the MFA flow and the OIDC client are code; to rebuild from scratch drop the `keycloak`
database and restart the container (see the header of `infra/keycloak/bootstrap.sh`).

Then create the first admin and retire the bootstrap admin:

```bash
docker cp keycloak/bootstrap.sh aegisops-keycloak:/tmp/bootstrap.sh
docker exec -e INITIAL_ADMIN_USERNAME=you -e INITIAL_ADMIN_EMAIL=you@yourcompany.com \
  -e INITIAL_ADMIN_PASSWORD='a-temporary-12+-char-password' \
  aegisops-keycloak sh /tmp/bootstrap.sh create-admin
```

At first login that user must change the password and enrol TOTP (mandatory for `platform_admin`
and `devops_engineer`).

### Rotate the bootstrap admin

Keycloak's `KC_BOOTSTRAP_ADMIN_*` account is temporary by design:

```bash
docker exec -e MASTER_ADMIN_USERNAME=you-admin -e MASTER_ADMIN_PASSWORD='a-long-random-password' \
  aegisops-keycloak sh /tmp/bootstrap.sh rotate-bootstrap-admin
```

The Keycloak admin console is **not** routed by Nginx (`/admin` and `/realms/master` return 404 on
`auth.$DOMAIN`). Administer it with `kcadm` through `docker exec`, or temporarily from the dev override.

### DNS / TLS

Keycloak is served at `https://auth.$DOMAIN`. Add a proxied Cloudflare A record for `auth` (same IP).
The Phase 1 Origin Certificate already covers `*.$DOMAIN`. `DOMAIN` in `infra/.env` is still the only
place the domain is configured.

## Local development

```bash
cd infra && cp .env.example .env   # fill values; DOMAIN can stay example.com locally
docker network create aegisops-net
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres redis keycloak
```

`docker-compose.dev.yml` publishes Postgres (15432), Redis (16379) and Keycloak (18080) on
**127.0.0.1 only**, using non-default ports so they do not collide with other local stacks. Never use
it on the droplet. Then copy `apps/api/.env.example` → `apps/api/.env` and `apps/web/.env.example` →
`apps/web/.env.local`, run `pnpm --filter @aegisops/api exec prisma migrate deploy`, build and start the API
(`pnpm --filter @aegisops/api build && node --env-file=.env dist/main.js`) and the web app
(`pnpm --filter @aegisops/web dev`, port 13000).

## Tests

| Command | What it proves |
|---|---|
| `pnpm --filter @aegisops/api test` | Guard unit tests, "every route declares authorization" rule, audit redaction, env validation, compose/Dockerfile security invariants |
| `pnpm --filter @aegisops/api test:integration` | Real Postgres (migrations applied) + real Keycloak (the production realm file): forged/`alg=none` tokens rejected, RBAC + project isolation, developer cross-project attempts audited, auditor read-only, API key hashing, audit-log immutability (DB trigger) |
| `pnpm --filter @aegisops/e2e test` | Real browser: redirect to Keycloak → forced TOTP enrolment → authenticated → create a project. Needs the dev stack running plus `E2E_KC_ADMIN_USER` / `E2E_KC_ADMIN_PASSWORD` (the bootstrap admin, local only) |

## Security self-check (Phase 2)

- [x] Every route has `@Roles(...)` or `@Public()`; a route with neither is rejected at runtime *and* fails a unit test. Routes with `:projectId` must also declare `@ProjectAccess(...)`.
- [x] No secrets in committed files; `.env` gitignored; `.env.example` placeholders only (enforced by a test).
- [x] Postgres/Redis/Keycloak/api/web are not port-published (enforced by a test); Nginx is the only published service.
- [x] DTO validation with `whitelist` + `forbidNonWhitelisted`; Prisma only, no string-built SQL.
- [x] Secrets are redacted from audit metadata; API-key plaintext is shown once and stored only as SHA-256 (tested).
- [x] Auth failures, role denials, project-access denials, and project/member/environment/API-key mutations write audit entries; the table is append-only via DB trigger (tested).
- [x] Global rate limit (120 req/min/IP) and Nginx `limit_req` on `/api/v1/`.
- [x] CI: `pnpm audit --audit-level=high`, gitleaks, Trivy (HIGH/CRITICAL fails) on built images, Dependabot.
- [x] Containers run as the non-root `node` user; api/web root filesystems are read-only.
- [ ] Deployment rollback guarantee — Phase 3.

## Known gaps / follow-ups

See "Implementation notes" at the end of `docs/PRD.md` for deviations from the spec.

## Running the whole stack locally (HTTPS on localtest.me)

```
cd infra
docker compose -f docker-compose.yml -f docker-compose.local-https.yml up -d
```

`docker-compose.local-https.yml` is local-only: it disables Node TLS verification and routes `auth.$DOMAIN`
to the host for the web container, because the local Nginx cert is self-signed. It is never used on the droplet.
