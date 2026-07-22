// @vitest-environment jsdom

import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildDateRangeOptions,
  NO_OWNER_FILTER_VALUE,
  resolveMostUsedFilmDateBounds,
  useReportsPageModel
} from './useReportsPageModel';
import {
  buildOwnershipOwnerOptions,
  buildOwnershipReportReadModel,
  filterOwnershipReportRows,
  summarizeOwnershipReportRows
} from './ownerCompanyResolution';
import type { Box, OwnerCompanyEntry } from '../../../../domain';

const useReportsSummaryMock = vi.fn();
const useWarehouseRegistryMock = vi.fn();
const useOfflineInventorySearchMock = vi.fn();
const useOwnerCompaniesMock = vi.fn();
const useAuthMock = vi.fn();

vi.mock('../../../auth/AuthContext', () => ({
  useAuth: () => useAuthMock()
}));

vi.mock('../../../../hooks/useIsPhoneLayout', () => ({
  useIsPhoneLayout: () => false
}));

vi.mock('../../hooks/useDefaultWarehouse', () => ({
  useDefaultWarehouse: () => 'IL1'
}));

vi.mock('../../hooks/useWarehouseRegistry', () => ({
  useWarehouseRegistry: () => useWarehouseRegistryMock()
}));

vi.mock('../../hooks/useInventoryQueries', () => ({
  useReportsSummary: (filters: unknown, options: unknown) => useReportsSummaryMock(filters, options),
  useOwnerCompanies: (options: unknown) => useOwnerCompaniesMock(options)
}));

vi.mock('../../hooks/useOfflineInventorySearch', () => ({
  useOfflineInventorySearch: (warehouse: unknown, options: unknown) => useOfflineInventorySearchMock(warehouse, options)
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false
      }
    }
  });

  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function mockReportsSummary(data = {}) {
  useReportsSummaryMock.mockReturnValue({
    data: {
      mostUsedFilm: [],
      mostUsedFilmOptions: {
        manufacturers: ['3M Solar'],
        filmNames: ['Prestige 70'],
        widths: [36, 60]
      },
      ...data
    },
    isLoading: false,
    error: null
  });
}

function buildBox(overrides: Partial<Box> = {}): Box {
  return {
    boxId: 'IL1-1001',
    warehouse: 'IL1',
    ownerCompanyId: 'owner-alpha',
    ownerCompanyCode: 'ALP',
    ownerCompanyDisplayName: 'Alpha Holdings',
    ownerCompanyIsActive: true,
    dealer: '',
    manufacturer: '3M Solar',
    filmName: 'Prestige 70',
    widthIn: 60,
    initialFeet: 100,
    feetAvailable: 75,
    physicalFeetAvailable: 80,
    allocatableNowFeet: 75,
    allocationPlanningFeet: 75,
    lotRun: '',
    status: 'IN_STOCK',
    orderDate: '2026-05-01',
    receivedDate: '2026-05-02',
    initialWeightLbs: null,
    lastRollWeightLbs: null,
    lastWeighedDate: '',
    filmKey: '3M SOLAR|PRESTIGE 70',
    coreType: '',
    coreWeightLbs: null,
    lfWeightLbsPerFt: null,
    pricePerLf: null,
    purchaseCost: null,
    notes: '',
    hasEverBeenCheckedOut: false,
    lastCheckoutJob: '',
    lastCheckoutDate: '',
    zeroedDate: '',
    zeroedReason: '',
    zeroedBy: '',
    ...overrides
  };
}

function buildOwner(overrides: Partial<OwnerCompanyEntry> = {}): OwnerCompanyEntry {
  return {
    ownerCompanyId: 'owner-alpha',
    code: 'ALP',
    displayName: 'Alpha Holdings',
    lookupKey: 'alp',
    isActive: true,
    createdAt: '',
    createdBy: '',
    updatedAt: '',
    updatedBy: '',
    deactivatedAt: '',
    deactivatedBy: '',
    ...overrides
  };
}

