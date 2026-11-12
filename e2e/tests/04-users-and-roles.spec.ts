import { expect, test, type Page } from '@playwright/test';
import { createUser, deleteUser, findUserId } from '../helpers/keycloak';
import { signIn } from '../helpers/platform';

/**
 * The Platform Admin persona: manage users and roles from the dashboard (PRD 6.1). Real Keycloak, real service account.
 * The person it creates is named e2e-person-… so `npm run cleanup` finds it if a run dies halfway.
 */
const tag = Date.now().toString(36);
const person = `e2e-person-${tag}`;
const created: string[] = [];

test.describe.serial('users and roles', () => {
  let page: Page;
  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: process.env.E2E_BASE_URL ?? 'https://localtest.me' });
    page = await ctx.newPage();
  });
  test.afterAll(async () => {
    await page?.context().close();
    const id = findUserId(person);
    if (id) deleteUser(id);
    for (const id of created) deleteUser(id);
  });

  test('a platform admin adds a person: a temporary password is shown once, with the role chosen', async () => {
    test.setTimeout(180_000);
    const admin = await createUser('platform_admin', { temporary: true });
    created.push(admin.id);
    await signIn(page, admin);

    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Users' }).click();
    await expect(page.getByRole('heading', { name: 'Users and roles' })).toBeVisible();
    await expect(page.getByTestId(`user-${admin.username}`)).toContainText('you');
    // no controls to lock yourself out
    await expect(page.getByTestId(`actions-${admin.username}`)).toContainText('This is you');
    await expect(page.getByTestId(`disable-${admin.username}`)).toHaveCount(0);

    const fold = page.getByTestId('new-user-fold');
    await fold.locator('summary').click();
    await fold.getByLabel(/^Username/).fill(person);
    await fold.getByLabel('Email').fill(`${person}@example.test`);
    await fold.getByLabel('Role').selectOption('developer');
    await page.getByTestId('create-user').click();

    const password = page.getByTestId('temp-password');
    await expect(password).toHaveText(/^[A-Za-z2-9]{20}$/);
    const first = await password.innerText();
    await expect(page.getByTestId(`role-${person}`)).toHaveText('Developer', { timeout: 20_000 });

    // shown once: a reload does not bring it back, and it is nowhere in the URL
    await page.reload();
    await expect(page.getByTestId('temp-password')).toHaveCount(0);
    expect(page.url()).not.toContain(first);

    // the same name twice is refused in the form
    await fold.locator('summary').click();
    await fold.getByLabel(/^Username/).fill(person);
    await fold.getByLabel('Email').fill(`other-${person}@example.test`);
    await page.getByTestId('create-user').click();
    await expect(page.getByTestId('user-error')).toContainText(/already exists/i);
  });

  test('role change, reset, disable and enable each take effect and say so', async () => {
    test.setTimeout(120_000);
    await page.goto(`/admin/users?search=${person}`);
    const row = page.getByTestId(`user-${person}`);
    await expect(row).toBeVisible();

    await page.getByTestId(`role-select-${person}`).selectOption('auditor');
    await page.getByTestId(`role-save-${person}`).click();
    await expect(page.getByTestId(`ok-${person}`)).toContainText('is now auditor');
    await expect(page.getByTestId(`role-${person}`)).toHaveText('Auditor');

    await page.getByTestId(`reset-${person}`).click();
    await expect(page.getByTestId('temp-password')).toHaveText(/^[A-Za-z2-9]{20}$/);

    await page.getByTestId(`disable-${person}`).click();
    await expect(page.getByTestId(`enabled-${person}`)).toHaveText('Disabled');
    await page.getByTestId(`enable-${person}`).click();
    await expect(page.getByTestId(`enabled-${person}`)).toHaveText('Enabled');
  });

  test('every action is in the audit log, and no password is', async () => {
    await page.goto('/audit?action=admin.*');
    const body = page.locator('main');
    for (const action of ['admin.user.create', 'admin.user.role_change', 'admin.user.reset_password', 'admin.user.disable', 'admin.user.enable']) {
      await expect(body).toContainText(action);
    }
    await expect(body).toContainText(person);
    await expect(body).not.toContainText(/temporaryPassword|password":/i);
  });

  test('nobody else can open the screen or sees it in the menu', async ({ browser }) => {
    test.setTimeout(120_000);
    const dev = await createUser('developer', { temporary: true });
    created.push(dev.id);
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: process.env.E2E_BASE_URL ?? 'https://localtest.me' });
    const p = await ctx.newPage();
    try {
      await signIn(p, dev);
      await expect(p.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Users' })).toHaveCount(0);
      const res = await p.goto('/admin/users');
      expect(res?.status()).toBe(404);
      const api = await p.request.get('/api/v1/admin/users');
      expect([401, 403, 404]).toContain(api.status());
    } finally {
      await ctx.close();
    }
  });
});
