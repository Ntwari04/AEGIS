import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createUser, deleteUser } from '../helpers/keycloak';
import { signIn } from '../helpers/platform';

/**
 * FR-UX-7: an automated WCAG 2.1 A/AA scan (axe-core, plus its best-practice rules) of every screen the dashboard serves, in both
 * colour themes, at desktop and phone width, with every folded section opened. Any violation fails the run.
 * Automated rules find roughly a third of accessibility problems: they cannot judge reading order, wording or how a screen reader
 * announces a live update, so this guards against regressions and is not a certification.
 * The Keycloak sign-in pages are Keycloak's own and are not scanned.
 */
test.describe('accessibility (WCAG 2.1 AA, automated)', () => {
  test('every screen, both themes, desktop and phone', async ({ browser }) => {
    test.setTimeout(400_000);
    const admin = await createUser('platform_admin', { temporary: true });
    const problems: string[] = [];
    const scan = async (page: Page, label: string) => {
      await page.evaluate(() => document.querySelectorAll('details').forEach((d) => { (d as HTMLDetailsElement).open = true; }));
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']).analyze();
      for (const v of r.violations) problems.push(`${label}: ${v.id} (${v.impact}) ${v.help} — ${v.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(' ; ')}`);
    };
    try {
      const ctx = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: process.env.E2E_BASE_URL ?? 'https://localtest.me', viewport: { width: 1280, height: 800 } });
      const page = await ctx.newPage();
      for (const scheme of ['dark', 'light'] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.goto('/login');
        await page.waitForLoadState('networkidle');
        await scan(page, `/login ${scheme}`);
        await page.goto('/no-such-page');
        await scan(page, `not-found ${scheme}`);
      }
      await signIn(page, admin);
      await page.goto('/projects');
      await page.waitForLoadState('networkidle');
      const project = await page.locator('a[href^="/projects/"]').evaluateAll((as) => as.map((a) => a.getAttribute('href')!).find((h) => /^\/projects\/[0-9a-f-]{36}$/.test(h)));
      expect(project, 'the scan needs at least one project to open its page').toBeTruthy();
      await page.goto(project!);
      const logs = await page.locator('a[href*="/logs"]').first().getAttribute('href');
      const paths = ['/projects', '/projects/new', project!, ...(logs ? [logs] : []), '/infra', '/backups', '/audit', '/api/docs'];

      for (const scheme of ['dark', 'light'] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        for (const [w, h] of [[1280, 800], [380, 800]] as const) {
          await page.setViewportSize({ width: w, height: h });
          for (const p of paths) {
            const res = await page.goto(p);
            await page.waitForLoadState('networkidle');
            expect(res?.status(), `${p} should load`).toBeLessThan(400);
            await scan(page, `${p} ${scheme} ${w}px`);
          }
        }
      }
      await ctx.close();
    } finally {
      deleteUser(admin.id);
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  test('the sidebar is reachable by keyboard and can be skipped', async ({ browser }) => {
    test.setTimeout(120_000);
    const admin = await createUser('platform_admin', { temporary: true });
    try {
      const ctx = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: process.env.E2E_BASE_URL ?? 'https://localtest.me' });
      const page = await ctx.newPage();
      await signIn(page, admin);
      await page.goto('/projects');
      await page.keyboard.press('Tab');
      await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
      await expect(page.getByRole('link', { name: 'Skip to content' })).toBeVisible();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/#main$/);
      // the nav is a named landmark and marks the current page
      await expect(page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Projects' })).toHaveAttribute('aria-current', 'page');
      // focus is visible on a nav link
      await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Backups' }).focus();
      const outline = await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Backups' }).evaluate((e) => getComputedStyle(e).outlineStyle);
      expect(outline).not.toBe('none');
      await ctx.close();
    } finally {
      deleteUser(admin.id);
    }
  });
});
