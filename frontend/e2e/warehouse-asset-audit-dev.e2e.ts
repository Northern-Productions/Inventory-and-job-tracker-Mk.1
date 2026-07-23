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
        const table = root?.querySelector<HTMLTableElement>('.warehouse-asset-audit-table');
        const headers = Array.from(table?.querySelectorAll('thead th') || []);
        const cells = Array.from(table?.querySelectorAll('th, td') || []);
        const numericCells = Array.from(
          table?.querySelectorAll(
            [
              '.warehouse-asset-audit-col-width',
              '.warehouse-asset-audit-col-on-hand-lf',
              '.warehouse-asset-audit-col-asset-cost'
            ].join(',')
          ) || []
        ).filter((cell) => cell.tagName !== 'COL');
        let overflowCells = 0;
        let orphanCells = 0;

        for (const cell of cells) {
          const cellRect = cell.getBoundingClientRect();
          const lines = new Map<number, { characters: number; overflow: boolean }>();
          const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
          let node = walker.nextNode();
          while (node) {
            const value = node.textContent || '';
            for (let index = 0; index < value.length; index += 1) {
              if (/\s/.test(value[index])) continue;
              const range = document.createRange();
              range.setStart(node, index);
              range.setEnd(node, index + 1);
              for (const rect of Array.from(range.getClientRects())) {
                const top = Math.round(rect.top * 2) / 2;
                const line = lines.get(top) || { characters: 0, overflow: false };
                line.characters += 1;
                line.overflow ||= (
                  rect.left < cellRect.left - 0.5 ||
                  rect.right > cellRect.right + 0.5 ||
                  rect.top < cellRect.top - 0.5 ||
                  rect.bottom > cellRect.bottom + 0.5
                );
                lines.set(top, line);
              }
            }
            node = walker.nextNode();
          }
          const orderedLines = Array.from(lines.entries()).sort(([left], [right]) => left - right);
          if (orderedLines.some(([, line]) => line.overflow)) {
            overflowCells += 1;
          }
          if (
            orderedLines.length > 1 &&
            (orderedLines.at(-1)?.[1].characters || 0) <= 2
          ) {
            orphanCells += 1;
          }
        }

        const headerLeaves = Array.from(
          root?.querySelectorAll(
            [
              '.warehouse-asset-audit-print-header h1',
              '.warehouse-asset-audit-print-header > div > strong',
              '.warehouse-asset-audit-print-header dt',
              '.warehouse-asset-audit-print-header dd',
              '.warehouse-asset-audit-print-filters span',
              '.warehouse-asset-audit-print-summary > div'
            ].join(',')
          ) || []
        );
        let headerCollisions = 0;
        for (let leftIndex = 0; leftIndex < headerLeaves.length; leftIndex += 1) {
          const left = headerLeaves[leftIndex].getBoundingClientRect();
          for (let rightIndex = leftIndex + 1; rightIndex < headerLeaves.length; rightIndex += 1) {
            const right = headerLeaves[rightIndex].getBoundingClientRect();
            const horizontalOverlap = Math.min(left.right, right.right) - Math.max(left.left, right.left);
            const verticalOverlap = Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top);
            if (horizontalOverlap > 0.5 && verticalOverlap > 0.5) {
              headerCollisions += 1;
            }
          }
        }

        const rootRect = root?.getBoundingClientRect();
        const tableRect = table?.getBoundingClientRect();
        document.body.dataset.auditPrintCalled = 'true';
        document.body.dataset.auditPrintRows = String(rows.length);
        document.body.dataset.auditPrintUniqueRows = String(ids.size);
        document.body.dataset.auditPrintExpectedRows =
          root?.getAttribute('data-audit-expected-row-count') || '';
        document.body.dataset.auditPrintTotals = String(
          root?.querySelectorAll('[data-audit-totals]').length || 0
        );
        document.body.dataset.auditPrintHeaders = headers
          .map((header) => header.textContent?.trim() || '')
          .join('|');
        document.body.dataset.auditPrintCenteredCells = String(
          cells.filter((cell) => getComputedStyle(cell).textAlign === 'center').length
        );
        document.body.dataset.auditPrintMiddleCells = String(
          cells.filter((cell) => getComputedStyle(cell).verticalAlign === 'middle').length
        );
        document.body.dataset.auditPrintCellCount = String(cells.length);
        document.body.dataset.auditPrintNumericCells = String(numericCells.length);
        document.body.dataset.auditPrintTabularCells = String(
          numericCells.filter((cell) =>
            getComputedStyle(cell).fontVariantNumeric.includes('tabular-nums')
          ).length
        );
        document.body.dataset.auditPrintOverflowCells = String(overflowCells);
        document.body.dataset.auditPrintOrphanCells = String(orphanCells);
        document.body.dataset.auditPrintHeaderCollisions = String(headerCollisions);
        document.body.dataset.auditPrintTableLayout = table ? getComputedStyle(table).tableLayout : '';
        document.body.dataset.auditPrintTableWidth = String(tableRect?.width || 0);
        document.body.dataset.auditPrintRootWidth = String(rootRect?.width || 0);
        document.body.dataset.auditPrintHorizontalOverflow = String(
          Boolean(
            root &&
            tableRect &&
            rootRect &&
            (
              root.scrollWidth > root.clientWidth + 1 ||
              tableRect.left < rootRect.left - 0.5 ||
              tableRect.right > rootRect.right + 0.5
            )
          )
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
  await expect(
    page.locator('.warehouse-asset-audit-screen-table thead th')
  ).toHaveText([
    'Box ID',
    'Owner',
    'Custody Warehouse',
    'Status',
    'Manufacturer',
    'Film',
    'Width',
    'On-Hand LF',
    'On-Hand Asset Cost'
  ]);
  await expect(page.locator('.warehouse-asset-audit-screen-table thead')).not.toContainText(
    'Cost Basis'
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
  await page.setViewportSize({ width: 995, height: 816 });
  await page.emulateMedia({ media: 'print' });
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
    totals: Number(body.dataset.auditPrintTotals || 0),
    headers: body.dataset.auditPrintHeaders || '',
    centeredCells: Number(body.dataset.auditPrintCenteredCells || 0),
    middleCells: Number(body.dataset.auditPrintMiddleCells || 0),
    cellCount: Number(body.dataset.auditPrintCellCount || 0),
    numericCells: Number(body.dataset.auditPrintNumericCells || 0),
    tabularCells: Number(body.dataset.auditPrintTabularCells || 0),
    overflowCells: Number(body.dataset.auditPrintOverflowCells || 0),
    orphanCells: Number(body.dataset.auditPrintOrphanCells || 0),
    headerCollisions: Number(body.dataset.auditPrintHeaderCollisions || 0),
    tableLayout: body.dataset.auditPrintTableLayout || '',
    tableWidth: Number(body.dataset.auditPrintTableWidth || 0),
    rootWidth: Number(body.dataset.auditPrintRootWidth || 0),
    horizontalOverflow: body.dataset.auditPrintHorizontalOverflow || ''
  }));
  expect(printMetrics.rows).toBe(forcedRowCount);
  expect(printMetrics.uniqueRows).toBe(forcedRowCount);
  expect(printMetrics.expectedRows).toBe(forcedRowCount);
  expect(printMetrics.totals).toBe(2);
  expect(printMetrics.headers.split('|')).toEqual([
    'Box ID',
    'Owner',
    'Custody Warehouse',
    'Status',
    'Manufacturer',
    'Film',
    'Width',
    'On-Hand LF',
    'On-Hand Asset Cost'
  ]);
  expect(printMetrics.centeredCells).toBe(printMetrics.cellCount);
  expect(printMetrics.middleCells).toBe(printMetrics.cellCount);
  expect(printMetrics.tabularCells).toBe(printMetrics.numericCells);
  expect(printMetrics.overflowCells).toBe(0);
  expect(printMetrics.orphanCells).toBe(0);
  expect(printMetrics.headerCollisions).toBe(0);
  expect(printMetrics.tableLayout).toBe('fixed');
  expect(printMetrics.tableWidth).toBeGreaterThanOrEqual(994);
  expect(printMetrics.tableWidth).toBeLessThanOrEqual(995);
  expect(printMetrics.tableWidth).toBeLessThanOrEqual(printMetrics.rootWidth);
  expect(printMetrics.horizontalOverflow).toBe('false');
});
