import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');
const storageStatePath = path.resolve(
  repoRoot,
  process.env.PLAYWRIGHT_STORAGE_STATE || '.secrets/playwright/dev-storage-state.json'
);

test.beforeAll(() => {
  if (!fs.existsSync(storageStatePath)) {
    throw new Error(
      `Missing DEV browser auth storage state at ${path.relative(repoRoot, storageStatePath)}. ` +
      'Run npm --prefix backend run browser-auth:dev first.'
    );
  }
});

test.use({ storageState: storageStatePath });

test('loads an authenticated protected route without leaving the sign-in gate', async ({ page }) => {
  await page.goto('/#/');

  await expect(page.getByText('Window Film Inventory')).toBeVisible();
  await expect(page.getByText(/^Warehouse:/)).toBeVisible();
  await expect(page.getByText('Inventory').first()).toBeVisible();
  await expect(page.getByRole('textbox', { name: /email/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /sign in/i })).toHaveCount(0);
});
