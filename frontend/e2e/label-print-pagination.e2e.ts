import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer, type ViteDevServer } from 'vite';
import type {
  LabelTemplatePreset,
  PrintableLabel
} from '../src/features/inventory/components/labels/PrintableLabelSheet';

const PRINT_CSS = readFileSync('src/styles.css', 'utf8');
const CSS_PIXELS_PER_INCH = 96;
const PDF_POINTS_PER_INCH = 72;
const LETTER_LANDSCAPE_WIDTH_PT = 11 * PDF_POINTS_PER_INCH;
const LETTER_LANDSCAPE_HEIGHT_PT = 8.5 * PDF_POINTS_PER_INCH;
const GEOMETRY_TOLERANCE_PX = 0.1;
const TRANSPARENT_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

let viteServer: ViteDevServer;
let PrintableLabelSheet: ComponentType<{ labels: PrintableLabel[] }>;
let labelTemplatePresets: Record<string, LabelTemplatePreset>;

type SyntheticLabel = Omit<PrintableLabel, 'slot'> & {
  sourceId: string;
};

type PrintSettings = {
  headers: boolean;
  margins: 'default' | 'none';
};

type ElementGeometry = {
  width: number;
  height: number;
};

type SheetGeometry = {
  sheet: ElementGeometry;
  cards: ElementGeometry[];
  qrBoxes: ElementGeometry[];
  qrImages: ElementGeometry[];
  historyGrids: ElementGeometry[];
  boxIdBlocks: ElementGeometry[];
  runNumberBlocks: ElementGeometry[];
  filmNames: ElementGeometry[];
  widths: ElementGeometry[];
};

type PrintDomSnapshot = {
  bodyHeight: number;
  bodyMargin: string;
  appRootDisplay: string;
  auditRootDisplay: string;
  printHostPosition: string;
  printHostHeight: number;
  printHostBreakAfter: string;
  printHostMargin: string;
  printHostPseudoBeforeContent: string;
  printHostPseudoAfterContent: string;
  sheetBreaks: string[];
  sheetLegacyBreaks: string[];
  sheetTransforms: string[];
  sheetOverflows: Array<{ x: number; y: number }>;
  visibleLabelsPerSheet: number[];
  hiddenCardsPerSheet: number[];
  labelSlots: string[];
  labelIds: string[];
  nonWhitespaceTextNodes: number;
  geometry: SheetGeometry[];
};

const syntheticLabels: SyntheticLabel[] = Array.from({ length: 4 }, (_, index) => {
  const ordinal = index + 1;
  const sourceId = `SYN-${ordinal}`;

  return {
    sourceId,
    draft: {
      date: '01/02/2030',
      jobId: `JOB-${ordinal}`,
      weightLbs: `${10 + index}.0`,
      by: 'QA',
      balance: `${100 - index}`,
      checked: '',
      filmName: `Synthetic Film ${ordinal}`,
      width: `${48 + index}"`,
      boxId: sourceId,
      runNumber: `RUN-${ordinal}`
    },
    qrDataUrl: TRANSPARENT_PNG_DATA_URL,
    qrPayload: sourceId,
    qrError: ''
  };
});

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function inchesToPixels(inches: number): number {
  return inches * CSS_PIXELS_PER_INCH;
}

function buildLabelSheets(labels: SyntheticLabel[]): string[] {
  const sheets: string[] = [];

  for (let index = 0; index < labels.length; index += 2) {
    const sheetLabels = labels.slice(index, index + 2).map<PrintableLabel>((label, slotIndex) => ({
      slot: slotIndex === 0 ? 'A' : 'B',
      draft: label.draft,
      qrDataUrl: label.qrDataUrl,
      qrPayload: label.qrPayload,
      qrError: label.qrError
    }));
    sheets.push(renderToStaticMarkup(createElement(PrintableLabelSheet, { labels: sheetLabels })));
  }

  return sheets;
}

