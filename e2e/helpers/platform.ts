import { execFileSync } from 'node:child_process';
import type { Page } from '@playwright/test';
import * as OTPAuth from 'otpauth';

/** Runs SQL as the superuser: reads the audit log, and seeds rows into the test project's own provisioned database. */
export function psql(sql: string, database = 'aegisops'): string {
  return execFileSync(
    'docker',
    ['exec', process.env.E2E_POSTGRES_CONTAINER ?? 'aegisops-postgres', 'psql', '-U', 'postgres', '-d', database, '-At', '-F', '|', '-c', sql],
    { encoding: 'utf8' },
  ).trim();
}

/**
 * Signs in through the real Keycloak pages. Handles whatever the realm asks for, in whatever order:
 * temporary-password change, TOTP enrolment (first login) or a TOTP code (later logins).
 * Returns the TOTP secret so a test can log in again.
 */
export async function signIn(page: Page, user: { username: string; password: string }, totpSecret?: string): Promise<string | undefined> {
  const origin = new URL(process.env.E2E_BASE_URL ?? 'https://localtest.me').origin;
  const inApp = (u: URL) => u.origin === origin && u.pathname.startsWith('/projects');

  await page.goto('/projects');
  await page.waitForURL(/\/login/);
  await page.getByTestId('signin').click();
  await page.waitForURL(/\/realms\/aegisops\//);
  await page.locator('#username').fill(user.username);
  await page.locator('#password').fill(user.password);
  await page.locator('#kc-login').click();

  let secret = totpSecret;
  for (let step = 0; step < 8; step++) {
    await Promise.race([
      page.waitForURL(inApp, { timeout: 20_000 }),
      page.locator('#password-new, #totp, #otp').first().waitFor({ timeout: 20_000 }),
    ]).catch(() => undefined);
    if (inApp(new URL(page.url()))) return secret;

    if (await page.locator('#password-new').isVisible()) {
      const next = `New-${user.password}-x9`;
      await page.locator('#password-new').fill(next);
      await page.locator('#password-confirm').fill(next);
      await page.locator('input[type=submit], button[type=submit]').first().click();
    } else if (await page.locator('#otp').isVisible()) {
      if (!secret) throw new Error('Keycloak asked for a TOTP code but no secret is known');
      await page.locator('#otp').fill(new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), digits: 6, period: 30 }).generate());
      await page.locator('#kc-login').click();
    } else if (await page.locator('#totp').isVisible()) {
      await page.getByRole('link', { name: /unable to scan/i }).click();
      secret = (await page.locator('#kc-totp-secret-key').innerText()).replace(/\s/g, '');
      await page.locator('#totp').fill(new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), digits: 6, period: 30 }).generate());
      await page.locator('#userLabel').fill('e2e');
      await page.locator('input[type=submit], button[type=submit]').first().click();
    }
  }
  throw new Error(`sign-in did not reach the application (stuck at ${page.url()})`);
}
