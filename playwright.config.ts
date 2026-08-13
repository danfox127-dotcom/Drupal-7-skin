import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    trace: 'on-first-retry',
    // Some tests need a real browser. If `npx playwright install` has not been run,
    // or the installed Chromium build does not match the version this Playwright
    // expects, point CHROME_PATH at an existing binary instead of downloading:
    //
    //   CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm test
    //
    // Left unset, Playwright uses its own managed browser as usual.
    ...(process.env.CHROME_PATH
      ? { launchOptions: { executablePath: process.env.CHROME_PATH } }
      : {}),
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
