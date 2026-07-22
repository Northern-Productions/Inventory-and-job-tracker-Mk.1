// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { WarehouseAssetAuditResponse } from '../../../../domain';
import {
  WarehouseAssetAuditWorksheet,
  formatAuditCurrencyCents
} from './WarehouseAssetAuditWorksheet';

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
  it('renders every filtered row exactly once regardless of screen pagination size', () => {
    const snapshot = buildSnapshot(127);
    const { container } = render(<WarehouseAssetAuditWorksheet snapshot={snapshot} />);
    const rows = Array.from(container.querySelectorAll('[data-audit-row-id]'));
    expect(rows).toHaveLength(127);
    expect(new Set(rows.map((row) => row.getAttribute('data-audit-row-id'))).size).toBe(127);
    expect(container.querySelector('[data-audit-expected-row-count="127"]')).not.toBeNull();
  });

  it('prints Unassigned, the applied snapshot metadata, and the final totals footer', () => {
    render(<WarehouseAssetAuditWorksheet snapshot={buildSnapshot(1)} />);
    expect(screen.getByText('Unassigned')).toBeTruthy();
    expect(screen.getByText('Test Organization')).toBeTruthy();
    expect(screen.getByText('Test User')).toBeTruthy();
    expect(screen.getByText('Total Known On-Hand Asset Cost')).toBeTruthy();
    expect(screen.getAllByText('$125.00')).toHaveLength(2);
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
    expect(screen.getByText('Total On-Hand LF')).toBeTruthy();
    expect(screen.getAllByText('$125.00')).toHaveLength(2);
  });

  it('formats large cent strings without losing integer precision', () => {
    expect(formatAuditCurrencyCents('900719925474099301')).toBe('$9,007,199,254,740,993.01');
    expect(formatAuditCurrencyCents(null)).toBe('Missing');
  });
});
