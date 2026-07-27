// @vitest-environment jsdom

import {
  QueryClient,
  QueryClientProvider
} from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  WarehouseAssetAuditFilters,
  WarehouseAssetAuditResponse
} from '../../../../domain';
import { useWarehouseAssetAuditReport } from './activityAndReportQueries';

const getWarehouseAssetAuditReportMock = vi.hoisted(() => vi.fn());

vi.mock('../../../../api/features/reportsClient', () => ({
  getOwnerAssetTotalCostReport: vi.fn(),
  getReportsSummary: vi.fn(),
  getWarehouseAssetAuditReport: getWarehouseAssetAuditReportMock
}));

function buildSnapshot(q: string): WarehouseAssetAuditResponse {
  return {
    snapshotVersion: 2,
    metadata: {
      organizationName: 'Organization',
      generatedAt: `2026-07-24T12:00:0${q.length}.000Z`,
      generatedBy: 'Reader'
    },
    appliedFilters: {
      warehouse: 'IL1',
      ownerCompanyId: '',
      manufacturer: '',
      filmName: '',
      width: null,
      statuses: ['IN_STOCK', 'CHECKED_OUT', 'TRANSFER'],
      q
    },
    appliedFilterLabels: {
      warehouse: 'Wauconda IL1',
      owner: 'All Owners',
      manufacturer: 'All Manufacturers',
      filmName: 'All Films',
      width: 'All Widths',
      statuses: ['In Stock', 'Checked Out', 'Pending Transfer'],
      search: q || 'None'
    },
    filterOptions: {
      warehouses: [{ value: 'IL1', label: 'Wauconda IL1' }],
      owners: [{ value: 'UNASSIGNED', label: 'Unassigned' }],
      manufacturers: [],
      filmNames: [],
      widths: [],
      statuses: [
        { value: 'IN_STOCK', label: 'In Stock' },
        { value: 'CHECKED_OUT', label: 'Checked Out' },
        { value: 'TRANSFER', label: 'Pending Transfer' }
      ]
    },
    rows: [],
    totals: {
      matchingBoxes: 0,
      totalOnHandLf: 0,
      totalKnownOnHandAssetCostCents: '0',
      boxesMissingCostBasis: 0
    }
  };
}

function buildFilters(q: string): WarehouseAssetAuditFilters {
  return {
    warehouse: ' il1 ',
    ownerCompanyId: '',
    manufacturer: '',
    filmName: '',
    width: '',
    statuses: ['TRANSFER', 'IN_STOCK', 'CHECKED_OUT'],
    q
  };
}

