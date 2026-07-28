import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer, type ViteDevServer } from 'vite';
import type {
  WarehouseAssetAuditResponse,
  WarehouseAssetAuditRow
} from '../src/domain';

const PRINT_CSS = readFileSync('src/styles.css', 'utf8');
const LETTER_LANDSCAPE_WIDTH_PT = 11 * 72;
const LETTER_LANDSCAPE_HEIGHT_PT = 8.5 * 72;
const ROW_COUNT = 96;

let viteServer: ViteDevServer;
let WarehouseAssetAuditWorksheet: ComponentType<{
  snapshot: WarehouseAssetAuditResponse;
}>;
let WarehouseAssetAuditTable: ComponentType<{
  rows: WarehouseAssetAuditRow[];
}>;

function buildRow(index: number): WarehouseAssetAuditRow {
  const ordinal = index + 1;
  const checkedOut = index % 3 === 1;
  return {
    boxId: `SYN-${String(ordinal).padStart(4, '0')}`,
    ownerCompanyId: null,
    ownerCompanyLabel: index % 4 === 0 ? 'Unassigned' : 'EDH - Ed Hoy Holdings',
    ownerCategory: index % 4 === 0 ? 'UNASSIGNED' : 'ASSIGNED',
    warehouse: index % 2 === 0 ? 'IL1' : 'MS1',
    custodyBasis: checkedOut ? 'CHECKOUT_SOURCE' : 'CURRENT_WAREHOUSE',
    pendingTransferDestination: null,
    status: checkedOut ? 'CHECKED_OUT' : 'IN_STOCK',
    statusLabel: checkedOut ? 'Checked Out' : 'In Stock',
    checkedOutJobNumber: checkedOut ? `JOB-${1000 + ordinal}` : null,
    checkedOutCrewLeaderName: checkedOut && index % 6 !== 1 ? 'Jordan Sample' : null,
    manufacturer: index % 5 === 0 ? 'Decorative Film Manufacturer' : '3M Fasara',
    filmName: index % 5 === 0
      ? 'Synthetic Matte Deep Black Privacy Film'
      : 'Prestige Exterior Series 70',
    widthIn: index % 2 === 0 ? 60 : 48,
    onHandLf: 100 + ordinal,
    costBasis: index % 7 === 0 ? 'MISSING' : 'DIRECT_PRICE_PER_LF',
    onHandAssetCostCents: index % 7 === 0 ? null : String((100 + ordinal) * 1000)
  };
}

function buildSnapshot(
  rows = Array.from({ length: ROW_COUNT }, (_, index) => buildRow(index))
): WarehouseAssetAuditResponse {
  const knownCost = rows.reduce(
    (total, row) => total + BigInt(row.onHandAssetCostCents || '0'),
    0n
  );
  return {
    snapshotVersion: 2,
    metadata: {
      organizationName: 'Synthetic Warehouse Audit Verification',
      generatedAt: '2026-07-27T12:00:00.000Z',
      generatedBy: 'Authorized Reports Reader'
    },
    appliedFilters: {
      warehouse: '',
      ownerCompanyId: '',
      manufacturer: '',
      filmName: '',
      width: null,
      statuses: ['IN_STOCK', 'CHECKED_OUT', 'TRANSFER'],
      q: ''
    },
    appliedFilterLabels: {
      warehouse: 'All Warehouses',
      owner: 'All Owners',
      manufacturer: 'All Manufacturers',
      filmName: 'All Films',
      width: 'All Widths',
      statuses: ['In Stock', 'Checked Out', 'Pending Transfer'],
      search: 'None'
    },
    filterOptions: {
      warehouses: [],
      owners: [],
      manufacturers: [],
      filmNames: [],
      widths: [],
      statuses: []
    },
    rows,
    totals: {
      matchingBoxes: rows.length,
      totalOnHandLf: rows.reduce((total, row) => total + row.onHandLf, 0),
      totalKnownOnHandAssetCostCents: knownCost.toString(),
      boxesMissingCostBasis: rows.filter((row) => row.costBasis === 'MISSING').length
    }
  };
}

