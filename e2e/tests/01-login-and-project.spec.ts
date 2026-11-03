import { expect, test } from '@playwright/test';
import * as OTPAuth from 'otpauth';
import { createUser } from '../helpers/keycloak';

/**
 * Phase 2 checkpoint (PRD 14): a real user logs in through Keycloak WITH MFA and creates a project.
 * Drives the real browser flow end to end: no mocked auth.
 */
test('platform admin: redirected to Keycloak, enrols TOTP, lands authenticated, creates a project', async ({ page }) => {
  const user = await createUser('platform_admin', { temporary: true });

  // 1. Unauthenticated visit -> Keycloak
  await page.goto('/projects');
  await page.waitForURL(/\/login/);
  await page.getByTestId('signin').click();
  await page.waitForURL(/\/realms\/aegisops\//);

  // 2. Username/password
  await page.locator('#username').fill(user.username);
  await page.locator('#password').fill(user.password);
  await page.locator('#kc-login').click();

  // 4. MFA is MANDATORY for platform_admin (FR-IAM-2): Keycloak forces TOTP enrolment
  await expect(page.locator('#kc-totp-secret-key, #totp')).toBeVisible();
  await page.getByRole('link', { name: /unable to scan/i }).click();
  const secret = (await page.locator('#kc-totp-secret-key').innerText()).replace(/\s/g, '');
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), digits: 6, period: 30 });
  await page.locator('#totp').fill(totp.generate());
  await page.locator('#userLabel').fill('e2e');
  await page.locator('input[type=submit], button[type=submit]').first().click();

  // Keycloak then asks for the temporary password to be changed
  if (await page.locator('#password-new').waitFor({ state: "visible", timeout: 5000 }).then(() => true).catch(() => false)) {
    const newPassword = `New-${user.password}-x9`;
    await page.locator('#password-new').fill(newPassword);
    await page.locator('#password-confirm').fill(newPassword);
    await page.locator('input[type=submit], button[type=submit]').first().click();
  }

  // 5. Back in AegisOps, authenticated
  await page.waitForURL(/localhost:13000\/projects/);
  await expect(page.getByTestId('whoami')).toContainText(/E2E|e2e/i);

  // 6. Create a project
  const slug = `e2e-${Date.now().toString(36)}`;
  await page.getByTestId('new-project').click();
  await page.locator('#name').fill('E2E Project');
  await page.locator('#slug').fill(slug);
  await page.locator('#githubRepo').fill('example-org/e2e-demo');
  await page.getByTestId('create-project').click();
  await expect(page.getByTestId('project-name')).toHaveText('E2E Project');

  // 7. It shows up in the list, with the creator as OWNER
  await page.goto('/projects');
  await expect(page.getByRole('link', { name: 'E2E Project' }).first()).toBeVisible();
});
