import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:5173';
const outputDir =
  process.env.PLAYWRIGHT_OUTPUT_DIR ||
  path.resolve(repoRoot, 'test-results', `playwright-${new Date().toISOString().replace(/[:.]/g, '-')}`);

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  timeout: 45_000,
  expect: {
    timeout: 10_000
  },
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  outputDir,
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off'
  },
  webServer: [
    {
      command: 'npm --prefix backend run dev',
      cwd: repoRoot,
      url: 'http://127.0.0.1:3000/health',
      reuseExistingServer: true,
      timeout: 120_000
    },
    {
      command: 'npm run dev -- --host 127.0.0.1',
      cwd: __dirname,
      url: baseURL,
      reuseExistingServer: true,
      timeout: 120_000
    }
  ],
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome']
      }
    }
  ]
});
