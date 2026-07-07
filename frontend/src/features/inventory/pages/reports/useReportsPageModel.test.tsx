// @vitest-environment jsdom

import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildDateRangeOptions,
  resolveMostUsedFilmDateBounds,
  useReportsPageModel
} from './useReportsPageModel';

const useReportsSummaryMock = vi.fn();
const useWarehouseRegistryMock = vi.fn();

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
  useReportsSummary: (filters: unknown) => useReportsSummaryMock(filters)
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
    mockReportsSummary();
  });

  afterEach(() => {
    cleanup();
  });

  it('defaults to Most Used Film, default warehouse, All time, and Actual Used LF', () => {
    const { result } = renderHook(() => useReportsPageModel(), {
      wrapper: createWrapper()
    });

    expect(result.current.reportTypeOptions).toEqual([{ label: 'Most Used Film', value: 'most_used_film' }]);
    expect(result.current.filters.warehouse).toBe('IL1');
    expect(result.current.filters.dateRange).toBe('all_time');
    expect(result.current.filters.rankBy).toBe('actual_used_lf');
    expect(useReportsSummaryMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        warehouse: 'IL1',
        from: '',
        to: '',
        rankBy: 'actual_used_lf'
      })
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
      })
    );
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
      })
    );
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
