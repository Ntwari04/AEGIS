# AegisOps: end-to-end test (definition of done)

`e2e/tests/02-definition-of-done.spec.ts` walks the eight steps of the PRD's definition of done, in order, in a real browser against the running stack
(Keycloak with MFA, Nginx + HTTPS, the Docker deployer, Prometheus and Loki, Postgres backups). Nothing is mocked.

```
cd e2e && npx playwright test        # about 3 minutes
```

Defaults match the local stack (`https://localtest.me`, self-signed certificate). Override with `E2E_BASE_URL`, `E2E_GITHUB_REPO`, `E2E_GOOD_SHA`, `E2E_BAD_SHA`.

| # | Step | What the test checks |
|---|---|---|
| 1 | MFA login | a new platform admin is forced through TOTP enrolment, then lands authenticated |
| 2 | Project + GitHub | project linked to a repository the GitHub App can see, and an environment with a domain and memory limit |
| 3 | Deploy | a real GHCR image becomes a healthy container, answers `200` on `https://<env domain>/` |
| 4 | Dashboard | state `Up`, CPU and memory (with the limit) filled in, Metrics and Logs links go to Grafana/Loki, in-app log search loads |
| 5 | Bad deploy | an image whose health check fails ends `FAILED`/`ROLLED_BACK`, the previous commit stays live and keeps answering |
| 6 | Backup and restore | provision a database, put a table with 3 rows in it, back it up, restore to a NEW database, integrity line reads exactly `verified: 1 tables, 3 rows` |
| 7 | Developer isolation | a developer sees no projects, cannot open another project by URL, and `authz.project_denied` is in the audit log |
| 8 | Auditor | sees the project, databases and servers; is offered no deploy, secret, environment, database, container or cordon control |

Steps 7 to 13 go beyond the eight, covering the screens added after Phase 5:

| # | Step | What the test checks |
|---|---|---|
| 7 (cont.) | Membership | the admin adds the developer to the project in the dashboard and the project appears for them; the developer cannot change the team; removing them takes it away again |
| 8 (cont.) | Auditor | the audit log page is readable and filterable, and offers nothing to change |
| 9 | Audit log | search by action, every row matches; the CSV export honours the filter; the export is recorded as `audit.export` |
| 10 | Sign-out | signing out ends the Keycloak session too: signing in again shows the login form, not a silent sign-in |
| 11 | Sign-ins and role changes | a sign-in appears in the audit log (Keycloak, Promtail, Loki, API); an administrator adds a role and the person's navigation changes within about a minute; the change and the refused old token are in the audit log |
| 12 | API reference | `/api/docs` lists the operations with the roles the guard checks and the validation rules; the downloaded `openapi.json` is a valid document; signed out, both lead to the sign-in page |
| 13 | CI key | a key is shown once and only its prefix afterwards; it triggers a deployment of its own project; after revoking it, the same call returns `401` |

## Things to know

- **Step 3 deploys from the dashboard, not from a GitHub push.** Both create the same deployment, and the webhook path is covered by `apps/api/test/api.int.ts`.
  A signed webhook is deliberately not used: it deploys every project linked to the repository, and the repository belongs to a real project too.
- Users are created and removed with `kcadm` inside the Keycloak container (the admin API is not public by design). Every run creates one project, one container
  and one provisioned database that it does not remove: there is no project deletion in the product yet. `node e2e/scripts/cleanup.mjs` lists them (and only them: slugs
  starting `e2e-`), `--yes` removes them. It leaves the encrypted archives of those test databases in the bucket (`aegisops/db/`); delete that folder when you like.
- The test needs Docker access on the machine that runs it (`docker exec` for Keycloak users and a read-only audit-log query).
- `npm run measure` (in `e2e/`) runs the separate measurement spec behind [measurements.md](measurements.md): page loads, API latency, how long a stopped container takes to be noticed, merge-to-live time and the platform's memory. It deploys a test project, so clean up with `npm run cleanup` afterwards.
- It is not part of CI: it needs the full stack, GHCR images and a public DNS name.
