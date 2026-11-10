import { defineConfig } from '@playwright/test';

// The measurements of docs/measurements.md: slow, and they deploy a test project, so they are NOT part of `playwright test`.
//   npx playwright test -c playwright.measure.config.ts
export default defineConfig({
  testDir: './measure',
  timeout: 600_000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: process.env.E2E_BASE_URL ?? 'https://localtest.me', ignoreHTTPSErrors: true },
});
