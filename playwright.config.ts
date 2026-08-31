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
    /**
     * Two projects, because the extension tests cannot run in parallel with each other.
     *
     * Their `context` fixture launches a whole browser per test with an unpacked
     * extension loaded. Several of those at once contend badly: a full-suite run failed
     * "a deep parent can be selected" and "a large menu lists nothing until you type",
     * both of which pass every time on one worker. Left alone, the suite fails a random
     * couple of tests per run and trains everyone to ignore it.
     *
     * `fullyParallel: false` makes tests within a file run in order on a single worker.
     * The unit-style specs keep running fully parallel in the other project, so the
     * suite does not get slower overall.
     */
    {
      name: 'chromium',
      testIgnore: /extension\.test\.ts$/,
      /**
       * Parallel by FILE, not by test.
       *
       * With fullyParallel: true, tests inside one file are spread across workers, and
       * these drive real browser pages — a full run intermittently failed a couple of
       * them ("submits even with an empty required field on a hidden form", "returns null
       * rather than guessing"), all passing serially. Files still run concurrently, so
       * the suite stays quick.
       */
      fullyParallel: false,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'extension',
      testMatch: /extension\.test\.ts$/,
      /**
       * MUST run with `--workers=1`; `npm run test:extension` does that, and `npm test`
       * runs this project separately for the same reason.
       *
       * Each test in here launches a whole browser with an unpacked extension loaded.
       * Run them concurrently and a shifting two or three fail per run — a different set
       * every time, every one of them passing in isolation. `fullyParallel: false` is not
       * sufficient on its own; only one worker is.
       *
       * Left unfixed this is worse than a slow suite: it fails randomly, so people stop
       * believing failures.
       */
      fullyParallel: false,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
