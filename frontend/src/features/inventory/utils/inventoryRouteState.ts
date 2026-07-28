import { BOX_STATUSES, isWarehouse, type BoxStatus, type WarehouseEntry } from '../../../domain';
import type { InventoryFilterValues } from '../schemas/boxSchemas';
import { canonicalizeManufacturerLabel } from './boxHelpers';
import { normalizeSelectedWidths, readSelectedWidths, writeSelectedWidths } from './widthFilters';
import {
  ALL_WAREHOUSES_OPTION_VALUE,
  getSafeSpecificWarehouseValue,
  normalizeWarehouseCode,
  type WarehouseFilterValue
} from './warehouseOptions';

export type InventoryView = 'film' | 'caulk';

export interface InventoryRouteState {
  inventoryView: InventoryView;
  filters: InventoryFilterValues;
}

interface InventoryRouteStateOptions {
  defaultWarehouse?: string;
  warehouseEntries?: WarehouseEntry[];
  warehouseRegistrySettled?: boolean;
}

const BOX_STATUS_SET = new Set<string>(BOX_STATUSES);

function readInventoryStatus(value: string | null): BoxStatus | '' {
  const normalized = String(value || '').trim().toUpperCase();
  return BOX_STATUS_SET.has(normalized) ? (normalized as BoxStatus) : '';
}

function readWarehouse(
  searchParams: URLSearchParams,
  {
    defaultWarehouse = '',
    warehouseEntries = [],
    warehouseRegistrySettled = false
  }: InventoryRouteStateOptions
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

export function readInventoryRouteState(
  searchParams: URLSearchParams,
  options: InventoryRouteStateOptions = {}
): InventoryRouteState {
  return {
    inventoryView: searchParams.get('inventoryView') === 'caulk' ? 'caulk' : 'film',
    filters: {
      warehouse: readWarehouse(searchParams, options),
      manufacturer: canonicalizeManufacturerLabel(searchParams.get('manufacturer') || ''),
      q: searchParams.get('q') || '',
      status: readInventoryStatus(searchParams.get('status')),
      film: '',
      widths: readSelectedWidths(searchParams),
      showRetired: false
    }
  };
}

export function writeInventoryRouteState(
  state: InventoryRouteState,
  { defaultWarehouse = '' }: Pick<InventoryRouteStateOptions, 'defaultWarehouse'> = {}
): URLSearchParams {
  const searchParams = new URLSearchParams();
  const normalizedDefault = normalizeWarehouseCode(defaultWarehouse);
  const normalizedWarehouse = normalizeWarehouseCode(state.filters.warehouse);

  if (state.inventoryView === 'caulk') {
    searchParams.set('inventoryView', 'caulk');
  }
  if (!normalizedWarehouse && normalizedDefault) {
    searchParams.set('warehouse', ALL_WAREHOUSES_OPTION_VALUE);
  } else if (normalizedWarehouse !== normalizedDefault) {
    searchParams.set('warehouse', normalizedWarehouse);
  }
  if (state.filters.manufacturer) {
    searchParams.set(
      'manufacturer',
      canonicalizeManufacturerLabel(state.filters.manufacturer)
    );
  }
  if (state.filters.status) {
    searchParams.set('status', state.filters.status);
  }
  if (state.filters.q) {
    searchParams.set('q', state.filters.q);
  }
  writeSelectedWidths(searchParams, normalizeSelectedWidths(state.filters.widths));

  return searchParams;
}

export function patchInventoryRouteState(
  state: InventoryRouteState,
  patch: {
    inventoryView?: InventoryView;
    filters?: Partial<InventoryFilterValues>;
  }
): InventoryRouteState {
  return {
    inventoryView: patch.inventoryView ?? state.inventoryView,
    filters: {
      ...state.filters,
      ...patch.filters,
      film: '',
      widths: normalizeSelectedWidths(patch.filters?.widths ?? state.filters.widths),
      showRetired: false
    }
  };
}

export function replaceInventoryHashSearchParams(
  searchParams: URLSearchParams
): boolean {
  if (
    typeof window === 'undefined' ||
    typeof window.history?.replaceState !== 'function' ||
    !window.location.hash.startsWith('#')
  ) {
    return false;
  }

  const queryIndex = window.location.hash.indexOf('?');
  const hashPath =
    queryIndex >= 0 ? window.location.hash.slice(0, queryIndex) : window.location.hash;
  const serializedSearch = searchParams.toString();
  const nextHash = serializedSearch
    ? `${hashPath}?${serializedSearch}`
    : hashPath;
  const nextRelativeUrl =
    `${window.location.pathname}${window.location.search}${nextHash}`;

  window.history.replaceState(
    window.history.state,
    document.title,
    nextRelativeUrl
  );
  return true;
}
