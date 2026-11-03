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

## 16. Implementation notes & deviations (updated during Phase 2 build)

Recorded so the spec and the code do not drift. Items marked **Open** are not yet met.

- **Roles (FR-IAM-3 / §9):** there is no `Role` table. Roles live only in Keycloak and arrive as the `roles` claim of the validated JWT. A marker realm role `mfa_required` is included in the `platform_admin` and `devops_engineer` composites; the browser flow requires TOTP for holders of it (FR-IAM-2). `developer` MFA is not forced.
- **OpenAPI (§10):** the Swagger UI at `/api/docs` is **Open**; it is deferred until it can be placed behind authentication.
- **FR-IAM-5 API keys:** create / list / revoke are implemented (SHA-256 at rest, project-scoped, scopes `deployments:trigger`, `deployments:read`). *Authenticating with* an API key is **Open** and lands with the Deployment Engine (Phase 3).
- **FR-IAM-6 auth events:** the API audits rejected tokens, role denials and project-access denials. Login success/failure/MFA events are emitted by Keycloak (event listeners enabled in the realm) to its logs; surfacing them in the audit view and the failed-login alert is **Open** (Phase 4, with Loki).
- **FR-IAM-7:** access token 15 min, SSO session max 8 h, refresh tokens rotate and are single-use (configured in the realm). A role change takes effect at the next token refresh (≤ 15 min). Immediate server-side revocation / forced re-auth on role change is **Open**.
- **Access to non-members** returns `404` (not `403`) so project existence is not disclosed; the attempt is audited (`authz.project_denied`).
- **Keycloak exposure:** served at `auth.$DOMAIN`; Nginx returns 404 for `/admin`, `/realms/master`, `/metrics`, `/health`. Keycloak is administered via `kcadm` inside the container.
- **Rate limiting:** global in-process limit (120/min/IP) plus Nginx `limit_req`. The throttler is not yet Redis-backed, so it is per-instance (fine for one API container). The API has no password endpoints; Keycloak enforces brute-force lockout.
- **CSP (§8.5):** the dashboard ships a CSP with `'unsafe-inline'` for scripts (Next.js inline bootstrap). A nonce-based CSP is **Open**.
- **Images:** the API image reuses the build stage (non-root, but not slimmed); slimming with `pnpm deploy --prod` is a follow-up.
- **Build tooling:** the API is compiled with `tsc` rather than the Nest CLI.
- **Local ports:** the dev override uses non-default ports (Postgres 15432, Redis 16379, Keycloak 18080, web 13000).

---

*This PRD is a living document. As Claude Code builds against it, update this file in place rather than letting the build drift from the spec — a PRD nobody updates becomes fiction by Phase 3.*
