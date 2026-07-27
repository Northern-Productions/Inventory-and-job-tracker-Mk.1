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
const responseVersion = Number(process.env.AUDIT_COMPAT_RESPONSE_VERSION);
const responseVariant =
  process.env.AUDIT_COMPAT_RESPONSE_VARIANT || `v${responseVersion}`;
const expectedOutcome = process.env.AUDIT_COMPAT_EXPECTED_OUTCOME;
const scenario = process.env.AUDIT_COMPAT_SCENARIO || 'cold';

function isWarehouseAssetAuditUrl(value: string) {
  const url = new URL(value);
  return (
    url.pathname.includes('/reports/warehouse-asset-audit') ||
    url.searchParams.get('path') === '/reports/warehouse-asset-audit'
  );
}

function isApiPath(value: string, pathName: string) {
  const url = new URL(value);
  return url.searchParams.get('path') === pathName;
}

function buildAuthContextResponse() {
  return {
    ok: true,
    data: {
      orgId: 'compatibility-scope',
      accessStatus: 'approved',
      role: 'owner',
      permissions: {
        reports: { read: true, write: false }
      },
      isAdminConsoleAllowed: false,
      pendingCount: 0,
      receivesInAppNotifications: false,
      defaultWarehouse: 'IL1'
    },
    warnings: []
  };
}

function buildResponse(
  snapshotVersion: 1 | 2,
  options: { malformedContext?: boolean; search?: string } = {}
) {
  const row = {
    boxId: 'TEST-BOX',
    ownerCompanyId: null,
    ownerCompanyLabel: 'Unassigned',
    ownerCategory: 'UNASSIGNED',
    warehouse: 'IL1',
    custodyBasis: 'CURRENT_WAREHOUSE',
    pendingTransferDestination: null,
    status: 'IN_STOCK',
    statusLabel: 'In Stock',
    manufacturer: 'Test Manufacturer',
    filmName: 'Test Film',
    widthIn: 60,
    onHandLf: 100,
    costBasis: 'DIRECT_PRICE_PER_LF',
    onHandAssetCostCents: '10000',
    ...(snapshotVersion === 2
      ? {
          checkedOutJobNumber: options.malformedContext
            ? 'SYNTHETIC-JOB-FOR-NONCHECKED-ROW'
            : null,
          checkedOutCrewLeaderName: null
        }
      : {})
  };
  return {
    snapshotVersion,
    metadata: {
      organizationName: 'Compatibility Test Organization',
      generatedAt: '2026-07-27T12:00:00.000Z',
      generatedBy: 'Compatibility verifier'
    },
    appliedFilters: {
      warehouse: 'IL1',
      ownerCompanyId: '',
      manufacturer: '',
      filmName: '',
      width: null,
      statuses: ['IN_STOCK', 'CHECKED_OUT', 'TRANSFER'],
      q: options.search || ''
    },
    appliedFilterLabels: {
      warehouse: 'Wauconda IL1',
      owner: 'All Owners',
      manufacturer: 'All Manufacturers',
      filmName: 'All Films',
      width: 'All Widths',
      statuses: ['In Stock', 'Checked Out', 'Pending Transfer'],
      search: 'None'
    },
    filterOptions: {
      warehouses: [{ value: 'IL1', label: 'Wauconda IL1' }],
      owners: [{ value: 'UNASSIGNED', label: 'Unassigned' }],
      manufacturers: ['Test Manufacturer'],
      filmNames: ['Test Film'],
      widths: [60],
      statuses: [
        { value: 'IN_STOCK', label: 'In Stock' },
        { value: 'CHECKED_OUT', label: 'Checked Out' },
        { value: 'TRANSFER', label: 'Pending Transfer' }
      ]
    },
    rows: [row],
    totals: {
      matchingBoxes: 1,
      totalOnHandLf: 100,
      totalKnownOnHandAssetCostCents: '10000',
      boxesMissingCostBasis: 0
    }
  };
}

