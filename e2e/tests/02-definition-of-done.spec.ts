import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { addRole, createUser, deleteUser } from '../helpers/keycloak';
import { psql, signIn } from '../helpers/platform';

/**
 * PRD "definition of done": the eight steps, in order, against the real stack (Keycloak with MFA, Nginx + HTTPS,
 * Docker deployer, Prometheus/Loki, Postgres backups). Nothing is mocked.
 * The one stand-in: step 3 deploys through the dashboard instead of a GitHub push. Both create the same deployment
 * (the webhook path is covered by the integration suite), and the images are real ones CI built and pushed to GHCR.
 * A webhook is not used here because it deploys EVERY project linked to the repository, including real ones.
 */
const REPO = process.env.E2E_GITHUB_REPO ?? 'Ntwari04/AEGIS';
const GOOD_SHA = process.env.E2E_GOOD_SHA ?? '8b12f2f7647da0b1564e2cb72188eae9cebc0ebd'; // healthy sample-app image
const BAD_SHA = process.env.E2E_BAD_SHA ?? 'cc141498985dfede9f1ebfc193742f67a0b758c2'; // sample-app whose health check fails

const tag = Date.now().toString(36);
const slug = `e2e-${tag}`;
const domain = `${slug}.localtest.me`;
const created: string[] = [];
const state: { projectId?: string; admin?: Awaited<ReturnType<typeof createUser>> } = {};

async function freshPage(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: process.env.E2E_BASE_URL ?? 'https://localtest.me' });
  return ctx.newPage();
}

