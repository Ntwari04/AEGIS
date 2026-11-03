# Prompt for Claude Code: Build AegisOps

Copy everything below the line into Claude Code (CLI), run from inside the
`AegisOps` repo root (where `docs/` and `infra/` already exist). It's
written to be handed over as-is — it carries its own context, the
non-negotiables, the build order, and the definition of done, so you
shouldn't need to re-explain the project first.

---

## 0. Read this first

Read `docs/PRD.md` in full before writing any code. It is the spec for
everything below — this prompt tells you *how* to build it and in what
order; the PRD tells you *what* "it" is in detail (functional requirements,
data model, security requirements). Where this prompt and the PRD seem to
conflict, the PRD wins; tell me about the conflict rather than silently
picking one.

Also read `infra/` and `docs/phase1-infrastructure-setup.md`. Phase 1
(droplet, Cloudflare, Nginx reverse proxy, Docker, hardening) is **already
built and working** — don't redo it, and don't break it. You're extending
`infra/docker-compose.yml`, not replacing it.

## 1. What you're building

The AegisOps application: a NestJS API + Next.js dashboard, backed by
Postgres, Redis, and Keycloak, that lets an authorized engineer deploy,
monitor, and manage containerized applications through a single UI — per
`docs/PRD.md` Sections 5–11.

Locked-in technology decisions (do not re-litigate these; they were made
deliberately with the project owner):

- **Language/runtime**: TypeScript throughout, Node.js LTS.
- **API**: NestJS. **Dashboard**: Next.js (React). **Monorepo**: npm or
  pnpm workspaces, under `apps/api`, `apps/web`, `packages/shared-types`.
- **Database**: PostgreSQL, accessed via an ORM with migrations (Prisma or
  TypeORM — your call, but pick one and use it consistently; don't mix).
- **Cache/queue**: Redis (e.g. via BullMQ for the deployment/backup job
  queue — deployments and restores must be async jobs, never a request
  that blocks for minutes).
- **Identity**: Keycloak, self-hosted in Docker, OIDC Authorization Code +
  PKCE from the Next.js app. AegisOps does not implement its own password
  storage, login form crypto, or MFA — that's Keycloak's job (PRD 8.1).
- **Monitoring**: Prometheus + Grafana + Loki + Promtail, all in Docker,
  joined to the existing `aegisops-net` network from Phase 1.
- **CI/CD**: GitHub Actions.

## 2. Non-negotiable engineering standards

Treat every item below as a blocking requirement, not a nice-to-have. If
you find yourself tempted to skip one "for now," stop and tell me instead
of shipping it skipped — these map directly to PRD Section 8 (Security)
and a system handling deployment/infra control for a company's real
products doesn't get a pass on any of them.

**Security — self-check this list before calling any phase "done":**

- [ ] Every mutating API route has an explicit authorization guard
      (role + project-membership check). No route is open-by-default.
- [ ] No secret (DB password, Keycloak client secret, GitHub App key,
      object-storage credentials) appears in committed code, `docker-compose.yml`,
      or a Dockerfile. Everything comes from `.env`, and `.env` is
      gitignored. Add `.env.example` with placeholder values + comments,
      never real ones.
- [ ] Postgres, Redis, and Keycloak are reachable only on the internal
      `aegisops-net` Docker network — never port-published to the host.
      Only Nginx is.
- [ ] All API input is validated at the boundary (NestJS DTOs +
      class-validator); no raw string-built SQL anywhere.
- [ ] Passwords/tokens/secrets are never written to logs or included in
      audit-log diffs.
- [ ] Security-relevant actions (Section 6.8/8.8 of the PRD: auth events,
      role changes, deploys, server actions, backup/restore) write an
      immutable audit log entry — actor, action, target, timestamp,
      result.
- [ ] Rate limiting is on auth endpoints and the general API.
- [ ] Dependency/image scanning runs in CI (`npm audit` or
      Dependabot/Renovate, plus Trivy on built images) and a high/critical
      finding fails the build rather than being silently ignored.
- [ ] Containers run as non-root where the base image supports it.
- [ ] A failed deployment health check automatically rolls back — it
      must be structurally impossible for a broken container to stay
      live and routed.

**Testing:**

- Unit tests for authorization guards and anything touching money, data
  integrity, or access control — these are the regressions that become
  incidents, not just bugs.
- Integration tests run against real containerized Postgres/Redis/Keycloak
  (e.g. via Testcontainers), not mocks, for anything touching auth or
  data integrity.
- A Playwright end-to-end test that runs the full flow in Section 5
  below. This is the actual proof the system works, not just that its
  parts compile.
- `npm test` (or equivalent) must pass before you report a phase as
  complete. Don't report completion with known-failing tests "to fix
  later."

**Process:**

- Work in the phase order in Section 4. After each phase, stop, summarize
  what you built, run the tests, and report status before moving on —
  don't silently barrel through all five phases in one pass. I'd rather
  course-correct after Phase 2 than discover a problem after Phase 5.
- Small, reviewable commits with descriptive messages, not one giant
  commit per phase.
- If you deviate from `docs/PRD.md` (a requirement turns out to be
  wrong, ambiguous, or infeasible as written), update the PRD in the same
  change and say so explicitly in your summary — don't let the code and
  the spec quietly drift apart.
- If you're missing information you need to proceed (a credential, an
  account, a decision the PRD left open) — **stop and ask**. Do not
  invent a plausible-looking API key, domain name, or account ID and
  continue as if it were real; that fails silently and expensively later.
  Section 3 lists exactly what you'll need from me and when.

## 3. What you'll need from me (the human) — don't fabricate these

