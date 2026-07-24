import { defineConfig, devices } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'label-print-pagination.e2e.ts',
  timeout: 45_000,
  expect: {
    timeout: 10_000
  },
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [['list']],
  outputDir:
    process.env.PLAYWRIGHT_OUTPUT_DIR ||
    path.join(os.tmpdir(), 'window-film-label-print-playwright'),
  use: {
    ...devices['Desktop Chrome'],
    trace: 'off',
    screenshot: 'off',
    video: 'off'
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome']
      }
    }
  ]
});
