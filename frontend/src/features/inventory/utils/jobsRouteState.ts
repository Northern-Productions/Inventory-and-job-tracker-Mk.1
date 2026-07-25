import { isWarehouse, type WarehouseEntry } from '../../../domain';
import { todayDateString } from '../../../lib/date';
import { getCurrentCalendarAnchorDate, type JobCalendarView } from './jobCalendar';
import type { JobSortOption } from './jobSorts';
import {
  ALL_WAREHOUSES_OPTION_VALUE,
  getSafeSpecificWarehouseValue,
  normalizeWarehouseCode,
  type WarehouseFilterValue
} from './warehouseOptions';

export type JobsViewMode = 'list' | 'calendar';
export type JobsWorkflowView = 'active' | 'completed';

export interface JobsRouteState {
  view: JobsViewMode;
  workflow: JobsWorkflowView;
  warehouse: WarehouseFilterValue;
  search: string;
  sort: JobSortOption;
  calendarView: JobCalendarView;
  calendarDate: string;
}

interface JobsRouteStateOptions {
  defaultWarehouse?: string;
  warehouseEntries?: WarehouseEntry[];
  warehouseRegistrySettled?: boolean;
  today?: string;
  defaults?: Partial<JobsRouteState>;
}

const JOB_SORT_OPTIONS = new Set<JobSortOption>([
  'install_date_asc',
  'install_date_desc',
  'ready',
  'film_order'
]);
const DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/;

function normalizeCalendarDate(value: string | null | undefined, fallback: string) {
  const normalized = String(value || '').trim();
  if (!DATE_PATTERN.test(normalized)) {
    return fallback;
  }

  const parsed = new Date(`${normalized}T00:00:00`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getFullYear() !== Number(normalized.slice(0, 4)) ||
    parsed.getMonth() + 1 !== Number(normalized.slice(5, 7)) ||
    parsed.getDate() !== Number(normalized.slice(8, 10))
  ) {
    return fallback;
  }

  return normalized;
}

function normalizeJobSearch(value: string | null | undefined) {
  return String(value || '').replace(/[^0-9]/g, '');
}

function readWarehouse(
  searchParams: URLSearchParams,
  {
    defaultWarehouse = '',
    warehouseEntries = [],
    warehouseRegistrySettled = false
  }: JobsRouteStateOptions
): WarehouseFilterValue {
  const normalizedDefault = normalizeWarehouseCode(defaultWarehouse);
  if (!searchParams.has('warehouse')) {
    return normalizedDefault;
  }

  const rawValue = String(searchParams.get('warehouse') || '').trim().toUpperCase();
  if (!rawValue || rawValue === ALL_WAREHOUSES_OPTION_VALUE) {
    return '';
  }
  if (!isWarehouse(rawValue)) {
    return normalizedDefault;
  }
  if (!warehouseRegistrySettled) {
    return rawValue;
  }

  return (
    getSafeSpecificWarehouseValue(warehouseEntries, rawValue) ||
    getSafeSpecificWarehouseValue(warehouseEntries, normalizedDefault)
  );
}

export function getDefaultJobsRouteState(
  {
    defaultWarehouse = '',
    today = todayDateString(),
    defaults = {}
  }: Pick<JobsRouteStateOptions, 'defaultWarehouse' | 'today' | 'defaults'> = {}
): JobsRouteState {
  return {
    view: defaults.view === 'list' ? 'list' : 'calendar',
    workflow: defaults.workflow === 'completed' ? 'completed' : 'active',
    warehouse:
      defaults.warehouse === ''
        ? ''
        : normalizeWarehouseCode(defaults.warehouse || defaultWarehouse),
    search: normalizeJobSearch(defaults.search),
    sort: defaults.sort && JOB_SORT_OPTIONS.has(defaults.sort)
      ? defaults.sort
      : 'install_date_asc',
    calendarView: defaults.calendarView === 'month' ? 'month' : 'week',
    calendarDate: normalizeCalendarDate(
      defaults.calendarDate,
      getCurrentCalendarAnchorDate(today)
    )
  };
}

export function readJobsRouteState(
  searchParams: URLSearchParams,
  options: JobsRouteStateOptions = {}
): JobsRouteState {
  const defaults = getDefaultJobsRouteState(options);
  const sort = String(searchParams.get('sort') || '').trim() as JobSortOption;

  return {
    view:
      searchParams.get('view') === 'list'
        ? 'list'
        : searchParams.get('view') === 'calendar'
          ? 'calendar'
          : defaults.view,
    workflow:
      searchParams.get('lifecycle') === 'completed'
        ? 'completed'
        : searchParams.get('lifecycle') === 'active'
          ? 'active'
          : defaults.workflow,
    warehouse: readWarehouse(searchParams, options),
    search: searchParams.has('q')
      ? normalizeJobSearch(searchParams.get('q'))
      : defaults.search,
    sort: JOB_SORT_OPTIONS.has(sort) ? sort : defaults.sort,
    calendarView:
      searchParams.get('calendarView') === 'month'
        ? 'month'
        : searchParams.get('calendarView') === 'week'
          ? 'week'
          : defaults.calendarView,
    calendarDate: normalizeCalendarDate(
      searchParams.get('date'),
      defaults.calendarDate
    )
  };
}

export function writeJobsRouteState(
  state: JobsRouteState,
  options: Pick<JobsRouteStateOptions, 'defaultWarehouse' | 'today' | 'defaults'> = {}
): URLSearchParams {
  const defaults = getDefaultJobsRouteState(options);
  const searchParams = new URLSearchParams();
  const warehouse = normalizeWarehouseCode(state.warehouse);
  const defaultWarehouse = normalizeWarehouseCode(defaults.warehouse);

  if (state.view !== defaults.view) {
    searchParams.set('view', state.view);
  }
  if (state.workflow !== defaults.workflow) {
    searchParams.set('lifecycle', state.workflow);
  }
  if (!warehouse && defaultWarehouse) {
    searchParams.set('warehouse', ALL_WAREHOUSES_OPTION_VALUE);
  } else if (warehouse !== defaultWarehouse) {
    searchParams.set('warehouse', warehouse);
  }
  if (state.search) {
    searchParams.set('q', normalizeJobSearch(state.search));
  }
  if (state.sort !== defaults.sort) {
    searchParams.set('sort', state.sort);
  }
  if (state.calendarView !== defaults.calendarView) {
    searchParams.set('calendarView', state.calendarView);
  }
  if (state.calendarDate !== defaults.calendarDate) {
    searchParams.set('date', normalizeCalendarDate(state.calendarDate, defaults.calendarDate));
  }

  return searchParams;
}

export function patchJobsRouteState(
  state: JobsRouteState,
  patch: Partial<JobsRouteState>
): JobsRouteState {
  return {
    ...state,
    ...patch,
    search:
      patch.search === undefined ? state.search : normalizeJobSearch(patch.search),
    calendarDate:
      patch.calendarDate === undefined
        ? state.calendarDate
        : normalizeCalendarDate(patch.calendarDate, state.calendarDate)
  };
}
