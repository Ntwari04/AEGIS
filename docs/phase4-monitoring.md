# AegisOps: Phase 4, Monitoring & Observability

## What runs

| Service | Role | Reachable |
|---|---|---|
| `prometheus` | metrics, alert rules (15d retention) | internal only |
| `alertmanager` | routes alerts to Slack / email | internal only |
| `grafana` | dashboards + log search, SSO through Keycloak | `https://grafana.$DOMAIN` via Nginx |
| `loki` + `promtail` | log storage (14d) and shipping | internal only |
| `container-exporter` | container state, restarts, health, CPU, RAM | internal only |
| `node-exporter` | host memory and disk | internal only |
| `blackbox` | TLS certificate expiry of the Nginx listener | internal only |
| `docker-proxy` | **read-only** view of the Docker API for the exporter and Promtail | internal only |

Nothing here publishes a port; only Nginx does. `/metrics` is a hard 404 on every public host.

```
            ┌───────────── Prometheus ◄── api:/metrics (latency, errors, queue, deployments, expected containers)
 Dashboard ─┤   (rules)  ◄── container-exporter ◄── docker-proxy (GET only) ◄── docker.sock (ro)
 (AegisOps) │            ◄── node-exporter, keycloak:9000, blackbox (TLS expiry)
   API      └─► Alertmanager ──► Slack / email
 /monitoring/overview ──► Prometheus + Alertmanager + the AegisOps DB
 Grafana ◄── Prometheus, Loki, Alertmanager        Promtail ──► Loki (logs labelled project / environment)
```

## How a deployed app is monitored with no per-project config (FR-MON-2)

The Deployment Engine labels every container `aegisops.project` / `aegisops.environment`. The container exporter turns those labels
into metric labels (`project`, `environment`) and Promtail turns them into log labels. Deploy a new project and it appears in
Prometheus, Loki, the dashboard and the alert rules by itself.

The exporter and Promtail read **only containers on `aegisops-net`**, so other workloads on the same Docker host are never read or stored.

## Default alerts (FR-MON-3)

Rules live in `infra/monitoring/prometheus/rules/aegisops.rules.yml`; thresholds are config. Each is unit-tested in
`infra/monitoring/prometheus/tests/aegisops.rules.test.yml` (`promtool test rules`, also run in CI).

| Alert | Fires when |
|---|---|
| `ContainerDown` | a managed environment's container is stopped or gone for > 1 min (expected container comes from the database) |
| `PlatformContainerDown` | a platform container (postgres, redis, keycloak, api, web, nginx, deployer) is stopped or gone > 1 min |
| `ContainerRestarting` / `ContainerHighMemory` | restart loop; container above 90% of its memory limit |
| `HostMemoryHigh` / `DiskUsageHigh` | host memory > 90%, a filesystem > 85% |
| `CertificateExpiringSoon` / `TlsProbeFailing` | the TLS certificate expires within 14 days; the probe cannot connect |
| `RepeatedFailedLogins` | more than 5 failed Keycloak logins in 5 minutes |
| `DeploymentFailed` / `DeployQueueBacklog` / `ApiHighErrorRate` | a deployment failed or rolled back; deployments queued > 10 min; more than 5% 5xx |
| `ScrapeTargetDown` | a monitoring target is unreachable |
| `BackupFailed` / `BackupStale` | **Phase 5** publishes the backup metrics these read; until then they never fire |

## Notifications (FR-MON-4)

Set at least one in `infra/.env` (then `docker compose up -d alertmanager`):

- `ALERT_SLACK_WEBHOOK_URL`, or
- `ALERT_EMAIL_TO` + `ALERT_SMTP_HOST` (+ `ALERT_SMTP_PORT`, `ALERT_SMTP_USER`, `ALERT_SMTP_PASSWORD`, `ALERT_EMAIL_FROM`).

With neither set, alerts are still evaluated and shown on the dashboard and in Alertmanager; nothing is sent. Routing (grouping, repeat
interval, severity routes) is `infra/monitoring/alertmanager/alertmanager.base.yml`: change it and restart Alertmanager, no application deploy.
The webhook URL is written to a file at start-up and never appears in the rendered config.

## The AegisOps dashboard (FR-DASH-1..4)

