# AegisOps: measured against the PRD's numbers (sections 7 and 13)

Measured on 2026-11-10 against the running stack on the development machine (Docker Desktop, 11.3 GB given to Docker), with `e2e/measure/measure.spec.ts`:

```
cd e2e && npx playwright test -c playwright.measure.config.ts      # about 3 minutes, writes test-results/measure.json
```

It is not part of the normal `playwright test` run: it deploys a test project. Read the limits at the end before quoting any of these numbers.

## Performance (PRD section 7)

| Target | Measured | Verdict |
|---|---|---|
| Dashboard initial load under 2 s on a warm cache | **p95 143 ms** on `/projects`; **p95 98 to 179 ms** across the five main pages (worst single load 224 ms) | Met, with a wide margin |
| API p95 latency under 300 ms for read endpoints | **p95 about 34 ms** over 224 GET requests; slowest route `/monitoring/overview` at about 44 ms | Met, with a wide margin |

Page loads are the browser's own navigation timing (time to the load event), 30 loads per page after 3 warm-up loads, signed in as a platform admin.

| Page | Load p50 / p95 / max (ms) | First byte p50 / p95 (ms) |
|---|---|---|
| Projects | 82 / 143 / 153 | 53 / 130 |
| Audit log | 84 / 158 / 164 | 60 / 96 |
| Backups | 85 / 143 / 152 | 67 / 123 |
| Infrastructure | 72 / 98 / 104 | 56 / 76 |
| A project | 122 / 179 / 224 | 86 / 162 |

API latency is the API's own `aegisops_http_request_duration_seconds` histogram over the same window, GET requests only. The five slowest routes (p95): monitoring overview 44 ms, backups overview 39 ms,
restores 25 ms, servers 23 ms, audit log 21 ms.

## Detection time (PRD section 13: "mean time to detect an induced failure")

A test project was deployed, its container was stopped from the dashboard, and the time to each signal was taken from the click:

| Signal | Seconds after the stop |
|---|---|
| The dashboard shows the container is no longer up | **28** |
| `ContainerDown` is firing in Alertmanager (a Slack message follows about 20 seconds later, the grouping wait) | **102** |

This matches the configuration: a 15 s scrape, a rule that must hold for 1 minute, and a 15 s evaluation. The Slack message for the test project was silenced (a 30-minute silence on that project only), so nothing was sent to your channel.
"Versus noticing manually" cannot be measured without a baseline from before AegisOps.

## Merge to live (PRD section 13)

| Step | Measured |
|---|---|
| CI builds and pushes the image (sample app, 7 successful runs) | median **20 s**, longest 23 s |
| The platform deploys it (pull, start, health gate, route switch; 4 webhook deployments) | median **9 s**, longest 43 s |

So about **30 seconds** from a successful build to a healthy container, for a small image. A large image and a slow health check will add to the deploy figure. There is no "before AegisOps" figure to compare with.

## Cost and size (PRD section 7: "recompute the budget")

Memory the platform's 18 containers use at rest, from `docker stats`: **1.9 GiB** in total, of which **148 MiB is the local-only test storage** that a server does not run, so about **1.7 GiB** on a server.

| Container | Memory (MiB) |
|---|---|
| Keycloak | 835 |
| Loki | 137 |
| PostgreSQL | 121 |
| Grafana | 109 |
| Promtail | 92 |
| everything else (12 containers) | about 460 |

The numbers to size a server from:

- The platform needs about **1.7 GiB at rest**, and Keycloak alone is nearly half of it (it is a Java service and uses what it is given).
- Add the operating system (about 0.4 GiB), room for a backup or a restore drill (`pg_dump` and `psql` run next to the database), and the hosted applications: each takes its environment's memory limit, 256 MB by default.
- **A 2 GB server is too small. A 4 GB server is the smallest that leaves room**, and 8 GB if several projects run on it. This is my reading of the numbers above; confirm it with a week of real use.
- CPU was close to idle (all containers under about 1.5%), so memory, not CPU, picks the server size.
- Disk was 10% used. Backups go to object storage (a few kilobytes each for the platform databases), not the server's disk.
- I have not put a price on this: check your provider's current price for a 4 GB and an 8 GB server, and add the object-storage bill. Re-approving the budget is your decision, with these figures as input.

## What these numbers do not show

- **One machine, no network.** The browser and the server are on the same computer, so page loads exclude the network. Add your users' round-trip time and TLS setup for a first visit.
- **A warm, small system.** One project, one user, data measured in kilobytes. A cold first load, many people at once and a large audit log (the page reads 50 rows at a time) were not measured.
- **Coarse latency buckets.** The API histogram has buckets of 10, 25, 50, 100 ms and so on, so "about 34 ms" is an interpolation inside a bucket, not an exact figure.
- **Idle memory, not peak.** Peaks during a backup, a drill or a deploy were not captured.
- **A tiny sample app.** Build and deploy times will be longer for a real application.
- **Not measured at all:** the improvement over before AegisOps (merge to live, time to notice by hand), because there is no earlier data; and the "number of manual server changes per month" target, which only time can show.