function createHarness() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: 0,
        gcTime: Infinity
      }
    }
  });
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  getWarehouseAssetAuditReportMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('useWarehouseAssetAuditReport', () => {
  it('keeps a cold incompatible response empty and unsettled', async () => {
    getWarehouseAssetAuditReportMock.mockRejectedValue(
      new Error('Warehouse asset audit data is incompatible with this application version.')
    );
    const { wrapper } = createHarness();
    const { result } = renderHook(
      () => useWarehouseAssetAuditReport('user-1', 'org-1', buildFilters('cold')),
      { wrapper }
    );

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
    expect(result.current.isPlaceholderData).toBe(false);
  });

  it('does not settle replacement data when an incompatible response rejects', async () => {
    getWarehouseAssetAuditReportMock
      .mockResolvedValueOnce(buildSnapshot('valid'))
      .mockRejectedValueOnce(
        new Error('Warehouse asset audit data is incompatible with this application version.')
      );
    const { wrapper } = createHarness();
    const { result, rerender } = renderHook(
      ({ q }) => useWarehouseAssetAuditReport('user-1', 'org-1', buildFilters(q)),
      { initialProps: { q: 'valid' }, wrapper }
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    rerender({ q: 'replacement' });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data?.appliedFilters.q).not.toBe('replacement');
    expect(result.current.isPlaceholderData).toBe(false);
  });

  it('uses canonical filters in a key containing both user and organization', async () => {
    getWarehouseAssetAuditReportMock.mockResolvedValue(buildSnapshot('box 12'));
    const { queryClient, wrapper } = createHarness();
    const { result } = renderHook(
      () => useWarehouseAssetAuditReport(
        ' user-1 ',
        ' org-1 ',
        buildFilters('  box   12  ')
      ),
      { wrapper }
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(queryClient.getQueryCache().getAll()[0]?.queryKey).toEqual([
      'inventory',
      'reports',
      'warehouse-asset-audit',
      'user-1',
      'org-1',
      {
        warehouse: 'IL1',
        ownerCompanyId: '',
        manufacturer: '',
        filmName: '',
        width: null,
        statuses: ['IN_STOCK', 'CHECKED_OUT', 'TRANSFER'],
        q: 'box 12'
      }
    ]);
    expect(getWarehouseAssetAuditReportMock).toHaveBeenCalledWith(
      {
        warehouse: 'IL1',
        ownerCompanyId: '',
        manufacturer: '',
        filmName: '',
        width: '',
        statuses: ['IN_STOCK', 'CHECKED_OUT', 'TRANSFER'],
        q: 'box 12'
      },
      { signal: expect.any(AbortSignal) }
    );
  });

  it('reuses previous data only for the exact same user and organization', async () => {
    const pending = new Map<string, ReturnType<typeof deferred<WarehouseAssetAuditResponse>>>();
    getWarehouseAssetAuditReportMock.mockImplementation((filters: WarehouseAssetAuditFilters) => {
      const request = deferred<WarehouseAssetAuditResponse>();
      pending.set(String(filters.q || ''), request);
      return request.promise;
    });
    const { wrapper } = createHarness();
    const { result, rerender } = renderHook(
      ({ userId, orgId, q }) =>
        useWarehouseAssetAuditReport(userId, orgId, buildFilters(q)),
      {
        initialProps: { userId: 'user-1', orgId: 'org-1', q: 'initial' },
        wrapper
      }
    );

    await waitFor(() => expect(pending.has('initial')).toBe(true));
    await act(async () => pending.get('initial')?.resolve(buildSnapshot('initial')));
    await waitFor(() => expect(result.current.data?.appliedFilters.q).toBe('initial'));

    rerender({ userId: 'user-1', orgId: 'org-1', q: 'same-scope' });
    await waitFor(() => expect(result.current.isPlaceholderData).toBe(true));
    expect(result.current.data?.appliedFilters.q).toBe('initial');
    await act(async () => pending.get('same-scope')?.resolve(buildSnapshot('same-scope')));
    await waitFor(() => expect(result.current.data?.appliedFilters.q).toBe('same-scope'));

    rerender({ userId: 'user-2', orgId: 'org-1', q: 'new-user' });
    expect(result.current.isPlaceholderData).toBe(false);
    expect(result.current.data).toBeUndefined();
    await act(async () => pending.get('new-user')?.resolve(buildSnapshot('new-user')));
    await waitFor(() => expect(result.current.data?.appliedFilters.q).toBe('new-user'));

    rerender({ userId: 'user-2', orgId: 'org-2', q: 'new-org' });
    expect(result.current.isPlaceholderData).toBe(false);
    expect(result.current.data).toBeUndefined();
    await act(async () => pending.get('new-org')?.resolve(buildSnapshot('new-org')));
    await waitFor(() => expect(result.current.data?.appliedFilters.q).toBe('new-org'));
  });

  it('aborts a superseded request and completes only the active request', async () => {
    const requests = new Map<
      string,
      ReturnType<typeof deferred<WarehouseAssetAuditResponse>> & { signal: AbortSignal }
    >();
    const completed: string[] = [];
    getWarehouseAssetAuditReportMock.mockImplementation(
      (filters: WarehouseAssetAuditFilters, options: { signal: AbortSignal }) => {
        const q = String(filters.q || '');
        const request = deferred<WarehouseAssetAuditResponse>();
        requests.set(q, { ...request, signal: options.signal });
        options.signal.addEventListener(
          'abort',
          () => request.reject(new DOMException('aborted', 'AbortError')),
          { once: true }
        );
        return request.promise.then((response) => {
          completed.push(q);
          return response;
        });
      }
    );
    const { wrapper } = createHarness();
    const { result, rerender } = renderHook(
      ({ q }) => useWarehouseAssetAuditReport('user-1', 'org-1', buildFilters(q)),
      { initialProps: { q: 'initial' }, wrapper }
    );

    await waitFor(() => expect(requests.has('initial')).toBe(true));
    await act(async () => requests.get('initial')?.resolve(buildSnapshot('initial')));
    await waitFor(() => expect(result.current.data?.appliedFilters.q).toBe('initial'));

    rerender({ q: 'superseded' });
    await waitFor(() => expect(requests.has('superseded')).toBe(true));
    rerender({ q: 'final' });
    await waitFor(() => expect(requests.has('final')).toBe(true));

    expect(requests.get('superseded')?.signal.aborted).toBe(true);
    await act(async () => requests.get('final')?.resolve(buildSnapshot('final')));
    await waitFor(() => expect(result.current.data?.appliedFilters.q).toBe('final'));
    expect(completed).toEqual(['initial', 'final']);
  });

  it('never renders a late response from an inactive query key', async () => {
    const requests = new Map<string, ReturnType<typeof deferred<WarehouseAssetAuditResponse>>>();
    getWarehouseAssetAuditReportMock.mockImplementation((filters: WarehouseAssetAuditFilters) => {
      const request = deferred<WarehouseAssetAuditResponse>();
      requests.set(String(filters.q || ''), request);
      return request.promise;
    });
    const { wrapper } = createHarness();
    const { result, rerender } = renderHook(
      ({ q }) => useWarehouseAssetAuditReport('user-1', 'org-1', buildFilters(q)),
      { initialProps: { q: 'initial' }, wrapper }
    );

    await waitFor(() => expect(requests.has('initial')).toBe(true));
    await act(async () => requests.get('initial')?.resolve(buildSnapshot('initial')));
    await waitFor(() => expect(result.current.data?.appliedFilters.q).toBe('initial'));

    rerender({ q: 'slow' });
    await waitFor(() => expect(requests.has('slow')).toBe(true));
    rerender({ q: 'active' });
    await waitFor(() => expect(requests.has('active')).toBe(true));
    await act(async () => requests.get('active')?.resolve(buildSnapshot('active')));
    await waitFor(() => expect(result.current.data?.appliedFilters.q).toBe('active'));

    await act(async () => requests.get('slow')?.resolve(buildSnapshot('slow')));
    expect(result.current.data?.appliedFilters.q).toBe('active');
  });
});
