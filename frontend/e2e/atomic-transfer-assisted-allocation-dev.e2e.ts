import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');
const fixtureTag = String(process.env.ATOMIC_TRANSFER_FIXTURE_TAG || '').trim().toUpperCase();
const storageStatePath = path.resolve(
  repoRoot,
  process.env.PLAYWRIGHT_STORAGE_STATE || '.secrets/playwright/dev-owner-storage-state.json'
);
const manifestPath = path.resolve(
  repoRoot,
  '.secrets/dev-fixtures',
  `${fixtureTag.toLowerCase()}.json`
);

let jobRoute = '';
let boxRoute = '';

test.describe('atomic transfer-assisted allocation DEV fixture', () => {
  test.skip(!fixtureTag, 'Set ATOMIC_TRANSFER_FIXTURE_TAG to run the guarded DEV workflow check.');
  test.use({ storageState: storageStatePath });

  test.beforeAll(() => {
    if (!fs.existsSync(storageStatePath)) {
      throw new Error('Missing ignored DEV browser auth storage state.');
    }
    if (!fs.existsSync(manifestPath)) {
      throw new Error('Missing ignored atomic-transfer DEV fixture manifest.');
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    jobRoute = String(manifest?.routes?.jobDetails?.[0] || '');
    boxRoute = String(manifest?.routes?.boxDetails?.[0] || '');
    if (!jobRoute.startsWith('/#/allocations/jobs/')) {
      throw new Error('Atomic-transfer fixture manifest has no guarded Job Details route.');
    }
    if (!boxRoute.startsWith('/#/inventory/')) {
      throw new Error('Atomic-transfer fixture manifest has no guarded Box Details route.');
    }
  });

  test('shows linked transfer custody without allowing checkout or staging', async ({ page }) => {
    const seriousErrors: string[] = [];
    page.on('pageerror', (error) => seriousErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') {
        seriousErrors.push(message.text());
      }
    });
    await page.goto(jobRoute);

    await expect(page.getByText('Film Transfer Alerts')).toBeVisible();
    await expect(
      page.locator('.job-transfer-alert-panel').getByText('Transfer Pending', { exact: true })
    ).toBeVisible();
    await expect(page.getByText(/Transfer in progress from .* to .*\./)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel Transfer' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Checkout All' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Mark Staged for Pickup' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Check Out' })).toHaveCount(0);
    await expect(page.getByText('TRANSFER', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /sign in/i })).toHaveCount(0);

    const workScopeValue = page
      .locator('.allocation-stat-grid .key-value')
      .filter({ hasText: 'WORK SCOPE' })
      .locator('dd');
    await expect(workScopeValue).toBeVisible();
    expect(
      await workScopeValue.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)
    ).toBe(true);

    await page.goto(boxRoute);
    await expect(page.getByText('Pending Transfer', { exact: true })).toBeVisible();
    await expect(page.getByText(/before the box can be checked out or staged/)).toBeVisible();

    await page.getByRole('button', { name: 'Receive Box' }).click();
    await expect(page.getByRole('heading', { name: 'Receive Transfer?' })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();

    await page.getByRole('button', { name: 'Cancel Transfer' }).click();
    await expect(page.getByRole('heading', { name: 'Cancel Transfer?' })).toBeVisible();
    await page.getByRole('button', { name: 'Keep Transfer' }).click();

    expect(seriousErrors).toEqual([]);
  });
});
