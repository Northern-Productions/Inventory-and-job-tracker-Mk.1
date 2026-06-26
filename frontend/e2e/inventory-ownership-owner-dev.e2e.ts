import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');
const fixtureTag = String(process.env.INVENTORY_OWNERSHIP_OWNER_FIXTURE_TAG || '').trim();
const ownerStorageStatePath = path.resolve(
  repoRoot,
  process.env.PLAYWRIGHT_OWNER_STORAGE_STATE || '.secrets/playwright/dev-owner-storage-state.json'
);
const nonOwnerStorageStatePath = path.resolve(
  repoRoot,
  process.env.PLAYWRIGHT_STORAGE_STATE || '.secrets/playwright/dev-storage-state.json'
);
const artifactDir = path.resolve(repoRoot, '.codex-runlogs/inventory-ownership-owner-browser/screenshots');

type FixtureManifest = {
  tag: string;
  ids: {
    boxIds: string[];
    caulkStockIds: string[];
  };
  summary: {
    ownerCompanies: {
      createdActiveCode: string;
      deactivatedCode: string;
    };
    film: {
      boxId: string;
      ownerAfter: string;
    };
    caulk: {
      ownerChange: { stockId: string };
      ownerRows: Array<{ stockId: string; owner: string }>;
    };
    bulkTransfer: {
      filmBoxId: string;
      caulkStockId: string;
    };
  };
};

function fixtureManifestPath(tag: string) {
  return path.resolve(repoRoot, '.secrets/dev-fixtures', `${tag.toLowerCase()}.json`);
}

function readManifest(): FixtureManifest {
  const manifestPath = fixtureManifestPath(fixtureTag);
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as FixtureManifest;
}

