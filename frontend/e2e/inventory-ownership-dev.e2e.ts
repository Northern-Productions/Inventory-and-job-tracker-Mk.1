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
const fixtureTag = String(process.env.INVENTORY_OWNERSHIP_FIXTURE_TAG || '').trim();

function fixtureManifestPath(tag: string) {
  return path.resolve(repoRoot, '.secrets/dev-fixtures', `${tag.toLowerCase()}.json`);
}

async function expectOwnerToolPageOrGuard(page: import('@playwright/test').Page, visibleText: RegExp) {
  await expect(page.getByRole('main')).toContainText(/Owner Access Required|Owner Tools|Bulk Ownership Transfer/i);
  if (await page.getByRole('heading', { name: /Owner Access Required/i }).isVisible()) {
    await expect(page.getByText(/Only owners can open this page/i)).toBeVisible();
    return false;
  }

  await expect(page.getByText(visibleText)).toBeVisible();
  return true;
}

test.describe('DEV inventory ownership fixture UI', () => {
  test.skip(!fixtureTag, 'Set INVENTORY_OWNERSHIP_FIXTURE_TAG to run ownership fixture UI checks.');

  test.beforeAll(() => {
    if (!fs.existsSync(storageStatePath)) {
      throw new Error(
        `Missing DEV browser auth storage state at ${path.relative(repoRoot, storageStatePath)}. ` +
          'Run npm --prefix backend run browser-auth:dev first.'
      );
    }
    const manifestPath = fixtureManifestPath(fixtureTag);
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`Missing inventory ownership fixture manifest for ${fixtureTag}.`);
    }
  });

  test.use({ storageState: storageStatePath });

  test('shows owned film, caulk, owner management, and bulk transfer UI', async ({ page }) => {
    const manifest = JSON.parse(fs.readFileSync(fixtureManifestPath(fixtureTag), 'utf8'));
    const filmBoxId = manifest.summary.film.boxId;
    const activeOwnerCode = manifest.summary.film.ownerAfter;
    const retiredOwnerCode = manifest.summary.ownerCompanies.deactivatedCode;
    const retiredOwnerBoxId = (manifest.ids.boxIds as string[]).find((entry) => entry.includes('-CRET-'));
    const activeCaulkStockId = manifest.summary.caulk.ownerChange.stockId;

    if (!retiredOwnerBoxId) {
      throw new Error('Missing retained inactive-owner film box fixture ID.');
    }

    await page.goto(`/#/inventory/${encodeURIComponent(filmBoxId)}`);
    await expect(page.getByText('BOX DETAILS')).toBeVisible();
    await expect(page.getByRole('heading', { name: filmBoxId })).toBeVisible();
    await expect(page.getByText(activeOwnerCode).first()).toBeVisible();

    await page.goto(`/#/inventory/${encodeURIComponent(retiredOwnerBoxId)}`);
    await expect(page.getByText('BOX DETAILS')).toBeVisible();
    await expect(page.getByRole('heading', { name: retiredOwnerBoxId })).toBeVisible();
    await expect(page.getByText(retiredOwnerCode).first()).toBeVisible();

    await page.goto(`/#/caulk/stock/${encodeURIComponent(activeCaulkStockId)}`);
    await expect(page.getByText(/Caulk/i).first()).toBeVisible();
    await expect(page.getByText(activeOwnerCode).first()).toBeVisible();

    await page.goto('/#/owner/companies');
    if (await expectOwnerToolPageOrGuard(page, /Owner Companies/i)) {
      await expect(page.getByText('MGT').first()).toBeVisible();
      await expect(page.getByText('EDH').first()).toBeVisible();
      await expect(page.getByText('KAM').first()).toBeVisible();
      await expect(page.getByText(activeOwnerCode).first()).toBeVisible();
      await expect(page.getByText(retiredOwnerCode).first()).toBeVisible();
    }

    await page.goto('/#/owner/bulk-ownership-transfer');
    if (await expectOwnerToolPageOrGuard(page, /Bulk Ownership Transfer/i)) {
      await expect(page.getByLabel(/New owner company/i)).toBeVisible();
    }
  });
});
