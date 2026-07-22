// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WarehouseAssetAuditResponse } from '../../../../domain';
import { WarehouseAssetAuditReport } from './WarehouseAssetAuditReport';

const getLiveReportMock = vi.fn();
const useAuditQueryMock = vi.fn();

vi.mock('../../../../api/features/reportsClient', () => ({
  getWarehouseAssetAuditReport: (...args: unknown[]) => getLiveReportMock(...args)
}));

vi.mock('../../../auth/AuthContext', () => ({
  useAuth: () => ({ accessContext: { orgId: 'org-1' } })
}));

vi.mock('../../hooks/useDefaultWarehouse', () => ({
  useDefaultWarehouse: () => 'IL1'
}));

vi.mock('../../hooks/useInventoryQueries', () => ({
  useWarehouseAssetAuditReport: (...args: unknown[]) => useAuditQueryMock(...args)
}));

function buildSnapshot(generatedAt: string, rowCount: number): WarehouseAssetAuditResponse {
  const rows = Array.from({ length: rowCount }, (_, index) => ({
    boxId: `IL1-${index + 1}`,
    ownerCompanyId: null,
    ownerCompanyLabel: 'Unassigned',
    ownerCategory: 'UNASSIGNED' as const,
    warehouse: 'IL1',
    custodyBasis: 'CURRENT_WAREHOUSE' as const,
    pendingTransferDestination: null,
    status: 'IN_STOCK' as const,
    statusLabel: 'In Stock',
    manufacturer: 'Maker',
    filmName: 'Film',
    widthIn: 60,
    onHandLf: 100,
    costBasis: 'DIRECT_PRICE_PER_LF' as const,
    onHandAssetCostCents: '10000'
  }));
  return {
    snapshotVersion: 1,
    metadata: { organizationName: 'Organization', generatedAt, generatedBy: 'Reader' },
    appliedFilters: {
      warehouse: 'IL1',
      ownerCompanyId: '',
      manufacturer: '',
      filmName: '',
      width: null,
      statuses: ['IN_STOCK', 'CHECKED_OUT', 'TRANSFER'],
      q: ''
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
      manufacturers: ['Maker'],
      filmNames: ['Film'],
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
      totalKnownOnHandAssetCostCents: String(rowCount * 10000),
      boxesMissingCostBasis: 0
    }
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: true });
  window.requestAnimationFrame = (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  };
  useAuditQueryMock.mockReturnValue({
    data: buildSnapshot('2026-07-21T10:00:00.000Z', 55),
    error: null,
    isLoading: false,
    isFetching: false,
    refetch: vi.fn()
  });
  getLiveReportMock.mockResolvedValue(buildSnapshot('2026-07-21T11:00:00.000Z', 72));
});

afterEach(() => {
  cleanup();
  document.body.classList.remove('warehouse-asset-audit-printing');
  vi.restoreAllMocks();
});

describe('WarehouseAssetAuditReport', () => {
  it('uses one forced live response for every printed row, total, filter, and timestamp', async () => {
    const printMock = vi.spyOn(window, 'print').mockImplementation(() => {
      expect(document.body.classList.contains('warehouse-asset-audit-printing')).toBe(true);
      const root = document.querySelector('.warehouse-asset-audit-print-only-root');
      expect(root?.querySelectorAll('[data-audit-row-id]')).toHaveLength(72);
      expect(root?.textContent).toContain('Wauconda IL1');
      expect(root?.textContent).toContain('72');
      expect(root?.querySelector('[data-audit-print-snapshot="2026-07-21T11:00:00.000Z"]')).not.toBeNull();
    });
    render(<WarehouseAssetAuditReport />);

    fireEvent.click(screen.getByRole('button', { name: 'Print Audit' }));

    await waitFor(() => expect(printMock).toHaveBeenCalledTimes(1));
    expect(getLiveReportMock).toHaveBeenCalledTimes(1);
    expect(getLiveReportMock.mock.calls[0][0]).toMatchObject({
      warehouse: 'IL1',
      statuses: ['IN_STOCK', 'CHECKED_OUT', 'TRANSFER']
    });
    expect(document.body.classList.contains('warehouse-asset-audit-printing')).toBe(false);
  });

  it('paginates only the screen while retaining full-response totals at the bottom', () => {
    render(<WarehouseAssetAuditReport />);
    expect(document.querySelectorAll('.warehouse-asset-audit-screen-table [data-audit-row-id]')).toHaveLength(50);
    expect(screen.getByText('Page 1 of 2')).toBeTruthy();
    expect(screen.getByText('Total On-Hand LF')).toBeTruthy();
    expect(screen.getByText('5,500')).toBeTruthy();
  });

  it('disables printing while offline', () => {
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: false });
    render(<WarehouseAssetAuditReport />);
    expect((screen.getByRole('button', { name: 'Print Audit' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Connect to the internet/)).toBeTruthy();
  });
});
