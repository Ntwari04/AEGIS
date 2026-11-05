import { readFileSync } from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { createUser, deleteUser } from '../helpers/keycloak';
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

  test('10. a CI key deploys its own project, is shown only once, and stops working when revoked', async () => {
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