`GET /api/v1/monitoring/overview` combines the database (projects, deployments), Prometheus (state, CPU, RAM, restarts) and Alertmanager (alerts).

- **Visibility:** members see their own projects only; platform_admin and auditor see all projects and the platform roll-up (FR-DASH-2).
  A user never receives alerts about a project they cannot see.
- **State** is computed for the container that *should* be running (the latest successful deployment), so a container that disappears is **Down**, not missing.
  If Prometheus is unreachable the state is **Unknown** (never a false "Up") and deployment status still shows.
- **Links (FR-DASH-4):** each environment links to its Grafana dashboard and to a Loki query for exactly that project and environment. Developers get no
  Grafana links because Grafana does not admit them.
- The page refreshes itself every 15 s.

## Grafana access

Single sign-on only (login form disabled). Roles: `platform_admin` → Admin, `devops_engineer` → Editor, `auditor` → Viewer. **Developers and anyone
without a role are refused**: Loki holds every project's logs, so project isolation means developers see their own project's health in the AegisOps
dashboard instead. A break-glass local admin exists (`GRAFANA_ADMIN_PASSWORD`) for CLI use only.

## Setup

1. `node infra/scripts/ensure-secrets.mjs` adds `GRAFANA_ADMIN_PASSWORD` and `GRAFANA_OAUTH_SECRET` to `infra/.env` if missing (prints no values).
2. Existing realm (created before Phase 4): register the Grafana client once.
   ```
   docker cp infra/keycloak/bootstrap.sh aegisops-keycloak:/tmp/bootstrap.sh
   docker exec aegisops-keycloak sh /tmp/bootstrap.sh add-grafana-client
   ```
   (The Keycloak container already receives `GRAFANA_ORIGIN` and `GRAFANA_OAUTH_SECRET` from compose.) A fresh install imports the client from the realm file.
3. `docker compose up -d`. Add the DNS record `grafana.$DOMAIN` (covered by the wildcard origin certificate).

Local development on Docker Desktop: use both compose files as in `docs/phase2-core-platform.md`; `grafana.localtest.me` resolves to 127.0.0.1.

## Verified live (2026-11-03)

- All 9 scrape targets up; container metrics carry `project` / `environment` from the engine's labels.
- Crash test: `docker stop` on a deployed container: the overview showed **Down within 21 s**; `ContainerDown` (critical) reached Alertmanager at **~113 s**
  (the rule waits one full minute); `docker start`: **Up within 24 s** and all alerts cleared within 46 s.
- 8 real failed Keycloak logins fired `RepeatedFailedLogins`.
- Public `/metrics` is 404 on `$DOMAIN`, `/api/v1/` and `grafana.$DOMAIN`; Grafana redirects to Keycloak (PKCE); Prometheus and Loki datasources healthy.

Findings fixed on the way: cAdvisor could not track containers on Docker Desktop's containerd image store (and needs `/`, `/sys`, `/var/lib/docker` mounted), so it was
replaced by the first-party exporter; a PromQL `unless`/`or` precedence bug made `PlatformContainerDown` fire for healthy containers (now guarded by promtool tests);
Keycloak reports failed logins as `event="login"` with an `error` label, not `login_error`; a new counter's first burst is invisible to `increase()` (handled).

**False alarm found 2026-11-06, fixed.** The "new counter" branch of `RepeatedFailedLogins` treated "no sample 5 minutes ago" as "the counter is new", so after the machine
(or Docker) slept, the running total of old failures (12) looked like a fresh burst and the alert fired four times in a morning with no failed login at all. The branch now also
requires that Keycloak was being scraped 5 minutes ago (`up` existed), and a promtool test reproduces the sleep gap (it fails against the old rule). On a laptop, expect gaps in all
metrics while it sleeps; on a server this does not happen.

## Known gaps

- Alertmanager delivery to Slack is connected and exercised (2026-11-05); email is not configured.
- Login success/failure events are counted and alerted, but not yet shown in the AegisOps audit view (FR-IAM-6); Keycloak's own logs are searchable in Loki.
- Per-project log access for developers inside AegisOps (Loki is Grafana-only for operators and auditors).
- The Grafana "Alertmanager" datasource health test reports an error on this Grafana version; the alert list panel works.
- Sizing: the monitoring stack needs roughly 1.5 GB RAM on top of the platform; revisit the droplet size before production (PRD §11).