test.describe.serial('definition of done', () => {
  let page: Page;
  test.beforeAll(async ({ browser }) => {
    page = await freshPage(browser);
  });
  test.afterAll(async () => {
    await page?.context().close();
    for (const id of created) deleteUser(id);
  });

  test('1. platform admin signs in with MFA', async () => {
    const admin = await createUser('platform_admin', { temporary: true });
    created.push(admin.id);
    state.admin = admin;
    const secret = await signIn(page, admin);
    expect(secret, 'TOTP enrolment is mandatory for platform_admin').toBeTruthy();
    await expect(page.getByTestId('whoami')).toContainText(/e2e/i);
  });

  test('2. creates a project linked to a GitHub repository, with an environment', async () => {
    await page.getByTestId('new-project').click();
    await page.locator('#name').fill(`E2E ${tag}`);
    await page.locator('#slug').fill(slug);
    await page.locator('#githubRepo').fill(REPO);
    await page.getByTestId('create-project').click();
    await expect(page.getByTestId('project-name')).toHaveText(`E2E ${tag}`);
    state.projectId = new URL(page.url()).pathname.split('/').pop();
    await expect(page.getByText(REPO)).toBeVisible();

    await page.locator('#env-name').fill('staging');
    await page.locator('#env-domain').fill(domain);
    await page.locator('#env-mem').fill('256');
    await page.getByTestId('add-environment').click();
    await expect(page.getByTestId('env-staging')).toContainText(domain);
    await expect(page.getByTestId('page-error')).toHaveCount(0);
  });

  /** Deploys through the dashboard's own form, so only THIS project's environment is touched. */
  async function deployFromDashboard(sha: string) {
    await page.goto(`/projects/${state.projectId}`);
    await page.getByTestId('env-staging').locator('input[name=commitSha]').fill(sha);
    await page.getByTestId('deploy-staging').click();
  }

  test('3. a deployment is built into a healthy container that answers on HTTPS', async () => {
    test.setTimeout(240_000);
    await deployFromDashboard(GOOD_SHA);
    const first = page.getByTestId('history-staging').locator('tbody tr').first().locator('.status');
    await expect(first).toHaveText('SUCCESS', { timeout: 200_000 });

    const live = await page.request.get(`https://${domain}/`);
    expect(live.status()).toBe(200);
    await expect(page.getByTestId('env-staging')).toContainText(`live: ${GOOD_SHA.slice(0, 7)}`);
  });

  test('4. the dashboard shows health, CPU and memory, with Grafana and Loki links', async () => {
    test.setTimeout(180_000);
    await page.goto('/projects');
    const card = page.getByTestId(`project-${slug}`);
    const row = card.getByTestId('health-staging');
    await expect(row.getByTestId('state-staging')).toHaveText('Up', { timeout: 120_000 });
    // CPU and memory come from the exporter's next scrape; the page refreshes itself every 15 s.
    await expect(row.locator('td').nth(3)).not.toHaveText('—', { timeout: 90_000 });
    await expect(row.locator('td').nth(4)).toContainText(/MB|MiB|KB|GB/i, { timeout: 90_000 });
    await expect(row.locator('td').nth(4)).toContainText('256');
    // FR-DASH-1: storage per environment (what the container has written to its own filesystem).
    await expect(row.getByTestId('storage-staging')).toHaveText(/^[\d.]+ (KB|MB|GB)$/, { timeout: 90_000 });

    const links = row.locator('.links a');
    await expect(links).toHaveCount(2);
    for (const a of await links.all()) expect(await a.getAttribute('href')).toContain('grafana.');
    expect(await links.nth(1).getAttribute('href')).toMatch(/explore|loki/i);

    // The in-app log search reads the same Loki; it must load without a problem banner.
    await page.goto(`/projects/${state.projectId}`);
    await page.getByTestId('logs-staging').click();
    await expect(page.getByTestId('logs-problem')).toHaveCount(0);
    await expect(page.getByTestId('log-lines').or(page.getByTestId('no-logs'))).toBeVisible();
  });

  test('5. a bad deployment fails its health gate and is rolled back automatically', async () => {
    test.setTimeout(300_000);
    await deployFromDashboard(BAD_SHA);
    const newest = page.getByTestId('history-staging').locator('tbody tr').first();
    await expect(newest.locator('.status')).toHaveAttribute('data-status', /FAILED|ROLLED_BACK/, { timeout: 240_000 });
    await expect(newest).toContainText(BAD_SHA.slice(0, 7));

    // The previous version is still the live one, and still answers.
    await expect(page.getByTestId('env-staging')).toContainText(`live: ${GOOD_SHA.slice(0, 7)}`);
    expect((await page.request.get(`https://${domain}/`)).status()).toBe(200);
    await page.goto('/projects');
    await expect(page.getByTestId(`project-${slug}`).getByTestId('state-staging')).toHaveText('Up', { timeout: 60_000 });
  });

  test('6. backs up a database and restores it to a new one with the integrity check passing', async () => {
    test.setTimeout(420_000);
    await page.goto(`/projects/${state.projectId}`);
    await page.locator('#db-name').fill('e2edb');
    await page.locator('#db-env').selectOption({ label: 'staging' });
    await page.getByTestId('provision-db').click();
    const db = page.getByTestId('db-e2edb');
    await expect(db.locator('.status')).toHaveText('READY', { timeout: 150_000 });
    // Real data, so the integrity check proves rows survive: exactly 1 table and 3 rows must come back.
    const pgName = psql(`select "pgName" from "Database" where "projectId"='${state.projectId}' and name='e2edb'`);
    expect(pgName).toMatch(/^app_/);
    psql('create table orders (id int primary key, note text); insert into orders values (1,\'a\'),(2,\'b\'),(3,\'c\');', pgName);
    await db.getByRole('link', { name: 'Backups' }).click();

    await page.getByTestId('backup-now').click();
    const backup = page.getByTestId('backup-history').locator('tbody tr').first();
    await expect(backup.locator('.status')).toHaveText('SUCCESS', { timeout: 150_000 });

    await backup.locator('summary', { hasText: 'Restore' }).click();
    await backup.getByTestId('restore-new').click();
    const restore = page.getByTestId('restore-history').locator('tbody tr').first();
    await expect(restore.locator('.status')).toHaveText('SUCCESS', { timeout: 200_000 });
    await expect(restore).toContainText('verified: 1 tables, 3 rows');
    await expect(restore).toContainText(/restore_/);
  });

  test('7. a developer cannot see another team’s project, and the attempt is audited', async ({ browser }) => {
    test.setTimeout(150_000);
    const dev = await createUser('developer', { temporary: true });
    created.push(dev.id);
    const devPage = await freshPage(browser);
    try {
      await signIn(devPage, dev);
      await expect(devPage.getByTestId('empty')).toBeVisible();
      await expect(devPage.getByTestId('new-project')).toHaveCount(0);
      await expect(devPage.getByText(`E2E ${tag}`)).toHaveCount(0);

      // Guessing the address does not help.
      await devPage.goto(`/projects/${state.projectId}`);
      await expect(devPage.getByTestId('project-name')).toHaveCount(0);
      await expect(devPage.getByText(domain)).toHaveCount(0);
      await devPage.goto('/infra');
      await expect(devPage.getByTestId('platform-action')).toHaveCount(0);

      const who = dev.username.split('-').pop()!; // random suffix, whether the log keeps username or email
      await expect
        .poll(() => psql(`select count(*) from "AuditLogEntry" where action='authz.project_denied' and result='DENIED' and "targetId"='${state.projectId}' and "actorName" like '%${who}%'`), { timeout: 30_000 })
        .not.toBe('0');

      // Membership is what grants access (FR-IAM-4 / FR-PROJ-4): the admin adds the developer in the dashboard, and takes them out again.
      await page.goto(`/projects/${state.projectId}`);
      await page.getByText('Add a member').click(); // the form is folded away once a project has members
      await page.locator('#member-username').fill(dev.username);
      await page.getByTestId('add-member').click();
      await expect(page.getByTestId(`member-${dev.username}`)).toBeVisible();
      await devPage.goto('/projects');
      await expect(devPage.getByTestId(`project-${slug}`)).toBeVisible();
      await devPage.goto(`/projects/${state.projectId}`);
      await expect(devPage.getByTestId('project-name')).toHaveText(`E2E ${tag}`);
      await expect(devPage.getByTestId('add-member')).toHaveCount(0); // a developer can read the team, not change it

      await page.getByTestId(`remove-${dev.username}`).click();
      await expect(page.getByTestId(`member-${dev.username}`)).toHaveCount(0);
      await devPage.goto(`/projects/${state.projectId}`);
      await expect(devPage.getByTestId('project-name')).toHaveCount(0);
    } finally {
      await devPage.context().close();
    }
  });

  test('8. an auditor can read everything and change nothing', async ({ browser }) => {
    test.setTimeout(150_000);
    const aud = await createUser('auditor', { temporary: true });
    created.push(aud.id);
    const audPage = await freshPage(browser);
    try {
      await signIn(audPage, aud);
      await expect(audPage.getByTestId(`project-${slug}`)).toBeVisible();
      await expect(audPage.getByTestId('new-project')).toHaveCount(0);

      await audPage.goto(`/projects/${state.projectId}`);
      await expect(audPage.getByTestId('env-staging')).toContainText(domain);
      await expect(audPage.getByTestId('history-staging')).toBeVisible();
      for (const id of ['deploy-staging', 'set-secret-staging', 'add-environment', 'provision-db', 'restart-staging', 'stop-staging', 'add-member', 'api-keys-card']) {
        await expect(audPage.getByTestId(id), `${id} must not be offered to an auditor`).toHaveCount(0);
      }
      await expect(audPage.getByTestId('db-e2edb')).toBeVisible();

      await audPage.goto('/infra');
      await expect(audPage.locator('[data-testid^="server-"]').first()).toBeVisible();
      for (const id of ['drain', 'register-server', 'platform-action']) {
        await expect(audPage.getByTestId(id), `${id} must not be offered to an auditor`).toHaveCount(0);
      }
      await audPage.goto('/backups');
      await expect(audPage.getByTestId('drill-now')).toHaveCount(0);

      // The audit log is the auditor's tool: searchable and exportable, with nothing to edit.
      await audPage.goto('/audit');
      await expect(audPage.getByTestId('audit-table')).toBeVisible();
      await expect(audPage.getByTestId('audit-export')).toBeVisible();
      await audPage.locator('#f-result').selectOption('DENIED');
      await audPage.getByTestId('audit-search').click();
      await expect(audPage.getByTestId('audit-row').first()).toContainText('DENIED');
      for (const row of await audPage.getByTestId('audit-row').all()) await expect(row).toContainText('DENIED');
    } finally {
      await audPage.context().close();
    }
  });

  test('9. the audit log can be searched and exported, and the export is itself recorded', async () => {
    await page.goto('/audit');
    await expect(page.getByTestId('audit-table')).toBeVisible();
    await page.locator('#f-action').fill('project.create');
    await page.getByTestId('audit-search').click();
    await expect(page.getByTestId('audit-row').first()).toContainText('project.create');
    for (const row of await page.getByTestId('audit-row').all()) await expect(row).toContainText('project.create');

    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('audit-export').click()]);
    const csv = readFileSync((await download.path())!, 'utf8');
    expect(csv.split('\r\n')[0]).toBe('time,actor,actor_id,action,result,target_type,target_id,source_ip,metadata');
    expect(csv).toContain('project.create');
    expect(csv).not.toContain('authz.project_denied'); // the filter applies to the export, not just the page

    const who = state.admin!.username.split('-').pop()!;
    await expect
      .poll(() => psql(`select count(*) from "AuditLogEntry" where action='audit.export' and result='SUCCESS' and "actorName" like '%${who}%'`), { timeout: 30_000 })
      .not.toBe('0');
  });

  test('10. signing out ends the Keycloak session too: signing back in asks for a password again', async ({ browser }) => {
    test.setTimeout(150_000);
    const person = await createUser('developer', { temporary: true });
    created.push(person.id);
    const p = await freshPage(browser);
    try {
      await signIn(p, person);
      await p.getByRole('button', { name: 'Sign out' }).click();
      await p.locator('#kc-logout').click(); // Keycloak asks to confirm when it is not given the ID token
      await p.waitForURL(/\/login/);

      await p.goto('/projects');
      await p.waitForURL(/\/login/);
      await p.getByTestId('signin').click();
      await p.waitForURL(/\/realms\/aegisops\//);
      await expect(p.locator('#username')).toBeVisible(); // the login form, not a silent sign-in
    } finally {
      await p.context().close();
    }
  });

  test('11. sign-ins and role changes reach the audit log, and a role change takes effect within about a minute', async ({ browser }) => {
    test.setTimeout(420_000);
    const person = await createUser('developer', { temporary: true });
    created.push(person.id);
    const p = await freshPage(browser);
    try {
      await signIn(p, person);
      await expect(p.getByRole('link', { name: 'Audit log' })).toHaveCount(0);

      // FR-IAM-6: Keycloak's sign-in event is copied into the audit log (Keycloak -> Promtail -> Loki -> API).
      const seen = async (query: string) => {
        await page.goto(`/audit?${query}`);
        return page.getByTestId('audit-row').count();
      };
      await expect.poll(() => seen(`action=auth.login&actor=${person.username}`), { timeout: 150_000, intervals: [5_000] }).toBeGreaterThan(0);

      // FR-IAM-7: an administrator gives them another role. They must not wait out their 15-minute token to get it.
      addRole(person.username, 'auditor');
      await expect
        .poll(async () => {
          await p.goto('/projects');
          if (/\/login/.test(p.url())) await p.getByTestId('signin').click(); // sent to sign in again: silent while their Keycloak session lives
          await p.waitForURL(/\/projects/);
          return p.getByRole('link', { name: 'Audit log' }).count();
        }, { timeout: 180_000, intervals: [5_000] })
        .toBeGreaterThan(0);

      // The audit log tells the story: the change, and the refused old token.
      await expect.poll(() => seen('action=auth.admin.realm_role_mapping.create'), { timeout: 60_000, intervals: [5_000] }).toBeGreaterThan(0);
      await expect.poll(() => seen(`action=auth.token_revoked&actor=${person.username}`), { timeout: 60_000, intervals: [5_000] }).toBeGreaterThan(0);
    } finally {
      await p.context().close();
    }
  });

  test('12. the API reference is generated from the running API, and only for signed-in people', async ({ browser }) => {
    test.setTimeout(120_000);
    await page.goto('/api/docs');
    await expect(page.getByTestId('api-count')).toContainText(/\d+ operations/);
    const op = page.getByTestId('api-op-get-/audit-log');
    await expect(op).toBeVisible();
    await expect(op).toContainText('platform_admin');
    await expect(op).toContainText('auditor');
    await expect(op).not.toContainText('developer'); // the roles shown are the roles the guard checks
    await op.locator('summary').click();
    await expect(op).toContainText('one of SUCCESS, DENIED, ERROR'); // validation rules come from the same DTOs the API enforces
    await expect(page.getByTestId('api-op-post-/ci/deployments')).toContainText('no user token');

    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('openapi-download').click()]);
    const doc = JSON.parse(readFileSync((await download.path())!, 'utf8'));
    expect(doc.openapi).toBe('3.0.3');
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(['/projects', '/audit-log', '/projects/{projectId}/environments']));

    // Signed out, neither the page nor the file is reachable: both lead to the sign-in page.
    const anon = await freshPage(browser);
    try {
      await anon.goto('/api/docs');
      await anon.waitForURL(/\/login/);
      await anon.goto('/api/docs/openapi.json');
      await anon.waitForURL(/\/login/);
    } finally {
      await anon.context().close();
    }
  });

  test('13. the page policy lets only nonce-marked scripts run, the app works under it, and injected script is refused', async () => {
    test.setTimeout(240_000);
    const violations: string[] = [];
    await page.exposeFunction('reportViolation', (v: string) => violations.push(v));
    await page.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (e) => (window as unknown as { reportViolation: (v: string) => void }).reportViolation(`${e.violatedDirective} ${e.blockedURI || 'inline'}`));
    });
    const policies: string[] = [];
    page.on('response', (r) => { if (r.request().resourceType() === 'document') policies.push(r.headers()['content-security-policy'] ?? ''); });

    const inlineScripts = () => page.evaluate(() => [...document.scripts].filter((s) => !s.src).map((s) => s.nonce));
    for (const url of ['/projects', `/projects/${state.projectId}`, '/audit', '/backups', '/infra', '/api/docs']) {
      await page.goto(url);
      await page.waitForLoadState('networkidle');
      const nonce = /'nonce-([^']+)'/.exec(policies[policies.length - 1] ?? '')?.[1];
      expect(nonce, `${url} must carry a nonce policy`).toBeTruthy();
      const nonces = await inlineScripts();
      expect(nonces.length).toBeGreaterThan(0); // Next.js's own bootstrap scripts
      expect(nonces.every((n) => n === nonce), `every inline script on ${url} carries this request's nonce`).toBe(true);
    }
    await page.getByTestId('api-op-get-/audit-log').locator('summary').click(); // interactive page parts still work

    // The policy: nonce plus strict-dynamic, no 'unsafe-inline' for scripts, nothing framed, nonce different every time.
    const last = policies[policies.length - 1];
    const scriptSrc = /script-src ([^;]+)/.exec(last)![1];
    expect(scriptSrc).toContain("'strict-dynamic'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(last).toContain("object-src 'none'");
    expect(last).toContain("frame-ancestors 'none'");
    expect(new Set(policies.map((p) => /'nonce-([^']+)'/.exec(p)?.[1])).size).toBe(policies.length);

    expect(violations, 'the dashboard must not trip its own policy').toEqual([]);

    // An attacker who gets MARKUP into the page cannot run script: an inline event handler is refused, and so is a parser-inserted inline
    // <script> (here in a framed document, which inherits the page's policy and has no nonce). The one thing 'strict-dynamic' allows by
    // design is a script CREATED by code that is already trusted (createElement), so that is not what is tested here: it needs script
    // execution already, which is what the policy exists to prevent.
    await page.evaluate(() => {
      document.body.insertAdjacentHTML('beforeend', '<img src="x" onerror="window.__pwned = true">');
      const frame = document.createElement('iframe');
      frame.srcdoc = '<script>parent.__pwned2 = true</script>';
      document.body.appendChild(frame);
    });
    await page.waitForTimeout(800);
    expect(await page.evaluate(() => [(window as unknown as { __pwned?: boolean }).__pwned, (window as unknown as { __pwned2?: boolean }).__pwned2])).toEqual([undefined, undefined]);
    expect(violations.length).toBeGreaterThan(0);
  });

  test('14. live logs follow the application as it writes, resume after a pause without repeating, and refuse outsiders', async ({ browser }) => {
    test.setTimeout(300_000);
    const marker = `live-${tag}`;
    // The deployed app is only started for a moment; write straight to the container's output, as an application's own logging would.
    const container = execFileSync('docker', ['ps', '--filter', `name=aegis-${slug}-staging`, '--format', '{{.Names}}'], { encoding: 'utf8' }).trim().split('\n')[0];
    expect(container, 'the test environment must be running').toBeTruthy();
    const say = (text: string) => execFileSync('docker', ['exec', container, 'sh', '-c', `echo '${text}' > /proc/1/fd/1`]);

    await page.goto(`/projects/${state.projectId}`);
    const logsHref = (await page.getByTestId('logs-staging').getAttribute('href'))!;
    await page.goto(logsHref);
    await expect(page.getByTestId('live-status')).toHaveText('Not started');
    await page.getByTestId('live-start').click();
    await expect(page.getByTestId('live-status')).toHaveText('Live', { timeout: 30_000 });

    say(`${marker} one`);
    await expect(page.getByTestId('live-lines')).toContainText(`${marker} one`, { timeout: 90_000 }); // container -> Promtail -> Loki -> API -> browser

    await page.getByTestId('live-pause').click();
    await expect(page.getByTestId('live-status')).toHaveText('Paused');
    say(`${marker} two`);
    say(`${marker} three`);
    await page.getByTestId('live-start').click(); // resumes after the last line it has
    await expect(page.getByTestId('live-lines')).toContainText(`${marker} three`, { timeout: 90_000 });
    const shown = await page.getByTestId('live-lines').innerText();
    for (const n of ['one', 'two', 'three']) expect(shown.split(`${marker} ${n}`).length - 1, `"${n}" appears exactly once`).toBe(1);

    // Outsiders: someone who is not a member of the project gets nothing, and neither does a signed-out visitor.
    const envId = /environments\/([^/]+)\/logs/.exec(logsHref)![1];
    const streamUrl = `/projects/${state.projectId}/environments/${envId}/logs/stream`;
    const outsider = await createUser('developer', { temporary: true });
    created.push(outsider.id);
    const dev = await freshPage(browser);
    const anon = await freshPage(browser);
    try {
      await signIn(dev, outsider);
      expect((await dev.request.get(streamUrl)).status()).toBe(404);
      const signedOut = await anon.request.get(streamUrl);
      expect(signedOut.url()).toMatch(/\/login/); // sent to sign in, not given a stream
    } finally {
      await dev.context().close();
      await anon.context().close();
    }
  });

  test('15. screens read clearly: styled not-found page, labelled unambiguous times, slug suggestion, form kept on error, and nothing scrolls sideways on a phone', async () => {
    test.setTimeout(240_000);

    // A page that is not there, or not yours, looks like the rest of the app and leads somewhere.
    await page.goto('/projects/00000000-0000-0000-0000-000000000000');
    await expect(page.getByTestId('not-found')).toBeVisible();
    await page.getByRole('link', { name: 'Back to projects' }).click();
    await page.waitForURL(/\/projects$/);

    // Times name their month and their zone, and the exact UTC instant is in the tooltip.
    await page.goto('/audit');
    const time = page.locator('time').first();
    await expect(time).toHaveAttribute('title', /\(UTC\)$/);
    // The month is a NAME (in the viewer's own order: "12 Nov 2026" or "Nov 12, 2026") and the zone is named, never a bare 11/12/2026.
    await expect(time).toHaveText(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b.*\b\d{4}\b/);
    await expect(time).toHaveText(/UTC|GMT|[A-Z]{2,5}$/);

    // The slug follows the name until the person writes their own, and a refused form comes back filled in.
    await page.goto('/projects/new');
    await page.locator('#name').fill('My Billing App');
    await expect(page.locator('#slug')).toHaveValue('my-billing-app');
    await page.locator('#slug').fill('custom-slug');
    await page.locator('#name').fill('Other Name');
    await expect(page.locator('#slug')).toHaveValue('custom-slug');
    await page.locator('#githubRepo').fill('nobody/not-installed-' + tag);
    await page.getByTestId('create-project').click();
    await expect(page.getByTestId('form-error')).toBeVisible();
    await expect(page.locator('#name')).toHaveValue('Other Name');
    await expect(page.locator('#slug')).toHaveValue('custom-slug');
    await expect(page.locator('#githubRepo')).toHaveValue('nobody/not-installed-' + tag);

    // On a phone: no sideways scrolling anywhere, and a table row keeps its important cells on screen.
    await page.setViewportSize({ width: 390, height: 844 });
    try {
      for (const url of ['/projects', `/projects/${state.projectId}`, '/audit', '/backups', '/infra', '/api/docs']) {
        await page.goto(url);
        await page.waitForLoadState('networkidle');
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, `${url} must not scroll sideways on a phone`).toBeLessThanOrEqual(1);
      }
      await page.goto(`/projects/${state.projectId}`);
      const commit = page.getByTestId('history-staging').locator('td[data-label="Commit"]').first();
      await expect(commit).toBeVisible();
      const box = (await commit.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(390);
    } finally {
      await page.setViewportSize({ width: 1280, height: 720 });
    }
  });

  test('16. the page updates itself during a deployment without discarding what was typed or unfolded', async () => {
    test.setTimeout(300_000);
    await page.goto(`/projects/${state.projectId}`);
    await page.getByTestId('env-staging').locator('input[name=commitSha]').fill(BAD_SHA); // takes about a minute: it fails its health check and is rolled back
    await page.getByTestId('deploy-staging').click();
    const newest = page.getByTestId('history-staging').locator('tbody tr').first().locator('.status');
    await expect(newest).toHaveAttribute('data-status', /PENDING|RUNNING/, { timeout: 30_000 });

    // The person starts filling in something else, and unfolds a form, while the deployment is still running.
    await page.getByText('Add a member').click();
    await page.locator('#member-username').fill('half-typed-name');
    await page.locator('#member-username').blur(); // not typing any more, so the page is free to refresh
    await page.evaluate(() => { (window as unknown as { __notReloaded: boolean }).__notReloaded = true; });

    // The history changes by itself...
    await expect(newest).toHaveAttribute('data-status', /ROLLED_BACK|FAILED/, { timeout: 240_000 });

    // ...and it was updated in place: the page was never reloaded, and nothing the person did was lost.
    expect(await page.evaluate(() => (window as unknown as { __notReloaded?: boolean }).__notReloaded)).toBe(true);
    await expect(page.locator('#member-username')).toHaveValue('half-typed-name');
    await expect(page.locator('details', { has: page.locator('#member-username') })).toHaveAttribute('open', '');
    expect(await page.locator('meta[http-equiv="refresh"]').count()).toBe(0);

    // FR-DASH-4: the alert this failed deployment raises is not a bare notification; it leads to Grafana's panel and to the logs.
    const card = page.getByTestId(`project-${slug}`);
    await expect
      .poll(async () => { await page.goto('/projects'); return card.getByTestId('alert-panel').count(); }, { timeout: 180_000, intervals: [5_000] })
      .toBeGreaterThan(0);
    expect(await card.getByTestId('alert-panel').first().getAttribute('href')).toMatch(/grafana\.[^/]+\/d\/aegisops-env\?var-project=e2e-/);
    expect(await card.getByTestId('alert-logs').first().getAttribute('href')).toMatch(/\/explore\?/);
  });

  test('17. a CI key deploys its own project, is shown only once, and stops working when revoked', async () => {
    test.setTimeout(150_000);
    await page.goto(`/projects/${state.projectId}`);
    await page.locator('#key-name').fill('e2e-ci');
    await page.getByTestId('create-api-key').click();
    const shown = page.getByTestId('new-api-key');
    await expect(shown).toBeVisible();
    const key = (await shown.innerText()).trim();
    expect(key).toMatch(/^aegis_[A-Za-z0-9_-]{20,}$/);

    // After a reload the key is gone: only its first characters are listed.
    await page.goto(`/projects/${state.projectId}`);
    await expect(page.getByTestId('new-api-key')).toHaveCount(0);
    await expect(page.getByTestId('api-key-e2e-ci')).toContainText(key.slice(0, 12));
    await expect(page.getByTestId('api-key-e2e-ci')).not.toContainText(key);

    const call = () => page.request.post('/api/v1/ci/deployments', { headers: { 'X-API-Key': key }, data: { environment: 'staging', commitSha: GOOD_SHA } });
    expect((await call()).status()).toBe(201);

    await page.getByTestId('revoke-e2e-ci').click();
    await expect(page.getByTestId('api-key-e2e-ci')).toContainText('revoked');
    expect((await call()).status()).toBe(401);
  });
});
