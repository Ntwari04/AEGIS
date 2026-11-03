# AegisOps — Phase 3: Deployment Automation

## Flow

```
git push (main) ─► GitHub Actions "Build image" ─► ghcr.io/<owner>/<repo>:<sha>
                                   │ workflow_run completed/success
                                   ▼
        POST /api/v1/webhooks/github  (HMAC-verified, @Public, audited)
                                   │ one Deployment per environment tracking that branch (idempotent per delivery)
                                   ▼
                       BullMQ queue "deployments" (Redis)
                                   ▼
   deployer (only service with Docker access):
     pull ─► start new container ─► HEALTH GATE ─► write Nginx route ─► nginx -t + reload
          ─► verify route through Nginx ─► remove old container ─► SUCCESS
     any failure before the old container is removed ─► remove the new one ─► ROLLED_BACK (or FAILED if first deploy)
```

Why push alone does not deploy: the image does not exist until CI finishes, so the engine reacts to the
successful completion of the workflow named `GITHUB_DEPLOY_WORKFLOW` (default `Build image`).

## The rollback guarantee (FR-DEPLOY-5)

A broken container cannot be routed: the route file is not touched until the container has passed its
health check, and after the switch the route is verified end to end through Nginx. If `nginx -t`, the reload
or the verification fails, the previous route is restored. The old container is removed only after all of that.
This is tested against real Docker and a real Nginx (`apps/api/test/deploy.int.ts`).

## Operating it

- Environment settings: `branch`, `domain`, `containerPort`, `healthPath`, `imageRepo` (defaults to `ghcr.io/<githubRepo lowercased>`).
- Manual deploy: `POST /api/v1/projects/:id/environments/:envId/deployments {commitSha}` (header `Idempotency-Key` supported).
- Rollback: `POST .../deployments/:deploymentId/rollback` (target must be a SUCCESS deployment of the same environment).
- Production environments need `devops_engineer` or `platform_admin` (FR-DEPLOY-6). Auditors can read history only.
- Deployed containers run with `no-new-privileges`, all capabilities dropped, labels `aegisops.*` for Phase 4 discovery.

## Setup

1. GitHub App: Contents:read, Metadata:read, Deployments:read+write, Commit statuses:read+write; event **Workflow run**;
   webhook URL `https://$DOMAIN/api/v1/webhooks/github`; secret = `GITHUB_WEBHOOK_SECRET`.
2. Private key at `infra/secrets/github-app.pem` (gitignored, never committed).
3. GHCR: make the image package public, or set `GHCR_USERNAME` / `GHCR_TOKEN` (PAT with `read:packages`; GHCR does not accept GitHub App tokens).
4. On the droplet: `sudo chown 1000:1000 infra/nginx/conf.d/managed`, set `DOCKER_GID`, then `docker compose up -d --build deployer`.

## Known gaps

- Per-environment secret values (env vars for deployed apps) are not injected yet; only `PORT` and `AEGIS_*` are. Phase 5 secrets work.
- Deploys are serialized (concurrency 1). Fine for v1.
- The GitHub App key is not used yet (reserved for commit-status reporting); webhook auth is HMAC only.
- Deployer holds the Docker socket (root-equivalent on the host). It is isolated: no ports, no HTTP, capabilities dropped, API never mounts it.

## Verified live (local stack, 2026-11-03)

Real GitHub push → GitHub Actions `Build image` → GHCR → `workflow_run` webhook through a temporary
Cloudflare quick tunnel → deployer → health-gated swap behind Nginx over HTTPS:

| Commit | Result |
|---|---|
| good build | `SUCCESS`; `https://staging.<domain>/healthz` 200 and served the exact commit |
| `health.flag = broken` | `ROLLED_BACK` (`/healthz did not return 2xx in time`); the previous version kept serving throughout, the broken container was never routed; audited |
| flag restored | `SUCCESS`; old container removed after the new one was routed |

Findings fixed while doing it:
- **Nginx default server:** without an explicit `default_server`, the first managed project route became the default for unknown
  Hosts, so a request with an unrecognised Host was proxied to a project container. The template now has a catch-all that drops them (`return 444`).
- **Docker Desktop socket:** the socket is `root:root` there, so the local override adds group 0 to the deployer (`docker-compose.local-https.yml`). On a
  Linux droplet set `DOCKER_GID` to the socket's gid instead.
- **Tunnel Host header:** a tunnel must present the dashboard host (`cloudflared ... --http-host-header <DOMAIN>`), otherwise Nginx drops the webhook.
  On the droplet GitHub posts to `https://$DOMAIN/...`, so this only affects local testing.
