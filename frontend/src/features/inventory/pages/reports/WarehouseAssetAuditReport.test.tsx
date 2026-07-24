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
  it('renders exactly the approved nine screen columns without retired fields', () => {
    const { container } = render(<WarehouseAssetAuditReport />);
    const table = container.querySelector('.warehouse-asset-audit-screen-table table');
    const headers = Array.from(table?.querySelectorAll('thead th') || [], (header) =>
      header.textContent?.trim()
    );

    expect(headers).toEqual([
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
    expect(table?.querySelectorAll('tbody tr:first-child td')).toHaveLength(9);
    expect(headers).not.toContain('Cost Basis');
    expect(headers).not.toContain('Found');
    expect(headers).not.toContain('Owner Verified');
    expect(headers).not.toContain('Notes');
  });

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
    expect(
      screen.getByText('Known asset total excludes boxes with unavailable cost basis.')
    ).toBeTruthy();
  });

  it('shows missing valuation in the asset-cost column and preserves the missing-cost total', () => {
    const snapshot = buildSnapshot('2026-07-21T10:00:00.000Z', 1);
    snapshot.rows[0] = {
      ...snapshot.rows[0],
      costBasis: 'MISSING',
      onHandAssetCostCents: null
    };
    snapshot.totals.totalKnownOnHandAssetCostCents = '0';
    snapshot.totals.boxesMissingCostBasis = 1;
    useAuditQueryMock.mockReturnValue({
      data: snapshot,
      error: null,
      isLoading: false,
      isFetching: false,
      refetch: vi.fn()
    });

    const { container } = render(<WarehouseAssetAuditReport />);
    const screenTable = container.querySelector('.warehouse-asset-audit-screen-table table');

    expect(
      screenTable?.querySelector('tbody .warehouse-asset-audit-col-asset-cost')?.textContent
    ).toBe('Missing');
    expect(
      Array.from(screenTable?.querySelectorAll('thead th') || [], (header) =>
        header.textContent?.trim()
      )
    ).not.toContain('Cost Basis');
    expect(screen.getByText('Boxes Missing Cost Basis')).toBeTruthy();
    expect(screen.getByText('Known asset total excludes boxes with unavailable cost basis.')).toBeTruthy();
  });

  it('renders the server-resolved owner label and keeps owner filtering canonical', () => {
    const snapshot = buildSnapshot('2026-07-21T10:00:00.000Z', 2);
    snapshot.rows = snapshot.rows.map((row) => ({
      ...row,
      ownerCompanyId: 'owner-alpha',
      ownerCompanyLabel: 'ALP - Alpha Holdings',
      ownerCategory: 'ASSIGNED'
    }));
    snapshot.filterOptions.owners = [
      { value: 'owner-alpha', label: 'ALP - Alpha Holdings' },
      { value: 'UNASSIGNED', label: 'Unassigned' }
    ];
    useAuditQueryMock.mockReturnValue({
      data: snapshot,
      error: null,
      isLoading: false,
      isFetching: false,
      refetch: vi.fn()
    });

    render(<WarehouseAssetAuditReport />);

    expect(screen.getAllByText('ALP - Alpha Holdings')).toHaveLength(3);
    const ownerSelect = screen.getByLabelText('Owner') as HTMLSelectElement;
    expect(Array.from(ownerSelect.options).map((option) => option.textContent)).toContain(
      'ALP - Alpha Holdings'
    );
    expect(screen.getByText('Total On-Hand LF')).toBeTruthy();
    expect(screen.getByText('200')).toBeTruthy();
    expect(screen.getAllByText('$200.00')).toHaveLength(1);
  });

  it('keeps rows, totals, financial values, and printing closed on a report error', () => {
    useAuditQueryMock.mockReturnValue({
      data: undefined,
      error: new Error('Warehouse asset audit ownership could not be resolved safely.'),
      isLoading: false,
      isFetching: false,
      refetch: vi.fn()
    });

    render(<WarehouseAssetAuditReport />);

    expect(screen.getByText('Warehouse asset audit ownership could not be resolved safely.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Print Audit' }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelectorAll('[data-audit-row-id]')).toHaveLength(0);
    expect(screen.queryByText('Total Known On-Hand Asset Cost')).toBeNull();
  });

  it('disables printing while offline', () => {
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: false });
    render(<WarehouseAssetAuditReport />);
    expect((screen.getByRole('button', { name: 'Print Audit' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Connect to the internet/)).toBeTruthy();
  });
});
