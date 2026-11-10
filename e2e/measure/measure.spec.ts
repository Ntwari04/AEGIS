import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { expect, test } from '@playwright/test';
import { createUser, deleteUser } from '../helpers/keycloak';
import { psql, signIn } from '../helpers/platform';

/**
 * Measures the PRD's numbers (section 7 performance and cost, section 13 success metrics) against the running stack and writes them to
 * JSON. Nothing here is asserted against a target: the result is the point. docs/measurements.md records what it found and how.
 */
const OUT = process.env.MEASURE_OUT ?? 'test-results/measure.json';
const GOOD_SHA = process.env.E2E_GOOD_SHA ?? '8b12f2f7647da0b1564e2cb72188eae9cebc0ebd';
const REPO = process.env.E2E_GITHUB_REPO ?? 'Ntwari04/AEGIS';
const PID = process.env.MEASURE_PROJECT; // an existing project id to load (optional)

const sh = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const prom = (query: string): { metric: Record<string, string>; value: number }[] =>
  JSON.parse(sh('docker', ['exec', 'aegisops-prometheus', 'wget', '-qO-', `http://localhost:9090/api/v1/query?query=${encodeURIComponent(query)}`])).data.result
    .map((r: { metric: Record<string, string>; value: [number, string] }) => ({ metric: r.metric, value: Number(r.value[1]) }));
const am = (path: string, post?: object) =>
  JSON.parse(sh('docker', ['exec', 'aegisops-alertmanager', 'wget', '-qO-', ...(post ? ['--header=Content-Type: application/json', `--post-data=${JSON.stringify(post)}`] : []), `http://localhost:9093${path}`]) || '{}');

const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };
const stats = (xs: number[]) => ({ n: xs.length, p50: Math.round(pct(xs, 50)), p95: Math.round(pct(xs, 95)), max: Math.round(Math.max(...xs)) });
const result: Record<string, unknown> = { measuredAt: new Date().toISOString() };
const created: string[] = [];

test.afterAll(() => {
  for (const id of created) deleteUser(id);
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
});

test('page load times and API latency under repeated use', async ({ page }) => {
  test.setTimeout(300_000);
  const admin = await createUser('platform_admin', { temporary: true });
  created.push(admin.id);
  await signIn(page, admin);

  const urls = ['/projects', '/audit', '/backups', '/infra', ...(PID ? [`/projects/${PID}`] : [])];
  const loads: Record<string, unknown> = {};
  const windowStart = Date.now();
  for (const url of urls) {
    const times: number[] = [];
    const ttfb: number[] = [];
    for (let i = 0; i < 33; i++) {
      await page.goto(url, { waitUntil: 'load' });
      const t = await page.evaluate(() => {
        const n = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
        return { load: n.loadEventEnd, ttfb: n.responseStart };
      });
      if (i >= 3) { times.push(t.load); ttfb.push(t.ttfb); } // the first three warm caches and are not counted
    }
    loads[url] = { loadMs: stats(times), firstByteMs: stats(ttfb) };
  }
  result.pageLoad = loads;

  // The API's own histogram over the same window (GET only). The upper bound of the bucket the 95th percentile falls in.
  const seconds = Math.ceil((Date.now() - windowStart) / 1000) + 30;
  const window = `${seconds}s`;
  const p95 = prom(`histogram_quantile(0.95, sum by (le)(increase(aegisops_http_request_duration_seconds_bucket{method="GET"}[${window}])))`);
  const count = prom(`sum(increase(aegisops_http_request_duration_seconds_count{method="GET"}[${window}]))`);
  const slow = prom(`topk(5, histogram_quantile(0.95, sum by (le, route)(increase(aegisops_http_request_duration_seconds_bucket{method="GET"}[${window}]))))`);
  result.apiReadLatency = {
    window, getRequests: Math.round(count[0]?.value ?? 0), p95Seconds: p95[0]?.value ?? null,
    slowestRoutesP95Seconds: slow.map((s) => ({ route: s.metric.route, p95: s.value })),
  };
});