Some of what you need to build an end-to-end working system isn't
something you can generate yourself. Ask for these at the point you
actually need them (don't block Phase 2 on something only Phase 3 needs):

| Needed for | What | Notes |
|---|---|---|
| Phase 2 (Keycloak) | Nothing from me — stand up Keycloak yourself via Docker and its admin API/CLI, create the realm, roles, and a confidential client for the Next.js app programmatically, and document the bootstrap admin credential rotation step. |
| Phase 3 (GitHub integration) | A GitHub App (not a personal token) installed on the target repo(s), with its App ID, installation ID, and private key. | I'll create the GitHub App; tell me exactly which permissions/webhook events it needs so I set it up right the first time. |
| Phase 3 (image registry) | Confirmation that GitHub Container Registry (GHCR) is acceptable, or an alternative if not. | Default to GHCR unless told otherwise. |
| Phase 5 (backups) | Object storage credentials (e.g. DigitalOcean Spaces access key/secret) and a bucket name. | Don't hardcode a bucket/region — read from `.env`. |
| Phase 4 (alerting) | A Slack webhook URL or alert email address for Alertmanager's default route. | Fine to stub with a placeholder and a clear `.env.example` entry until I provide the real one. |
| Any phase | The actual domain name for this environment (Phase 1 already parameterized this via `infra/.env`'s `DOMAIN` — reuse it, don't introduce a second place domain is configured). | |

If something isn't on this list but you still find you need a real-world
credential or decision from me to make a feature actually work end to
end (not just compile), add it to this table in your summary when you
report that phase's status.

## 4. Build order

Follow `docs/PRD.md` Section 14's phases. Concretely:

**Phase 2 — Core Platform Development**
1. Scaffold the monorepo (`apps/api`, `apps/web`, `packages/shared-types`).
2. Add Postgres, Redis, Keycloak to `infra/docker-compose.yml` (new
   services, joined to the existing `aegisops-net`; do not touch the
   existing `nginx` service's config beyond adding routes for the new
   app).
3. Keycloak realm/client/roles bootstrap (scripted, not manual clicking —
   someone needs to be able to tear this down and recreate it).
4. NestJS: auth guard validating Keycloak-issued JWTs, DB schema +
   migrations for the entities in PRD Section 9, Identity & Access module
   (PRD 6.1), Project Management module (PRD 6.3).
5. Next.js: login (redirect to Keycloak), project list/detail, basic
   layout shell.
6. **Checkpoint**: a real user can log in via Keycloak and create a
   project. Report status.

**Phase 3 — Deployment Automation**
1. GitHub App webhook receiver, Deployment Engine (PRD 6.4): build/pull
   image, blue-green-ish container swap with health-check gating,
   automatic rollback on failed health check, deployment history.
2. Wire deployment routing into the Nginx template mechanism from Phase 1
   (`infra/nginx/templates/default.conf.template`) — extend it to
   generate/route per-project server blocks rather than replacing the
   placeholder by hand.
3. **Checkpoint**: push to a connected repo → live, health-checked,
   HTTPS-routed container, with a working one-click rollback. Report
   status.

**Phase 4 — Monitoring & Observability**
1. Prometheus + Grafana + Loki + Promtail in `infra/docker-compose.yml`,
   auto-discovering containers the Deployment Engine labels.
2. `/metrics` endpoint on the API; default alert rules (PRD 6.6.1);
   Alertmanager routing from `.env`.
3. Executive Dashboard (PRD 6.2) wired to real Prometheus/Loki data, not
   placeholder numbers.
4. **Checkpoint**: kill a container on purpose → alert fires, dashboard
   reflects it, logs are visible, within the stated monitoring interval.
   Report status.

**Phase 5 — Enterprise Scaling**
1. Infrastructure Management module (multi-server view, container
   controls, PRD 6.5).
2. Database Management module (provision/backup/restore-to-new, PRD 6.6).
3. Backup & Recovery (PRD 6.7): scheduled encrypted off-box backups,
   retention policy, and — critically — an actual restore drill against a
   non-production target, not just a backup-creation feature.
4. Secrets-management hardening pass (PRD 8.3) — revisit whether `.env`
   files are still sufficient at this scale or whether a real secrets
   manager (Infisical/Doppler, both OSS-friendly) is now warranted.
5. **Checkpoint**: full backup → restore drill succeeds within the RTO
   stated in PRD Section 7. Report status.

## 5. Definition of done (the actual end-to-end test)

The system is not "done" because the code compiles or units pass. It's
done when this sequence works for real, driven by the Playwright E2E
suite:

1. Visit the dashboard → redirected to Keycloak login → log in with MFA
   → redirected back, authenticated.
2. Create a project, connect it to a GitHub repo.
3. Push a commit → deployment triggers automatically → container comes
   up, passes health check, becomes reachable over HTTPS at its routed
   domain.
4. Dashboard shows the project as healthy, with live CPU/RAM and a link
   to its logs (Loki) and metrics (Grafana).
5. Trigger a deliberate bad deploy (failing health check) → it
   auto-rolls-back → previous version stays live → this is visible in
   deployment history.
6. Trigger an on-demand database backup → see it complete → restore it to
   a new database → verify data integrity.
7. As a `developer`-role user, confirm you cannot see or touch a project
   you're not a member of, and that attempt is in the audit log.
8. As an `auditor`-role user, confirm you can read the audit log but
   cannot trigger any mutating action.

If any one of these eight steps doesn't work, the system isn't e2e yet —
keep going, don't call it finished.

## 6. Starting instruction

Start now: read `docs/PRD.md` and `infra/`, then begin Phase 2 step 1. Ask
me anything from Section 3 you need as you reach the point where you
actually need it, and give me a status report at each checkpoint in
Section 4 before moving to the next phase.
