import { useMemo, useState } from 'react';
import type {
  MostUsedFilmRankBy,
  ReportsSummaryFilters,
  Warehouse
} from '../../../../domain';
import { useIsPhoneLayout } from '../../../../hooks/useIsPhoneLayout';
import { useDefaultWarehouse } from '../../hooks/useDefaultWarehouse';
import { useReportsSummary } from '../../hooks/useInventoryQueries';
import { parseWarehouseFilterValue } from '../../utils/warehouseOptions';

export type ReportType = 'most_used_film';
export type MostUsedFilmDateRange =
  | 'this_year'
  | 'last_30_days'
  | 'last_90_days'
  | 'all_time'
  | 'custom'
  | `year_${number}`;

export interface MostUsedFilmFilters {
  warehouse: Warehouse | '';
  manufacturer: string;
  filmName: string;
  width: string;
  dateRange: MostUsedFilmDateRange;
  customFrom: string;
  customTo: string;
  rankBy: MostUsedFilmRankBy;
}

export const REPORT_TYPE_OPTIONS: Array<{ label: string; value: ReportType }> = [
  { label: 'Most Used Film', value: 'most_used_film' }
];

export const REPORT_TYPE_TITLES: Record<ReportType, string> = {
  most_used_film: 'Most Used Film'
};

export const RANK_BY_OPTIONS: Array<{ label: string; value: MostUsedFilmRankBy }> = [
  { label: 'Actual Used LF', value: 'actual_used_lf' },
  { label: 'Jobs Using It', value: 'jobs_using_it' }
];

function toDateInputValue(date: Date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function isValidDateInput(value: string) {
  if (!value) {
    return false;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  return !Number.isNaN(Date.parse(`${value}T00:00:00`));
}

export function buildDateRangeOptions(today = new Date()) {
  const currentYear = today.getFullYear();
  const previousYears = Array.from({ length: 5 }, (_, index) => currentYear - index - 1);
  return [
    { label: 'This year', value: 'this_year' },
    { label: 'Last 30 days', value: 'last_30_days' },
    { label: 'Last 90 days', value: 'last_90_days' },
    { label: 'All time', value: 'all_time' },
    { label: 'Custom date range', value: 'custom' },
    ...previousYears.map((year) => ({ label: String(year), value: `year_${year}` }))
  ] as Array<{ label: string; value: MostUsedFilmDateRange }>;
}

export function resolveMostUsedFilmDateBounds(
  filters: Pick<MostUsedFilmFilters, 'dateRange' | 'customFrom' | 'customTo'>,
  today = new Date()
) {
  const currentYear = today.getFullYear();

  if (filters.dateRange === 'all_time') {
    return { from: '', to: '', error: '' };
  }

  if (filters.dateRange === 'last_30_days') {
    return { from: toDateInputValue(addDays(today, -29)), to: toDateInputValue(today), error: '' };
  }

  if (filters.dateRange === 'last_90_days') {
    return { from: toDateInputValue(addDays(today, -89)), to: toDateInputValue(today), error: '' };
  }

  if (filters.dateRange === 'custom') {
    const from = isValidDateInput(filters.customFrom) ? filters.customFrom : '';
    const to = isValidDateInput(filters.customTo) ? filters.customTo : '';
    if (from && to && from > to) {
      return { from: '', to: '', error: 'Start date must be on or before end date.' };
    }

    return { from, to, error: '' };
  }

  const yearMatch = /^year_(\d{4})$/.exec(filters.dateRange);
  const year = yearMatch ? Number(yearMatch[1]) : currentYear;
  return { from: `${year}-01-01`, to: `${year}-12-31`, error: '' };
}

function ensureOption(options: string[], value: string) {
  const trimmed = value.trim();
  if (!trimmed || options.includes(trimmed)) {
    return options;
  }

  return [...options, trimmed].sort((left, right) => left.localeCompare(right));
}

function ensureWidthOption(options: number[], value: string) {
  const width = Number(value);
  if (!Number.isFinite(width) || width <= 0 || options.includes(width)) {
    return options;
  }

  return [...options, width].sort((left, right) => left - right);
}

export function useReportsPageModel() {
  const defaultWarehouse = useDefaultWarehouse();
  const isPhoneLayout = useIsPhoneLayout();
  const [reportType, setReportType] = useState<ReportType>('most_used_film');
  const [filters, setFilters] = useState<MostUsedFilmFilters>(() => ({
    warehouse: defaultWarehouse,
    manufacturer: '',
    filmName: '',
    width: '',
    dateRange: 'this_year',
    customFrom: '',
    customTo: '',
    rankBy: 'actual_used_lf'
  }));

  const dateBounds = useMemo(
    () => resolveMostUsedFilmDateBounds(filters),
    [filters.customFrom, filters.customTo, filters.dateRange]
  );

  const summaryFilters: ReportsSummaryFilters = useMemo(
    () => ({
      warehouse: filters.warehouse,
      manufacturer: filters.manufacturer,
      film: filters.filmName,
      width: filters.width,
      from: dateBounds.from,
      to: dateBounds.to,
      rankBy: filters.rankBy
    }),
    [
      dateBounds.from,
      dateBounds.to,
      filters.filmName,
      filters.manufacturer,
      filters.rankBy,
      filters.warehouse,
      filters.width
    ]
  );
  const reportsQuery = useReportsSummary(summaryFilters);
  const mostUsedFilmOptions = reportsQuery.data?.mostUsedFilmOptions || {
    manufacturers: [],
    filmNames: [],
    widths: []
  };

  const manufacturerOptions = useMemo(
    () => ensureOption(mostUsedFilmOptions.manufacturers, filters.manufacturer),
    [filters.manufacturer, mostUsedFilmOptions.manufacturers]
  );
  const filmNameOptions = useMemo(
    () => ensureOption(mostUsedFilmOptions.filmNames, filters.filmName),
    [filters.filmName, mostUsedFilmOptions.filmNames]
  );
  const widthOptions = useMemo(
    () => ensureWidthOption(mostUsedFilmOptions.widths, filters.width),
    [filters.width, mostUsedFilmOptions.widths]
  );

  function patchMostUsedFilmFilters(next: Partial<MostUsedFilmFilters>) {
    setFilters((current) => ({
      ...current,
      ...next,
      warehouse:
        next.warehouse === undefined
          ? current.warehouse
          : parseWarehouseFilterValue(next.warehouse)
    }));
  }

  return {
    isPhoneLayout,
    filters,
    reportType,
    setReportType,
    reportTypeOptions: REPORT_TYPE_OPTIONS,
    dateRangeOptions: buildDateRangeOptions(),
    rankByOptions: RANK_BY_OPTIONS,
    mostUsedFilm: reportsQuery.data?.mostUsedFilm || [],
    manufacturerOptions,
    filmNameOptions,
    widthOptions,
    showReportLoading: reportsQuery.isLoading && !reportsQuery.data,
    reportError: reportsQuery.error,
    dateRangeError: dateBounds.error,
    patchMostUsedFilmFilters
  };
}