test('time from a container stopping to the platform noticing', async ({ page }) => {
  test.setTimeout(420_000);
  const admin = await createUser('platform_admin', { temporary: true });
  created.push(admin.id);
  await signIn(page, admin);

  const tag = Date.now().toString(36);
  const slug = `e2e-measure-${tag}`;
  await page.getByTestId('new-project').click();
  await page.locator('#name').fill(`Measure ${tag}`);
  await page.locator('#slug').fill(slug);
  await page.locator('#githubRepo').fill(REPO);
  await page.getByTestId('create-project').click();
  await expect(page.getByTestId('project-name')).toBeVisible({ timeout: 30_000 });
  const projectId = new URL(page.url()).pathname.split('/').pop()!;
  await page.locator('#env-name').fill('staging');
  await page.locator('#env-domain').fill(`${slug}.localtest.me`);
  await page.locator('#env-mem').fill('256');
  await page.getByTestId('add-environment').click();
  await page.getByTestId('env-staging').locator('input[name=commitSha]').fill(GOOD_SHA);
  await page.getByTestId('deploy-staging').click();
  await expect(page.getByTestId('history-staging').locator('tbody tr').first().locator('.status')).toHaveText('SUCCESS', { timeout: 200_000 });

  // Wait until the platform sees it up, so the stop is the only thing that changes. Silence only THIS test project's alerts in Slack.
  await expect.poll(async () => { await page.goto('/projects'); return page.getByTestId(`project-${slug}`).getByTestId('state-staging').innerText(); }, { timeout: 120_000, intervals: [3_000] }).toBe('Up');
  am('/api/v2/silences', {
    matchers: [{ name: 'project', value: slug, isRegex: false, isEqual: true }],
    startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    createdBy: 'measure', comment: 'Measuring detection time of an induced failure; this alert is expected.',
  });

  await page.goto(`/projects/${projectId}`);
  const t0 = Date.now();
  await page.getByTestId('stop-staging').click();

  const seconds = (from: number) => Math.round((Date.now() - from) / 100) / 10;
  let dashboard: number | null = null;
  let alert: number | null = null;
  while ((dashboard === null || alert === null) && Date.now() - t0 < 360_000) {
    if (dashboard === null) {
      await page.goto('/projects');
      if ((await page.getByTestId(`project-${slug}`).getByTestId('state-staging').innerText()) !== 'Up') dashboard = seconds(t0);
    }
    if (alert === null) {
      const alerts = am('/api/v2/alerts?active=true') as unknown as { labels: Record<string, string>; status: { state: string } }[];
      if (alerts.some((a) => a.labels.alertname === 'ContainerDown' && a.labels.project === slug)) alert = seconds(t0);
    }
    await page.waitForTimeout(2_000);
  }
  result.detection = {
    note: 'stop pressed -> dashboard shows the container is not up / -> ContainerDown firing in Alertmanager (its Slack message was silenced for this test project)',
    secondsToDashboard: dashboard, secondsToAlert: alert,
    configured: { scrapeIntervalSeconds: 15, ruleFor: '1m', alertmanagerGroupWaitSeconds: 20 },
  };
  expect(alert).not.toBeNull();
});

test('the other numbers: merge-to-live, cost and footprint', async () => {
  // Merge to live: how long CI takes to build the image (GitHub), plus how long the platform then takes to deploy it (this database).
  const runs = JSON.parse(sh('gh', ['run', 'list', '--workflow', 'sample-app.yml', '--limit', '30', '--json', 'conclusion,startedAt,updatedAt'])) as { conclusion: string; startedAt: string; updatedAt: string }[];
  const ci = runs.filter((r) => r.conclusion === 'success').map((r) => (Date.parse(r.updatedAt) - Date.parse(r.startedAt)) / 1000);
  const deploy = psql(`select round(extract(epoch from ("finishedAt" - "startedAt"))::numeric,1) from "Deployment" where status='SUCCESS' and "triggerSource"='webhook' and "finishedAt" is not null`)
    .split('\n').filter(Boolean).map(Number);
  result.mergeToLive = {
    ciBuildSeconds: ci.length ? { n: ci.length, p50: Math.round(pct(ci, 50)), max: Math.round(Math.max(...ci)) } : null,
    platformDeploySeconds: deploy.length ? { n: deploy.length, p50: Math.round(pct(deploy, 50)), max: Math.round(Math.max(...deploy)) } : null,
  };

  // Footprint: memory the platform's containers actually use right now, against what compose allows them.
  const rows = sh('docker', ['stats', '--no-stream', '--format', '{{.Name}}|{{.MemUsage}}|{{.CPUPerc}}']).trim().split('\n').map((l) => l.split('|'));
  const toMiB = (s: string) => { const m = /([\d.]+)\s*(KiB|MiB|GiB)/.exec(s.split('/')[0]); return m ? Number(m[1]) * ({ KiB: 1 / 1024, MiB: 1, GiB: 1024 } as Record<string, number>)[m[2]] : 0; };
  const platform = rows.filter(([n]) => n.startsWith('aegisops-')).map(([n, mem, cpu]) => ({ name: n, mib: Math.round(toMiB(mem)), cpu }));
  result.footprint = {
    platformContainers: platform.length,
    platformMemoryMiB: platform.reduce((a, c) => a + c.mib, 0),
    largest: [...platform].sort((a, b) => b.mib - a.mib).slice(0, 6),
    hostMemoryMiB: Math.round(Number(sh('docker', ['info', '--format', '{{.MemTotal}}']).trim()) / 1048576),
  };
});
