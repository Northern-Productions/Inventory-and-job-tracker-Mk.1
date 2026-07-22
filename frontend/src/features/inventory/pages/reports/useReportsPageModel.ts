import { useEffect, useMemo, useState } from 'react';
import type {
  MostUsedFilmRankBy,
  ReportsSummaryFilters,
  Warehouse
} from '../../../../domain';
import { useIsPhoneLayout } from '../../../../hooks/useIsPhoneLayout';
import { useAuth } from '../../../auth/AuthContext';
import { useDefaultWarehouse } from '../../hooks/useDefaultWarehouse';
import { useWarehouseRegistry } from '../../hooks/useWarehouseRegistry';
import {
  useOwnerCompanies,
  useReportsSummary
} from '../../hooks/useInventoryQueries';
import { useOfflineInventorySearch } from '../../hooks/useOfflineInventorySearch';
import { canonicalizeManufacturerLabel } from '../../utils/boxHelpers';
import { getSafeWarehouseFilterValue, parseWarehouseFilterValue } from '../../utils/warehouseOptions';
import {
  buildOwnershipOwnerOptions,
  buildOwnershipReportReadModel,
  filterOwnershipReportRows,
  NO_OWNER_FILTER_VALUE,
  OwnershipReportResolutionError,
  summarizeOwnershipReportRows,
  type OwnershipReportFilters
} from './ownerCompanyResolution';

export { NO_OWNER_FILTER_VALUE } from './ownerCompanyResolution';

export type ReportType = 'most_used_film' | 'ownership' | 'warehouse_asset_audit';
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

export type OwnershipFilters = OwnershipReportFilters;

export const REPORT_TYPE_OPTIONS: Array<{ label: string; value: ReportType }> = [
  { label: 'Most Used Film', value: 'most_used_film' },
  { label: 'Ownership', value: 'ownership' },
  { label: 'Warehouse Asset Audit', value: 'warehouse_asset_audit' }
];

