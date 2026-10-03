import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

const PORT = 3100;

/**
 * Some environments ship a Chromium that does not match the revision this
 * Playwright version would download. When one is present, use it rather than
 * pulling a second copy; on CI, where `playwright install` has run, this is
 * empty and Playwright resolves its own.
 */
const preinstalledChromium = process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
const launchOptions = existsSync(preinstalledChromium)
  ? { executablePath: preinstalledChromium }
  : {};
const baseURL = `http://127.0.0.1:${PORT}`;

/**
 * E2E runs against a production build, not the dev server: middleware, ISR and
 * static generation all behave differently under `next dev`, and those are
 * exactly the layers the access-control tests will lean on from Phase 2.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL,
    trace: 'on-first-retry',
    locale: 'fr-FR',
    launchOptions,
  },
  projects: [
    // A distinct client address per project. The register form is limited to
    // five attempts per address in fifteen minutes, and both projects submit
    // it; without this they share one bucket and the later project is refused
    // by the throttle rather than by the rule under test. Vercel sets this
    // header in production — here it only tells the limiter that the two
    // browsers are two clients, which they are.
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], extraHTTPHeaders: { 'x-forwarded-for': '10.0.0.1' } },
    },
    {
      name: 'mobile',
      use: { ...devices['Pixel 7'], extraHTTPHeaders: { 'x-forwarded-for': '10.0.0.2' } },
    },
  ],
  webServer: {
    command: `npx next start --port ${PORT}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