async function renderWorksheet(page: Page, snapshot: WarehouseAssetAuditResponse) {
  const worksheet = renderToStaticMarkup(
    createElement(WarehouseAssetAuditWorksheet, { snapshot })
  );
  await page.setViewportSize({ width: 995, height: 755 });
  await page.setContent(`
    <!doctype html>
    <html>
      <head>
        <title>Warehouse Asset Audit Print Verification</title>
        <style>${PRINT_CSS}</style>
      </head>
      <body class="warehouse-asset-audit-printing">
        <div id="root">Screen report must stay hidden.</div>
        <div class="label-print-only-root print-root">Label print must stay hidden.</div>
        <div class="warehouse-asset-audit-print-only-root">${worksheet}</div>
      </body>
    </html>
  `);
  await page.emulateMedia({ media: 'print' });
}

async function renderScreenTable(page: Page, rows: WarehouseAssetAuditRow[]) {
  const table = renderToStaticMarkup(
    createElement(WarehouseAssetAuditTable, { rows })
  );
  await page.setViewportSize({ width: 1200, height: 755 });
  await page.setContent(`
    <!doctype html>
    <html>
      <head>
        <title>Warehouse Asset Audit Screen Verification</title>
        <style>${PRINT_CSS}</style>
      </head>
      <body>
        <div class="table-wrap warehouse-asset-audit-screen-table">${table}</div>
      </body>
    </html>
  `);
  await page.emulateMedia({ media: 'screen' });
}

function getPdfPageCount(pdf: Buffer): number {
  return pdf.toString('latin1').match(/\/Type\s*\/Page(?!s)\b/g)?.length || 0;
}

function getPdfMediaBoxes(pdf: Buffer): Array<{ width: number; height: number }> {
  return Array.from(
    pdf
      .toString('latin1')
      .matchAll(/\/MediaBox\s*\[\s*0\s+0\s+([0-9.]+)\s+([0-9.]+)\s*\]/g),
    (match) => ({ width: Number(match[1]), height: Number(match[2]) })
  );
}

test.beforeAll(async () => {
  viteServer = await createServer({
    appType: 'custom',
    cacheDir: path.join(os.tmpdir(), 'codex-warehouse-audit-print-vite-cache'),
    optimizeDeps: {
      noDiscovery: true
    },
    server: {
      middlewareMode: true
    }
  });
  const module = await viteServer.ssrLoadModule(
    '/src/features/inventory/pages/reports/WarehouseAssetAuditWorksheet.tsx'
  );
  WarehouseAssetAuditWorksheet = module.WarehouseAssetAuditWorksheet;
  WarehouseAssetAuditTable = module.WarehouseAssetAuditTable;
});

test.afterAll(async () => {
  await viteServer.close();
});