export const REPORT_TYPE_TITLES: Record<ReportType, string> = {
  most_used_film: 'Most Used Film',
  ownership: 'Ownership',
  warehouse_asset_audit: 'Warehouse Asset Audit'
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
    { label: 'Custom date range', value: 'custom' },
    { label: 'All time', value: 'all_time' },
    { label: 'This year', value: 'this_year' },
    { label: 'Last 90 days', value: 'last_90_days' },
    { label: 'Last 30 days', value: 'last_30_days' },
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

const EMPTY_OWNERSHIP_READ_MODEL = buildOwnershipReportReadModel({
  boxes: [],
  ownerCompanies: []
});

export function useReportsPageModel() {
  const auth = useAuth();
  const defaultWarehouse = useDefaultWarehouse();
  const warehouseRegistry = useWarehouseRegistry();
  const warehouseScopeReady = warehouseRegistry.scopeReady !== false;
  const isPhoneLayout = useIsPhoneLayout();
  const [reportType, setReportType] = useState<ReportType>('most_used_film');
  const [filters, setFilters] = useState<MostUsedFilmFilters>(() => ({
    warehouse: defaultWarehouse,
    manufacturer: '',
    filmName: '',
    width: '',
    dateRange: 'all_time',
    customFrom: '',
    customTo: '',
    rankBy: 'actual_used_lf'
  }));
  const [ownershipFilters, setOwnershipFilters] = useState<OwnershipFilters>(() => ({
    warehouse: defaultWarehouse,
    manufacturer: '',
    filmName: '',
    width: '',
    status: '',
    q: '',
    ownerCompanyId: ''
  }));
  const ownerCompanyUserId = String(auth.session?.user?.sub || '').trim();
  const ownerCompanyOrgId = String(auth.accessContext?.orgId || '').trim();
  const ownerCompanyScopeReady =
    auth.isAccessReady && auth.isApproved && Boolean(ownerCompanyUserId && ownerCompanyOrgId);
  const ownerCompanyScope = useMemo(
    () =>
      ownerCompanyScopeReady
        ? { userId: ownerCompanyUserId, orgId: ownerCompanyOrgId }
        : null,
    [ownerCompanyOrgId, ownerCompanyScopeReady, ownerCompanyUserId]
  );
  const ownerCompanyScopeKey = ownerCompanyScope
    ? `${ownerCompanyScope.userId}\u0000${ownerCompanyScope.orgId}`
    : '';

  const safeWarehouse = warehouseScopeReady
    ? getSafeWarehouseFilterValue(warehouseRegistry.entries, filters.warehouse)
    : '';
  const safeFilters = useMemo<MostUsedFilmFilters>(
    () => ({
      ...filters,
      warehouse: safeWarehouse
    }),
    [filters, safeWarehouse]
  );
  const safeOwnershipWarehouse = warehouseScopeReady
    ? getSafeWarehouseFilterValue(warehouseRegistry.entries, ownershipFilters.warehouse)
    : '';
  const safeOwnershipFilters = useMemo<OwnershipFilters>(
    () => ({
      ...ownershipFilters,
      warehouse: safeOwnershipWarehouse
    }),
    [ownershipFilters, safeOwnershipWarehouse]
  );

  useEffect(() => {
    if (!warehouseScopeReady || filters.warehouse === safeWarehouse) {
      return;
    }
    setFilters((current) => ({
      ...current,
      warehouse: safeWarehouse
    }));
  }, [filters.warehouse, safeWarehouse, warehouseScopeReady]);

  useEffect(() => {
    if (!warehouseScopeReady || ownershipFilters.warehouse === safeOwnershipWarehouse) {
      return;
    }
    setOwnershipFilters((current) => ({
      ...current,
      warehouse: safeOwnershipWarehouse
    }));
  }, [ownershipFilters.warehouse, safeOwnershipWarehouse, warehouseScopeReady]);

  useEffect(() => {
    setOwnershipFilters((current) =>
      current.ownerCompanyId ? { ...current, ownerCompanyId: '' } : current
    );
  }, [ownerCompanyScopeKey]);

  const dateBounds = useMemo(
    () => resolveMostUsedFilmDateBounds(safeFilters),
    [safeFilters]
  );

  const summaryFilters: ReportsSummaryFilters = useMemo(
    () => ({
      warehouse: safeFilters.warehouse,
      manufacturer: safeFilters.manufacturer,
      film: safeFilters.filmName,
      width: safeFilters.width,
      from: dateBounds.from,
      to: dateBounds.to,
      rankBy: safeFilters.rankBy
    }),
    [
      dateBounds.from,
      dateBounds.to,
      safeFilters.filmName,
      safeFilters.manufacturer,
      safeFilters.rankBy,
      safeFilters.warehouse,
      safeFilters.width
    ]
  );
  const reportsQuery = useReportsSummary(summaryFilters, {
    enabled: reportType === 'most_used_film'
  });
  const ownershipBoxesQuery = useOfflineInventorySearch('', {
    enabled: reportType === 'ownership'
  });
  const ownerCompaniesQuery = useOwnerCompanies({
    includeInactive: true,
    enabled: reportType === 'ownership',
    scope: ownerCompanyScope
  });
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
  const ownershipManufacturerOptions = useMemo(() => {
    const optionsByKey = new Map<string, string>();
    const addOption = (value: string) => {
      const label = canonicalizeManufacturerLabel(value);
      const key = label.toLocaleLowerCase();
      if (!label || optionsByKey.has(key)) {
        return;
      }
      optionsByKey.set(key, label);
    };

    ownershipBoxesQuery.snapshotBoxes.forEach((box) => addOption(box.manufacturer));
    addOption(safeOwnershipFilters.manufacturer);

    return Array.from(optionsByKey.values()).sort((left, right) =>
      left.localeCompare(right, undefined, { sensitivity: 'base' })
    );
  }, [ownershipBoxesQuery.snapshotBoxes, safeOwnershipFilters.manufacturer]);
  const ownershipWidthOptions = useMemo(() => {
    const widths = new Set<number>();
    for (const box of ownershipBoxesQuery.snapshotBoxes) {
      if (Number.isFinite(box.widthIn) && box.widthIn > 0) {
        widths.add(box.widthIn);
      }
    }
    return ensureWidthOption(Array.from(widths).sort((left, right) => left - right), safeOwnershipFilters.width);
  }, [ownershipBoxesQuery.snapshotBoxes, safeOwnershipFilters.width]);
  const ownershipResolution = useMemo(() => {
    if (!ownerCompanyScopeReady || ownerCompaniesQuery.data === undefined) {
      return {
        readModel: EMPTY_OWNERSHIP_READ_MODEL,
        error: null as Error | null
      };
    }

    try {
      return {
        readModel: buildOwnershipReportReadModel({
          boxes: ownershipBoxesQuery.snapshotBoxes,
          ownerCompanies: ownerCompaniesQuery.data
        }),
        error: null as Error | null
      };
    } catch (error) {
      return {
        readModel: EMPTY_OWNERSHIP_READ_MODEL,
        error:
          error instanceof OwnershipReportResolutionError
            ? error
            : new OwnershipReportResolutionError()
      };
    }
  }, [
    ownerCompaniesQuery.data,
    ownerCompanyScopeKey,
    ownerCompanyScopeReady,
    ownershipBoxesQuery.snapshotBoxes
  ]);
  const ownerCompanyOptions = useMemo(
    () =>
      buildOwnershipOwnerOptions({
        readModel: ownershipResolution.readModel,
        selectedOwnerCompanyId: safeOwnershipFilters.ownerCompanyId
      }),
    [ownershipResolution.readModel, safeOwnershipFilters.ownerCompanyId]
  );
  const ownershipRows = useMemo(
    () => filterOwnershipReportRows(ownershipResolution.readModel.rows, safeOwnershipFilters),
    [ownershipResolution.readModel.rows, safeOwnershipFilters]
  );
  const ownershipCountsByOwner = useMemo(
    () => summarizeOwnershipReportRows(ownershipRows),
    [ownershipRows]
  );
  const unresolvedOwnerCount = useMemo(
    () => ownershipRows.filter((row) => row.owner.state === 'unresolved').length,
    [ownershipRows]
  );

  function patchMostUsedFilmFilters(next: Partial<MostUsedFilmFilters>) {
    setFilters((current) => ({
      ...current,
      ...next,
      warehouse:
        next.warehouse === undefined
          ? current.warehouse
          : getSafeWarehouseFilterValue(warehouseRegistry.entries, parseWarehouseFilterValue(next.warehouse))
    }));
  }

  function patchOwnershipFilters(next: Partial<OwnershipFilters>) {
    setOwnershipFilters((current) => ({
      ...current,
      ...next,
      warehouse:
        next.warehouse === undefined
          ? current.warehouse
          : getSafeWarehouseFilterValue(warehouseRegistry.entries, parseWarehouseFilterValue(next.warehouse))
    }));
  }

  return {
    isPhoneLayout,
    filters: safeFilters,
    ownershipFilters: safeOwnershipFilters,
    reportType,
    setReportType,
    reportTypeOptions: REPORT_TYPE_OPTIONS,
    dateRangeOptions: buildDateRangeOptions(),
    rankByOptions: RANK_BY_OPTIONS,
    mostUsedFilm: reportsQuery.data?.mostUsedFilm || [],
    manufacturerOptions,
    filmNameOptions,
    widthOptions,
    ownershipManufacturerOptions,
    ownershipWidthOptions,
    ownerCompanyOptions,
    ownershipRows,
    ownershipCountsByOwner,
    unresolvedOwnerCount,
    showReportLoading: reportsQuery.isLoading && !reportsQuery.data,
    showOwnershipLoading:
      reportType === 'ownership' &&
      (!ownerCompanyScopeReady ||
        ownershipBoxesQuery.isLoading ||
        (ownerCompaniesQuery.isLoading && !ownerCompaniesQuery.data)),
    reportError: reportsQuery.error,
    ownershipError:
      ownershipBoxesQuery.error || ownerCompaniesQuery.error || ownershipResolution.error,
    dateRangeError: dateBounds.error,
    patchMostUsedFilmFilters,
    patchOwnershipFilters
  };
}
