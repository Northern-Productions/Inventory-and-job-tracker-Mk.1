// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { WarehouseAssetAuditResponse } from '../../../../domain';
import {
  WarehouseAssetAuditWorksheet,
  formatAuditCurrencyCents
} from './WarehouseAssetAuditWorksheet';

const APPROVED_COLUMNS = [
  'Box ID',
  'Owner',
  'Warehouse',
  'Status',
  'Manufacturer',
  'Film',
  'Width',
  'On-Hand LF',
  'On-Hand Asset Cost'
];

function buildSnapshot(rowCount = 1): WarehouseAssetAuditResponse {
  const rows = Array.from({ length: rowCount }, (_, index) => ({
    boxId: `IL1-${String(index + 1).padStart(4, '0')}`,
    ownerCompanyId: index % 2 ? 'owner-1' : null,
    ownerCompanyLabel: index % 2 ? 'ALP - Alpha Holdings' : 'Unassigned',
    ownerCategory: index % 2 ? 'ASSIGNED' as const : 'UNASSIGNED' as const,
    warehouse: 'IL1',
    custodyBasis: 'CURRENT_WAREHOUSE' as const,
    pendingTransferDestination: null,
    status: 'IN_STOCK' as const,
    statusLabel: 'In Stock',
    manufacturer: '3M Solar',
    filmName: 'Prestige 70',
    widthIn: 60,
    onHandLf: 100,
    costBasis: 'DIRECT_PRICE_PER_LF' as const,
    onHandAssetCostCents: '12500'
  }));
  return {
    snapshotVersion: 1,
    metadata: {
      organizationName: 'Test Organization',
      generatedAt: '2026-07-21T12:00:00.000Z',
      generatedBy: 'Test User'
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
      warehouses: [{ value: 'IL1', label: 'Wauconda IL1' }],
      owners: [{ value: 'UNASSIGNED', label: 'Unassigned' }],
      manufacturers: ['3M Solar'],
      filmNames: ['Prestige 70'],
      widths: [60],
      statuses: [
        { value: 'IN_STOCK', label: 'In Stock' },
        { value: 'CHECKED_OUT', label: 'Checked Out' },
        { value: 'TRANSFER', label: 'Pending Transfer' }
      ]
    },
    rows,
    totals: {
      matchingBoxes: rowCount,
      totalOnHandLf: rowCount * 100,
      totalKnownOnHandAssetCostCents: String(rowCount * 12500),
      boxesMissingCostBasis: 0
    }
  };
}

afterEach(cleanup);