function screenshotPath(name: string) {
  fs.mkdirSync(artifactDir, { recursive: true });
  return path.join(artifactDir, `${fixtureTag.toLowerCase()}-${name}.png`);
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fieldByLabel(page: Page, label: RegExp | string) {
  const labelMatcher = typeof label === 'string' ? new RegExp(`^${escapeRegex(label)}$`) : label;
  return page
    .locator('label.field')
    .filter({ has: page.locator('.field-label').filter({ hasText: labelMatcher }) })
    .first();
}

async function selectOptionContaining(page: Page, label: RegExp | string, text: string) {
  const select = fieldByLabel(page, label).locator('select').first();
  await expect(select).toBeVisible();
  await expect
    .poll(
      async () =>
        select.locator('option').evaluateAll((options, optionText) =>
          options.some((option) => option.textContent?.includes(String(optionText))),
        text),
      { timeout: 15_000 }
    )
    .toBe(true);
  const value = await select.locator('option').evaluateAll(
    (options, optionText) => {
      const match = options.find((option) => option.textContent?.includes(String(optionText)));
      return match?.getAttribute('value') || '';
    },
    text
  );
  if (!value) {
    throw new Error(`No option containing "${text}" was available for ${String(label)}.`);
  }
  await select.selectOption(value);
}

async function expectOwnerCompanyRowStatus(page: Page, code: string, status: 'Active' | 'Inactive') {
  const row = page.locator('tr').filter({ hasText: code }).first();
  await expect(row).toBeVisible();
  await expect(row).toContainText(status);
}

async function fillTextInput(page: Page, label: RegExp | string, value: string) {
  const input = fieldByLabel(page, label).locator('input, textarea').first();
  await expect(input).toBeVisible();
  await input.fill(value);
}

async function expectVisibleOwnerCode(page: Page, code: string) {
  await expect(
    page
      .locator('.badge, [title="Inventory owner company"]')
      .filter({ hasText: new RegExp(`^\\s*${escapeRegex(code)}\\s*$`) })
      .first()
  ).toBeVisible({ timeout: 30_000 });
}

test.describe('DEV owner-role inventory ownership browser workflows', () => {
  test.skip(!fixtureTag, 'Set INVENTORY_OWNERSHIP_OWNER_FIXTURE_TAG to run owner-role ownership browser checks.');

  test.beforeAll(() => {
    if (!fs.existsSync(ownerStorageStatePath)) {
      throw new Error(`Missing owner DEV browser auth storage state at ${path.relative(repoRoot, ownerStorageStatePath)}.`);
    }
    if (!fs.existsSync(fixtureManifestPath(fixtureTag))) {
      throw new Error(`Missing inventory ownership fixture manifest for ${fixtureTag}.`);
    }
  });

  test.describe('owner session', () => {
    test.use({ storageState: ownerStorageStatePath });

    test('runs owner-only UI mutations for companies, film, caulk, add-box, and bulk transfer', async ({ page }) => {
      test.setTimeout(180_000);
      const manifest = readManifest();
      const suffix = fixtureTag.replace(/[^A-Z0-9]/gi, '').slice(-6);
      const runToken = String(process.env.INVENTORY_OWNERSHIP_OWNER_RUN_TOKEN || Date.now())
        .replace(/\D/g, '')
        .slice(-6)
        .padStart(6, '0');
      const uiOwnerCode = `UI${suffix}`.slice(0, 12);
      const uiOwnerName = `Codex UI Owner ${fixtureTag}`;
      const ownerChangedBoxId = manifest.summary.film.boxId;
      const bulkFilmBoxId =
        manifest.ids.boxIds.find((entry) => entry.includes('-CRET-')) ||
        manifest.summary.bulkTransfer.filmBoxId;
      const caulkOwnerChangeStockId = manifest.summary.caulk.ownerChange.stockId;
      const bulkCaulkStockId =
        manifest.summary.caulk.ownerRows.find((entry) => entry.owner === 'MGT')?.stockId ||
        manifest.summary.bulkTransfer.caulkStockId;
      const addedBoxId = `IL1-UIOWN-${runToken}`.toUpperCase();

      await page.goto('/#/owner/companies');
      await expect(page.getByRole('heading', { name: 'Owner Companies' })).toBeVisible();
      await expect(page.getByText('MGT').first()).toBeVisible();
      await expect(page.getByText('EDH').first()).toBeVisible();
      await expect(page.getByText('KAM').first()).toBeVisible();
      await fillTextInput(page, 'Code', uiOwnerCode);
      await fillTextInput(page, 'Display Name', uiOwnerName);
      await page.getByRole('button', { name: 'Save Owner Company' }).click();
      await expectOwnerCompanyRowStatus(page, uiOwnerCode, 'Active');
      await page.screenshot({ path: screenshotPath('owner-companies-created'), fullPage: true });

      page.once('dialog', async (dialog) => {
        await dialog.accept(fixtureTag);
      });
      await page.locator('tr').filter({ hasText: uiOwnerCode }).getByRole('button', { name: 'Deactivate' }).click();
      await expectOwnerCompanyRowStatus(page, uiOwnerCode, 'Inactive');

      await page.goto('/#/inventory/add');
      await expect(page.getByRole('heading', { name: 'Add Box' })).toBeVisible();
      await expect(page.getByLabel('Owner Company')).toBeVisible();
      const ownerSelect = page.getByLabel('Owner Company').first();
      await expect(ownerSelect.locator('option', { hasText: uiOwnerCode })).toHaveCount(0);

      await fillTextInput(page, 'BoxID', addedBoxId);
      await selectOptionContaining(page, /Manufacturer/i, 'Enter New Manufacturer');
      await fillTextInput(page, 'New Manufacturer', `Codex Owner UI ${suffix}`);
      await fillTextInput(page, 'Film Name', `Owner Browser Film ${suffix}`);
      await fillTextInput(page, 'Initial Linear Feet', '24');
      await fillTextInput(page, 'Lot Run', fixtureTag);
      await selectOptionContaining(page, 'Dealer', 'Add New Dealer');
      await fillTextInput(page, 'New Dealer', `Codex Owner Dealer ${suffix}`);
      await fillTextInput(page, 'Order Date', '2026-06-26');
      await fillTextInput(page, 'Received Date', '2026-06-26');
      await fillTextInput(page, 'Initial Weight (lbs)', '12');
      await selectOptionContaining(page, 'Core Type', 'White plastic');
      await fillTextInput(page, 'Notes', fixtureTag);
      await page.getByRole('button', { name: 'Create Box' }).click();
      await expect(page.getByRole('heading', { name: 'Add Box' })).toBeVisible();
      await expect(await ownerSelect.evaluate((element) => (element as HTMLSelectElement).required)).toBe(true);
      await expect(await ownerSelect.evaluate((element) => (element as HTMLSelectElement).validity.valid)).toBe(false);
      await selectOptionContaining(page, 'Owner Company', 'KAM');
      await page.getByRole('button', { name: 'Create Box' }).click();
      await expect(page).toHaveURL(new RegExp(`/inventory/${addedBoxId}`));
      await expect(page.getByText('BOX DETAILS')).toBeVisible();
      await expectVisibleOwnerCode(page, 'KAM');
      await expect(page.getByRole('button', { name: 'Edit' })).toBeEnabled({ timeout: 20_000 });
      await page.screenshot({ path: screenshotPath('add-box-owner-required-created'), fullPage: true });

      await page.goto(`/#/inventory/${encodeURIComponent(ownerChangedBoxId)}`);
      await expect(page.getByText('BOX DETAILS')).toBeVisible();
      await page.getByRole('button', { name: 'Edit' }).click();
      await expect(page.getByRole('heading', { name: 'Edit Box' })).toBeVisible();
      await selectOptionContaining(page, 'Owner Company', 'KAM');
      await fillTextInput(page, 'Ownership Note', fixtureTag);
      await page.getByRole('button', { name: 'Save Changes' }).click();
      await expect(page.getByText('BOX DETAILS')).toBeVisible();
      await expectVisibleOwnerCode(page, 'KAM');
      await expect(page.getByText(ownerChangedBoxId).first()).toBeVisible();
      await page.screenshot({ path: screenshotPath('box-owner-updated'), fullPage: true });

      await page.goto(`/#/caulk/stock/${encodeURIComponent(caulkOwnerChangeStockId)}`);
      await expect(page.getByRole('heading', { name: /Caulk/i }).first()).toBeVisible();
      await selectOptionContaining(page, 'Owner Company', 'KAM');
      await fillTextInput(page, 'Ownership Note', fixtureTag);
      const saveOwnershipButton = page.getByRole('button', { name: 'Save Ownership' });
      await expect(saveOwnershipButton).toBeEnabled();
      await saveOwnershipButton.scrollIntoViewIfNeeded();
      await saveOwnershipButton.click();
      await expect(page.getByText('Caulk owner updated')).toBeVisible({ timeout: 30_000 });
      await expectVisibleOwnerCode(page, 'KAM');
      await page.screenshot({ path: screenshotPath('caulk-owner-updated'), fullPage: true });

      await page.goto('/#/owner/bulk-ownership-transfer');
      await expect(page.getByRole('heading', { name: 'Bulk Ownership Transfer' })).toBeVisible();
      await selectOptionContaining(page, 'New Owner Company', 'EDH');
      await fillTextInput(page, 'Film Box IDs', bulkFilmBoxId);
      await fillTextInput(page, 'Caulk Stock IDs', bulkCaulkStockId);
      await fillTextInput(page, 'Transfer Note', fixtureTag);
      await page.getByRole('button', { name: 'Review Transfer' }).click();
      await expect(page.getByText(/Confirm transfer of 1 film box and 1 caulk stock row/i)).toBeVisible();
      await page.getByRole('button', { name: 'Confirm Transfer' }).click();
      await expect(page.getByText('Ownership transfer complete')).toBeVisible();
      await page.screenshot({ path: screenshotPath('bulk-ownership-transfer-complete'), fullPage: true });

      await page.goto(`/#/inventory/${encodeURIComponent(bulkFilmBoxId)}`);
      await expect(page.getByText('BOX DETAILS')).toBeVisible();
      await expectVisibleOwnerCode(page, 'EDH');
      await page.goto(`/#/caulk/stock/${encodeURIComponent(bulkCaulkStockId)}`);
      await expectVisibleOwnerCode(page, 'EDH');
    });
  });

  test.describe('standard non-owner session', () => {
    test.use({ storageState: nonOwnerStorageStatePath });

    test('keeps owner-only pages guarded and existing owner fields non-editable', async ({ page }) => {
      const manifest = readManifest();

      await page.goto('/#/owner/companies');
      await expect(page.getByRole('heading', { name: 'Owner Access Required' })).toBeVisible();
      await expect(page.getByText('Only owners can open this page.')).toBeVisible();

      await page.goto('/#/owner/bulk-ownership-transfer');
      await expect(page.getByRole('heading', { name: 'Owner Access Required' })).toBeVisible();

      await page.goto(`/#/inventory/${encodeURIComponent(manifest.summary.film.boxId)}`);
      await expect(page.getByText('BOX DETAILS')).toBeVisible();
      await page.getByRole('button', { name: 'Edit' }).click();
      await expect(page.getByLabel('Owner Company')).toBeDisabled();

      await page.goto(`/#/caulk/stock/${encodeURIComponent(manifest.summary.caulk.ownerChange.stockId)}`);
      await expect(page.getByLabel('Owner Company')).toBeDisabled();
      await page.screenshot({ path: screenshotPath('non-owner-guard'), fullPage: true });
    });
  });
});