async function renderPrintDocument(page: Page, labels: SyntheticLabel[]): Promise<void> {
  const sheets = buildLabelSheets(labels);
  const preview = sheets[0] || '';
  const printSheets = sheets.join('\n    ');

  await page.setViewportSize({
    width: inchesToPixels(11),
    height: inchesToPixels(8.5)
  });
  await page.setContent(`
    <!doctype html>
    <html>
      <head>
        <title>Synthetic Label Print Regression</title>
        <style>${PRINT_CSS}</style>
        <style>
          #root::before,
          #root::after {
            content: "hidden-flow-probe";
            display: block;
            height: 1in;
          }
        </style>
      </head>
      <body class="label-printing">
        <div id="root">
          <main class="app-shell">
            <section class="label-preview-panel">
              <div class="label-print-root">${preview}</div>
            </section>
          </main>
        </div>
        <div class="warehouse-asset-audit-print-only-root">
          <div class="warehouse-asset-audit-worksheet">Audit print must stay hidden.</div>
        </div>
        <div class="label-print-only-root print-root">
          ${printSheets}
        </div>
      </body>
    </html>
  `);
  await page.emulateMedia({ media: 'print' });
  await page.waitForFunction(() =>
    Array.from(document.images).every((image) => image.complete)
  );
}

async function readPrintDom(page: Page): Promise<PrintDomSnapshot> {
  return page.evaluate(() => {
    const host = document.querySelector<HTMLElement>(
      'body > .label-print-only-root.print-root'
    );
    const appRoot = document.querySelector<HTMLElement>('#root');
    const auditRoot = document.querySelector<HTMLElement>(
      'body > .warehouse-asset-audit-print-only-root'
    );
    const sheets = Array.from(
      host?.querySelectorAll<HTMLElement>(':scope > .label-print-sheet') || []
    );

    if (!host || !appRoot || !auditRoot || sheets.length === 0) {
      throw new Error('Synthetic print DOM did not render the expected roots and sheets.');
    }

    function size(element: Element): ElementGeometry {
      const rect = element.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    }

    const geometry = sheets.map<SheetGeometry>((sheet) => ({
      sheet: size(sheet),
      cards: Array.from(
        sheet.querySelectorAll<HTMLElement>('.print-label-card:not(.print-label-card-empty)')
      ).map(size),
      qrBoxes: Array.from(sheet.querySelectorAll<HTMLElement>('.print-label-qr-box')).map(size),
      qrImages: Array.from(sheet.querySelectorAll<HTMLImageElement>('.print-label-qr-box img')).map(
        size
      ),
      historyGrids: Array.from(
        sheet.querySelectorAll<HTMLElement>('.print-label-log-grid')
      ).map(size),
      boxIdBlocks: Array.from(
        sheet.querySelectorAll<HTMLElement>('.print-label-box-id-block')
      ).map(size),
      runNumberBlocks: Array.from(
        sheet.querySelectorAll<HTMLElement>('.print-label-run-number-block')
      ).map(size),
      filmNames: Array.from(sheet.querySelectorAll<HTMLElement>('.print-label-film-name')).map(
        size
      ),
      widths: Array.from(sheet.querySelectorAll<HTMLElement>('.print-label-width')).map(size)
    }));

    for (const sheet of sheets) {
      const sheetRect = sheet.getBoundingClientRect();
      const containedElements = sheet.querySelectorAll<HTMLElement>(
        '.print-label-card:not(.print-label-card-empty), .print-label-qr-box, .print-label-log-grid, .print-label-box-id-block, .print-label-run-number-block, .print-label-film-name, .print-label-width'
      );
      for (const element of containedElements) {
        const rect = element.getBoundingClientRect();
        const tolerance = 0.1;
        if (
          rect.left < sheetRect.left - tolerance ||
          rect.top < sheetRect.top - tolerance ||
          rect.right > sheetRect.right + tolerance ||
          rect.bottom > sheetRect.bottom + tolerance
        ) {
          throw new Error(`Print element ${element.className} escaped its label sheet.`);
        }
      }
    }

    return {
      bodyHeight: document.body.scrollHeight,
      bodyMargin: getComputedStyle(document.body).margin,
      appRootDisplay: getComputedStyle(appRoot).display,
      auditRootDisplay: getComputedStyle(auditRoot).display,
      printHostPosition: getComputedStyle(host).position,
      printHostHeight: host.getBoundingClientRect().height,
      printHostBreakAfter: getComputedStyle(host).breakAfter,
      printHostMargin: getComputedStyle(host).margin,
      printHostPseudoBeforeContent: getComputedStyle(host, '::before').content,
      printHostPseudoAfterContent: getComputedStyle(host, '::after').content,
      sheetBreaks: sheets.map((sheet) => getComputedStyle(sheet).breakAfter),
      sheetLegacyBreaks: sheets.map((sheet) => getComputedStyle(sheet).pageBreakAfter),
      sheetTransforms: sheets.map((sheet) => getComputedStyle(sheet).transform),
      sheetOverflows: sheets.map((sheet) => ({
        x: Math.max(0, sheet.scrollWidth - sheet.clientWidth),
        y: Math.max(0, sheet.scrollHeight - sheet.clientHeight)
      })),
      visibleLabelsPerSheet: sheets.map(
        (sheet) =>
          Array.from(
            sheet.querySelectorAll<HTMLElement>(
              '.print-label-card:not(.print-label-card-empty)'
            )
          ).filter((card) => getComputedStyle(card).visibility !== 'hidden').length
      ),
      hiddenCardsPerSheet: sheets.map(
        (sheet) =>
          Array.from(sheet.querySelectorAll<HTMLElement>('.print-label-card-empty')).filter(
            (card) => getComputedStyle(card).visibility === 'hidden' && card.textContent === ''
          ).length
      ),
      labelSlots: Array.from(
        host.querySelectorAll<HTMLElement>('[aria-label^="Printable Label"]')
      ).map((label) => label.getAttribute('aria-label') || ''),
      labelIds: Array.from(
        host.querySelectorAll<HTMLElement>('.print-label-box-id-value')
      ).map((label) => label.textContent?.trim() || ''),
      nonWhitespaceTextNodes: Array.from(host.childNodes).filter(
        (node) => node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim())
      ).length,
      geometry
    };
  });
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