describe('WarehouseAssetAuditWorksheet', () => {
  it('uses the approved nine-column contract without retired screen or paper fields', () => {
    const { container } = render(<WarehouseAssetAuditWorksheet snapshot={buildSnapshot(1)} />);
    const table = container.querySelector('.warehouse-asset-audit-table');
    const headers = Array.from(table?.querySelectorAll('thead th') || [], (header) =>
      header.textContent?.trim()
    );

    expect(headers).toEqual(APPROVED_COLUMNS);
    expect(table?.querySelectorAll('colgroup col')).toHaveLength(9);
    expect(table?.querySelectorAll('tbody tr:first-child td')).toHaveLength(9);
    expect(headers).not.toContain('Cost Basis');
    expect(headers).not.toContain('Found');
    expect(headers).not.toContain('Owner Verified');
    expect(headers).not.toContain('Notes');
  });

  it('renders every filtered row exactly once regardless of screen pagination size', () => {
    const snapshot = buildSnapshot(127);
    const { container } = render(<WarehouseAssetAuditWorksheet snapshot={snapshot} />);
    const rows = Array.from(container.querySelectorAll('[data-audit-row-id]'));
    expect(rows).toHaveLength(127);
    expect(new Set(rows.map((row) => row.getAttribute('data-audit-row-id'))).size).toBe(127);
    expect(container.querySelector('[data-audit-expected-row-count="127"]')).not.toBeNull();
  });

  it('prints Unassigned, immutable metadata, and matching first-page and final totals', () => {
    render(<WarehouseAssetAuditWorksheet snapshot={buildSnapshot(1)} />);
    expect(screen.getByText('Unassigned')).toBeTruthy();
    expect(screen.getByText('Test Organization')).toBeTruthy();
    expect(screen.getByText('Test User')).toBeTruthy();
    expect(screen.getAllByText('Total Known On-Hand Asset Cost')).toHaveLength(2);
    expect(screen.getAllByText('$125.00')).toHaveLength(3);
    expect(
      screen.getAllByText('Known asset total excludes boxes with unavailable cost basis.')
    ).toHaveLength(2);
  });

  it('prints only a safe owner label and selected-owner header when given a diagnostic label', () => {
    const unresolvedIdentity = '99999999-9999-4999-8999-999999999999';
    const snapshot = buildSnapshot(1);
    snapshot.rows[0] = {
      ...snapshot.rows[0],
      ownerCompanyId: unresolvedIdentity,
      ownerCompanyLabel: 'Unknown owner',
      ownerCategory: 'ASSIGNED'
    };
    snapshot.appliedFilters.ownerCompanyId = unresolvedIdentity;
    snapshot.appliedFilterLabels.owner = 'Unknown owner';
    const { container } = render(<WarehouseAssetAuditWorksheet snapshot={snapshot} />);

    expect(screen.getAllByText('Unknown owner').length).toBeGreaterThanOrEqual(2);
    expect(container.innerHTML).not.toContain(unresolvedIdentity);
    expect(screen.getAllByText('Total On-Hand LF')).toHaveLength(2);
    expect(screen.getAllByText('$125.00')).toHaveLength(3);
  });

  it('keeps cost basis internal while preserving direct, derived, missing, and total values', () => {
    const snapshot = buildSnapshot(3);
    snapshot.rows[0] = {
      ...snapshot.rows[0],
      costBasis: 'DIRECT_PRICE_PER_LF',
      onHandAssetCostCents: '12500'
    };
    snapshot.rows[1] = {
      ...snapshot.rows[1],
      costBasis: 'DERIVED_FROM_PURCHASE_COST',
      onHandAssetCostCents: '8333'
    };
    snapshot.rows[2] = {
      ...snapshot.rows[2],
      costBasis: 'MISSING',
      onHandAssetCostCents: null
    };
    snapshot.totals.totalKnownOnHandAssetCostCents = '20833';
    snapshot.totals.boxesMissingCostBasis = 1;

    const { container } = render(<WarehouseAssetAuditWorksheet snapshot={snapshot} />);
    const costs = Array.from(
      container.querySelectorAll('tbody .warehouse-asset-audit-col-asset-cost'),
      (cell) => cell.textContent
    );

    expect(costs).toEqual(['$125.00', '$83.33', 'Missing']);
    expect(screen.getAllByText('$208.33')).toHaveLength(2);
    expect(screen.getAllByText('Boxes Missing Cost Basis')).toHaveLength(2);
    expect(container.querySelectorAll('thead th')).toHaveLength(9);
    expect(
      Array.from(container.querySelectorAll('thead th'), (header) => header.textContent?.trim())
    ).not.toContain('Cost Basis');
  });

  it('formats large cent strings without losing integer precision', () => {
    expect(formatAuditCurrencyCents('900719925474099301')).toBe('$9,007,199,254,740,993.01');
    expect(formatAuditCurrencyCents(null)).toBe('Missing');
  });

  it('defines an isolated fixed Letter-landscape print layout with exact column widths', () => {
    const styles = readFileSync('src/styles.css', 'utf8');
    const auditPrintStart = styles.indexOf('body.warehouse-asset-audit-printing {');
    const auditPrintEnd = styles.indexOf('.job-calendar-week-card-empty', auditPrintStart);
    const auditPrintCss = styles.slice(auditPrintStart, auditPrintEnd);
    const widths = Array.from(
      auditPrintCss.matchAll(
        /col\.warehouse-asset-audit-col-([a-z-]+)\s*\{[^}]*width:\s*([0-9.]+)%/gs
      ),
      (match) => [match[1], Number(match[2])] as const
    );

    expect(styles).toContain('@page warehouse-asset-audit-page');
    expect(styles).toMatch(
      /@page warehouse-asset-audit-page\s*\{[^}]*size:\s*letter landscape;[^}]*margin:\s*0\.32in;/s
    );
    expect(widths).toEqual([
      ['box-id', 10.5],
      ['owner', 9.5],
      ['custody', 9],
      ['status', 8],
      ['manufacturer', 11],
      ['film', 24],
      ['width', 6],
      ['on-hand-lf', 8.5],
      ['asset-cost', 13.5]
    ]);
    expect(widths.reduce((total, [, width]) => total + width, 0)).toBe(100);
    expect(auditPrintCss).toMatch(
      /\.warehouse-asset-audit-table\s*\{[^}]*width:\s*100%;[^}]*box-sizing:\s*border-box;[^}]*table-layout:\s*fixed;/s
    );
    expect(auditPrintCss).toMatch(
      /\.warehouse-asset-audit-table th,[^{]*\.warehouse-asset-audit-table td\s*\{[^}]*box-sizing:\s*border-box;[^}]*text-align:\s*center;[^}]*vertical-align:\s*middle;/s
    );
    expect(auditPrintCss).toContain('font-size: 9pt');
    expect(auditPrintCss).toContain('font-size: 9.5pt');
    expect(auditPrintCss).toContain('font-variant-numeric: tabular-nums');
    expect(auditPrintCss).toContain('display: table-header-group');
    expect(auditPrintCss).toContain('break-inside: avoid');
    expect(auditPrintCss).toContain('text-wrap: pretty');
    expect(auditPrintCss).toMatch(
      /\.warehouse-asset-audit-table th\s*\{[^}]*white-space:\s*nowrap;[^}]*font-size:\s*9\.5pt;/s
    );
    expect(auditPrintCss).toMatch(
      /\.warehouse-asset-audit-table td\s*\{[^}]*text-wrap:\s*pretty;/s
    );
    expect(auditPrintCss).not.toContain('overflow-wrap: anywhere');
    expect(auditPrintCss).not.toMatch(/(?:^|[;{])\s*(?:zoom|transform|scale)\s*:/m);
    expect(auditPrintCss).not.toContain('body.label-printing');
  });
});
