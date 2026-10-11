import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

/**
 * Browser tests for code that only exists in a browser: MediaRecorder, canvas
 * capture, IndexedDB. No app server — each spec serves its own page — so this
 * runs in seconds, on every PR, with a fake camera and microphone.
 *
 * Separate from `playwright.config.ts`, which drives the production build.
 */
const preinstalledChromium = process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';

export default defineConfig({
  testDir: './tests/browser',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // Timing-based assertions on a shared CI runner: one retry, never more. A
  // second failure is a real failure.
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: {
    browserName: 'chromium',
    permissions: ['camera', 'microphone'],
    launchOptions: {
      ...(existsSync(preinstalledChromium) ? { executablePath: preinstalledChromium } : {}),
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
  },
});
