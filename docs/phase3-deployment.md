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

## Secrets, the GitHub App and CI keys

**Environment secrets** (dashboard: project page → environment → Secrets, or `PUT /projects/:id/environments/:envId/secrets/:NAME`):
- Values are write-only, AES-256-GCM encrypted with `SECRETS_ENCRYPTION_KEY` (`openssl rand -base64 32`; add it to `infra/.env`, back it up, never commit it). They are decrypted only by the deployer and injected into the container; the deployment log says how many were injected, never names or values; the audit log records the actor and the name.
- Names are `UPPER_SNAKE_CASE`; `PORT` and `AEGIS_*` are reserved. Production secrets need devops_engineer / platform_admin. Changes apply at the next deployment.
- Without the key, secret storage is disabled and refuses writes (fails closed).

**GitHub App** (`GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID`, key at `infra/secrets/github-app.pem`, mounted read-only at `/run/secrets/aegis/github-app.pem`; on the droplet `chmod 640` it and make it readable by uid 1000):
- Linking a project to `owner/repo` is refused unless the App is installed on that repository.
- Each deployment appears in the repository's Deployments tab with its status, environment URL and a link to the log page. Needs the App's **Deployments: read & write** permission; if GitHub refuses, a warning is logged and the deploy is unaffected.

**CI API keys** (created through the API: `POST /projects/:id/api-keys` with scope `deployments:trigger`; there is no dashboard screen for keys yet): a CI job can call

```
curl -X POST https://$DOMAIN/api/v1/ci/deployments -H "X-API-Key: $AEGIS_KEY" -H "Idempotency-Key: $GITHUB_RUN_ID" \
  -H "Content-Type: application/json" -d '{"environment":"staging","commitSha":"<40-char sha>"}'
```

The key only works on this route, only for its own project, and **never for production**. Revoke it to stop it immediately.

## Known gaps

- "Target server" per environment: single host in v1.
- Deploys are serialized (concurrency 1). Fine for v1.
- The deployer holds the Docker socket (root-equivalent on the host). It is isolated: no ports, no HTTP, capabilities dropped, read-only filesystem, and the API never mounts it.
- An API key keeps working if its creator leaves the project; revoke keys when offboarding.
- A container's last output is stored in the deployment log on failure; if an app prints its own secrets, they would appear there.

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

### Verified live, second round: secrets, GitHub App, logs (2026-11-03)

- **Secrets:** set `DEMO_TOKEN` from the dashboard; the database holds only ciphertext, the deployer injected it into the running container
  (confirmed in the container environment), the deployment log says `injecting 1 secret environment variable(s)` and never the name or value,
  and the audit log records `secret.set` by the actor with the secret name only.
- **GitHub App:** the installation token works against the real API; a project can be linked only to a repository the installation covers
  (`octocat/Hello-World`, a public repo the App is not installed on, is refused, which a plain `GET /repos/...` check would have let through).
  A manual deploy appeared in the repository's Deployments as `aegisops-deploy[bot]`, `in_progress` then `success`, with the environment URL and a link
  to the deployment's log page in the dashboard.
- **Logs:** each deployment has its own page with the step log and failure reason.
- **Image builds:** the pnpm install step needs the npm registry; with a slow registry it can time out. The Dockerfiles use BuildKit cache
  mounts, so a retry resumes from what was already downloaded.
