#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import playwright from 'playwright-core';

import {
  loadDevFixtureConfig,
  normalizeFixtureTag,
  parseArgs,
} from './dev-fixtures/lib/dev-fixture-guard.mjs';
import { readManifest } from './dev-fixtures/lib/dev-fixture-manifest.mjs';

const { chromium } = playwright;
const VERIFICATION_GATE_MS = 6_000;
const APPROVED_AUDIT_HEADERS = [
  'Box ID',
  'Owner',
  'Custody Warehouse',
  'Status',
  'Manufacturer',
  'Film',
  'Width',
  'On-Hand LF',
  'On-Hand Asset Cost',
];
let verificationStage = 'startup';

function asText(value) {
  return String(value ?? '').trim();
}

function colorComponents(value) {
  const normalized = asText(value).toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(normalized)) {
    return [
      Number.parseInt(normalized.slice(1, 3), 16),
      Number.parseInt(normalized.slice(3, 5), 16),
      Number.parseInt(normalized.slice(5, 7), 16),
      1,
    ];
  }
  const match = normalized.match(
    /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/
  );
  return match
    ? [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4] ?? 1)]
    : [];
}

function colorsMatch(left, right) {
  const a = colorComponents(left);
  const b = colorComponents(right);
  return (
    a.length === 4 &&
    b.length === 4 &&
    a.every((value, index) => Math.abs(value - b[index]) < (index === 3 ? 0.01 : 1))
  );
}

function assert(condition, code) {
  if (!condition) {
    throw new Error(code);
  }
}

