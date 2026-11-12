# AegisOps — Product Requirements Document

| | |
|---|---|
| **Status** | Draft v1.0 |
| **Author** | Ntwari Enock, with Claude |
| **Date** | November 3, 2026 |
| **Owner org** | (the operating organization) |
| **Related docs** | `AegisOps_Stakeholder_Review_v1.1.docx` (vision/business case) · `docs/phase1-infrastructure-setup.md` (infrastructure foundation, already built) |

This PRD turns the AegisOps Stakeholder Proposal into a buildable specification. The proposal established *why* AegisOps should exist and the cost envelope; this document defines *what* gets built, in what order, and — because this platform will sit in front of operationally and potentially customer-sensitive systems — *how it stays secure*.

I'm flagging up front: this PRD makes several concrete technology choices (Node.js/TypeScript, self-hosted Keycloak, a specific data model) that the proposal left open. Those were decided with you in this session rather than being facts about an existing system — treat the rest of this document as a specification to review and adjust, not as a description of something already built.

---

## 1. Purpose & Background

The organization currently has no single system for deploying, monitoring, and governing its infrastructure and applications. AegisOps centralizes that: one dashboard to deploy, observe, and manage every digital product the company runs, built entirely on open-source, self-hostable components to keep licensing cost at zero and keep the organization in control of its own operational data.

Phase 1 (Infrastructure Foundation) is already built: a hardened DigitalOcean droplet, Cloudflare in front of it, Docker, and an Nginx reverse proxy. This PRD covers everything that runs on top of that foundation — the AegisOps application itself.

## 2. Goals

- **G1 — One pane of glass.** A single authenticated dashboard surfaces the health, deployments, and logs of every hosted application.
- **G2 — Self-service deploys.** An authorized engineer can take a GitHub repo to a running, monitored, HTTPS-served container without hand-editing server config.
- **G3 — Operational safety.** Nothing in the platform can silently lose data, leak a credential, or let an unauthorized party touch production.
- **G4 — Low operating cost.** Stay on self-hosted, open-source components; avoid recurring per-seat SaaS licensing wherever a credible open-source alternative exists.
- **G5 — Auditability.** Every privileged action (deploy, config change, user/role change, backup restore) is attributable to a person and timestamped.

## 3. Non-Goals (v1)

- Multi-region / multi-cloud failover. v1 targets a single DigitalOcean region; the architecture shouldn't *preclude* multi-region later, but it isn't a v1 requirement.
- Billing/cost-allocation reporting across hosted products.
- A public plugin/extension marketplace for third parties.
- Supporting Kubernetes. v1 is Docker + Docker Compose on one or a small fixed set of droplets; a K8s backend is a plausible Phase 6+ direction, not in scope here.
- Building a general-purpose PaaS for arbitrary customers — AegisOps is an internal tool for the operating organization's own products.

## 4. Users & Personas

| Persona | Needs |
|---|---|
| **Platform Admin** | Full control: manage users/roles, servers, global settings, billing-relevant config. Small group (1–3 people). |
| **DevOps / Infra Engineer** | Deploys and manages applications, servers, databases, backups. Primary daily user. |
| **Developer** | Needs to see the status/logs/metrics of their own project, trigger deploys to non-prod environments, but shouldn't touch infrastructure or other teams' projects. |
| **Read-only / Auditor** | Needs visibility into deployments, audit logs, and alerts without the ability to change anything — e.g. for a compliance review. |

Every functional requirement below is scoped to one or more of these roles; Section 8 (Security) defines how that scoping is enforced.

## 5. System Overview & Architecture

### 5.1 Layer model (from the proposal, with the app layer now specified)

| Layer | Technology | Status |
|---|---|---|
| Edge Network | Cloudflare | Built (Phase 1) |
| Cloud Infrastructure | DigitalOcean droplet | Built (Phase 1) |
| Reverse Proxy | Nginx (Docker) | Built (Phase 1) |
| **Identity Provider** | **Keycloak (self-hosted)** | **New — this PRD** |
| **Application** | **Node.js/TypeScript: NestJS API + Next.js dashboard** | **New — this PRD** |
| Containers | Docker / Docker Compose | Built (Phase 1), extended here |
| Database | PostgreSQL | New — this PRD |
| Cache / Queue | Redis | New — this PRD |
| Monitoring | Prometheus + Grafana | New — this PRD |
| Logging | Loki + Promtail | New — this PRD |
| CI/CD | GitHub Actions | New — this PRD |

### 5.2 Why these choices

- **NestJS over a lighter framework**: the module boundaries in Section 6 (Identity, Projects, Deployments, Infra, DB, Monitoring, Backup) map directly onto NestJS modules, and its built-in dependency injection, guards (authz), and interceptors (audit logging) give us the security hooks Section 8 needs almost for free, rather than bolting them on later.
- **Next.js for the dashboard**: server-side rendering for the initial authenticated page load (avoids a flash of unauthenticated content), file-based routing matches the module list, and it shares the TypeScript types/DTOs with the NestJS API in the same monorepo.
- **Keycloak over custom auth**: per your call in this session — it is open source and self-hostable (keeping with G4), and it owns the hardest, highest-consequence security code (password hashing, MFA, session/token lifecycle, brute-force lockout) so AegisOps's own code only has to do RBAC and audit logging on top of tokens Keycloak already validated. This trades "one more container to operate" for "we are not the ones who wrote the login form's crypto," which is the right trade for a system that will likely front insurance-related data.
- **Postgres as system-of-record, Redis as cache/queue**: matches the proposal's existing stack choices; Redis also backs the job queue for long-running operations (deployments, backups) so the API never blocks a request on a multi-minute operation.
- **Prometheus/Grafana/Loki**: unchanged from the proposal; this PRD specifies what AegisOps needs to *expose* to them (Section 6.6) and what dashboards/alerts ship by default (Section 6.6.3).

### 5.3 Repository layout (monorepo)

```
AegisOps/
├── docs/                      # PRD, setup guides (this repo already has docs/)
├── infra/                     # Phase 1 — already built: compose, nginx, scripts
│   ├── docker-compose.yml     # extended in this PRD with app, db, cache, keycloak, monitoring services
│   └── ...
├── apps/
│   ├── api/                   # NestJS backend
│   └── web/                   # Next.js dashboard
├── packages/
│   ├── shared-types/          # DTOs/interfaces shared between api and web
│   └── config/                # shared eslint/tsconfig/etc.
├── .github/workflows/         # CI/CD pipelines
└── package.json               # npm/pnpm workspaces root
```

## 6. Functional Requirements by Module

Requirement IDs are `FR-<module>-<n>` for traceability into tickets and tests.

### 6.1 Identity & Access

