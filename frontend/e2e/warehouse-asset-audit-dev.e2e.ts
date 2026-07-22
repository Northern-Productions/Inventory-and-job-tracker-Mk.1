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

function isWarehouseAssetAuditUrl(value: string) {
  const url = new URL(value);
  return (
    url.pathname.includes('/reports/warehouse-asset-audit') ||
    url.searchParams.get('path') === '/reports/warehouse-asset-audit'
  );
}

test.beforeAll(() => {
  if (!fs.existsSync(storageStatePath)) {
    throw new Error('Missing guarded DEV browser auth storage state.');
  }
});

test.use({ storageState: storageStatePath });

test('prints one forced live warehouse asset audit response completely and exactly once', async ({ page }) => {
  test.setTimeout(90_000);
  const auditResponses: Array<import('@playwright/test').Response> = [];
  page.on('response', (response) => {
    if (
      response.request().method() === 'GET' &&
      isWarehouseAssetAuditUrl(response.url())
    ) {
      auditResponses.push(response);
    }
  });
  await page.addInitScript(() => {
    Object.defineProperty(window, 'print', {
      configurable: true,
      value: () => {
        const root = document.querySelector(
          '.warehouse-asset-audit-print-only-root [data-audit-print-snapshot]'
        );
        const rows = Array.from(root?.querySelectorAll('[data-audit-row-id]') || []);
        const ids = new Set(rows.map((row) => row.getAttribute('data-audit-row-id')));
        document.body.dataset.auditPrintCalled = 'true';
        document.body.dataset.auditPrintRows = String(rows.length);
        document.body.dataset.auditPrintUniqueRows = String(ids.size);
        document.body.dataset.auditPrintExpectedRows =
          root?.getAttribute('data-audit-expected-row-count') || '';
        document.body.dataset.auditPrintTotals = String(
          root?.querySelectorAll('[data-audit-totals]').length || 0
        );
      }
    });
    Object.defineProperty(window, '__warehouseAssetAuditPrintStubReady', {
      configurable: true,
      value: true
    });
  });

  await page.goto('/#/reports');
  await page.getByLabel('Report Type').selectOption('warehouse_asset_audit');
  await expect.poll(() => auditResponses.length, { timeout: 30_000 }).toBeGreaterThan(0);
  let allWarehouseResponse = auditResponses.at(-1);
  if (!allWarehouseResponse) {
    throw new Error('The initial live audit response was not captured.');
  }
  await expect(page.getByRole('heading', { name: 'Warehouse Asset Audit' })).toBeVisible();

  const warehouseSelect = page.locator('.warehouse-asset-audit-controls select').first();
  if (await warehouseSelect.inputValue()) {
    const responseCountBeforeWarehouseFilter = auditResponses.length;
    await warehouseSelect.selectOption('');
    await expect.poll(() => auditResponses.length, { timeout: 30_000 }).toBeGreaterThan(
      responseCountBeforeWarehouseFilter
    );
    allWarehouseResponse = auditResponses.at(-1);
    if (!allWarehouseResponse) {
      throw new Error('The all-warehouse live audit response was not captured.');
    }
  }
  expect(allWarehouseResponse.ok()).toBe(true);
  expect(allWarehouseResponse.headers()['cache-control']).toContain('no-store');
  const allWarehouseEnvelope = await allWarehouseResponse.json();
  const screenRowCount = Number(allWarehouseEnvelope?.data?.rows?.length || 0);
  expect(screenRowCount).toBeGreaterThan(0);
  await expect(page.locator('.warehouse-asset-audit-screen-table [data-audit-row-id]')).toHaveCount(
    Math.min(50, screenRowCount)
  );
  await expect(page.getByText('Matching Boxes').last()).toBeVisible();
  await expect(page.getByText('Total On-Hand LF').last()).toBeVisible();
  await expect(page.getByText('Total Known On-Hand Asset Cost').last()).toBeVisible();
  await expect(page.getByText('Boxes Missing Cost Basis').last()).toBeVisible();

  const responseCountBeforePrint = auditResponses.length;
  const printButton = page.getByRole('button', { name: 'Print Audit' });
  await expect(printButton).toBeEnabled();
  expect(await page.evaluate(() => Boolean(
    (window as typeof window & { __warehouseAssetAuditPrintStubReady?: boolean })
      .__warehouseAssetAuditPrintStubReady
  ))).toBe(true);
  await printButton.dispatchEvent('click');
  await expect.poll(() => auditResponses.length, { timeout: 30_000 }).toBeGreaterThan(
    responseCountBeforePrint
  );
  const forcedResponse = auditResponses.at(-1);
  expect(forcedResponse).toBeDefined();
  if (!forcedResponse) {
    throw new Error('The forced live audit response was not captured.');
  }
  expect(forcedResponse.ok()).toBe(true);
  expect(forcedResponse.headers()['cache-control']).toContain('no-store');
  const forcedEnvelope = await forcedResponse.json();
  const forcedRowCount = Number(forcedEnvelope?.data?.rows?.length || 0);

  await expect(page.locator('body')).toHaveAttribute('data-audit-print-called', 'true');
  const printMetrics = await page.locator('body').evaluate((body) => ({
    rows: Number(body.dataset.auditPrintRows || 0),
    uniqueRows: Number(body.dataset.auditPrintUniqueRows || 0),
    expectedRows: Number(body.dataset.auditPrintExpectedRows || 0),
    totals: Number(body.dataset.auditPrintTotals || 0)
  }));
  expect(printMetrics).toEqual({
    rows: forcedRowCount,
    uniqueRows: forcedRowCount,
    expectedRows: forcedRowCount,
    totals: 1
  });
});