async function generatePdf(
  page: Page,
  settings: PrintSettings,
  artifactName: string
): Promise<Buffer> {
  const margin =
    settings.margins === 'default'
      ? { top: '0.4in', right: '0.4in', bottom: '0.4in', left: '0.4in' }
      : { top: '0', right: '0', bottom: '0', left: '0' };
  const pdf = await page.pdf({
    format: 'Letter',
    landscape: true,
    preferCSSPageSize: true,
    displayHeaderFooter: settings.headers,
    headerTemplate: settings.headers
      ? '<div style="width:100%;font-size:8px;padding:0 0.25in">Synthetic header</div>'
      : undefined,
    footerTemplate: settings.headers
      ? '<div style="width:100%;font-size:8px;padding:0 0.25in">Synthetic footer <span class="pageNumber"></span>/<span class="totalPages"></span></div>'
      : undefined,
    printBackground: true,
    scale: 1,
    margin
  });

  const artifactDirectory = process.env.LABEL_PRINT_PDF_DIR?.trim();
  if (artifactDirectory) {
    mkdirSync(artifactDirectory, { recursive: true });
    writeFileSync(path.join(artifactDirectory, `${artifactName}.pdf`), pdf);
  }

  return pdf;
}

function expectLetterLandscape(pdf: Buffer, expectedPages: number): void {
  expect(getPdfPageCount(pdf)).toBe(expectedPages);
  const mediaBoxes = getPdfMediaBoxes(pdf);
  expect(mediaBoxes.length).toBeGreaterThan(0);
  for (const mediaBox of mediaBoxes) {
    expect(mediaBox.width).toBeCloseTo(LETTER_LANDSCAPE_WIDTH_PT, 3);
    expect(mediaBox.height).toBeCloseTo(LETTER_LANDSCAPE_HEIGHT_PT, 3);
  }
}