test('prints checked-out context across a complete multi-page Letter-landscape worksheet', async ({
  page
}) => {
  const snapshot = buildSnapshot();
  await renderWorksheet(page, snapshot);

  const metrics = await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>(
      '.warehouse-asset-audit-print-only-root'
    );
    const worksheet = root?.querySelector<HTMLElement>(
      '.warehouse-asset-audit-worksheet'
    );
    const table = root?.querySelector<HTMLTableElement>(
      '.warehouse-asset-audit-table'
    );
    const headers = Array.from(table?.querySelectorAll<HTMLTableCellElement>('thead th') || []);
    const rows = Array.from(table?.querySelectorAll<HTMLTableRowElement>('tbody tr') || []);
    const cells = Array.from(
      table?.querySelectorAll<HTMLTableCellElement>('th, td') || []
    );
    const footer = root?.querySelector<HTMLElement>(
      '.warehouse-asset-audit-print-footer'
    );
    const summary = root?.querySelector<HTMLElement>(
      '.warehouse-asset-audit-print-summary'
    );
    if (!root || !worksheet || !table || !footer || !summary || rows.length === 0) {
      throw new Error('Synthetic worksheet did not render the expected print structure.');
    }

    const lineLengths = (cell: Element) => {
      const lines = new Map<number, number>();
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
            lines.set(top, (lines.get(top) || 0) + 1);
          }
        }
        node = walker.nextNode();
      }
      return Array.from(lines.entries())
        .sort(([left], [right]) => left - right)
        .map(([, length]) => length);
    };
    const overflowCells = cells.filter((cell) => {
      const cellRect = cell.getBoundingClientRect();
      const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        const range = document.createRange();
        range.selectNodeContents(node);
        if (Array.from(range.getClientRects()).some((rect) =>
          rect.left < cellRect.left - 0.5 ||
          rect.right > cellRect.right + 0.5 ||
          rect.top < cellRect.top - 0.5 ||
          rect.bottom > cellRect.bottom + 0.5
        )) {
          return true;
        }
        node = walker.nextNode();
      }
      return false;
    });
    const orphanCells = cells.filter((cell) => {
      const lines = lineLengths(cell);
      return lines.length > 1 && (lines.at(-1) || 0) <= 2;
    });
    const headerLeaves = Array.from(
      root.querySelectorAll<HTMLElement>(
        [
          '.warehouse-asset-audit-print-header h1',
          '.warehouse-asset-audit-print-header > div > strong',
          '.warehouse-asset-audit-print-header dt',
          '.warehouse-asset-audit-print-header dd',
          '.warehouse-asset-audit-print-filters span',
          '.warehouse-asset-audit-print-summary > div',
          '.warehouse-asset-audit-cost-note'
        ].join(',')
      )
    );
    let headerCollisions = 0;
    for (let leftIndex = 0; leftIndex < headerLeaves.length; leftIndex += 1) {
      const left = headerLeaves[leftIndex].getBoundingClientRect();
      for (let rightIndex = leftIndex + 1; rightIndex < headerLeaves.length; rightIndex += 1) {
        const right = headerLeaves[rightIndex].getBoundingClientRect();
        if (
          Math.min(left.right, right.right) - Math.max(left.left, right.left) > 0.5 &&
          Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top) > 0.5
        ) {
          headerCollisions += 1;
        }
      }
    }
    const representativeIndexes = [0, Math.floor(rows.length / 2), rows.length - 1];
    const tableRect = table.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    const colWidths = Array.from(
      table.querySelectorAll<HTMLTableColElement>('col'),
      (col) => col.getBoundingClientRect().width
    );

    return {
      appDisplay: getComputedStyle(document.querySelector('#root') as HTMLElement).display,
      labelDisplay: getComputedStyle(
        document.querySelector('.label-print-only-root') as HTMLElement
      ).display,
      rowIds: rows.map((row) => row.dataset.auditRowId || ''),
      representativeIds: representativeIndexes.map(
        (index) => rows[index]?.dataset.auditRowId || ''
      ),
      representativeRects: representativeIndexes.map((index) => {
        const rect = rows[index].getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, height: rect.height };
      }),
      footerAfterRows:
        footer.getBoundingClientRect().top >= rows.at(-1)!.getBoundingClientRect().bottom,
      headers: headers.map((header) => header.textContent?.trim() || ''),
      headerLineCounts: headers.map((header) => lineLengths(header).length),
      headerFits: headers.map(
        (header) =>
          header.scrollWidth <= header.clientWidth + 1 &&
          header.scrollHeight <= header.clientHeight + 1
      ),
      bodyFontSize: Number.parseFloat(
        getComputedStyle(rows[0].querySelector('td') as HTMLElement).fontSize
      ),
      headerFontSize: Number.parseFloat(getComputedStyle(headers[0]).fontSize),
      centeredCells: cells.filter(
        (cell) =>
          getComputedStyle(cell).textAlign === 'center' &&
          getComputedStyle(cell).verticalAlign === 'middle'
      ).length,
      cellCount: cells.length,
      overflowCells: overflowCells.length,
      orphanCells: orphanCells.length,
      headerClipped: headerLeaves.filter(
        (element) =>
          element.scrollWidth > element.clientWidth + 1 ||
          element.scrollHeight > element.clientHeight + 1
      ).length,
      headerCollisions,
      tableHeaderGroup: getComputedStyle(table.tHead as HTMLElement).display,
      tableLayout: getComputedStyle(table).tableLayout,
      tableWidth: tableRect.width,
      rootWidth: rootRect.width,
      horizontalOverflow:
        root.scrollWidth > root.clientWidth + 1 ||
        tableRect.left < rootRect.left - 0.5 ||
        tableRect.right > rootRect.right + 0.5,
      colWidths,
      rowBreaks: rows.map((row) => {
        const style = getComputedStyle(row);
        return style.breakInside || style.pageBreakInside;
      }),
      statusStacks: Array.from(
        table.querySelectorAll<HTMLElement>(
          'tbody .warehouse-asset-audit-col-status .warehouse-asset-audit-status-stack'
        ),
        (stack) => {
          const lines = Array.from(
            stack.children,
            (child) => child.textContent?.trim() || ''
          );
          return lines.length
            ? lines.join('|')
            : stack.textContent?.replace(/\s+/g, ' ').trim() || '';
        }
      ),
      summaryCount: root.querySelectorAll('[data-audit-totals]').length,
      finalTotalsText: footer.textContent?.replace(/\s+/g, ' ').trim() || '',
      checkedOutStatusWidthPercent: (colWidths[3] / tableRect.width) * 100,
      filmWidthPercent: (colWidths[5] / tableRect.width) * 100
    };
  });

  expect(metrics.appDisplay).toBe('none');
  expect(metrics.labelDisplay).toBe('none');
  expect(metrics.rowIds).toHaveLength(ROW_COUNT);
  expect(new Set(metrics.rowIds).size).toBe(ROW_COUNT);
  expect(metrics.representativeIds).toEqual(['SYN-0001', 'SYN-0049', 'SYN-0096']);
  expect(metrics.representativeRects[0].top).toBeLessThan(
    metrics.representativeRects[1].top
  );
  expect(metrics.representativeRects[1].top).toBeLessThan(
    metrics.representativeRects[2].top
  );
  expect(metrics.representativeRects.every((rect) => rect.height > 0)).toBe(true);
  expect(metrics.footerAfterRows).toBe(true);
  expect(metrics.headers).toEqual([
    'Box ID',
    'Owner',
    'Warehouse',
    'Status',
    'Manufacturer',
    'Film',
    'Width',
    'On-Hand LF',
    'On-Hand Asset Cost'
  ]);
  expect(metrics.headerLineCounts).toEqual(new Array(9).fill(1));
  expect(metrics.headerFits).toEqual(new Array(9).fill(true));
  expect(metrics.bodyFontSize).toBeCloseTo(12, 2);
  expect(metrics.headerFontSize).toBeCloseTo(12.6667, 2);
  expect(metrics.centeredCells).toBe(metrics.cellCount);
  expect(metrics.overflowCells).toBe(0);
  expect(metrics.orphanCells).toBe(0);
  expect(metrics.headerClipped).toBe(0);
  expect(metrics.headerCollisions).toBe(0);
  expect(metrics.tableHeaderGroup).toBe('table-header-group');
  expect(metrics.tableLayout).toBe('fixed');
  expect(metrics.tableWidth).toBeGreaterThanOrEqual(994);
  expect(metrics.tableWidth).toBeLessThanOrEqual(995);
  expect(metrics.tableWidth).toBeLessThanOrEqual(metrics.rootWidth);
  expect(metrics.horizontalOverflow).toBe(false);
  expect(metrics.rowBreaks.every((value) => value === 'avoid')).toBe(true);
  expect(metrics.statusStacks).toContain('Checked Out|Job #JOB-1002|N/A');
  expect(metrics.statusStacks).toContain('Checked Out|Job #JOB-1005|Jordan Sample');
  expect(metrics.summaryCount).toBe(2);
  expect(metrics.finalTotalsText).toContain(`Matching Boxes${ROW_COUNT}`);
  expect(metrics.finalTotalsText).toContain('Boxes Missing Cost Basis');
  expect(metrics.checkedOutStatusWidthPercent).toBeCloseTo(8, 1);
  expect(metrics.filmWidthPercent).toBeCloseTo(24, 1);

  const screenshotDirectory = process.env.AUDIT_PRINT_SCREENSHOT_DIR?.trim();
  if (screenshotDirectory) {
    mkdirSync(screenshotDirectory, { recursive: true });
    const positions = await page.evaluate(() => {
      const rows = Array.from(
        document.querySelectorAll<HTMLElement>(
          '.warehouse-asset-audit-table tbody tr'
        )
      );
      const footer = document.querySelector<HTMLElement>(
        '.warehouse-asset-audit-print-footer'
      );
      const documentHeight = document.documentElement.scrollHeight;
      if (!rows.length || !footer) {
        throw new Error('Cannot capture audit print regions without rows and a footer.');
      }
      const middleTop = rows[Math.floor(rows.length / 2)].getBoundingClientRect().top;
      const finalTop = footer.getBoundingClientRect().top;
      const clipHeight = 755;
      return {
        first: 0,
        middle: Math.max(0, Math.min(middleTop - 120, documentHeight - clipHeight)),
        final: Math.max(0, Math.min(finalTop - 620, documentHeight - clipHeight))
      };
    });
    for (const [name, y] of Object.entries(positions)) {
      await page.evaluate((top) => window.scrollTo(0, top), y);
      await page.screenshot({
        path: path.join(screenshotDirectory, `${name}.png`)
      });
    }
    await page.evaluate(() => window.scrollTo(0, 0));
  }

  const pdf = await page.pdf({
    format: 'Letter',
    landscape: true,
    preferCSSPageSize: true,
    displayHeaderFooter: false,
    printBackground: true,
    scale: 1
  });
  const artifactPath = process.env.AUDIT_PRINT_PDF_PATH?.trim();
  if (artifactPath) {
    writeFileSync(artifactPath, pdf);
  }
  const pageCount = getPdfPageCount(pdf);
  expect(pageCount).toBeGreaterThanOrEqual(3);
  const mediaBoxes = getPdfMediaBoxes(pdf);
  expect(mediaBoxes.length).toBeGreaterThan(0);
  for (const mediaBox of mediaBoxes) {
    expect(mediaBox.width).toBeCloseTo(LETTER_LANDSCAPE_WIDTH_PT, 3);
    expect(mediaBox.height).toBeCloseTo(LETTER_LANDSCAPE_HEIGHT_PT, 3);
  }
});