describe('useReportsPageModel', () => {
  beforeEach(() => {
    useAuthMock.mockReset();
    useAuthMock.mockReturnValue({
      isAccessReady: true,
      isApproved: true,
      session: { user: { sub: 'user-a' } },
      accessContext: { orgId: 'org-a' }
    });
    useReportsSummaryMock.mockReset();
    useWarehouseRegistryMock.mockReset();
    useWarehouseRegistryMock.mockReturnValue({
      scopeReady: true,
      entries: [
        { code: 'IL1', name: 'Wauconda IL1', boxIdPrefix: 'IL1' },
        { code: 'MS1', name: 'Ridgeland MS1', boxIdPrefix: 'MS1' }
      ]
    });
    useOfflineInventorySearchMock.mockReset();
    useOwnerCompaniesMock.mockReset();
    mockReportsSummary();
    useOfflineInventorySearchMock.mockReturnValue({
      snapshotBoxes: [],
      isLoading: false,
      error: null
    });
    useOwnerCompaniesMock.mockReturnValue({
      data: [],
      isLoading: false,
      error: null
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('defaults to Most Used Film, default warehouse, All time, and Actual Used LF', () => {
    const { result } = renderHook(() => useReportsPageModel(), {
      wrapper: createWrapper()
    });

    expect(result.current.reportTypeOptions).toEqual([
      { label: 'Most Used Film', value: 'most_used_film' },
      { label: 'Ownership', value: 'ownership' },
      { label: 'Warehouse Asset Audit', value: 'warehouse_asset_audit' }
    ]);
    expect(result.current.filters.warehouse).toBe('IL1');
    expect(result.current.filters.dateRange).toBe('all_time');
    expect(result.current.filters.rankBy).toBe('actual_used_lf');
    expect(useReportsSummaryMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        warehouse: 'IL1',
        from: '',
        to: '',
        rankBy: 'actual_used_lf'
      }),
      { enabled: true }
    );
  });

  it('patches filters and sends report summary query params', () => {
    const { result } = renderHook(() => useReportsPageModel(), {
      wrapper: createWrapper()
    });

    act(() => {
      result.current.patchMostUsedFilmFilters({
        warehouse: '',
        manufacturer: '3M Solar',
        filmName: 'Prestige 70',
        width: '60',
        rankBy: 'jobs_using_it'
      });
    });

    expect(useReportsSummaryMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        warehouse: '',
        manufacturer: '3M Solar',
        film: 'Prestige 70',
        width: '60',
        rankBy: 'jobs_using_it'
      }),
      { enabled: true }
    );
  });

  it('keeps ownership filters independent and disables Most Used Film fetch while Ownership is selected', () => {
    const { result } = renderHook(() => useReportsPageModel(), {
      wrapper: createWrapper()
    });

    act(() => {
      result.current.setReportType('ownership');
      result.current.patchOwnershipFilters({
        warehouse: '',
        ownerCompanyId: 'owner-alpha',
        manufacturer: 'Llumar'
      });
    });

    expect(result.current.ownershipFilters).toEqual(
      expect.objectContaining({
        warehouse: '',
        ownerCompanyId: 'owner-alpha',
        manufacturer: 'Llumar'
      })
    );
    expect(result.current.filters.manufacturer).toBe('');
    expect(useReportsSummaryMock).toHaveBeenLastCalledWith(expect.any(Object), { enabled: false });
    expect(useOfflineInventorySearchMock).toHaveBeenLastCalledWith('', { enabled: true });
  });

  it('keeps the canonical ownership dataset organization-wide as warehouse filters change', () => {
    const { result } = renderHook(() => useReportsPageModel(), {
      wrapper: createWrapper()
    });

    act(() => {
      result.current.setReportType('ownership');
      result.current.patchOwnershipFilters({ warehouse: 'MS1' });
    });

    expect(result.current.ownershipFilters.warehouse).toBe('MS1');
    expect(useOfflineInventorySearchMock).toHaveBeenLastCalledWith('', { enabled: true });
  });

  it('filters ownership boxes by owner after applying inventory-like filters', () => {
    const boxes = [
      buildBox({ boxId: 'IL1-1001', ownerCompanyId: 'owner-alpha', manufacturer: '3M Solar', warehouse: 'IL1' }),
      buildBox({ boxId: 'MS1-2001', ownerCompanyId: 'owner-alpha', manufacturer: '3M Solar', warehouse: 'MS1' }),
      buildBox({ boxId: 'IL1-1002', ownerCompanyId: 'owner-beta', ownerCompanyCode: 'BET', manufacturer: '3M Solar', warehouse: 'IL1' }),
      buildBox({ boxId: 'IL1-1003', ownerCompanyId: '', ownerCompanyCode: '', ownerCompanyDisplayName: '', warehouse: 'IL1' })
    ];
    const rows = buildOwnershipReportReadModel({
      boxes,
      ownerCompanies: [
        buildOwner(),
        buildOwner({ ownerCompanyId: 'owner-beta', code: 'BET', displayName: 'Beta Holdings', lookupKey: 'bet' })
      ]
    }).rows;

    expect(
      filterOwnershipReportRows(rows, {
        warehouse: 'IL1',
        manufacturer: '3M Solar',
        filmName: '',
        width: '',
        status: '',
        q: '',
        ownerCompanyId: 'owner-alpha'
      }).map((row) => row.box.boxId)
    ).toEqual(['IL1-1001']);
    expect(
      filterOwnershipReportRows(rows, {
        warehouse: 'IL1',
        manufacturer: '',
        filmName: '',
        width: '',
        status: '',
        q: '',
        ownerCompanyId: NO_OWNER_FILTER_VALUE
      }).map((row) => row.box.boxId)
    ).toEqual(['IL1-1003']);
  });

  it('resolves production-shaped blank box labels through the scoped current-org registry', () => {
    useOfflineInventorySearchMock.mockReturnValue({
      snapshotBoxes: [
        buildBox({ ownerCompanyCode: '', ownerCompanyDisplayName: '' }),
        buildBox({
          boxId: 'IL1-1002',
          ownerCompanyId: 'owner-beta',
          ownerCompanyCode: '',
          ownerCompanyDisplayName: ''
        })
      ],
      isLoading: false,
      error: null
    });
    useOwnerCompaniesMock.mockReturnValue({
      data: [
        buildOwner(),
        buildOwner({
          ownerCompanyId: 'owner-beta',
          code: 'BET',
          displayName: 'Beta Holdings',
          lookupKey: 'bet'
        })
      ],
      isLoading: false,
      error: null
    });
    const { result } = renderHook(() => useReportsPageModel(), {
      wrapper: createWrapper()
    });

    act(() => result.current.setReportType('ownership'));

    expect(result.current.ownershipRows.map((row) => row.owner.displayLabel)).toEqual([
      'ALP - Alpha Holdings',
      'BET - Beta Holdings'
    ]);
    expect(result.current.ownershipCountsByOwner).toEqual([
      { key: 'owner-alpha', label: 'ALP - Alpha Holdings', count: 1 },
      { key: 'owner-beta', label: 'BET - Beta Holdings', count: 1 }
    ]);
    expect(useOwnerCompaniesMock).toHaveBeenLastCalledWith({
      includeInactive: true,
      enabled: true,
      scope: { userId: 'user-a', orgId: 'org-a' }
    });
  });

  it('fails the Ownership read surface closed on a registry conflict', () => {
    useOfflineInventorySearchMock.mockReturnValue({
      snapshotBoxes: [buildBox()],
      isLoading: false,
      error: null
    });
    useOwnerCompaniesMock.mockReturnValue({
      data: [
        buildOwner(),
        buildOwner({ ownerCompanyId: 'owner-beta', lookupKey: 'alp' })
      ],
      isLoading: false,
      error: null
    });
    const { result } = renderHook(() => useReportsPageModel(), {
      wrapper: createWrapper()
    });

    act(() => result.current.setReportType('ownership'));

    expect(result.current.ownershipRows).toEqual([]);
    expect(result.current.ownershipCountsByOwner).toEqual([]);
    expect(result.current.unresolvedOwnerCount).toBe(0);
    expect(result.current.ownershipError?.message).toBe(
      'Owner company identities could not be resolved safely for this report.'
    );
  });

  it('clears owner selection and derived rows when the active organization changes', async () => {
    useOfflineInventorySearchMock.mockReturnValue({
      snapshotBoxes: [buildBox()],
      isLoading: false,
      error: null
    });
    useOwnerCompaniesMock.mockReturnValue({
      data: [buildOwner()],
      isLoading: false,
      error: null
    });
    const { result, rerender } = renderHook(() => useReportsPageModel(), {
      wrapper: createWrapper()
    });
    act(() => {
      result.current.setReportType('ownership');
      result.current.patchOwnershipFilters({ ownerCompanyId: 'owner-alpha' });
    });
    expect(result.current.ownershipRows).toHaveLength(1);

    useAuthMock.mockReturnValue({
      isAccessReady: true,
      isApproved: true,
      session: { user: { sub: 'user-b' } },
      accessContext: { orgId: 'org-b' }
    });
    useOfflineInventorySearchMock.mockReturnValue({
      snapshotBoxes: [
        buildBox({
          ownerCompanyId: 'owner-beta',
          ownerCompanyCode: '',
          ownerCompanyDisplayName: ''
        })
      ],
      isLoading: false,
      error: null
    });
    useOwnerCompaniesMock.mockReturnValue({
      data: [
        buildOwner({
          ownerCompanyId: 'owner-beta',
          code: 'BET',
          displayName: 'Beta Holdings',
          lookupKey: 'bet'
        })
      ],
      isLoading: false,
      error: null
    });
    rerender();

    await waitFor(() => expect(result.current.ownershipFilters.ownerCompanyId).toBe(''));
    expect(result.current.ownershipRows.map((row) => row.owner.displayLabel)).toEqual([
      'BET - Beta Holdings'
    ]);
    expect(result.current.ownerCompanyOptions).not.toContainEqual(
      expect.objectContaining({ value: 'owner-alpha' })
    );
    expect(useOwnerCompaniesMock).toHaveBeenLastCalledWith({
      includeInactive: true,
      enabled: true,
      scope: { userId: 'user-b', orgId: 'org-b' }
    });
  });

  it('builds stable active, inactive-attached, selected inactive, and no-owner options', () => {
    const ownerCompanies = [
      buildOwner(),
      buildOwner({ ownerCompanyId: 'owner-beta', code: 'BET', displayName: 'Beta Holdings', lookupKey: 'bet', isActive: false }),
      buildOwner({ ownerCompanyId: 'owner-gamma', code: 'GAM', displayName: 'Gamma Holdings', lookupKey: 'gam', isActive: false })
    ];
    const boxes = [
      buildBox({ ownerCompanyId: 'owner-beta', ownerCompanyCode: 'BET', ownerCompanyDisplayName: '', ownerCompanyIsActive: false }),
      buildBox({ ownerCompanyId: '', ownerCompanyCode: '', ownerCompanyDisplayName: '' })
    ];
    const readModel = buildOwnershipReportReadModel({ ownerCompanies, boxes });

    expect(buildOwnershipOwnerOptions({ readModel, selectedOwnerCompanyId: 'owner-gamma' })).toEqual([
      { label: 'All Owners', value: '' },
      { label: 'ALP - Alpha Holdings', value: 'owner-alpha' },
      { label: 'BET - Beta Holdings (inactive)', value: 'owner-beta' },
      { label: 'GAM - Gamma Holdings (inactive)', value: 'owner-gamma' },
      { label: 'No owner assigned', value: NO_OWNER_FILTER_VALUE }
    ]);
  });

  it('summarizes ownership boxes by owner without totaling cost', () => {
    const readModel = buildOwnershipReportReadModel({
      ownerCompanies: [buildOwner()],
      boxes: [
        buildBox({ ownerCompanyId: 'owner-alpha', ownerCompanyCode: '' }),
        buildBox({ boxId: 'IL1-1002', ownerCompanyId: 'owner-alpha', ownerCompanyCode: '', purchaseCost: 500 }),
        buildBox({ boxId: 'IL1-1003', ownerCompanyId: '', ownerCompanyCode: '', ownerCompanyDisplayName: '' })
      ]
    });
    expect(
      summarizeOwnershipReportRows(readModel.rows)
    ).toEqual([
      { key: 'owner-alpha', label: 'ALP - Alpha Holdings', count: 2 },
      { key: NO_OWNER_FILTER_VALUE, label: 'No owner assigned', count: 1 }
    ]);
  });

  it('drops a warehouse filter that is absent from the active org registry', () => {
    const { result } = renderHook(() => useReportsPageModel(), {
      wrapper: createWrapper()
    });

    act(() => {
      result.current.patchMostUsedFilmFilters({ warehouse: 'MI1' });
    });

    expect(result.current.filters.warehouse).toBe('');
    expect(useReportsSummaryMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        warehouse: ''
      }),
      { enabled: true }
    );
  });

  it('drops an Ownership warehouse filter that is absent from the active org registry', () => {
    const { result } = renderHook(() => useReportsPageModel(), {
      wrapper: createWrapper()
    });

    act(() => {
      result.current.setReportType('ownership');
      result.current.patchOwnershipFilters({ warehouse: 'MI1' });
    });

    expect(result.current.ownershipFilters.warehouse).toBe('');
    expect(useOfflineInventorySearchMock).toHaveBeenLastCalledWith('', { enabled: true });
  });

  it('keeps current selected option values visible even when result options narrow', () => {
    mockReportsSummary({
      mostUsedFilmOptions: {
        manufacturers: [],
        filmNames: [],
        widths: []
      }
    });
    const { result } = renderHook(() => useReportsPageModel(), {
      wrapper: createWrapper()
    });

    act(() => {
      result.current.patchMostUsedFilmFilters({
        manufacturer: 'Fixture Manufacturer',
        filmName: 'Fixture Film',
        width: '72'
      });
    });

    expect(result.current.manufacturerOptions).toContain('Fixture Manufacturer');
    expect(result.current.filmNameOptions).toContain('Fixture Film');
    expect(result.current.widthOptions).toContain(72);
  });

  it('builds previous year date options and validates custom ranges', () => {
    const today = new Date('2026-05-31T12:00:00');
    expect(buildDateRangeOptions(today).map((option) => option.label)).toEqual([
      'Custom date range',
      'All time',
      'This year',
      'Last 90 days',
      'Last 30 days',
      '2025',
      '2024',
      '2023',
      '2022',
      '2021'
    ]);
    expect(
      resolveMostUsedFilmDateBounds(
        { dateRange: 'custom', customFrom: '2026-04-01', customTo: '2026-04-30' },
        today
      )
    ).toEqual({ from: '2026-04-01', to: '2026-04-30', error: '' });
    expect(
      resolveMostUsedFilmDateBounds(
        { dateRange: 'custom', customFrom: '2026-06-01', customTo: '2026-04-30' },
        today
      )
    ).toEqual({ from: '', to: '', error: 'Start date must be on or before end date.' });
    expect(
      resolveMostUsedFilmDateBounds(
        { dateRange: 'year_2025', customFrom: '', customTo: '' },
        today
      )
    ).toEqual({ from: '2025-01-01', to: '2025-12-31', error: '' });
  });
});
