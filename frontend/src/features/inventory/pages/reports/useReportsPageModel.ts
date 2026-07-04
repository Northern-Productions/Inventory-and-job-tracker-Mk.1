import { useEffect, useMemo, useState } from 'react';
import type {
  Box,
  BoxStatus,
  MostUsedFilmRankBy,
  OwnerCompanyEntry,
  ReportsSummaryFilters,
  Warehouse
} from '../../../../domain';
import { formatOwnerCompanyLabel } from '../../../../domain';
import { filterOfflineBoxes } from '../../../../lib/offlineInventory';
import { useIsPhoneLayout } from '../../../../hooks/useIsPhoneLayout';
import { useDefaultWarehouse } from '../../hooks/useDefaultWarehouse';
import { useWarehouseRegistry } from '../../hooks/useWarehouseRegistry';
import {
  useOwnerCompanies,
  useReportsSummary
} from '../../hooks/useInventoryQueries';
import { useOfflineInventorySearch } from '../../hooks/useOfflineInventorySearch';
import { canonicalizeManufacturerLabel } from '../../utils/boxHelpers';
import { getSafeWarehouseFilterValue, parseWarehouseFilterValue } from '../../utils/warehouseOptions';

export type ReportType = 'most_used_film' | 'ownership';
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

export interface OwnershipFilters {
  warehouse: Warehouse | '';
  manufacturer: string;
  filmName: string;
  width: string;
  status: BoxStatus | '';
  q: string;
  ownerCompanyId: string;
}

export interface OwnershipCountSummary {
  key: string;
  label: string;
  count: number;
}

export const NO_OWNER_FILTER_VALUE = '__NO_OWNER__';

export const REPORT_TYPE_OPTIONS: Array<{ label: string; value: ReportType }> = [
  { label: 'Most Used Film', value: 'most_used_film' },
  { label: 'Ownership', value: 'ownership' }
];