test.beforeAll(() => {
  if (!fs.existsSync(storageStatePath)) {
    throw new Error('Missing guarded DEV browser auth storage state.');
  }
  if (![1, 2].includes(responseVersion)) {
    throw new Error('AUDIT_COMPAT_RESPONSE_VERSION must be 1 or 2.');
  }
  if (!['v1', 'v2', 'malformed-v2'].includes(responseVariant)) {
    throw new Error('AUDIT_COMPAT_RESPONSE_VARIANT must be v1, v2, or malformed-v2.');
  }
  if (!['works', 'rejects'].includes(String(expectedOutcome))) {
    throw new Error('AUDIT_COMPAT_EXPECTED_OUTCOME must be works or rejects.');
  }
  if (!['cold', 'replacement'].includes(scenario)) {
    throw new Error('AUDIT_COMPAT_SCENARIO must be cold or replacement.');
  }
});

test.use({ storageState: storageStatePath });

test('Warehouse Asset Audit frontend/API compatibility cell', async ({ page }) => {
  let replacementTriggered = false;

  await page.route('**/*', async (route) => {
    if (
      route.request().method() === 'GET' &&
      isApiPath(route.request().url(), '/auth/context')
    ) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'cache-control': 'no-store' },
        body: JSON.stringify(buildAuthContextResponse())
      });
      return;
    }
    if (
      route.request().method() === 'GET' &&
      isWarehouseAssetAuditUrl(route.request().url())
    ) {
      const requestUrl = new URL(route.request().url());
      const activeVariant =
        scenario === 'replacement' && !replacementTriggered ? 'v2' : responseVariant;
      const activeVersion = activeVariant === 'v1' ? 1 : 2;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'cache-control': 'no-store' },
        body: JSON.stringify({
          ok: true,
          data: buildResponse(activeVersion, {
            malformedContext: activeVariant === 'malformed-v2',
            search: requestUrl.searchParams.get('q') || ''
          }),
          warnings: []
        })
      });
      return;
    }
    await route.continue();
  });

  await page.goto('/#/reports');
  await page.getByLabel('Report Type').selectOption('warehouse_asset_audit');
  await expect(page.getByRole('heading', { name: 'Warehouse Asset Audit' })).toBeVisible();

  const printButton = page.getByRole('button', { name: 'Print Audit' });
  if (scenario === 'replacement') {
    await expect(page.locator('.warehouse-asset-audit-screen-table [data-audit-row-id]'))
      .toHaveCount(1);
    await expect(printButton).toBeEnabled();

    replacementTriggered = true;
    await page.getByLabel('Search').fill('replacement');
    await expect(page.getByText(
      'Warehouse asset audit data is incompatible with this application version.'
    )).toBeVisible();
    await expect(page.getByText(/Previous results from/)).toBeVisible();
    await expect(page.getByText(
      'Previous results are shown and may not match the selected filters.'
    )).toBeVisible();
    await expect(page.locator('.warehouse-asset-audit-screen-table [data-audit-row-id]'))
      .toHaveCount(1);
    await expect(printButton).toBeDisabled();
    await expect(page.locator('.warehouse-asset-audit-print-only-root')).toHaveCount(0);
    return;
  }

  if (expectedOutcome === 'works') {
    await expect(page.locator('.warehouse-asset-audit-screen-table [data-audit-row-id]'))
      .toHaveCount(1);
    await expect(page.getByText('Compatibility Test Organization')).toHaveCount(0);
    await expect(printButton).toBeEnabled();
    await expect(page.getByText(
      'Warehouse asset audit data is incompatible with this application version.'
    )).toHaveCount(0);
  } else {
    await expect(page.locator('.warehouse-asset-audit-screen-table [data-audit-row-id]'))
      .toHaveCount(0);
    await expect(page.getByText(
      'Warehouse asset audit data is incompatible with this application version.'
    )).toBeVisible();
    await expect(printButton).toBeDisabled();
    await expect(page.locator('.warehouse-asset-audit-print-only-root')).toHaveCount(0);
  }
});
