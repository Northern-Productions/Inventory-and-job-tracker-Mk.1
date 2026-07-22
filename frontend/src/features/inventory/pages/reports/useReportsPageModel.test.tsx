// @vitest-environment jsdom

import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildOwnershipOwnerOptions,
  filterOwnershipBoxes,
  buildDateRangeOptions,
  NO_OWNER_FILTER_VALUE,
  resolveMostUsedFilmDateBounds,
  summarizeOwnershipBoxes,
  useReportsPageModel
} from './useReportsPageModel';
import type { Box, OwnerCompanyEntry } from '../../../../domain';

const useReportsSummaryMock = vi.fn();
const useWarehouseRegistryMock = vi.fn();
const useOfflineInventorySearchMock = vi.fn();
const useOwnerCompaniesMock = vi.fn();

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
    ownerCompanyId: 'owner-mgt',
    ownerCompanyCode: 'MGT',
    ownerCompanyDisplayName: 'MGT',
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
    ownerCompanyId: 'owner-mgt',
    code: 'MGT',
    displayName: 'MGT',
    lookupKey: 'mgt',
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
        ownerCompanyId: 'owner-mgt',
        manufacturer: 'Llumar'
      });
    });

    expect(result.current.ownershipFilters).toEqual(
      expect.objectContaining({
        warehouse: '',
        ownerCompanyId: 'owner-mgt',
        manufacturer: 'Llumar'
      })
    );
    expect(result.current.filters.manufacturer).toBe('');
    expect(useReportsSummaryMock).toHaveBeenLastCalledWith(expect.any(Object), { enabled: false });
    expect(useOfflineInventorySearchMock).toHaveBeenLastCalledWith('', { enabled: true });
  });

  it('filters ownership boxes by owner after applying inventory-like filters', () => {
    const boxes = [
      buildBox({ boxId: 'IL1-1001', ownerCompanyId: 'owner-mgt', manufacturer: '3M Solar', warehouse: 'IL1' }),
      buildBox({ boxId: 'MS1-2001', ownerCompanyId: 'owner-mgt', manufacturer: '3M Solar', warehouse: 'MS1' }),
      buildBox({ boxId: 'IL1-1002', ownerCompanyId: 'owner-edh', manufacturer: '3M Solar', warehouse: 'IL1' }),
      buildBox({ boxId: 'IL1-1003', ownerCompanyId: '', ownerCompanyCode: '', ownerCompanyDisplayName: '', warehouse: 'IL1' })
    ];

    expect(
      filterOwnershipBoxes(boxes, {
        warehouse: 'IL1',
        manufacturer: '3M Solar',
        filmName: '',
        width: '',
        status: '',
        q: '',
        ownerCompanyId: 'owner-mgt'
      }).map((box) => box.boxId)
    ).toEqual(['IL1-1001']);
    expect(
      filterOwnershipBoxes(boxes, {
        warehouse: 'IL1',
        manufacturer: '',
        filmName: '',
        width: '',
        status: '',
        q: '',
        ownerCompanyId: NO_OWNER_FILTER_VALUE
      }).map((box) => box.boxId)
    ).toEqual(['IL1-1003']);
  });

  it('builds stable active, inactive-attached, selected inactive, and no-owner options', () => {
    const ownerCompanies = [
      buildOwner({ ownerCompanyId: 'owner-mgt', code: 'MGT', displayName: 'MGT', isActive: true }),
      buildOwner({ ownerCompanyId: 'owner-edh', code: 'EDH', displayName: 'Eastside Holdings', isActive: false }),
      buildOwner({ ownerCompanyId: 'owner-kam', code: 'KAM', displayName: 'KAM', isActive: false })
    ];
    const boxes = [
      buildBox({ ownerCompanyId: 'owner-edh', ownerCompanyCode: 'EDH', ownerCompanyDisplayName: 'Eastside Holdings', ownerCompanyIsActive: false }),
      buildBox({ ownerCompanyId: '', ownerCompanyCode: '', ownerCompanyDisplayName: '' })
    ];

    expect(buildOwnershipOwnerOptions({ ownerCompanies, boxes, selectedOwnerCompanyId: 'owner-kam' })).toEqual([
      { label: 'All Owners', value: '' },
      { label: 'EDH - Eastside Holdings (inactive)', value: 'owner-edh' },
      { label: 'KAM (inactive)', value: 'owner-kam' },
      { label: 'MGT', value: 'owner-mgt' },
      { label: 'No owner assigned', value: NO_OWNER_FILTER_VALUE }
    ]);
  });

  it('summarizes ownership boxes by owner without totaling cost', () => {
    expect(
      summarizeOwnershipBoxes([
        buildBox({ ownerCompanyId: 'owner-mgt', ownerCompanyCode: 'MGT' }),
        buildBox({ boxId: 'IL1-1002', ownerCompanyId: 'owner-mgt', ownerCompanyCode: 'MGT', purchaseCost: 500 }),
        buildBox({ boxId: 'IL1-1003', ownerCompanyId: '', ownerCompanyCode: '', ownerCompanyDisplayName: '' })
      ])
    ).toEqual([
      { key: 'owner-mgt', label: 'MGT', count: 2 },
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