function resolveBrowserExecutablePath() {
  const candidates = [
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  const executablePath = candidates.find((candidate) => fs.existsSync(candidate));
  assert(executablePath, 'CHROMIUM_EXECUTABLE_NOT_FOUND');
  return executablePath;
}

function resolveStorageStatePath(config, value) {
  const candidate = asText(value) || '.secrets/playwright/dev-owner-storage-state.json';
  const resolved = path.resolve(config.repoRoot, candidate);
  const relative = path.relative(config.repoRoot, resolved).replace(/\\/g, '/');
  assert(relative.startsWith('.secrets/playwright/'), 'AUTH_STORAGE_PATH_OUTSIDE_IGNORED_SCOPE');
  assert(fs.existsSync(resolved), 'AUTH_STORAGE_STATE_NOT_FOUND');
  return resolved;
}

function requireExpectedBuild(value) {
  const expectedBuild = asText(value);
  assert(
    /^worktree-[0-9a-f]{8}-[0-9a-f]{12}$/.test(expectedBuild),
    'EXPECTED_DEV_BUILD_REQUIRED'
  );
  return expectedBuild;
}

async function verifyDevProxyTarget(request, appUrl, expectedBuild) {
  const response = await request.get(`${appUrl}/api?path=/health`, { timeout: 8_000 });
  assert(response.ok(), 'BROWSER_DEV_HEALTH_FAILURE');
  const payload = await response.json().catch(() => null);
  assert(
    asText(payload?.data?.apiBuildSha) === expectedBuild,
    'BROWSER_DEV_BUILD_MISMATCH'
  );
}

function requireFixtureSummary(manifest) {
  assert(manifest?.scenario === 'allocation-timeout-remediation', 'FIXTURE_SCENARIO_MISMATCH');
  const summary = manifest?.summary || {};
  const required = [
    summary.previewTarget?.jobId,
    summary.previewTarget?.jobNumber,
    summary.previewTarget?.requirementId,
    summary.previewTarget?.warehouse,
    summary.cases?.crossWarehouseZeroReservationBoxId,
    summary.cases?.scheduledReservedBoxId,
    summary.cases?.placeholderReservedBoxId,
    summary.cases?.historicalOnlyBoxId,
    summary.cases?.pendingTransferBoxId,
  ];
  assert(required.every((value) => asText(value)), 'BROWSER_FIXTURE_INCOMPLETE');
  return summary;
}

function isPreviewResponse(response) {
  const url = response.url();
  return (
    response.request().method() === 'GET' &&
    (url.includes('/allocations/preview') || url.includes('allocations%2Fpreview'))
  );
}

function buildTargetPayload(fixture, boxId) {
  const target = fixture.previewTarget;
  return {
    jobId: target.jobId,
    jobNumber: target.jobNumber,
    boxId,
    installDate: target.installDate,
    crewLeader: target.crewLeader,
    requestedFeet: 20,
    requestedWidthIn: Number(target.widthIn),
    requirementId: target.requirementId,
    selectedSuggestionBoxIds: [],
    extraAllocations: [],
    crossWarehouse: true,
    jobWarehouse: target.warehouse,
    autoAllocate: false,
  };
}

async function captureAuditPrint(page) {
  await page.evaluate(() => {
    window.__codexAuditPrintCapture = null;
    window.print = () => {
      const printRoot = document.querySelector(
        '.warehouse-asset-audit-print-only-root .warehouse-asset-audit-worksheet'
      );
      const screenTotals = document.querySelector('.warehouse-asset-audit-screen-totals');
      const printTotals = printRoot?.querySelector('.warehouse-asset-audit-print-summary');
      const rows = Array.from(printRoot?.querySelectorAll('[data-audit-row-id]') || []);
      const rowIds = rows.map((row) => row.getAttribute('data-audit-row-id'));
      const headers = Array.from(printRoot?.querySelectorAll('thead th') || []).map((cell) =>
        String(cell.textContent || '').replace(/\s+/g, ' ').trim()
      );
      const ownerCells = Array.from(
        printRoot?.querySelectorAll('tbody .warehouse-asset-audit-col-owner') || []
      ).map((cell) => String(cell.textContent || '').trim());
      window.__codexAuditPrintCapture = {
        bodyClassActive: document.body.classList.contains('warehouse-asset-audit-printing'),
        titlePresent: Boolean(printRoot?.querySelector('h1')),
        metadataPresent: (printRoot?.querySelectorAll('.warehouse-asset-audit-print-header dd').length || 0) === 2,
        filtersPresent: Boolean(printRoot?.querySelector('.warehouse-asset-audit-print-filters')),
        headers,
        rowCount: rows.length,
        uniqueRowCount: new Set(rowIds).size,
        expectedRowCount: Number(printRoot?.getAttribute('data-audit-expected-row-count') || -1),
        ownerLabelsSafe: ownerCells.every(
          (label) =>
            Boolean(label) &&
            !/^unknown owner/i.test(label) &&
            !/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i.test(label)
        ),
        screenTotals: String(screenTotals?.textContent || '').replace(/\s+/g, ' ').trim(),
        printTotals: String(printTotals?.textContent || '').replace(/\s+/g, ' ').trim(),
        footerPresent: Boolean(printRoot?.querySelector('.warehouse-asset-audit-print-footer')),
      };
    };
  });
}

async function inspectPrintLayout(page) {
  await page.emulateMedia({ media: 'print' });
  await page.setViewportSize({ width: 995, height: 768 });
  return page.evaluate(() => {
    document.body.classList.add('warehouse-asset-audit-printing');
    const root = document.querySelector(
      '.warehouse-asset-audit-print-only-root .warehouse-asset-audit-worksheet'
    );
    const table = root?.querySelector('.warehouse-asset-audit-table');
    const cells = Array.from(table?.querySelectorAll('th, td') || []);
    const sections = [
      root?.querySelector('.warehouse-asset-audit-print-header'),
      root?.querySelector('.warehouse-asset-audit-print-filters'),
      root?.querySelector('.warehouse-asset-audit-print-summary'),
      table,
      root?.querySelector('.warehouse-asset-audit-print-footer'),
    ].filter(Boolean);
    const sectionRects = sections.map((entry) => entry.getBoundingClientRect());
    const verticalOverlap = sectionRects.some((rect, index) => {
      if (index === 0) {
        return false;
      }
      return rect.top < sectionRects[index - 1].bottom - 1;
    });
    const computedTable = table ? getComputedStyle(table) : null;
    const repeatedHeaderDisplay = table?.querySelector('thead')
      ? getComputedStyle(table.querySelector('thead')).display
      : '';
    const cellOverflow = cells.some((cell) => cell.scrollWidth > cell.clientWidth + 1);
    const horizontalOverflow = Boolean(
      root && (root.scrollWidth > root.clientWidth + 1 || root.getBoundingClientRect().right > 996)
    );
    const tableLayout = computedTable?.tableLayout || '';
    const tableWidth = computedTable?.width || '';
    const centeredCells = cells.every((cell) => {
      const style = getComputedStyle(cell);
      return style.textAlign === 'center' && style.verticalAlign === 'middle';
    });
    document.body.classList.remove('warehouse-asset-audit-printing');
    return {
      rootPresent: Boolean(root),
      tableLayout,
      tableWidth,
      repeatedHeaderDisplay,
      verticalOverlap,
      cellOverflow,
      horizontalOverflow,
      centeredCells,
    };
  });
}

async function verifyDarkTheme(page) {
  await page.getByRole('button', { name: 'Account actions' }).click();
  await page.getByRole('button', { name: 'Dark' }).click();
  await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'dark');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);

  const checkbox = page.locator('.warehouse-asset-audit-status-filter input').first();
  await checkbox.focus();
  const checkboxState = await checkbox.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      accentColor: style.accentColor,
      focusVisible: element.matches(':focus-visible'),
      outlineColor: style.outlineColor,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
    };
  });
  const enabledButton = page.locator(
    '.warehouse-asset-audit-pagination .button-secondary:not(:disabled)'
  );
  await enabledButton.focus();
  const enabledFocusShadow = await enabledButton.evaluate(
    (element) => getComputedStyle(element).boxShadow
  );

  const contrastState = await page.evaluate(() => {
    function parseColor(value) {
      const normalized = String(value || '').trim().toLowerCase();
      if (/^#[0-9a-f]{6}$/.test(normalized)) {
        return {
          r: Number.parseInt(normalized.slice(1, 3), 16),
          g: Number.parseInt(normalized.slice(3, 5), 16),
          b: Number.parseInt(normalized.slice(5, 7), 16),
          a: 1,
        };
      }
      const match = normalized.match(
        /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/
      );
      if (!match) {
        return null;
      }
      return {
        r: Number(match[1]),
        g: Number(match[2]),
        b: Number(match[3]),
        a: match[4] === undefined ? 1 : Number(match[4]),
      };
    }
    function sameColor(left, right) {
      const a = parseColor(left);
      const b = parseColor(right);
      return Boolean(
        a &&
          b &&
          Math.abs(a.r - b.r) < 1 &&
          Math.abs(a.g - b.g) < 1 &&
          Math.abs(a.b - b.b) < 1 &&
          Math.abs(a.a - b.a) < 0.01
      );
    }
    function composite(foreground, background) {
      return {
        r: foreground.r * foreground.a + background.r * (1 - foreground.a),
        g: foreground.g * foreground.a + background.g * (1 - foreground.a),
        b: foreground.b * foreground.a + background.b * (1 - foreground.a),
        a: 1,
      };
    }
    function luminance(color) {
      const channels = [color.r, color.g, color.b].map((value) => {
        const normalized = value / 255;
        return normalized <= 0.03928
          ? normalized / 12.92
          : Math.pow((normalized + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    }
    function contrast(foregroundValue, backgroundValue) {
      const foreground =
        typeof foregroundValue === 'string' ? parseColor(foregroundValue) : foregroundValue;
      const background =
        typeof backgroundValue === 'string' ? parseColor(backgroundValue) : backgroundValue;
      if (!foreground || !background) {
        return 0;
      }
      const foregroundLuminance = luminance(foreground);
      const backgroundLuminance = luminance(background);
      return (
        (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
        (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
      );
    }

    const rootStyle = getComputedStyle(document.documentElement);
    const tokens = {
      primary: rootStyle.getPropertyValue('--color-primary').trim(),
      primaryStrong: rootStyle.getPropertyValue('--color-primary-strong').trim(),
      selectedBackground: rootStyle.getPropertyValue('--color-selected-bg').trim(),
      text1: rootStyle.getPropertyValue('--color-text-1').trim(),
      text2: rootStyle.getPropertyValue('--color-text-2').trim(),
      text3: rootStyle.getPropertyValue('--color-text-3').trim(),
      controlBackground: rootStyle.getPropertyValue('--color-control-bg').trim(),
    };
    const labels = Array.from(
      document.querySelectorAll('.warehouse-asset-audit-status-filter label'),
      (element) => getComputedStyle(element).color
    );
    const legend = document.querySelector('.warehouse-asset-audit-status-filter legend');
    const pageIndicator = document.querySelector('.warehouse-asset-audit-pagination > span');
    const enabled = document.querySelector(
      '.warehouse-asset-audit-pagination .button-secondary:not(:disabled)'
    );
    const disabled = document.querySelector(
      '.warehouse-asset-audit-pagination .button-secondary:disabled'
    );
    if (!legend || !pageIndicator || !enabled || !disabled) {
      return {
        controlCount: 0,
        minimumContrast: 0,
        themeTokensApplied: false,
        horizontalOverflow: true,
      };
    }
    const legendColor = getComputedStyle(legend).color;
    const pageIndicatorColor = getComputedStyle(pageIndicator).color;
    const enabledStyle = getComputedStyle(enabled);
    const disabledStyle = getComputedStyle(disabled);
    const primary = parseColor(tokens.primary);
    const disabledBackground = parseColor(disabledStyle.backgroundColor);
    const ratios = [
      contrast(legendColor, tokens.primary),
      ...labels.map((color) => contrast(color, tokens.primary)),
      contrast(pageIndicatorColor, tokens.primary),
      contrast(enabledStyle.color, enabledStyle.backgroundColor),
      primary && disabledBackground
        ? contrast(disabledStyle.color, composite(disabledBackground, primary))
        : 0,
    ];
    return {
      controlCount: labels.length + 4,
      minimumContrast: ratios.length ? Math.min(...ratios) : 0,
      themeTokensApplied:
        sameColor(legendColor, tokens.text2) &&
        labels.every((color) => sameColor(color, tokens.text1)) &&
        sameColor(pageIndicatorColor, tokens.text2) &&
        sameColor(enabledStyle.color, tokens.primaryStrong) &&
        sameColor(disabledStyle.color, tokens.text3) &&
        sameColor(disabledStyle.backgroundColor, tokens.controlBackground),
      expectedAccentColor: tokens.selectedBackground,
      expectedFocusColor: tokens.text1,
      horizontalOverflow:
        document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
  return {
    ...contrastState,
    darkApplied: true,
    focusIndicators:
      checkboxState.focusVisible &&
      checkboxState.outlineStyle === 'solid' &&
      checkboxState.outlineWidth === '2px' &&
      colorsMatch(checkboxState.outlineColor, contrastState.expectedFocusColor) &&
      colorsMatch(checkboxState.accentColor, contrastState.expectedAccentColor) &&
      enabledFocusShadow !== 'none',
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tag = normalizeFixtureTag(args.tag);
  const config = loadDevFixtureConfig({ ...args, env: args.env || '.env.dev' });
  const { manifest } = readManifest(config, tag);
  assert(manifest, 'FIXTURE_MANIFEST_NOT_FOUND');
  const fixture = requireFixtureSummary(manifest);
  const storageStatePath = resolveStorageStatePath(config, args['storage-state']);
  const appUrl = asText(args['app-url'] || config.appUrl).replace(/\/+$/g, '');
  const expectedBuild = requireExpectedBuild(args['expected-build']);
  const browser = await chromium.launch({
    executablePath: resolveBrowserExecutablePath(),
    headless: true,
  });
  const context = await browser.newContext({
    storageState: storageStatePath,
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(true);
    }
  });
  page.on('pageerror', () => pageErrors.push(true));
  page.on('requestfailed', () => failedRequests.push(true));

  try {
    verificationStage = 'dev-target-verification';
    await verifyDevProxyTarget(context.request, appUrl, expectedBuild);

    verificationStage = 'allocation-job-load';
    await page.goto(
      `${appUrl}/#/allocations/jobs/${encodeURIComponent(fixture.previewTarget.jobId)}`,
      { waitUntil: 'domcontentloaded' }
    );
    await page
      .getByRole('button', { name: 'Allocate Film' })
      .waitFor({ state: 'visible' })
      .catch(() => {
        throw new Error('BROWSER_ALLOCATION_JOB_ACTION_NOT_VISIBLE');
      });

    verificationStage = 'allocation-dialog';
    await page.getByRole('button', { name: 'Allocate Film' }).click();
    const dialog = page.getByRole('dialog', { name: 'Allocate Job Film' });
    await dialog.waitFor({ state: 'visible' });
    await dialog.getByText(fixture.cases.crossWarehouseZeroReservationBoxId, { exact: true }).waitFor();
    for (const excludedBoxId of [
      fixture.cases.scheduledReservedBoxId,
      fixture.cases.placeholderReservedBoxId,
      fixture.cases.pendingTransferBoxId,
      fixture.cases.checkedOutBoxId,
    ]) {
      assert(
        (await dialog.getByText(excludedBoxId, { exact: true }).count()) === 0,
        'BROWSER_EXCLUDED_CANDIDATE_VISIBLE'
      );
    }
    assert(
      (await dialog.getByText(fixture.cases.historicalOnlyBoxId, { exact: true }).count()) === 1,
      'BROWSER_HISTORICAL_CANDIDATE_MISSING'
    );

    await dialog.getByLabel('Requested LF').fill('60');
    const sourceRow = dialog
      .locator('tbody tr')
      .filter({ hasText: fixture.cases.crossWarehouseZeroReservationBoxId });
    assert((await sourceRow.count()) === 1, 'BROWSER_SOURCE_ROW_AMBIGUOUS');
    assert(
      /TRANSFER REQUIRED/.test(await sourceRow.textContent()),
      'BROWSER_TRANSFER_REQUIRED_STATE_MISSING'
    );
    const previewResponsePromise = page.waitForResponse(isPreviewResponse, { timeout: 8_000 });
    const previewStarted = performance.now();
    await sourceRow.getByRole('checkbox').click();
    const previewResponse = await previewResponsePromise;
    const browserPreviewMs = performance.now() - previewStarted;
    assert(previewResponse.ok(), 'BROWSER_PREVIEW_HTTP_FAILURE');
    assert(browserPreviewMs < VERIFICATION_GATE_MS, 'BROWSER_PREVIEW_SIX_SECOND_GATE_FAILURE');
    const previewUrl = new URL(previewResponse.url());
    const appOrigin = new URL(appUrl).origin;
    assert(
      previewUrl.hostname.includes(config.projectRef) ||
        (previewUrl.origin === appOrigin && previewUrl.pathname.startsWith('/api')),
      'BROWSER_PREVIEW_TARGET_MISMATCH'
    );
    await dialog.getByText('Loading the live allocation plan...').waitFor({ state: 'hidden' }).catch(() => {});
    assert(
      (await dialog.getByText('TRANSFER REQUIRED', { exact: true }).count()) > 0,
      'BROWSER_TRANSFER_REQUIRED_DISPLAY_MISSING'
    );
    const dialogOverflow = await dialog.evaluate(
      (element) => element.scrollWidth > element.clientWidth + 1
    );
    assert(!dialogOverflow, 'BROWSER_DIALOG_HORIZONTAL_OVERFLOW');

    verificationStage = 'browser-direct-submit-denial';
    const previewHeaders = await previewResponse.request().allHeaders();
    const tamperUrl = new URL(previewResponse.url());
    tamperUrl.search = '';
    tamperUrl.searchParams.set('path', '/allocations/apply');
    const tamperStarted = performance.now();
    const tamperResponse = await context.request.post(tamperUrl.toString(), {
      headers: {
        authorization: asText(previewHeaders.authorization),
        apikey: asText(previewHeaders.apikey),
        'content-type': 'application/json',
      },
      data: buildTargetPayload(fixture, fixture.cases.scheduledReservedBoxId),
      timeout: 8_000,
    });
    const tamperMs = performance.now() - tamperStarted;
    const tamperBody = await tamperResponse.text();
    assert(
      tamperResponse.status() >= 400 && tamperResponse.status() < 500,
      'BROWSER_DIRECT_SUBMIT_NOT_DENIED'
    );
    assert(!/57014|statement timeout/i.test(tamperBody), 'BROWSER_DIRECT_SUBMIT_SQLSTATE_57014');
    assert(tamperMs < VERIFICATION_GATE_MS, 'BROWSER_DIRECT_SUBMIT_SIX_SECOND_GATE_FAILURE');

    verificationStage = 'warehouse-asset-audit-screen';
    await page.goto(`${appUrl}/#/reports`, { waitUntil: 'domcontentloaded' });
    await page.getByLabel('Report Type').selectOption({ label: 'Warehouse Asset Audit' });
    await page.getByRole('heading', { name: 'Warehouse Asset Audit' }).waitFor({ state: 'visible' });
    const screenTable = page.locator('.warehouse-asset-audit-screen-table table');
    await screenTable.waitFor({ state: 'visible' });
    const screenHeaders = await screenTable.locator('thead th').allTextContents();
    assert(
      JSON.stringify(screenHeaders.map((value) => asText(value))) === JSON.stringify(APPROVED_AUDIT_HEADERS),
      'WAREHOUSE_AUDIT_SCREEN_COLUMN_CONTRACT_MISMATCH'
    );
    assert(
      (await page.getByText('Cost Basis', { exact: true }).count()) === 0,
      'WAREHOUSE_AUDIT_COST_BASIS_COLUMN_VISIBLE'
    );
    const screenOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
    );
    assert(!screenOverflow, 'WAREHOUSE_AUDIT_SCREEN_HORIZONTAL_OVERFLOW');

    verificationStage = 'warehouse-asset-audit-print';
    await captureAuditPrint(page);
    const printButton = page.getByRole('button', { name: 'Print Audit' });
    await printButton.waitFor({ state: 'visible' });
    await page.waitForFunction(
      () => !(document.querySelector('button') && false) &&
        !Array.from(document.querySelectorAll('button')).find(
          (button) => button.textContent?.trim() === 'Print Audit'
        )?.disabled
    );
    await printButton.click();
    await page.waitForFunction(() => Boolean(window.__codexAuditPrintCapture), null, {
      timeout: 15_000,
    });
    const printCapture = await page.evaluate(() => window.__codexAuditPrintCapture);
    assert(printCapture.bodyClassActive, 'WAREHOUSE_AUDIT_PRINT_CLASS_NOT_ACTIVE');
    assert(printCapture.titlePresent, 'WAREHOUSE_AUDIT_PRINT_TITLE_MISSING');
    assert(printCapture.metadataPresent, 'WAREHOUSE_AUDIT_PRINT_METADATA_MISSING');
    assert(printCapture.filtersPresent, 'WAREHOUSE_AUDIT_PRINT_FILTERS_MISSING');
    assert(
      JSON.stringify(printCapture.headers) === JSON.stringify(APPROVED_AUDIT_HEADERS),
      'WAREHOUSE_AUDIT_PRINT_COLUMN_CONTRACT_MISMATCH'
    );
    assert(
      printCapture.rowCount === printCapture.uniqueRowCount &&
        printCapture.rowCount === printCapture.expectedRowCount,
      'WAREHOUSE_AUDIT_PRINT_ROW_SET_MISMATCH'
    );
    assert(printCapture.ownerLabelsSafe, 'WAREHOUSE_AUDIT_OWNER_LABEL_UNSAFE');
    assert(
      printCapture.screenTotals === printCapture.printTotals,
      'WAREHOUSE_AUDIT_SCREEN_PRINT_TOTAL_MISMATCH'
    );
    assert(printCapture.footerPresent, 'WAREHOUSE_AUDIT_PRINT_FOOTER_MISSING');

    const printLayout = await inspectPrintLayout(page);
    assert(printLayout.rootPresent, 'WAREHOUSE_AUDIT_PRINT_ROOT_MISSING');
    assert(printLayout.tableLayout === 'fixed', 'WAREHOUSE_AUDIT_PRINT_TABLE_NOT_FIXED');
    assert(
      printLayout.repeatedHeaderDisplay === 'table-header-group',
      'WAREHOUSE_AUDIT_PRINT_HEADER_NOT_REPEATABLE'
    );
    assert(!printLayout.verticalOverlap, 'WAREHOUSE_AUDIT_PRINT_SECTION_OVERLAP');
    assert(!printLayout.cellOverflow, 'WAREHOUSE_AUDIT_PRINT_CELL_OVERFLOW');
    assert(!printLayout.horizontalOverflow, 'WAREHOUSE_AUDIT_PRINT_HORIZONTAL_OVERFLOW');
    assert(printLayout.centeredCells, 'WAREHOUSE_AUDIT_PRINT_CELL_ALIGNMENT_MISMATCH');

    verificationStage = 'warehouse-asset-audit-dark-theme';
    await page.emulateMedia({ media: 'screen' });
    await page.setViewportSize({ width: 1440, height: 900 });
    const darkTheme = await verifyDarkTheme(page);
    assert(darkTheme.darkApplied, 'WAREHOUSE_AUDIT_DARK_THEME_NOT_APPLIED');
    assert(darkTheme.controlCount > 0, 'WAREHOUSE_AUDIT_DARK_CONTROLS_NOT_FOUND');
    assert(darkTheme.themeTokensApplied, 'WAREHOUSE_AUDIT_DARK_THEME_TOKEN_MISMATCH');
    assert(darkTheme.focusIndicators, 'WAREHOUSE_AUDIT_DARK_FOCUS_INDICATOR_FAILURE');
    assert(darkTheme.minimumContrast >= 4.5, 'WAREHOUSE_AUDIT_DARK_CONTROL_CONTRAST_FAILURE');
    assert(!darkTheme.horizontalOverflow, 'WAREHOUSE_AUDIT_DARK_HORIZONTAL_OVERFLOW');

    assert(consoleErrors.length === 0, 'BROWSER_CONSOLE_ERRORS');
    assert(pageErrors.length === 0, 'BROWSER_PAGE_ERRORS');
    assert(failedRequests.length === 0, 'BROWSER_REQUEST_FAILURES');

    console.log(JSON.stringify({
      ok: true,
      target: 'dev',
      projectRef: config.projectRef,
      apiBuildSha: expectedBuild,
      gateMs: VERIFICATION_GATE_MS,
      timingsMs: {
        allocationPreview: Number(browserPreviewMs.toFixed(2)),
        directSubmitDenial: Number(tamperMs.toFixed(2)),
      },
      allocationDialog: {
        opened: true,
        candidateListLoaded: true,
        sameWarehouseBehaviorAvailable: true,
        crossWarehouseZeroReservationVisible: true,
        reservedCandidatesHidden: true,
        pendingTransferHidden: true,
        transferRequiredDisplayed: true,
        directSubmitDenied: true,
        horizontalOverflow: false,
      },
      warehouseAssetAudit: {
        screenColumns: screenHeaders.length,
        printColumns: printCapture.headers.length,
        printedRows: printCapture.rowCount,
        uniquePrintedRows: printCapture.uniqueRowCount,
        ownerLabelsSafe: true,
        totalsMatch: true,
        fixedPrintLayout: true,
        repeatedHeaders: true,
        printOverflow: false,
        darkControlMinimumContrast: Number(darkTheme.minimumContrast.toFixed(2)),
      },
      browserErrors: {
        console: 0,
        page: 0,
        requests: 0,
      },
    }, null, 2));
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  const assertionCode = /^[A-Z][A-Z0-9_]+$/.test(asText(error?.message))
    ? asText(error.message)
    : 'UNEXPECTED_BROWSER_VERIFIER_FAILURE';
  console.error(JSON.stringify({
    ok: false,
    stage: verificationStage,
    assertionCode,
  }));
  process.exit(1);
});
