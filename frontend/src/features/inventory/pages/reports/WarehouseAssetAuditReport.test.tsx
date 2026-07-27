// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WarehouseAssetAuditResponse } from '../../../../domain';
import { WarehouseAssetAuditReport } from './WarehouseAssetAuditReport';

const getLiveReportMock = vi.fn();
const useAuditQueryMock = vi.fn();
const authState = vi.hoisted(() => ({
  accessContext: { orgId: 'org-1' },
  session: { user: { sub: 'user-1' } }
}));

vi.mock('../../../../api/features/reportsClient', () => ({
  getWarehouseAssetAuditReport: (...args: unknown[]) => getLiveReportMock(...args)
}));

vi.mock('../../../auth/AuthContext', () => ({
  useAuth: () => authState
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
    checkedOutJobNumber: null,
    checkedOutCrewLeaderName: null,
    manufacturer: 'Maker',
    filmName: 'Film',
    widthIn: 60,
    onHandLf: 100,
    costBasis: 'DIRECT_PRICE_PER_LF' as const,
    onHandAssetCostCents: '10000'
  }));
  return {
    snapshotVersion: 2,
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
  authState.accessContext.orgId = 'org-1';
  authState.session.user.sub = 'user-1';
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
  vi.useRealTimers();
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

  it('shows no report and disables Print on a cold incompatible response', () => {
    useAuditQueryMock.mockReturnValue({
      data: undefined,
      error: new Error('Warehouse asset audit data is incompatible with this application version.'),
      isLoading: false,
      isFetching: false,
      isPlaceholderData: false,
      refetch: vi.fn()
    });

    render(<WarehouseAssetAuditReport />);

    expect(document.querySelectorAll('[data-audit-row-id]')).toHaveLength(0);
    expect(screen.queryByText('Total Known On-Hand Asset Cost')).toBeNull();
    expect(screen.getByText(
      'Warehouse asset audit data is incompatible with this application version.'
    )).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Print Audit' }) as HTMLButtonElement).disabled)
      .toBe(true);
  });

  it('retains only explicit previous rows and disables Print after replacement contract failure', () => {
    const valid = buildSnapshot('2026-07-21T10:00:00.000Z', 2);
    useAuditQueryMock.mockReturnValue({
      data: valid,
      error: null,
      isLoading: false,
      isFetching: false,
      isPlaceholderData: false,
      refetch: vi.fn()
    });
    const view = render(<WarehouseAssetAuditReport />);

    useAuditQueryMock.mockReturnValue({
      data: valid,
      error: new Error('Warehouse asset audit data is incompatible with this application version.'),
      isLoading: false,
      isFetching: false,
      isPlaceholderData: true,
      refetch: vi.fn()
    });
    view.rerender(<WarehouseAssetAuditReport />);

    expect(view.container.querySelectorAll('[data-audit-row-id]')).toHaveLength(2);
    expect(screen.getByText(/Previous results from/)).toBeTruthy();
    expect(screen.getByText(
      'Previous results are shown and may not match the selected filters.'
    )).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Print Audit' }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect(document.querySelector('.warehouse-asset-audit-print-only-root')).toBeNull();
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
    const assignedOwnerOption = Array.from(ownerSelect.options).find(
      (option) => option.textContent === 'ALP - Alpha Holdings'
    );
    fireEvent.change(ownerSelect, { target: { value: assignedOwnerOption?.value } });
    expect(useAuditQueryMock).toHaveBeenLastCalledWith(
      'user-1',
      'org-1',
      expect.objectContaining({ ownerCompanyId: 'owner-alpha' }),
      { enabled: true }
    );
    expect(ownerSelect.value).not.toBe('owner-alpha');
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

  it('passes the authenticated user, organization, and canonical filters to the query hook', () => {
    render(<WarehouseAssetAuditReport />);

    expect(useAuditQueryMock).toHaveBeenLastCalledWith(
      'user-1',
      'org-1',
      {
        warehouse: 'IL1',
        ownerCompanyId: '',
        manufacturer: '',
        filmName: '',
        width: '',
        statuses: ['IN_STOCK', 'CHECKED_OUT', 'TRANSFER'],
        q: ''
      },
      { enabled: true }
    );
  });

  it('keeps rows, totals, options, and controls available during an automatic update', () => {
    const snapshot = buildSnapshot('2026-07-21T10:00:00.000Z', 55);
    useAuditQueryMock.mockReturnValue({
      data: snapshot,
      error: null,
      isLoading: false,
      isFetching: true,
      isPlaceholderData: true,
      refetch: vi.fn()
    });

    render(<WarehouseAssetAuditReport />);

    expect(screen.getByRole('status').textContent).toBe('Updating results...');
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy();
    expect((screen.getByLabelText('Warehouse') as HTMLSelectElement).disabled).toBe(false);
    expect(document.querySelectorAll('.warehouse-asset-audit-screen-table [data-audit-row-id]')).toHaveLength(50);
    expect(screen.getByText('5,500')).toBeTruthy();
    expect(Array.from((screen.getByLabelText('Owner') as HTMLSelectElement).options).map((option) => option.textContent))
      .toContain('Unassigned');
    expect((screen.getByRole('button', { name: 'Print Audit' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('retains explicitly labeled previous results and options after a replacement query fails', () => {
    const snapshot = buildSnapshot('2026-07-21T10:00:00.000Z', 55);
    useAuditQueryMock.mockReturnValue({
      data: snapshot,
      error: null,
      isLoading: false,
      isFetching: false,
      isPlaceholderData: false,
      refetch: vi.fn()
    });
    const view = render(<WarehouseAssetAuditReport />);

    useAuditQueryMock.mockReturnValue({
      data: undefined,
      error: new Error('The live report request failed.'),
      isLoading: false,
      isFetching: false,
      isPlaceholderData: false,
      refetch: vi.fn()
    });
    view.rerender(<WarehouseAssetAuditReport />);

    expect(screen.getByText(/Previous results from/)).toBeTruthy();
    expect(screen.getByText('Previous results are shown and may not match the selected filters.')).toBeTruthy();
    expect(screen.getByText('The live report request failed.')).toBeTruthy();
    expect(document.querySelectorAll('.warehouse-asset-audit-screen-table [data-audit-row-id]')).toHaveLength(50);
    expect(Array.from((screen.getByLabelText('Owner') as HTMLSelectElement).options).map((option) => option.textContent))
      .toContain('Unassigned');
    expect((screen.getByRole('button', { name: 'Print Audit' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('tracks manual Refresh independently while preserving rows and filter controls', async () => {
    let finishRefresh!: () => void;
    const refetch = vi.fn(() => new Promise<void>((resolve) => {
      finishRefresh = resolve;
    }));
    useAuditQueryMock.mockReturnValue({
      data: buildSnapshot('2026-07-21T10:00:00.000Z', 55),
      error: null,
      isLoading: false,
      isFetching: false,
      isPlaceholderData: false,
      refetch
    });
    render(<WarehouseAssetAuditReport />);

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(screen.getByRole('button', { name: 'Refreshing...' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Refreshing current results...');
    expect((screen.getByLabelText('Search') as HTMLInputElement).disabled).toBe(false);
    expect(document.querySelectorAll('.warehouse-asset-audit-screen-table [data-audit-row-id]')).toHaveLength(50);
    expect((screen.getByRole('button', { name: 'Print Audit' }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => finishRefresh());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy());
    expect(refetch).toHaveBeenCalledWith({ cancelRefetch: true });
  });

  it('debounces and whitespace-normalizes rapid search input into one final request filter', () => {
    vi.useFakeTimers();
    render(<WarehouseAssetAuditReport />);
    useAuditQueryMock.mockClear();
    const search = screen.getByLabelText('Search');

    fireEvent.change(search, { target: { value: ' m' } });
    fireEvent.change(search, { target: { value: ' matte' } });
    fireEvent.change(search, { target: { value: ' matte   deep ' } });

    expect(useAuditQueryMock.mock.calls.some((call) => call[2]?.q)).toBe(false);
    act(() => vi.advanceTimersByTime(199));
    expect(useAuditQueryMock.mock.calls.some((call) => call[2]?.q)).toBe(false);
    act(() => vi.advanceTimersByTime(1));

    const completedSearchCalls = useAuditQueryMock.mock.calls.filter((call) => call[2]?.q);
    expect(completedSearchCalls).toHaveLength(1);
    expect(completedSearchCalls[0][2]).toMatchObject({ q: 'matte deep' });
  });

  it('waits until IME composition finishes before starting the search debounce', () => {
    vi.useFakeTimers();
    render(<WarehouseAssetAuditReport />);
    useAuditQueryMock.mockClear();
    const search = screen.getByLabelText('Search');

    fireEvent.compositionStart(search);
    fireEvent.change(search, { target: { value: 'matte' } });
    act(() => vi.advanceTimersByTime(500));
    expect(useAuditQueryMock.mock.calls.some((call) => call[2]?.q)).toBe(false);

    fireEvent.compositionEnd(search, { currentTarget: { value: 'matte' } });
    act(() => vi.advanceTimersByTime(199));
    expect(useAuditQueryMock.mock.calls.some((call) => call[2]?.q)).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(useAuditQueryMock.mock.calls.filter((call) => call[2]?.q)).toHaveLength(1);
  });

  it('never places a canonical owner identity in rendered report or option markup', () => {
    const ownerIdentity = '339b332c-2e62-4504-ae42-7d0cff5f4541';
    const snapshot = buildSnapshot('2026-07-21T10:00:00.000Z', 1);
    snapshot.rows[0] = {
      ...snapshot.rows[0],
      ownerCompanyId: ownerIdentity,
      ownerCompanyLabel: 'EDH - East Division Holdings',
      ownerCategory: 'ASSIGNED'
    };
    snapshot.filterOptions.owners = [
      { value: ownerIdentity, label: 'EDH - East Division Holdings' }
    ];
    useAuditQueryMock.mockReturnValue({
      data: snapshot,
      error: null,
      isLoading: false,
      isFetching: false,
      isPlaceholderData: false,
      refetch: vi.fn()
    });

    const { container } = render(<WarehouseAssetAuditReport />);
    const ownerSelect = screen.getByLabelText('Owner') as HTMLSelectElement;

    expect(container.innerHTML).not.toContain(ownerIdentity);
    expect(Array.from(ownerSelect.options).map((option) => option.value)).not.toContain(ownerIdentity);
    expect(screen.getAllByText('EDH - East Division Holdings').length).toBeGreaterThanOrEqual(2);
  });

  it('fails owner presentation closed without rendering an unsafe owner identity', () => {
    const ownerIdentity = '339b332c-2e62-4504-ae42-7d0cff5f4541';
    const unresolvedIdentity = 'a770d91e-097d-4a21-963d-fb3f224cbf66';
    const safeSnapshot = buildSnapshot('2026-07-21T09:00:00.000Z', 1);
    const snapshot = buildSnapshot('2026-07-21T10:00:00.000Z', 1);
    snapshot.rows[0] = {
      ...snapshot.rows[0],
      ownerCompanyId: ownerIdentity,
      ownerCompanyLabel: unresolvedIdentity,
      ownerCategory: 'ASSIGNED'
    };
    snapshot.filterOptions.owners = [{ value: ownerIdentity, label: unresolvedIdentity }];
    useAuditQueryMock.mockReturnValue({
      data: safeSnapshot,
      error: null,
      isLoading: false,
      isFetching: false,
      isPlaceholderData: false,
      refetch: vi.fn()
    });
    const view = render(<WarehouseAssetAuditReport />);

    useAuditQueryMock.mockReturnValue({
      data: snapshot,
      error: null,
      isLoading: false,
      isFetching: false,
      isPlaceholderData: false,
      refetch: vi.fn()
    });

    view.rerender(<WarehouseAssetAuditReport />);

    expect(view.container.innerHTML).not.toContain(ownerIdentity);
    expect(view.container.innerHTML).not.toContain(unresolvedIdentity);
    expect(screen.getAllByText('Warehouse asset audit owner labels could not be resolved safely.').length)
      .toBeGreaterThanOrEqual(1);
    expect(document.querySelectorAll('[data-audit-row-id]')).toHaveLength(0);
    expect(screen.queryByText('Total Known On-Hand Asset Cost')).toBeNull();
    expect((screen.getByRole('button', { name: 'Print Audit' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('fails closed when applied owner metadata contains an unresolved identity', () => {
    const unresolvedIdentity = 'a770d91e-097d-4a21-963d-fb3f224cbf66';
    const snapshot = buildSnapshot('2026-07-21T10:00:00.000Z', 1);
    snapshot.appliedFilterLabels.owner = unresolvedIdentity;
    useAuditQueryMock.mockReturnValue({
      data: snapshot,
      error: null,
      isLoading: false,
      isFetching: false,
      isPlaceholderData: false,
      refetch: vi.fn()
    });

    const { container } = render(<WarehouseAssetAuditReport />);

    expect(container.innerHTML).not.toContain(unresolvedIdentity);
    expect(document.querySelectorAll('[data-audit-row-id]')).toHaveLength(0);
    expect(screen.queryByText('Total Known On-Hand Asset Cost')).toBeNull();
    expect((screen.getByRole('button', { name: 'Print Audit' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('aborts and discards an in-flight print when the authenticated scope changes', async () => {
    const snapshot = buildSnapshot('2026-07-21T10:00:00.000Z', 1);
    useAuditQueryMock.mockImplementation((userId: string) => (
      userId === 'user-1'
        ? {
            data: snapshot,
            error: null,
            isLoading: false,
            isFetching: false,
            isPlaceholderData: false,
            refetch: vi.fn()
          }
        : {
            data: undefined,
            error: null,
            isLoading: true,
            isFetching: true,
            isPlaceholderData: false,
            refetch: vi.fn()
          }
    ));
    let printSignal: AbortSignal | undefined;
    getLiveReportMock.mockImplementation(
      (_filters: unknown, options: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          printSignal = options.signal;
          options.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true }
          );
        })
    );
    const printMock = vi.spyOn(window, 'print').mockImplementation(() => {});
    const view = render(<WarehouseAssetAuditReport />);

    fireEvent.click(screen.getByRole('button', { name: 'Print Audit' }));
    await waitFor(() => expect(getLiveReportMock).toHaveBeenCalledTimes(1));

    authState.session.user.sub = 'user-2';
    view.rerender(<WarehouseAssetAuditReport />);

    await waitFor(() => expect(printSignal?.aborted).toBe(true));
    expect(printMock).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Print Audit' }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.classList.contains('warehouse-asset-audit-printing')).toBe(false);
  });

  it('aborts and discards an in-flight print if its frozen filters change', async () => {
    let printSignal: AbortSignal | undefined;
    getLiveReportMock.mockImplementation(
      (_filters: unknown, options: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          printSignal = options.signal;
          options.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true }
          );
        })
    );
    const printMock = vi.spyOn(window, 'print').mockImplementation(() => {});
    render(<WarehouseAssetAuditReport />);

    fireEvent.click(screen.getByRole('button', { name: 'Print Audit' }));
    await waitFor(() => expect(getLiveReportMock).toHaveBeenCalledTimes(1));

    const search = screen.getByLabelText('Search') as HTMLInputElement;
    search.disabled = false;
    fireEvent.change(search, { target: { value: 'changed filters' } });

    await waitFor(() => expect(printSignal?.aborted).toBe(true));
    expect(printMock).not.toHaveBeenCalled();
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Print Audit' }) as HTMLButtonElement).disabled)
        .toBe(true)
    );
    expect(document.body.classList.contains('warehouse-asset-audit-printing')).toBe(false);
  });
});