function expectGeometry(snapshot: PrintDomSnapshot): void {
  const preset = labelTemplatePresets.double;
  const expected = {
    sheet: {
      width: inchesToPixels(preset.pageWidthIn),
      height: inchesToPixels(preset.pageHeightIn)
    },
    card: {
      width: inchesToPixels(preset.labelWidthIn),
      height: inchesToPixels(preset.labelHeightIn)
    },
    historyGrid: {
      width: inchesToPixels(sum(preset.gridColumnWidthsIn)),
      height: inchesToPixels(preset.labelHeightIn - 0.31 - 2.62)
    },
    qrBox: {
      width: inchesToPixels(preset.detailColumnWidthsIn[0]),
      height: inchesToPixels(preset.qrAreaHeightIn)
    },
    qrImage: {
      width: inchesToPixels(1.05),
      height: inchesToPixels(1.05)
    },
    boxIdBlock: {
      width: inchesToPixels(preset.detailColumnWidthsIn[0]),
      height: inchesToPixels(0.9)
    },
    runNumberBlock: {
      width: inchesToPixels(preset.detailColumnWidthsIn[1] + preset.detailColumnWidthsIn[2]),
      height: inchesToPixels(0.9)
    },
    filmName: {
      width: inchesToPixels(preset.detailColumnWidthsIn[1]),
      height: inchesToPixels(preset.qrAreaHeightIn)
    },
    width: {
      width: inchesToPixels(preset.detailColumnWidthsIn[2]),
      height: inchesToPixels(preset.qrAreaHeightIn)
    }
  };

  function expectSize(actual: ElementGeometry, target: ElementGeometry): void {
    expect(Math.abs(actual.width - target.width)).toBeLessThanOrEqual(GEOMETRY_TOLERANCE_PX);
    expect(Math.abs(actual.height - target.height)).toBeLessThanOrEqual(GEOMETRY_TOLERANCE_PX);
  }

  for (const geometry of snapshot.geometry) {
    expectSize(geometry.sheet, expected.sheet);
    geometry.cards.forEach((card) => expectSize(card, expected.card));
    geometry.historyGrids.forEach((grid) => expectSize(grid, expected.historyGrid));
    geometry.qrBoxes.forEach((qrBox) => expectSize(qrBox, expected.qrBox));
    geometry.qrImages.forEach((qrImage) => expectSize(qrImage, expected.qrImage));
    geometry.boxIdBlocks.forEach((block) => expectSize(block, expected.boxIdBlock));
    geometry.runNumberBlocks.forEach((block) => expectSize(block, expected.runNumberBlock));
    geometry.filmNames.forEach((filmName) => expectSize(filmName, expected.filmName));
    geometry.widths.forEach((width) => expectSize(width, expected.width));
  }
}

test.beforeAll(async () => {
  viteServer = await createServer({
    appType: 'custom',
    server: {
      middlewareMode: true
    }
  });
  const componentModule = await viteServer.ssrLoadModule(
    '/src/features/inventory/components/labels/PrintableLabelSheet.tsx'
  );
  PrintableLabelSheet = componentModule.PrintableLabelSheet;
  labelTemplatePresets = componentModule.LABEL_TEMPLATE_PRESETS;
});

test.afterAll(async () => {
  await viteServer.close();
});