- **FR-IAM-1**: Users authenticate via Keycloak (OIDC/OAuth2 Authorization Code + PKCE flow); AegisOps itself never sees or stores a password.
- **FR-IAM-2**: MFA (TOTP) is enforced in Keycloak for every account with the Platform Admin or DevOps Engineer role. Required, not optional, for those roles.
- **FR-IAM-3**: Roles are: `platform_admin`, `devops_engineer`, `developer`, `auditor`. Role assignment happens in Keycloak; AegisOps reads the role claim from the validated JWT on every request.
- **FR-IAM-4**: Project-level permissions (a Developer only sees their own project(s)) are enforced in AegisOps's own database via a `project_members` join table — Keycloak handles *who you are and what role you hold*, AegisOps handles *which projects you may touch*.
- **FR-IAM-5**: API keys: a Developer or DevOps Engineer can generate a scoped, named, revocable API key (e.g. for CI to call the Deployment Engine). Keys are hashed at rest (never stored or displayed in plaintext after creation) and scoped to specific projects + actions.
- **FR-IAM-6**: Every authentication event (login success/failure, MFA challenge, API key use) and every authorization decision that denies access is written to the audit log (Section 6.7).
- **FR-IAM-7**: Session/JWT lifetime is short (access token ≤ 15 min, refresh token ≤ 8 hr, sliding), with server-side revocation on logout or role change.

### 6.2 Executive Dashboard

- **FR-DASH-1**: Landing page (post-login) shows, per project the user has access to: current deployment status, container health (up/down/restarting), CPU/RAM/storage at a glance, and open alert count.
- **FR-DASH-2**: A platform-wide summary view (Platform Admin / Auditor only) rolls the same metrics up across all projects and all servers.
- **FR-DASH-3**: Dashboard data is read from Prometheus (metrics) and the AegisOps DB (deployment/project state) — the dashboard itself does not re-implement metrics collection.
- **FR-DASH-4**: Alerts surfaced on the dashboard link through to the relevant Grafana panel or Loki log query, not just a bare notification.

### 6.3 Project Management

- **FR-PROJ-1**: A Project groups one GitHub repository, its environments (e.g. `staging`, `production`), its assigned servers/containers, and its members.
- **FR-PROJ-2**: Creating a project links a GitHub repo via a GitHub App installation (not a personal access token) scoped to that repo only.
- **FR-PROJ-3**: Each environment has its own config: target server, container resource limits, environment variables (secrets handled per FR-SEC-5), and domain/subdomain.
- **FR-PROJ-4**: Project membership (who can see/deploy to this project) is managed by a Platform Admin or the project's own DevOps Engineer owner.

### 6.4 Deployment Engine

