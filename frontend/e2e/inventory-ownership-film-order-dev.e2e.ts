import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');
const fixtureTag = String(process.env.INVENTORY_OWNERSHIP_FILM_ORDER_FIXTURE_TAG || '').trim();
const storageStatePath = path.resolve(
  repoRoot,
  process.env.PLAYWRIGHT_STORAGE_STATE || '.secrets/playwright/dev-storage-state.json'
);
const artifactDir = path.resolve(repoRoot, '.codex-runlogs/inventory-ownership-film-order/screenshots');

type FixtureManifest = {
  tag: string;
  summary: {
    ownerCompanies: {
      inactiveOwnerCode: string;
    };
    job: {
      jobNumber: string;
      warehouse: string;
    };
    newBoxFulfillment: {
      filmOrderId: string;
      filmName: string;
      browserBoxId: string;
      expectedOwnerCode: string;
      expectedCreatedFeet: number;
    };
    orderedReceive: {
      boxId: string;
      ownerAfter: string;
      statusAfter: string;
      ownerPreserved: boolean;
    };
    routes: {
      filmOrders: string;
      filmOrderDetails: string;
      addBoxIntake: string;
      newBoxDetails: string;
      orderedBoxDetails: string;
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

async function fillTextInput(page: Page, label: RegExp | string, value: string) {
  const input = fieldByLabel(page, label).locator('input, textarea').first();
  await expect(input).toBeVisible();
  await input.fill(value);
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

async function expectVisibleOwnerCode(page: Page, code: string) {
  await expect(
    page
      .locator('.badge, [title="Inventory owner company"]')
      .filter({ hasText: new RegExp(`^\\s*${escapeRegex(code)}\\s*$`) })
      .first()
  ).toBeVisible({ timeout: 30_000 });
}

test.describe('DEV film order fulfillment inventory ownership workflow', () => {
  test.skip(!fixtureTag, 'Set INVENTORY_OWNERSHIP_FILM_ORDER_FIXTURE_TAG to run film-order ownership browser checks.');

  test.beforeAll(() => {
    if (!fs.existsSync(storageStatePath)) {
      throw new Error(`Missing DEV browser auth storage state at ${path.relative(repoRoot, storageStatePath)}.`);
    }
    if (!fs.existsSync(fixtureManifestPath(fixtureTag))) {
      throw new Error(`Missing inventory ownership film-order fixture manifest for ${fixtureTag}.`);
    }
  });

  test.use({ storageState: storageStatePath });

  test('requires owner for Film Order Add Box intake and persists selected owner', async ({ page }) => {
    test.setTimeout(180_000);
    const manifest = readManifest();
    const {
      ownerCompanies,
      job,
      newBoxFulfillment,
      orderedReceive,
      routes,
    } = manifest.summary;

    await expect(orderedReceive.ownerPreserved).toBeTruthy();
    await expect(orderedReceive.ownerAfter).toBe('EDH');
    await expect(orderedReceive.statusAfter).toBe('IN_STOCK');

    await page.goto(routes.filmOrderDetails);
    await expect(page.getByText('FILM ORDER DETAILS')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(newBoxFulfillment.filmOrderId)).toBeVisible();
    await expect(page.getByText('filmOrderId is required')).toHaveCount(0);
    await page.screenshot({ path: screenshotPath('film-order-details-before-intake'), fullPage: true });

    await page.goto(routes.filmOrders);
    await expect(page.getByRole('heading', { name: 'Film Orders' })).toBeVisible({ timeout: 30_000 });
    const orderRow = page
      .locator('tr')
      .filter({ hasText: newBoxFulfillment.filmName })
      .filter({ hasText: job.jobNumber })
      .first();
    await expect(orderRow).toBeVisible({ timeout: 30_000 });
    await orderRow.getByRole('button', { name: 'FILM ORDERED' }).click();

    await expect(page).toHaveURL(/\/inventory\/add\?/);
    await expect(page.getByText('Film Order Intake')).toBeVisible();
    await expect(page.getByText(newBoxFulfillment.filmOrderId).first()).toBeVisible();

    const ownerSelect = page.getByLabel('Owner Company').first();
    await expect(ownerSelect).toBeVisible();
    await expect(ownerSelect.locator('option', { hasText: ownerCompanies.inactiveOwnerCode })).toHaveCount(0);

    await fillTextInput(page, 'BoxID', newBoxFulfillment.browserBoxId);
    await fillTextInput(page, 'Initial Linear Feet', String(newBoxFulfillment.expectedCreatedFeet));
    await fillTextInput(page, 'Lot Run', fixtureTag);
    await selectOptionContaining(page, 'Dealer', 'Add New Dealer');
    await fillTextInput(page, 'New Dealer', `Codex Film Order Dealer ${fixtureTag.slice(-8)}`);
    await fillTextInput(page, 'Order Date', '2026-06-26');
    await fillTextInput(page, 'Received Date', '2026-06-26');
    await fillTextInput(page, 'Initial Weight (lbs)', '14.5');
    await selectOptionContaining(page, 'Core Type', 'White plastic');
    await fillTextInput(page, 'Notes', fixtureTag);

    await page.getByRole('button', { name: 'Create Box' }).click();
    await expect(await ownerSelect.evaluate((element) => (element as HTMLSelectElement).required)).toBe(true);
    await expect(await ownerSelect.evaluate((element) => (element as HTMLSelectElement).validity.valid)).toBe(false);
    await expect(page.getByText('Film Order Intake')).toBeVisible();

    await selectOptionContaining(page, 'Owner Company', newBoxFulfillment.expectedOwnerCode);
    await page.getByRole('button', { name: 'Create Box' }).click();
    await expect(page.getByText(new RegExp(`Added\\s+${escapeRegex(newBoxFulfillment.browserBoxId)}`))).toBeVisible({
      timeout: 30_000,
    });
    await page.screenshot({ path: screenshotPath('film-order-add-box-owner-created'), fullPage: true });

    await page.goto(routes.newBoxDetails);
    await expect(page.getByText('BOX DETAILS')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(newBoxFulfillment.browserBoxId).first()).toBeVisible();
    await expectVisibleOwnerCode(page, newBoxFulfillment.expectedOwnerCode);
    await page.getByRole('button', { name: 'Edit' }).click();
    await expect(page.getByRole('heading', { name: 'Edit Box' })).toBeVisible();
    await expect(page.getByLabel('Owner Company')).toBeDisabled();
    await page.screenshot({ path: screenshotPath('film-order-box-owner-non-owner-disabled'), fullPage: true });

    await page.goto(routes.filmOrderDetails);
    await expect(page.getByText('FILM ORDER DETAILS')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(newBoxFulfillment.browserBoxId).first()).toBeVisible();
    await expect(page.getByText('filmOrderId is required')).toHaveCount(0);

    await page.goto(routes.orderedBoxDetails);
    await expect(page.getByText('BOX DETAILS')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(orderedReceive.boxId).first()).toBeVisible();
    await expectVisibleOwnerCode(page, orderedReceive.ownerAfter);
    await page.screenshot({ path: screenshotPath('ordered-receive-owner-preserved'), fullPage: true });
  });
});