test('prints two labels once on one page across the Chromium settings matrix', async ({
  page
}) => {
  await renderPrintDocument(page, syntheticLabels.slice(0, 2));
  const snapshot = await readPrintDom(page);

  expect(snapshot.appRootDisplay).toBe('none');
  expect(snapshot.auditRootDisplay).toBe('none');
  expect(snapshot.printHostPosition).toBe('static');
  expect(snapshot.printHostHeight).toBeCloseTo(inchesToPixels(8.5), 3);
  expect(snapshot.printHostBreakAfter).toBe('auto');
  expect(snapshot.printHostMargin).toBe('0px');
  expect(snapshot.printHostPseudoBeforeContent).toBe('none');
  expect(snapshot.printHostPseudoAfterContent).toBe('none');
  expect(snapshot.bodyHeight).toBe(inchesToPixels(8.5));
  expect(snapshot.bodyMargin).toBe('0px');
  expect(snapshot.sheetBreaks).toEqual(['auto']);
  expect(snapshot.sheetLegacyBreaks).toEqual(['auto']);
  expect(snapshot.sheetTransforms).toEqual(['none']);
  expect(snapshot.sheetOverflows).toEqual([{ x: 0, y: 0 }]);
  expect(snapshot.visibleLabelsPerSheet).toEqual([2]);
  expect(snapshot.hiddenCardsPerSheet).toEqual([0]);
  expect(snapshot.labelSlots).toEqual(['Printable Label A', 'Printable Label B']);
  expect(snapshot.labelIds).toEqual(['SYN-1', 'SYN-2']);
  expect(snapshot.nonWhitespaceTextNodes).toBe(0);
  expectGeometry(snapshot);

  for (const margins of ['default', 'none'] as const) {
    for (const headers of [false, true]) {
      const pdf = await generatePdf(
        page,
        { margins, headers },
        `two-labels-${margins}-headers-${headers ? 'on' : 'off'}`
      );
      expectLetterLandscape(pdf, 1);
    }
  }
});

test('prints a single label on one page without a visible phantom card', async ({ page }) => {
  await renderPrintDocument(page, syntheticLabels.slice(0, 1));
  const snapshot = await readPrintDom(page);

  expect(snapshot.visibleLabelsPerSheet).toEqual([1]);
  expect(snapshot.hiddenCardsPerSheet).toEqual([1]);
  expect(snapshot.labelSlots).toEqual(['Printable Label A']);
  expect(snapshot.labelIds).toEqual(['SYN-1']);
  expect(snapshot.sheetBreaks).toEqual(['auto']);
  expectGeometry(snapshot);

  const pdf = await generatePdf(
    page,
    { margins: 'default', headers: false },
    'one-label-default-headers-off'
  );
  expectLetterLandscape(pdf, 1);
});

test('preserves source order and paginates incomplete and complete synthetic pairs', async ({
  page
}) => {
  for (const count of [3, 4]) {
    const labels = syntheticLabels.slice(0, count);
    await renderPrintDocument(page, labels);
    const snapshot = await readPrintDom(page);

    expect(snapshot.printHostPosition).toBe('static');
    expect(snapshot.printHostHeight).toBeCloseTo(inchesToPixels(17), 3);
    expect(snapshot.bodyHeight).toBe(inchesToPixels(17));
    expect(snapshot.printHostBreakAfter).toBe('auto');
    expect(snapshot.sheetBreaks).toEqual(['page', 'auto']);
    expect(snapshot.sheetLegacyBreaks).toEqual(['always', 'auto']);
    expect(snapshot.visibleLabelsPerSheet).toEqual(count === 3 ? [2, 1] : [2, 2]);
    expect(snapshot.hiddenCardsPerSheet).toEqual(count === 3 ? [0, 1] : [0, 0]);
    expect(snapshot.labelSlots).toEqual(
      count === 3
        ? ['Printable Label A', 'Printable Label B', 'Printable Label A']
        : [
            'Printable Label A',
            'Printable Label B',
            'Printable Label A',
            'Printable Label B'
          ]
    );
    expect(snapshot.labelIds).toEqual(labels.map((label) => label.sourceId));
    expect(new Set(snapshot.labelIds).size).toBe(count);
    expect(snapshot.sheetOverflows).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 0 }
    ]);
    expect(snapshot.nonWhitespaceTextNodes).toBe(0);
    expectGeometry(snapshot);

    const pdf = await generatePdf(
      page,
      { margins: 'default', headers: true },
      `${count}-labels-default-headers-on`
    );
    expectLetterLandscape(pdf, 2);
  }
});