export const REPORT_TYPE_TITLES: Record<ReportType, string> = {
  most_used_film: 'Most Used Film',
  ownership: 'Ownership'
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

function getOwnerLabelFromBox(box: Box) {
  return formatOwnerCompanyLabel({
    code: box.ownerCompanyCode,
    displayName: box.ownerCompanyDisplayName
  }) || 'No owner assigned';
}

function getOwnerOptionLabel(entry: OwnerCompanyEntry) {
  const label = formatOwnerCompanyLabel({
    code: entry.code,
    displayName: entry.displayName
  });
  return `${label}${entry.isActive ? '' : ' (inactive)'}`;
}

function sortSelectOptions(options: Array<{ label: string; value: string }>) {
  return options.slice().sort((left, right) =>
    left.label.localeCompare(right.label, undefined, { sensitivity: 'base' })
  );
}

export function buildOwnershipOwnerOptions({
  ownerCompanies,
  boxes,
  selectedOwnerCompanyId
}: {
  ownerCompanies: OwnerCompanyEntry[];
  boxes: Box[];
  selectedOwnerCompanyId: string;
}) {
  const attachedOwnerIds = new Set(
    boxes
      .map((box) => String(box.ownerCompanyId || '').trim())
      .filter(Boolean)
  );
  const hasUnownedBoxes = boxes.some((box) => !String(box.ownerCompanyId || '').trim());
  const selectedOwnerId = String(selectedOwnerCompanyId || '').trim();
  const optionsById = new Map<string, { label: string; value: string }>();

  for (const entry of ownerCompanies) {
    const ownerId = String(entry.ownerCompanyId || '').trim();
    if (!ownerId) {
      continue;
    }

    if (entry.isActive || attachedOwnerIds.has(ownerId) || ownerId === selectedOwnerId) {
      optionsById.set(ownerId, {
        label: getOwnerOptionLabel(entry),
        value: ownerId
      });
    }
  }

  for (const box of boxes) {
    const ownerId = String(box.ownerCompanyId || '').trim();
    if (!ownerId || optionsById.has(ownerId)) {
      continue;
    }

    optionsById.set(ownerId, {
      label: `${getOwnerLabelFromBox(box)}${box.ownerCompanyIsActive === false ? ' (inactive)' : ''}`,
      value: ownerId
    });
  }

  const noOwnerOption =
    hasUnownedBoxes || selectedOwnerCompanyId === NO_OWNER_FILTER_VALUE
      ? [{ label: 'No owner assigned', value: NO_OWNER_FILTER_VALUE }]
      : [];

  return [
    { label: 'All Owners', value: '' },
    ...sortSelectOptions(Array.from(optionsById.values())),
    ...noOwnerOption
  ];
}

export function filterOwnershipBoxes(boxes: Box[], filters: OwnershipFilters) {
  const inventoryFiltered = filterOfflineBoxes(boxes, {
    warehouse: filters.warehouse,
    manufacturer: filters.manufacturer,
    film: filters.filmName,
    width: filters.width,
    status: filters.status,
    q: filters.q
  });
  const ownerCompanyId = String(filters.ownerCompanyId || '').trim();

  if (!ownerCompanyId) {
    return inventoryFiltered;
  }

  if (ownerCompanyId === NO_OWNER_FILTER_VALUE) {
    return inventoryFiltered.filter((box) => !String(box.ownerCompanyId || '').trim());
  }

  return inventoryFiltered.filter((box) => String(box.ownerCompanyId || '').trim() === ownerCompanyId);
}

export function summarizeOwnershipBoxes(boxes: Box[]) {
  const countsByOwner = new Map<string, OwnershipCountSummary>();

  for (const box of boxes) {
    const ownerId = String(box.ownerCompanyId || '').trim();
    const key = ownerId || NO_OWNER_FILTER_VALUE;
    const label = ownerId
      ? `${getOwnerLabelFromBox(box)}${box.ownerCompanyIsActive === false ? ' (inactive)' : ''}`
      : 'No owner assigned';
    const current = countsByOwner.get(key);
    countsByOwner.set(key, {
      key,
      label: current?.label || label,
      count: (current?.count || 0) + 1
    });
  }

  return Array.from(countsByOwner.values()).sort((left, right) =>
    left.label.localeCompare(right.label, undefined, { sensitivity: 'base' })
  );
}

export function useReportsPageModel() {
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
  const ownershipBoxesQuery = useOfflineInventorySearch(safeOwnershipFilters.warehouse, {
    enabled: reportType === 'ownership'
  });
  const ownerCompaniesQuery = useOwnerCompanies({
    includeInactive: true,
    enabled: reportType === 'ownership'
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
  const ownerCompanyOptions = useMemo(
    () =>
      buildOwnershipOwnerOptions({
        ownerCompanies: ownerCompaniesQuery.data || [],
        boxes: ownershipBoxesQuery.snapshotBoxes,
        selectedOwnerCompanyId: safeOwnershipFilters.ownerCompanyId
      }),
    [ownerCompaniesQuery.data, ownershipBoxesQuery.snapshotBoxes, safeOwnershipFilters.ownerCompanyId]
  );
  const ownershipBoxes = useMemo(
    () => filterOwnershipBoxes(ownershipBoxesQuery.snapshotBoxes, safeOwnershipFilters),
    [ownershipBoxesQuery.snapshotBoxes, safeOwnershipFilters]
  );
  const ownershipCountsByOwner = useMemo(
    () => summarizeOwnershipBoxes(ownershipBoxes),
    [ownershipBoxes]
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
    ownershipBoxes,
    ownershipCountsByOwner,
    showReportLoading: reportsQuery.isLoading && !reportsQuery.data,
    showOwnershipLoading:
      reportType === 'ownership' &&
      (ownershipBoxesQuery.isLoading || (ownerCompaniesQuery.isLoading && !ownerCompaniesQuery.data)),
    reportError: reportsQuery.error,
    ownershipError: ownershipBoxesQuery.error || ownerCompaniesQuery.error,
    dateRangeError: dateBounds.error,
    patchMostUsedFilmFilters,
    patchOwnershipFilters
  };
}