test('emergency-wraps long checked-out context without changing screen or print geometry', async ({
  page
}) => {
  const multiWordCrew = 'Alexandra Field Operations Lead';
  const longCrewToken = 'SYNTHETICUNBROKENCREWCONTEXTTOKEN0123456789';
  const longJobToken = 'SYNTHETICUNBROKENJOBNUMBERTOKEN0123456789';
  const checkedOutRow = (
    index: number,
    checkedOutJobNumber: string,
    checkedOutCrewLeaderName: string | null
  ): WarehouseAssetAuditRow => ({
    ...buildRow(index),
    status: 'CHECKED_OUT',
    statusLabel: 'Checked Out',
    custodyBasis: 'CHECKOUT_SOURCE',
    checkedOutJobNumber,
    checkedOutCrewLeaderName
  });
  const rows: WarehouseAssetAuditRow[] = [
    checkedOutRow(100, 'JOB-SHORT', 'Alexis'),
    checkedOutRow(101, 'JOB-MULTI', multiWordCrew),
    checkedOutRow(102, 'JOB-CREW-TOKEN', longCrewToken),
    checkedOutRow(103, longJobToken, 'Jordan Sample'),
    checkedOutRow(104, 'JOB-NO-CREW', null),
    {
      ...buildRow(105),
      status: 'IN_STOCK',
      statusLabel: 'In Stock',
      custodyBasis: 'CURRENT_WAREHOUSE',
      checkedOutJobNumber: null,
      checkedOutCrewLeaderName: null
    },
    {
      ...buildRow(106),
      status: 'TRANSFER',
      statusLabel: 'Pending Transfer',
      custodyBasis: 'PENDING_TRANSFER_SOURCE',
      checkedOutJobNumber: null,
      checkedOutCrewLeaderName: null
    }
  ];

  await renderScreenTable(page, rows);
  const screenMetrics = await page.evaluate(({ crewToken, jobToken }) => {
    const wrapper = document.querySelector<HTMLElement>(
      '.warehouse-asset-audit-screen-table'
    );
    const table = wrapper?.querySelector<HTMLTableElement>(
      '.warehouse-asset-audit-table'
    );
    const cells = Array.from(table?.querySelectorAll<HTMLTableCellElement>('tbody td') || []);
    if (!wrapper || !table || cells.length === 0) {
      throw new Error('Synthetic screen table did not render.');
    }
    const textOverflow = (cell: HTMLElement) => {
      const cellRect = cell.getBoundingClientRect();
      const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
      let overflow = 0;
      let node = walker.nextNode();
      while (node) {
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of Array.from(range.getClientRects())) {
          overflow = Math.max(
            overflow,
            cellRect.left - rect.left,
            rect.right - cellRect.right
          );
        }
        node = walker.nextNode();
      }
      return Math.max(0, overflow);
    };
    const statusStack = table.querySelector<HTMLElement>(
      '.warehouse-asset-audit-status-stack'
    );
    const attributeValues = Array.from(
      table.querySelectorAll('.warehouse-asset-audit-status-stack *')
    ).flatMap((element) => Array.from(element.attributes, (attribute) => attribute.value));

    return {
      fontSize: Number.parseFloat(getComputedStyle(table).fontSize),
      tableWidth: table.getBoundingClientRect().width,
      wrapperWidth: wrapper.getBoundingClientRect().width,
      wrapperHorizontalOverflow: wrapper.scrollWidth > wrapper.clientWidth + 1,
      maxCellOverflow: Math.max(...cells.map(textOverflow)),
      statusStackMinInlineSize: statusStack
        ? getComputedStyle(statusStack).minInlineSize
        : '',
      attributeLeak:
        attributeValues.some((value) => value.includes(crewToken)) ||
        attributeValues.some((value) => value.includes(jobToken))
    };
  }, { crewToken: longCrewToken, jobToken: longJobToken });

  expect(screenMetrics.fontSize).toBeCloseTo(13.44, 2);
  expect(screenMetrics.tableWidth).toBeLessThanOrEqual(screenMetrics.wrapperWidth + 1);
  expect(screenMetrics.wrapperHorizontalOverflow).toBe(false);
  expect(screenMetrics.maxCellOverflow).toBeLessThanOrEqual(0.5);
  expect(screenMetrics.statusStackMinInlineSize).toBe('0px');
  expect(screenMetrics.attributeLeak).toBe(false);

  const snapshot = buildSnapshot(rows);
  await renderWorksheet(page, snapshot);
  const printMetrics = await page.evaluate(({
    crewToken,
    jobToken,
    multiWord
  }) => {
    const root = document.querySelector<HTMLElement>(
      '.warehouse-asset-audit-print-only-root'
    );
    const table = root?.querySelector<HTMLTableElement>(
      '.warehouse-asset-audit-table'
    );
    const renderedRows = Array.from(
      table?.querySelectorAll<HTMLTableRowElement>('tbody tr') || []
    );
    const cells = Array.from(table?.querySelectorAll<HTMLTableCellElement>('tbody td') || []);
    if (!root || !table || renderedRows.length === 0 || cells.length === 0) {
      throw new Error('Synthetic long-token worksheet did not render.');
    }
    const statusCell = (rowIndex: number) =>
      renderedRows[rowIndex].querySelector<HTMLElement>(
        '.warehouse-asset-audit-col-status'
      )!;
    const statusLine = (rowIndex: number, lineIndex: number) =>
      statusCell(rowIndex).querySelectorAll<HTMLElement>(
        '.warehouse-asset-audit-status-stack > span'
      )[lineIndex]!;
    const lineTops = (element: HTMLElement) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return new Set(
        Array.from(range.getClientRects(), (rect) => Math.round(rect.top * 2) / 2)
      ).size;
    };
    const wordLineCounts = (element: HTMLElement) => {
      const node = element.firstChild;
      if (!(node instanceof Text)) return [];
      const value = node.textContent || '';
      let offset = 0;
      return multiWord.split(' ').map((word) => {
        const start = value.indexOf(word, offset);
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + word.length);
        offset = start + word.length;
        return new Set(
          Array.from(range.getClientRects(), (rect) => Math.round(rect.top * 2) / 2)
        ).size;
      });
    };
    const textOverflow = (cell: HTMLElement) => {
      const cellRect = cell.getBoundingClientRect();
      const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
      let overflow = 0;
      let node = walker.nextNode();
      while (node) {
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of Array.from(range.getClientRects())) {
          overflow = Math.max(
            overflow,
            cellRect.left - rect.left,
            rect.right - cellRect.right
          );
        }
        node = walker.nextNode();
      }
      return Math.max(0, overflow);
    };
    const colWidths = Array.from(
      table.querySelectorAll<HTMLTableColElement>('col'),
      (col) => col.getBoundingClientRect().width
    );
    const tableWidth = table.getBoundingClientRect().width;
    const longCrewLine = statusLine(2, 2);
    const longJobLine = statusLine(3, 1);
    const longCrewStyle = getComputedStyle(longCrewLine);
    const adjacentOverlap = renderedRows.some((row) => {
      const rowCells = Array.from(row.cells, (cell) => cell.getBoundingClientRect());
      return rowCells.some(
        (cell, index) =>
          index < rowCells.length - 1 && cell.right > rowCells[index + 1].left + 0.5
      );
    });
    const attributeValues = Array.from(
      table.querySelectorAll('.warehouse-asset-audit-status-stack *')
    ).flatMap((element) => Array.from(element.attributes, (attribute) => attribute.value));

    return {
      rowIds: renderedRows.map((row) => row.dataset.auditRowId || ''),
      statusTexts: renderedRows.map(
        (row) =>
          row.querySelector('.warehouse-asset-audit-col-status')?.textContent || ''
      ),
      bodyFontSize: Number.parseFloat(
        getComputedStyle(cells[0]).fontSize
      ),
      statusWidthPercent: (colWidths[3] / tableWidth) * 100,
      filmWidthPercent: (colWidths[5] / tableWidth) * 100,
      maxCellOverflow: Math.max(...cells.map(textOverflow)),
      horizontalOverflow:
        root.scrollWidth > root.clientWidth + 1 ||
        table.scrollWidth > table.clientWidth + 1,
      adjacentOverlap,
      shortRowHeight: renderedRows[0].getBoundingClientRect().height,
      longCrewRowHeight: renderedRows[2].getBoundingClientRect().height,
      longJobRowHeight: renderedRows[3].getBoundingClientRect().height,
      multiWordLineCount: lineTops(statusLine(1, 2)),
      multiWordWordLineCounts: wordLineCounts(statusLine(1, 2)),
      longCrewLineCount: lineTops(longCrewLine),
      longJobLineCount: lineTops(longJobLine),
      longCrewText: longCrewLine.textContent || '',
      longJobText: longJobLine.textContent || '',
      emergencyStyle: {
        minInlineSize: longCrewStyle.minInlineSize,
        maxWidth: longCrewStyle.maxWidth,
        whiteSpace: longCrewStyle.whiteSpace,
        overflowWrap: longCrewStyle.overflowWrap,
        wordBreak: longCrewStyle.wordBreak,
        overflow: longCrewStyle.overflow,
        textOverflow: longCrewStyle.textOverflow
      },
      rowBreaks: renderedRows.map((row) => {
        const style = getComputedStyle(row);
        return style.breakInside || style.pageBreakInside;
      }),
      tableHeaderGroup: getComputedStyle(table.tHead as HTMLElement).display,
      attributeLeak:
        attributeValues.some((value) => value.includes(crewToken)) ||
        attributeValues.some((value) => value.includes(jobToken))
    };
  }, {
    crewToken: longCrewToken,
    jobToken: longJobToken,
    multiWord: multiWordCrew
  });

  expect(printMetrics.rowIds).toHaveLength(rows.length);
  expect(new Set(printMetrics.rowIds).size).toBe(rows.length);
  expect(printMetrics.statusTexts).toEqual([
    'Checked OutJob #JOB-SHORTAlexis',
    `Checked OutJob #JOB-MULTI${multiWordCrew}`,
    `Checked OutJob #JOB-CREW-TOKEN${longCrewToken}`,
    `Checked OutJob #${longJobToken}Jordan Sample`,
    'Checked OutJob #JOB-NO-CREWN/A',
    'In Stock',
    'Pending Transfer'
  ]);
  expect(printMetrics.bodyFontSize).toBeCloseTo(12, 2);
  expect(printMetrics.statusWidthPercent).toBeCloseTo(8, 1);
  expect(printMetrics.filmWidthPercent).toBeCloseTo(24, 1);
  expect(printMetrics.maxCellOverflow).toBeLessThanOrEqual(0.5);
  expect(printMetrics.horizontalOverflow).toBe(false);
  expect(printMetrics.adjacentOverlap).toBe(false);
  expect(printMetrics.longCrewRowHeight).toBeGreaterThan(printMetrics.shortRowHeight);
  expect(printMetrics.longJobRowHeight).toBeGreaterThan(printMetrics.shortRowHeight);
  expect(printMetrics.multiWordLineCount).toBeGreaterThan(1);
  expect(printMetrics.multiWordWordLineCounts).toEqual(new Array(4).fill(1));
  expect(printMetrics.longCrewLineCount).toBeGreaterThan(1);
  expect(printMetrics.longJobLineCount).toBeGreaterThan(1);
  expect(printMetrics.longCrewText).toBe(longCrewToken);
  expect(printMetrics.longJobText).toBe(`Job #${longJobToken}`);
  expect(printMetrics.emergencyStyle).toMatchObject({
    minInlineSize: '0px',
    whiteSpace: 'normal',
    overflowWrap: 'anywhere',
    wordBreak: 'normal',
    overflow: 'visible',
    textOverflow: 'clip'
  });
  expect(Number.parseFloat(printMetrics.emergencyStyle.maxWidth)).toBeGreaterThan(0);
  expect(printMetrics.rowBreaks.every((value) => value === 'avoid')).toBe(true);
  expect(printMetrics.tableHeaderGroup).toBe('table-header-group');
  expect(printMetrics.attributeLeak).toBe(false);

  const pdf = await page.pdf({
    format: 'Letter',
    landscape: true,
    preferCSSPageSize: true,
    displayHeaderFooter: false,
    printBackground: true,
    scale: 1
  });
  expect(getPdfPageCount(pdf)).toBe(2);
  for (const mediaBox of getPdfMediaBoxes(pdf)) {
    expect(mediaBox.width).toBeCloseTo(LETTER_LANDSCAPE_WIDTH_PT, 3);
    expect(mediaBox.height).toBeCloseTo(LETTER_LANDSCAPE_HEIGHT_PT, 3);
  }
});