- **FR-DEPLOY-1**: A deployment is triggered by a GitHub Actions webhook (on push/merge to a configured branch) or manually from the dashboard by an authorized user.
- **FR-DEPLOY-2**: Deployment steps: pull the built image (from GitHub Container Registry, built by the project's own CI), stop the old container, start the new one with health-check gating, update the Nginx route (reusing the Phase-1 reverse-proxy template mechanism), tear down the old container only after the new one passes its health check.
- **FR-DEPLOY-3**: Every deployment is a recorded entity: who triggered it, source commit SHA, start/end time, resulting status (success/failed/rolled back), and a link to its logs.
- **FR-DEPLOY-4**: One-click rollback to any previous successful deployment of that environment.
- **FR-DEPLOY-5**: A failed health check automatically rolls back and never leaves an environment pointed at a broken container.
- **FR-DEPLOY-6**: Deployments to a `production`-flagged environment require the triggering user to hold `devops_engineer` or `platform_admin` — a `developer` can deploy to non-production environments only.

### 6.5 Infrastructure Management

- **FR-INFRA-1**: Register/view servers (initially the one Phase-1 droplet; architecture allows more) with their role, IP, resource capacity, and installed services.
- **FR-INFRA-2**: Container-level controls (start/stop/restart, view resource usage, view live logs) for containers the user's role/project membership entitles them to see.
- **FR-INFRA-3**: Multi-server actions (e.g. "drain and cordon this server") are Platform-Admin-only and require a confirmation step plus a typed reason that is recorded to the audit log.

### 6.6 Database Management

- **FR-DB-1**: Provision a new PostgreSQL database (and least-privileged app user) for a project/environment from the dashboard, instead of a human running SQL by hand.
- **FR-DB-2**: Scheduled automated backups per database (Section 6.8 covers the shared backup/recovery requirements in detail).
- **FR-DB-3**: A DevOps Engineer can trigger an on-demand backup and view backup history/size/status for databases their role covers.
- **FR-DB-6**: Password rotation: a platform admin or the project's DevOps engineer can rotate a provisioned role's password from the dashboard (recorded reason). The new password is proven to log in before the environment's connection string is replaced, and the old one is put back if that fails; the application must be redeployed to use it.
- **FR-DB-5**: Deprovisioning: a platform admin can remove a provisioned database and its role from the dashboard (typed name and a recorded reason). A final backup is taken first and nothing is dropped if it fails; the environment's connection-string secret is deleted if it still points there; its backups stay restorable into a new database for 90 days and then all expire.
- **FR-DB-4**: Restore-to-new-database (never an in-place destructive restore over a live database without an explicit, separately-confirmed "overwrite" step).

### 6.6.1 Monitoring & Logs — what AegisOps exposes

- **FR-MON-1**: The API exposes a `/metrics` endpoint (Prometheus format) with request latency/error-rate, job queue depth, and deployment counters.
- **FR-MON-2**: Every container launched by the Deployment Engine is labeled so Prometheus/cAdvisor and Promtail auto-discover it without manual config.
- **FR-MON-3**: Default alert rules ship with the platform (not left for the operator to invent from scratch): container down > 1 min, disk > 85%, memory > 90%, HTTPS certificate expiring within 14 days, repeated failed login attempts (ties into Section 8), backup job failed.
- **FR-MON-4**: Alertmanager routes default to a single notification channel configured at install time (e.g. Slack webhook or email); routing rules are config, not code, so they can change without a deploy.

### 6.7 Backup & Recovery

- **FR-BACKUP-1**: Nightly automated backups of: every provisioned Postgres database, the AegisOps system database itself, and Keycloak's realm configuration/export.
- **FR-BACKUP-2**: Backups are encrypted at rest and shipped off the source droplet (object storage — e.g. DigitalOcean Spaces — not just a second disk on the same machine).
- **FR-BACKUP-3**: Retention: daily backups kept 14 days, weekly kept 8 weeks, monthly kept 12 months (tune with the business once real storage cost is known — flagging this as a default, not a fixed requirement).
- **FR-BACKUP-4**: A documented, *tested* restore procedure exists and is actually run (to a non-production target) on a recurring schedule — an untested backup is not a backup. This should be a calendar reminder/runbook item, not just a feature.
- **FR-BACKUP-5**: Backup job success/failure is itself a monitored metric (ties to FR-MON-3).

### 6.8 Audit Log (cross-cutting, referenced by every module above)

- **FR-AUDIT-1**: Every create/update/delete of a security-relevant entity (users, roles, API keys, projects, environments, deployments, server actions, backup/restore operations) is written as an immutable audit event: actor, action, target, timestamp, source IP, result (success/denied/error).
- **FR-AUDIT-2**: Audit log is append-only at the application layer (no UPDATE/DELETE exposed through the API) and retained at minimum 1 year, independent of the general data-retention policy for operational tables.
- **FR-AUDIT-3**: Auditors can search/filter/export the audit log (read-only) without needing any other elevated permission.

### 6.9 Interface (added after Phase 5, from reviewing every screen)

The PRD said nothing about the interface beyond the dashboard requirements above and the 2-second load target, so these are stated here, with where each stands today. **Met** items have an automated browser test (see [e2e.md](e2e.md)).

| ID | Requirement | Status |
|---|---|---|
| **FR-UX-1** | Every screen is usable on a phone (390 px wide): nothing scrolls sideways, and a table row keeps its important cells on screen. | Met |
| **FR-UX-2** | A time is never ambiguous: month spelled out, zone named, the exact UTC instant available. | Met |
| **FR-UX-3** | A page that updates itself never discards what someone is typing or has unfolded. | Met |
| **FR-UX-4** | A missing page, a page the person may not see, or a failure shows a page in the app's style with a way back, and never the error's text (it can name internals). | Met |
| **FR-UX-5** | A refused form comes back filled in; a secret shown once (an API key) is shown once and nowhere else. | Met |
| **FR-UX-6** | Every alert on the dashboard leads to the relevant Grafana panel and to the logs (the in-app log page for people who cannot open Grafana): FR-DASH-4. | Met (checked against a live alert) |
| **FR-UX-7** | Accessibility: operable by keyboard, labelled controls, sufficient contrast; target WCAG 2.1 AA. | **Partly met**: an automated WCAG 2.1 A/AA scan (axe-core) of every dashboard screen, both themes, desktop and phone, with folds opened, now passes and runs as an E2E test (`03-accessibility`). The first scan found failing contrast on filled buttons (white on the blue, 3.2:1) and on the tinted status pills (down to 3.95:1), and five table headers with no text for a screen reader; all fixed (text colours tuned per theme, headers labelled). Added a skip link, a named navigation landmark and a visible focus ring. **Not done:** a manual walkthrough with a screen reader, a keyboard-only pass of every form, and Keycloak's own sign-in pages (stock theme, not scanned). Automated rules find only part of the problems |
| **FR-UX-8** | Both colour themes (light and dark, following the system setting) are reviewed. | **Partly met**: after the sidebar restyle the Projects, Infrastructure, Backups and Audit screens were rendered in both themes at 1280 px and 380 px (no sideways scroll, fonts loaded, no policy violations) and Projects and Backups were looked at. Contrast in both themes is now checked by the automated scan (see FR-UX-7); most screens have still not been looked at by a person in both themes |
| **FR-UX-9** | Language: English only in v1. | Accepted limit |

Gaps against the requirements and personas above, found in the same review and **not** fixed:
- **FR-DASH-1** (storage) is now met: the container exporter reports `aegisops_container_disk_bytes` (Docker's writable-layer size, measured at most every 5 minutes per container) and the Projects page shows it as a Storage column per environment. It counts what the container wrote to its own filesystem, not the image and not named volumes; volume use per project is not reported.
- **Platform Admin persona** ("manage users and roles") is now met by **Users** in the menu (`/admin/users`, platform admins only; see "Users and roles screen" in section 16). The command-line steps in [incident-response.md](incident-response.md) remain as the fallback.

## 7. Non-Functional Requirements

| Category | Requirement |
|---|---|
| Performance | Dashboard initial load < 2s on a warm cache; API p95 latency < 300ms for read endpoints under normal load. |
| Scalability | v1 targets dozens of projects / low hundreds of containers on a small number of droplets — not designed for thousands of tenants. |
| Availability | Single-region, single-droplet v1: a documented RTO/RPO (e.g. RTO ≤ 4 hr, RPO ≤ 24 hr) is more honest here than an uptime SLA you can't yet back with redundant infrastructure. State this plainly to stakeholders. |
| Observability | Every service (API, web, Postgres, Redis, Keycloak, Nginx) ships metrics and structured logs; "it broke and we don't know why" should not be possible for a v1 incident. |
| Maintainability | All infra and app config is code (Docker Compose, Terraform/doctl scripts, DB migrations) — no manual, undocumented server changes ("ClickOps"). |
| Cost | The proposal's ~$25–30/month figure covered Phase 1 only. Adding Postgres, Redis, Keycloak, Prometheus/Grafana/Loki, and the app itself will need more droplet RAM/CPU than Phase 1 budgeted — recompute and re-approve the budget once the full stack's resource footprint is known, rather than assuming the original number still holds. |

## 8. Security Requirements

This section is the one you asked not to skip, so it's deliberately the most detailed. I'm structuring it as control families; each maps to specific implementation work for Claude Code to pick up, and several overlap with the functional requirements above (cross-referenced).

### 8.1 Authentication & session security
- OIDC via Keycloak only; no parallel local password store in the AegisOps app (FR-IAM-1).
- MFA mandatory for privileged roles (FR-IAM-2); recommended (prompted, not forced) for `developer`.
- Short-lived access tokens, server-side refresh-token revocation list, and forced re-auth on role change (FR-IAM-7).
- Account lockout / exponential backoff on repeated failed logins, configured in Keycloak; failed attempts feed the monitoring alert in FR-MON-3.

### 8.2 Authorization
- Enforce RBAC + project-scoped ABAC at the API layer via NestJS guards — **never** in the frontend alone. The Next.js app hiding a button is UX, not security; every mutating endpoint re-checks role and project membership server-side.
- Default-deny: a route with no explicit guard should fail closed, not open. Add a lint/test rule that fails CI if a new controller method lacks an authorization guard.
- Principle of least privilege for the database roles AegisOps itself creates (FR-DB-1): app users get only the grants their service needs, never superuser.

### 8.3 Secrets management
- No secret (DB password, API token, Keycloak client secret, backup-storage credentials) is ever committed to the repository. `.env` files are gitignored (the Phase-1 `infra/.gitignore` already does this for the proxy; extend the same pattern to the app).
- Secrets are injected at deploy time via environment variables sourced from a secrets store (at minimum: Docker Compose `.env` files restricted with filesystem permissions on the droplet; consider a real secrets manager — e.g. Infisical or Doppler, both have free self-hostable/OSS tiers — before production launch rather than after).
- Rotate the Keycloak client secret, DB passwords, and any API keys on a defined schedule and immediately on suspected compromise or offboarding.
- Pre-commit/CI secret-scanning (e.g. gitleaks) blocks a push that contains anything that looks like a credential.

### 8.4 Data protection
- TLS everywhere in transit: already enforced edge-to-origin by Phase 1 (Cloudflare Full-strict + Nginx origin cert); extend the same expectation to service-to-service traffic that leaves the Docker network (it doesn't need to for this architecture, since Postgres/Redis/Keycloak all stay on the internal `aegisops-net` and are never port-published to the host — keep it that way).
- Encryption at rest for the Postgres data volume and for backup archives (FR-BACKUP-2).
- PII/sensitive-field handling: if any hosted project's data AegisOps touches includes personal or insurance-related data, treat that data with field-level care (don't log it, don't include it in error messages or audit-log "before/after" diffs) — I don't have enough information about which specific regulatory regimes apply (likely a mix depending on which countries the organization's client base sits in) to assert a specific compliance framework here; have this reviewed by whoever owns legal/compliance before launch, rather than assuming general good practice is sufficient.

### 8.5 Application security (OWASP-aligned)
- Input validation on every API boundary (NestJS `class-validator` DTOs) — reject, don't sanitize-and-hope.
- Parameterized queries / ORM only (e.g. Prisma or TypeORM) — no string-concatenated SQL anywhere, including ad hoc admin scripts.
- CSRF protection on any cookie-authenticated, state-changing route (the OIDC flow's session cookie); CORS locked to the known dashboard origin(s), not `*`.
- Rate limiting on auth endpoints and on the public-facing API generally (e.g. `@nestjs/throttler`), independent of Keycloak's own lockout.
- Security headers (HSTS, X-Content-Type-Options, X-Frame-Options, a real Content-Security-Policy) set by the app and/or Nginx — Phase 1's Nginx template already sets the first three; add CSP once the dashboard's script/style origins are finalized.
- Dependency scanning in CI (`npm audit` / GitHub Dependabot or Renovate) with a policy of not ignoring high/critical findings silently.

### 8.6 Container & supply-chain security
- Pin base image versions by tag *and*, where feasible, digest; don't float on `latest` for anything that touches production (Phase 1's `nginx:stable-alpine` is a reasonable default — revisit if stricter pinning is wanted).
- Run application containers as a non-root user; mount filesystems read-only where the service allows it.
- Scan built images for known CVEs in CI (e.g. Trivy) before a deploy is allowed to proceed.
- The shared `aegisops-net` Docker network (already created in Phase 1) keeps Postgres/Redis/Keycloak off the public internet entirely — only Nginx is port-published. Keep new services following this same pattern by default.

### 8.7 Network & host security
- Already delivered in Phase 1: UFW allowing only 22/80/443, fail2ban, SSH key-only auth, unattended security upgrades. This PRD's job is to not regress any of that while adding services — e.g. a new service must never request a new inbound port without a documented reason.
- Database/cache/IdP ports are never exposed to the host's public interface, only to the internal Docker network (8.6).

### 8.8 Audit & monitoring (security-relevant)
- FR-AUDIT-1–3 above are the backbone of this. In addition: failed authorization attempts, not just failed authentication, are logged and alertable (a user repeatedly trying to access a project they're not a member of is itself a signal worth seeing).
- Log retention and access to the audit log itself is restricted — an Auditor can read it, nobody can edit it (FR-AUDIT-2).

### 8.9 Incident response (minimum viable)
- A short runbook (who to contact, how to rotate a compromised credential, how to pull a service offline fast via the existing UFW/Nginx controls) should exist before go-live — this is a documentation deliverable, not a code deliverable, but it's listed here because "we'll figure it out during the incident" is not a security control.

## 9. Data Model (high level)

Core entities: `User` (mirrors Keycloak subject, not the password), `Role`, `Project`, `ProjectMember`, `Environment`, `Server`, `Container`, `Deployment`, `Database` (the provisioned-database metadata, not Postgres itself), `BackupJob`, `ApiKey`, `AuditLogEntry`, `AlertRule`. Exact schema/migrations are an implementation detail for Claude Code to produce against these entities and the functional requirements above, not fixed here.

## 10. API Design Principles

- REST, versioned from day one (`/api/v1/...`) even though there's only one version today — retrofitting versioning later is far more painful than starting with it.
- OpenAPI spec generated from the NestJS decorators (e.g. `@nestjs/swagger`), published at a (non-public, authenticated) `/api/docs` route.
- Consistent error shape (`{ error: { code, message, details? } }`) and consistent pagination (`?page=&pageSize=`, response includes `total`).
- Idempotency keys accepted on deployment-trigger endpoints so a retried webhook can't double-deploy.

## 11. Deployment & Environments

- **Environments**: `local` (docker-compose, for development), `staging`, `production` — AegisOps manages *other* projects' staging/production, but AegisOps itself also needs its own staging slot to test platform changes before they hit the real one.
- **CI/CD**: GitHub Actions builds and pushes images to GHCR, runs tests + security scans (8.5, 8.6), and — for AegisOps's *own* deploys — calls the same Deployment Engine API it provides to hosted projects (dogfooding; if the deploy mechanism isn't good enough for AegisOps itself, it isn't good enough to ship).
- **Migrations**: run as a separate, explicit CI/deploy step (never implicit "sync on boot") so a schema change is always reviewable and reversible.

## 12. Testing Strategy

- Unit tests for business logic (especially authorization guards — these are exactly the kind of code where a regression is a security incident, not just a bug).
- Integration tests against a real (containerized) Postgres/Redis/Keycloak, not mocks, for anything touching auth or data integrity.
- End-to-end tests (Playwright) covering: login → view dashboard → create project → trigger deploy → see it go healthy → view its logs/metrics → trigger backup → roll back a deployment. This is the literal "does it work end to end" checklist handed to Claude Code in the companion build prompt.
- A security-focused test pass: attempt cross-project access as a `developer`, attempt a privileged action as an `auditor`, confirm both are denied and logged.

## 13. Success Metrics

- Time from "merge to main" to "live and healthy" for a sample project, before vs. after AegisOps.
- Number of manual/undocumented server changes per month (target: zero).
- Mean time to detect (via alerting) vs. mean time to notice manually, for an induced test failure.
- Backup restore drill: did it work, and how long did it take (ties to the RTO/RPO in Section 7).

## 14. Roadmap (maps to the original proposal's 5 phases)

| Phase | Scope | Exit criteria |
|---|---|---|
| 1 — Infrastructure Foundation | *Done.* Droplet, Cloudflare, Nginx, Docker, hardening. | Reverse proxy serves HTTPS, health check passes. |
| 2 — Core Platform Development | Postgres, Redis, Keycloak, the NestJS API skeleton, Next.js shell, Identity & Access, Project Management. | A real user can log in via Keycloak and create a project. |
| 3 — Deployment Automation | Deployment Engine, GitHub integration, rollback. | A push to a connected repo results in a live, health-checked container, end to end. |
| 4 — Monitoring & Observability | Prometheus/Grafana/Loki wired to app + containers, default alerts, Executive Dashboard fully live. | An induced container crash triggers an alert and is visible on the dashboard within the monitoring interval. |
| 5 — Enterprise Scaling | Infrastructure Management (multi-server), Database Management module, Backup & Recovery module, hardened secrets management (8.3), tested restore drill. | A full backup → restore drill succeeds against a non-production target within the stated RTO. |

## 15. Risks & Assumptions

- **Assumption**: a single droplet is acceptable for v1 availability expectations. If stakeholders expect high availability sooner, Phase 5+ needs re-scoping (multi-server) earlier than planned.
- **Risk**: adding Keycloak + Postgres + Redis + Prometheus/Grafana/Loki + the app itself on one small droplet may hit resource limits before Phase 5. Budget/size should be revisited after Phase 2 lands with real numbers, not assumed from the Phase-1 estimate.
- **Risk**: "self-hosted everything" (G4) trades licensing cost for operational burden (you patch and secure Keycloak, Postgres, etc. yourselves). This is a deliberate trade, but worth stating explicitly so it isn't a surprise later.
- **Open question**: what data residency/compliance requirements actually apply to projects AegisOps will host (especially anything insurance-related)? Flagged in 8.4 — needs a legal/compliance answer, not an engineering assumption.

---

## 16. Implementation notes & deviations (updated through Phase 5)

Recorded so the spec and the code do not drift. Items marked **Open** are not yet met.

- **Roles (FR-IAM-3 / §9):** there is no `Role` table. Roles live only in Keycloak and arrive as the `roles` claim of the validated JWT. A marker realm role `mfa_required` is included in the `platform_admin` and `devops_engineer` composites; the browser flow requires TOTP for holders of it (FR-IAM-2). `developer` MFA is not forced.
- **OpenAPI (§10):** done, and not with Swagger UI: see "OpenAPI and measurements" below.
- **FR-IAM-5 API keys:** create / list / revoke (SHA-256 at rest, project-scoped, scopes `deployments:trigger`, `deployments:read`). A key authenticates **one** route, `POST /api/v1/ci/deployments` (header `X-API-Key`), for CI to trigger a deployment of its own project. It can **never deploy to production** (a key carries no role, and FR-DEPLOY-6 requires a privileged human) and is not a bearer token anywhere else. A key keeps working if its creator is later removed from the project, so revoking keys is part of offboarding (§8.3).
- **FR-IAM-6 auth events:** the API audits rejected tokens, role denials and project-access denials. Keycloak's own events are now copied into the audit log too: see "Keycloak events and revocation" below. (Earlier wording: they were left in Keycloak's logs.)
- **FR-IAM-7:** access token 15 min, SSO session max 8 h, refresh tokens rotate and are single-use (configured in the realm). Revocation on sign-out, and on a role, group or account change, is now enforced by the API: see "Keycloak events and revocation" below.
- **Access to non-members** returns `404` (not `403`) so project existence is not disclosed; the attempt is audited (`authz.project_denied`).
- **Keycloak exposure:** served at `auth.$DOMAIN`; Nginx returns 404 for `/admin`, `/realms/master`, `/metrics`, `/health`. Keycloak is administered via `kcadm` inside the container.
- **Rate limiting:** global in-process limit (120/min/IP) plus Nginx `limit_req`. The throttler is not yet Redis-backed, so it is per-instance (fine for one API container). The API has no password endpoints; Keycloak enforces brute-force lockout.
- **CSP (§8.5):** done: see "Nonce-based CSP" below.
- **Images:** the API image reuses the build stage (non-root, but not slimmed); slimming with `pnpm deploy --prod` is a follow-up.
- **Build tooling:** the API is compiled with `tsc` rather than the Nest CLI.
- **Phase 3, deployment engine (FR-DEPLOY-1..6):** a separate `deployer` process is the only holder of the Docker socket; deployments are serialized; the route is switched only after the new container is healthy and verified through Nginx, so a failed health check always rolls back (verified live against GitHub Actions, GHCR and Docker). Push-triggered deploys react to the successful `workflow_run` of the CI workflow (default name `Build image`), not to the push itself, because the image does not exist until CI finishes. GHCR does not accept GitHub App tokens, so a private image needs `GHCR_USERNAME` / `GHCR_TOKEN` (a `read:packages` PAT); a public package needs nothing.
- **FR-PROJ-2 GitHub App:** the App is used for what it can do: linking a project to a repository is refused unless the installation can see it, and each deployment is reported to GitHub as a Deployment with status and log link (best effort, never affects the deploy). It is **not** used to pull images (GHCR limitation above) or to authenticate webhooks (HMAC). Repository access check and status reporting are skipped when no App is configured.
- **FR-PROJ-3 / FR-SEC-5 environment secrets:** secret env var values are stored AES-256-GCM encrypted (key `SECRETS_ENCRYPTION_KEY`, ciphertext bound to environment + name), are write-only (no API returns a value), are never logged or audited (the audit log records the name and actor), and are decrypted only by the deployer when starting a container. Who may write follows FR-DEPLOY-6. Without the key, secret storage is disabled and fails closed. Rotation = re-enter the value; changing the key makes existing values unreadable. This is the at-minimum approach from §8.3, a real secrets manager remains recommended before production launch.
- **FR-PROJ-3 resource limits:** per-environment memory (MB) and CPU limits are validated and applied to the container. "Target server" is **Open** (single host in v1).
- **FR-DEPLOY-3 logs:** each deployment has a log (steps, health-gate result, last container output on failure) shown on its own page. Streaming live container logs lands with Loki in Phase 4.
- **Nginx default server:** an explicit catch-all `default_server` drops requests whose Host matches no configured domain; without it the first managed project route would become the default for unknown hosts.
- **Phase 4, monitoring (FR-MON-1..4, FR-DASH-1..4):** Prometheus, Alertmanager, Loki, Promtail, Grafana, node-exporter, blackbox and a first-party container exporter run on `aegisops-net` and publish nothing; Grafana is reachable only at `grafana.$DOMAIN` behind Keycloak SSO. See [phase4-monitoring.md](phase4-monitoring.md). Deviations: container metrics come from a small exporter in the API codebase reading Docker through a read-only socket proxy, **not cAdvisor** (cAdvisor cannot track containers on Docker Desktop and needs host-root mounts); the exporter and Promtail read only containers on the platform network. Grafana admits only platform_admin (Admin), devops_engineer (Editor) and auditor (Viewer): developers are refused because Loki holds every project's logs, so developers get health, alerts and deployment state in the AegisOps dashboard instead. Alert delivery (Slack / email) is configured from the environment; Slack is connected and a test alert was delivered (2026-11-05), email is not configured. Login events in the audit view (FR-IAM-6) were closed afterwards: see "Keycloak events and revocation"; failed logins are counted and alerted.
- **Phase 5, backups and recovery (FR-BACKUP-1..5):** the data worker backs up the AegisOps database, Keycloak and every provisioned database nightly, as gzip'd plain SQL under **chunked AES-256-GCM** (per-chunk authentication, so a tampered archive releases no plaintext before it verifies), to S3-compatible object storage; nothing is kept on the server's disk and an unconfigured store makes backups fail loudly and alert. The row-count manifest and `pg_dump` share one exported snapshot. Restore always targets a NEW database: checksum first, then authenticated decryption, one transaction, then exact row counts. A weekly drill does this to a scratch database and measures it against the RTO (4 h; RPO 24 h follows from the nightly schedule). Retention is 14 daily / 8 weekly / 12 monthly for scheduled backups; **manual backups are kept 30 days and are never displaced by a nightly one** (a deviation from a plain GFS policy, so a deliberate pre-change backup is not pruned). Metrics and `promtool`-tested alerts cover failed, stale, never-run, failed-drill, stale-drill and slower-than-RTO. See [phase5-data.md](phase5-data.md). Recovery into a completely empty AegisOps database is a command-line tool (`recover-cli`, needs only the bucket and the key) and was rehearsed on 2026-11-05 against the real bucket and a fresh Postgres: Keycloak and AegisOps restored with exact row counts in 10 s (RTO 4 h); a full rebuild on a new server has **not** been rehearsed. **Open:** point-in-time recovery is not provided; the backup key is symmetric and held on the server (trade-off in [secrets-review.md](secrets-review.md)).
- **Phase 5, database management (FR-DB-1..4):** a project devops engineer or platform admin provisions a PostgreSQL database with its own least-privilege role (no superuser, cannot create databases or roles, cannot connect to any other database); the generated password goes only to Postgres and the encrypted `DATABASE_URL` environment secret. On-demand backup, history and restore-to-new follow the PRD's roles. **Overwrite** is a separate step, **platform_admin only**, with the database name typed back and a reason; it takes a safety backup first (and refuses without it), verifies a staged restore, then swaps by rename and keeps the old data as `<name>_old_<time>`. Deprovisioning and password rotation are **Open** (deliberately not offered from the dashboard).
- **Phase 5, infrastructure (FR-INFRA-1..3):** the single droplet registers itself as `primary`; `platform_admin` can register more. Container start/stop/restart follows the deploy role rule (production needs devops/admin); platform containers are `platform_admin` only with a typed reason, an exact allowlist, and critical services (database, queue, API, login, proxy) restart-only. Logs are searched through Loki, bound to the caller's project. Cordon, uncordon and drain are `platform_admin` only with the server name typed back and a reason; a cordoned server refuses deployments on every path, and drain refuses unless cordoned. The deployer re-validates every container action and resolves targets from the database. **Open:** real multi-server scheduling (environments run on the one host; the per-environment `serverId` is only used for the cordon check).
- **Secrets management (§8.3):** [secrets-review.md](secrets-review.md) inventories every secret with its blast radius and rotation, and `infra/scripts/check-secrets.mjs` audits `.env` (missing, weak, reused, invalid keys, git tracking, permissions) without printing a value. A real secrets manager is still recommended before production launch.
- **Definition of done (§12):** [e2e.md](e2e.md) walks the eight steps in a real browser against the live stack and passes. Deviation: the deploy step uses the dashboard instead of a GitHub push (a webhook would also deploy real projects linked to the same repository); the webhook path is covered by the integration suite.
- **Usability pass (UX):** found by looking at every screen on a desktop and a phone, and fixed:
  - **Times** were in the server's timezone with no zone and an ambiguous `11/4/2026`. One component (`src/app/time.tsx`) now renders `4 Nov 2026, 13:14 UTC` on the server and in the browser's first paint, then the viewer's own time with the zone named (`Nov 4, 2026, 13:14 GMT+2`), with the exact UTC instant in the tooltip.
  - **Tables on a phone** hid their important columns off screen (the deployment history showed only the status). Tables marked `stack` become one labelled card per row below 720 px, the audit log a compact four-line card; key/value tables wrap; long API paths wrap. A test fails if any main page scrolls sideways on a 390 px screen.
  - **The project page** is a long page: it now has jump links, and the forms that are rarely needed (add environment, provision a database, add a member) fold away once there is something in the list (they stay open while it is empty). The API-key form stays open on purpose: it shows the one-time key, which a collapse would hide.
  - **Errors and dead ends:** the framework's unstyled 404 and error pages are replaced by pages in the app's style with a way back; the error page shows a reference for the administrator, never the error text. A refused new-project form comes back with what was typed (none of it is secret), the slug is suggested from the name until the person edits it, and the sign-in page says what the product is.
  - **Smaller:** the logs page leads with the live view and labels the search; the API reference uses readable names ("Create API key", "Infrastructure and logs"); status pills no longer break across lines; the checkbox next to "Follow new lines" is back beside its label (a style rule of mine had pushed it away).
  - **Auto-refresh no longer discards work:** pages that follow something in flight (a deployment, a provisioning database, the health overview) used a meta-refresh that reloaded the whole page every 3 to 20 seconds, throwing away anything being typed and folding every form shut again. `src/app/auto-refresh.tsx` replaces all six: it calls `router.refresh()`, which re-reads the server data and updates only what changed, so typed text, unfolded forms and scroll position stay. It does nothing while the tab is hidden and waits while a field has focus, so a list never shifts under someone typing. Verified in a real browser: during a one-minute deployment the history changed by itself, the page was never reloaded, and half-typed text and a hand-opened fold survived.
  - **Alerts lead somewhere (FR-DASH-4):** an alert on the dashboard was plain text. It now links to its Grafana panel (the platform dashboard, or the environment's dashboard filtered to that project and environment) and, for an environment, to its logs: Grafana's Loki view for people who can open Grafana, the dashboard's own log page for developers. Checked against a live alert injected into Alertmanager. A test run's induced failed deployment raises a real `DeploymentFailed` alert, so running the E2E suite can post to the alert channel.
  - **Known gaps, not fixed:** see section 6.9 for the interface requirements and their status. Open: a manual accessibility and theme review (the automated scan passes).
- **Users and roles screen (Platform Admin persona):** `/admin/users`, menu entry **Users**, platform admins only (`GET/POST /api/v1/admin/users`, `PUT …/:id/role`, `POST …/:id/{disable,enable,reset-password,sign-out}`; the API returns 403 to every other role). Keycloak stays the only place identities and roles live (FR-IAM-1, FR-IAM-3): the API signs in to Keycloak's admin API as a dedicated **service account**, the client `aegisops-admin` (client-credentials only, no browser flows, access token 5 minutes), which holds realm-management's `view-users`, `query-users`, `manage-users` and `view-realm` and nothing else. Its secret is `KEYCLOAK_ADMIN_CLIENT_SECRET` (generated by `ensure-secrets.mjs`; a realm created before this needs `bootstrap.sh add-admin-client` once). Without the secret the platform runs as before and the screen says it is not set up.
  - **What it does:** lists people (username, email, role, enabled, last seen in AegisOps), searches, adds a person with a role, changes a person's role (one platform role each), disables and enables, resets a password, ends someone's sessions. **Passwords never pass through AegisOps as a choice:** a new or reset account gets a random 20-character temporary password, shown once in the response to the form that asked for it (never in a URL, and never in the audit log, which also strips secret-shaped keys), and Keycloak makes the person replace it at first sign-in and, for platform admins and DevOps engineers, enrol an authenticator app (FR-IAM-2).
  - **Rules:** you cannot change, disable or reset yourself; the last enabled platform admin cannot be demoted or disabled; a role change, disable, reset or sign-out ends the person's sessions in Keycloak and makes the API refuse every token they hold **at once** (FR-IAM-7), rather than after the 30-second event poll; a create that cannot set its role disables the half-made account. Every action is audited as `admin.user.create / role_change / disable / enable / reset_password / sign_out` with the target and, for a role change, the roles before and after.
  - **Risk accepted:** Keycloak's `manage-users` permission can map any realm role, so the service-account secret is worth as much as an administrator (the API only ever offers the four platform roles, but the secret itself is not limited that way). It lives only in `infra/.env`, the API container and Keycloak's client; rotation and switching it off are in [incident-response.md](incident-response.md) section 4. Keycloak's finer-grained admin permissions could narrow this further; they are not used.
  - **Not covered:** groups, deleting a person (disable instead, so the audit trail keeps a name), changing an email or username, emailing the temporary password (there is no outbound mail), and assigning roles other than the four platform ones. Verified against a real Keycloak (integration tests) and in the browser (E2E `04-users-and-roles`).
- **Database deprovisioning (FR-DB-5):** on a database's page a platform admin chooses *Remove this database* (typed name, reason of at least 10 characters; `POST …/databases/:dbId/deprovision`, 403 to everyone else). The API claims the database at once (status `DECOMMISSIONING`, which blocks new backups and overwrites) and queues a job; the data worker takes a **final backup and drops nothing if it fails** (the database returns to READY with the reason), then refuses new connections, ends the existing ones, drops the database, **every copy its role owns (restores into a new database, `_old_` copies from an overwrite: Postgres will not drop a role that owns one; the names are audited)** and its role, deletes the environment's `DATABASE_URL` secret **only if it still points at that database**, and marks the row `DECOMMISSIONED` (label freed for reuse, row kept as history). Its backups, including the final one, stay restorable into a **new** database for 90 days (`DECOMMISSION_RETENTION_DAYS`), then **all** expire, the newest too; nightly backups and drills skip it. Every step is repeatable, so an interrupted removal (shown as FAILED after a worker restart) is completed by asking again. Audited as `database.deprovision.request` and `database.deprovision`, with the reason, the final backup and whether the secret was removed. Verified against real Postgres and object storage (integration) and in the browser (E2E test 19). **Not covered:** the application's own volumes and files, redeploying the application without its database (the person does that), and anything outside the provisioned database.
- **Database password rotation (FR-DB-6):** on a database's page a platform admin or the project's devops engineer chooses *Rotate the application's database password* with a reason of at least 10 characters (`POST …/databases/:dbId/rotate-password`, 403 to developers and auditors, 409 unless the database is READY). The data worker reads the current password from the environment's `DATABASE_URL` (which must still point at that role, otherwise it refuses and changes nothing), sets a new random password, **proves a login with it**, and only then replaces `DATABASE_URL`; if storing the secret fails it puts the old password back, so the application never holds a secret that does not work. The password appears nowhere: not the page, the audit log (`database.rotate_password.request` / `database.rotate_password`, with the reason) or an error. The page shows when it last happened and why the last attempt failed. **Limit:** Postgres has no two-passwords-at-once and keeps open connections, so the running application must be **redeployed** before its next new connection; rotation does not do that for you. Verified against real Postgres (integration) and in the browser (E2E test 18).
- **Live logs (FR-INFRA-2):** the environment's logs page now has a live view. `GET /api/v1/projects/:projectId/environments/:envId/logs/stream` sends server-sent events: it polls Loki every 2 s from a cursor (no long-lived connection to Loki to break), sends each new line once with its nanosecond timestamp as the event `id`, a heartbeat every 15 s, and ends after 30 minutes; the browser resumes from the last `id` (`since=` / `Last-Event-ID`, starting just after that line, so nothing is lost or repeated). It has the same access rule and the same project- and environment-bound, escaped LogQL as the search (members, operators and auditors; a non-member gets 404), a plain-substring filter, a 10-minute backlog ceiling, and caps of 3 streams per person and 20 in total (429 beyond). A Loki failure sends a notice and retries, then stops after 5 failed polls. The browser cannot hold the API token (httpOnly cookie), so the dashboard's own route `/projects/:id/environments/:envId/logs/stream` forwards the stream with the signed-in user's token and aborts upstream when the page closes. The viewer shows text only, keeps the newest 2,000 lines, can pause, resume and follow. Nginx has an explicit route for the stream (HTTP/1.1, no buffering, no gzip, 1-hour read timeout); the responses also carry `X-Accel-Buffering: no` and `Cache-Control: no-transform`, and the stream works through the default route on those headers alone (verified). After editing the Nginx template, **restart the Nginx container**: changing a mounted template does not recreate it. **Limits:** lines reach the browser a few seconds after the application writes them (container, Promtail, Loki, the 2 s poll), so this is a near-live view, not a terminal; application output can contain secrets the application chose to print; and one API instance counts the caps (fine for one).
- **Nonce-based CSP (§8.5):** the dashboard's Content-Security-Policy is now built per request in `src/middleware.ts` (`src/lib/csp.ts`) around a fresh 128-bit nonce: `script-src 'self' 'nonce-…' 'strict-dynamic'`, with **no `'unsafe-inline'` for scripts**, plus `object-src 'none'`, `frame-ancestors 'none'`, `form-action 'self'`, `base-uri 'self'`, `font-src 'self'` and `upgrade-insecure-requests` in production. Next.js reads the policy from the request and stamps the nonce on its own bootstrap scripts; every page is rendered per request (`force-dynamic`) so none is built without one. The policy moved out of `next.config.mjs` (a static header cannot carry a per-request value). The sign-in rule moved into one shared place (`src/lib/access.ts`) because Auth.js runs a middleware you supply even when its `authorized` callback says no, so the middleware now does the redirect itself; verified that every protected path still answers `307` to the sign-in page when signed out. Verified in a real browser across the main pages: every inline script carries that request's nonce, the nonce differs on every request, the page trips no violation of its own policy, an injected inline event handler and a parser-inserted inline `<script>` are both refused. **Limits, by design of `strict-dynamic`:** a script created by code that is already trusted (`createElement('script')`) is allowed, so the policy stops injected *markup* from running, not code that is already running; and `style-src` still allows `'unsafe-inline'` because React's `style={…}` attributes cannot carry a nonce (style injection is a much smaller risk; moving those styles into CSS classes would let it be dropped). The Grafana and Keycloak pages set their own policies.
- **OpenAPI and measurements (§10, §7, §13):** `GET /api/v1/openapi.json` (any signed-in role) returns an OpenAPI 3 document that the API builds from the routes it actually serves: Nest's route and parameter metadata, our own `@Roles` / `@Public` / `@ProjectAccess` / `@Audited` decorators, and the class-validator rules on every DTO. Each operation lists the roles the guard checks (`x-roles`), the project access it needs and its audit action, so the document cannot disagree with the enforcement. The dashboard renders it at `/api/docs` (and offers the file for download), behind sign-in; Swagger UI was not used (no extra script bundle, no CSP exception, and the roles are shown). Metrics is left out: it is outside the public tree. The same enumeration now drives the CI rule of §8.2: the old test checked a hand-kept list of six controllers and missed the newer ones, so it was replaced by one that walks **every** controller in the running application, and it also asserts that only `GET /health`, `POST /ci/deployments` and `POST /webhooks/github` are public and that no route lets an auditor change anything (except signing out). Measured on 2026-11-10 ([measurements.md](measurements.md)): dashboard load p95 98 to 179 ms (target 2 s), API read p95 about 34 ms (target 300 ms), a stopped container reaches the dashboard in 28 s and a firing alert in 102 s, CI build plus deploy about 30 s for the sample app, and the platform uses about 1.7 GiB at rest (so a 4 GB server at least). Local, single-user and warm: read the limits there.
- **Keycloak events and revocation (FR-IAM-6, FR-IAM-7):** Keycloak logs every event as `key="value"` pairs; Promtail ships that log to Loki; the API reads it every 30 s and copies each event into the audit log exactly once (a unique source key makes overlapping reads harmless), as `auth.login`, `auth.login_error`, `auth.logout`, `auth.update_totp`, … and, for admin changes, `auth.admin.<resource>.<operation>`. Successful events are logged at `info` (`KC_SPI_EVENTS_LISTENER__JBOSS_LOGGING__SUCCESS_LEVEL`) because Keycloak writes them at debug by default. Sign-ins to the `master` realm are recorded and labelled, since that is someone using the Keycloak console or `kcadm`. Enforcement: each person has a `tokensValidAfter` time, and a token issued at or before it is refused with `401 Session ended` however long it has left. It is set (a) when the person signs out, by the dashboard calling `POST /api/v1/me/revoke` (instant), and (b) from Keycloak's own events: a sign-out, a lockout, or an admin change to that person's account, roles or groups (typically within a minute: the 30 s poll plus log shipping), using the event's time so a token issued after the change is untouched. The dashboard answers a refused token by clearing its cookie and sending the person to sign in again, which is silent while their Keycloak session lives and so brings the new roles without a password. **Sign-out now also ends the Keycloak single-sign-on session** (it used to clear only the dashboard cookie, so signing back in needed no password for up to 8 hours). An alert, `AuthEventsNotCopied`, fires if the copying stops for 10 minutes. Verified end to end: a role added in Keycloak showed up in a signed-in person's navigation within about a minute, with the sign-in, the change and the refused token all in the audit log. **Limits:** an admin event names who it changed but not which realm, and a change to a role or group definition does not say which people it affects, so those are recorded but revoke nobody (a new token with the new roles arrives at the next refresh, ≤ 15 min). The copying depends on Loki and Promtail: a gap longer than Loki keeps its data, or than the 24 h catch-up on API start, would lose events (the alert tells you). The audit entries copied in are as complete as Keycloak's log, not signed by Keycloak.
- **Audit log, members, API keys, incident response (closing gaps found after Phase 5):**
  - **FR-AUDIT-3:** `/audit` (auditor and platform admin) searches by action (exact, or a prefix with `*`), who, result and date range, pages through the results, and exports CSV. The export returns the newest 10,000 matching entries, is itself audited (`audit.export`, with the filters and row count), and defuses spreadsheet formulas in any cell. The log stays read-only.
  - **FR-PROJ-4:** the project page adds and removes members (platform admin, or a devops owner; the API refuses anyone else and says why).
  - **FR-IAM-5:** the project page creates, lists and revokes CI keys. The plaintext is shown once in the response to the form that asked for it, never in a URL; afterwards only its first characters are listed. Verified end to end: a key deploys its own project and returns `401` once revoked. Auditors see no keys.
  - **§8.9:** [incident-response.md](incident-response.md): contacts to fill in, taking things offline, disabling a person, rotating each secret, recovery, and the aftermath. The Keycloak commands in it were run against the live realm.
- **Requirements still open after Phase 5** (none blocks the roadmap exit criteria, but each is a gap against this document):
  - **§8.4:** encryption at rest of the Postgres data volume is a host/disk concern and has not been verified; backups are encrypted.
  - **§11:** AegisOps deploying itself through its own Deployment Engine, and a staging slot for platform changes.
  - **§7 cost:** the budget has not been re-approved: the sizing inputs are in [measurements.md](measurements.md) and the decision is the owner's. **§13:** "manual server changes per month" and the before-AegisOps comparisons need time and a baseline, not engineering.
  - **FR-PROJ-3:** real multi-server targets (needs a second host to build and test against).
- **Local ports:** the dev override uses non-default ports (Postgres 15432, Redis 16379, Keycloak 18080, web 13000).

---

*This PRD is a living document. As Claude Code builds against it, update this file in place rather than letting the build drift from the spec — a PRD nobody updates becomes fiction by Phase 3.*