test('does not accumulate print portals across two attempts in one Chromium session', async ({
  page
}) => {
  const printSheet = buildLabelSheets(syntheticLabels.slice(0, 2))[0];
  await page.setViewportSize({
    width: inchesToPixels(11),
    height: inchesToPixels(8.5)
  });
  await page.setContent(`
    <!doctype html>
    <html>
      <head>
        <style>${PRINT_CSS}</style>
      </head>
      <body>
        <div id="root">
          <button id="print-attempt" type="button">Print labels</button>
        </div>
        <div class="warehouse-asset-audit-print-only-root">
          <div class="warehouse-asset-audit-worksheet">Audit print must stay hidden.</div>
        </div>
      </body>
    </html>
  `);
  await page.emulateMedia({ media: 'print' });
  await page.evaluate((sheetMarkup) => {
    const captures: Array<{
      appRootDisplay: string;
      auditRootDisplay: string;
      bodyPrinting: boolean;
      labelIds: string[];
      labelSlots: string[];
      printRoots: number;
      sheets: number;
    }> = [];
    Object.defineProperty(window, '__labelPrintLifecycleCaptures', {
      configurable: true,
      value: captures
    });
    Object.defineProperty(window, 'print', {
      configurable: true,
      value: () => {
        const roots = Array.from(document.body.children).filter(
          (element) =>
            element instanceof HTMLElement &&
            element.classList.contains('label-print-only-root') &&
            element.classList.contains('print-root')
        );
        const printRoot = roots[0];
        captures.push({
          appRootDisplay: getComputedStyle(
            document.querySelector('#root') as HTMLElement
          ).display,
          auditRootDisplay: getComputedStyle(
            document.querySelector('.warehouse-asset-audit-print-only-root') as HTMLElement
          ).display,
          bodyPrinting: document.body.classList.contains('label-printing'),
          labelIds: Array.from(
            printRoot?.querySelectorAll<HTMLElement>('.print-label-box-id-value') || []
          ).map((label) => label.textContent?.trim() || ''),
          labelSlots: Array.from(
            printRoot?.querySelectorAll<HTMLElement>('[aria-label^="Printable Label"]') || []
          ).map((label) => label.getAttribute('aria-label') || ''),
          printRoots: roots.length,
          sheets: printRoot?.querySelectorAll('.label-print-sheet').length || 0
        });
      }
    });

    document.querySelector('#print-attempt')?.addEventListener('click', () => {
      document.body.classList.add('label-printing');
      const printRoot = document.createElement('div');
      printRoot.className = 'label-print-only-root print-root';
      printRoot.setAttribute('aria-hidden', 'true');
      printRoot.innerHTML = sheetMarkup;
      document.body.appendChild(printRoot);
      try {
        window.print();
      } finally {
        document.body.classList.remove('label-printing');
        printRoot.remove();
      }
    });
  }, printSheet);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.locator('#print-attempt').click();
    await expect
      .poll(() =>
        page.evaluate(() => ({
          bodyPrinting: document.body.classList.contains('label-printing'),
          printRoots: document.querySelectorAll(
            'body > .label-print-only-root.print-root'
          ).length,
          rootDisplay: getComputedStyle(document.querySelector('#root') as HTMLElement).display
        }))
      )
      .toEqual({
        bodyPrinting: false,
        printRoots: 0,
        rootDisplay: 'block'
      });
  }

  const captures = await page.evaluate(
    () =>
      (
        window as typeof window & {
          __labelPrintLifecycleCaptures: Array<{
            appRootDisplay: string;
            auditRootDisplay: string;
            bodyPrinting: boolean;
            labelIds: string[];
            labelSlots: string[];
            printRoots: number;
            sheets: number;
          }>;
        }
      ).__labelPrintLifecycleCaptures
  );

  const expectedCapture = {
    appRootDisplay: 'none',
    auditRootDisplay: 'none',
    bodyPrinting: true,
    labelIds: ['SYN-1', 'SYN-2'],
    labelSlots: ['Printable Label A', 'Printable Label B'],
    printRoots: 1,
    sheets: 1
  };
  expect(captures).toEqual([expectedCapture, expectedCapture]);
});
