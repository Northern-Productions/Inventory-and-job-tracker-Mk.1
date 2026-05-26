import { isWarehouse, type Warehouse, type WarehouseEntry } from '../../../domain';

export const ALL_WAREHOUSES_OPTION_VALUE = 'ALL';
export const ALL_WAREHOUSES_LABEL = 'All Warehouses';
export const ADD_WAREHOUSE_OPTION_VALUE = '__add_warehouse__';
export type WarehouseFilterValue = Warehouse | '';

export function parseWarehouseFilterValue(
  value: string | null | undefined
): WarehouseFilterValue {
  if (!value) {
    return '';
  }

  const normalized = value.trim().toUpperCase();
  if (!normalized || normalized === ALL_WAREHOUSES_OPTION_VALUE) {
    return '';
  }

  return isWarehouse(normalized) ? normalized : '';
}

export function toWarehouseFilterOptionValue(
  value: WarehouseFilterValue | undefined
): string {
  return value || ALL_WAREHOUSES_OPTION_VALUE;
}

export function toWarehouseSelectOptions(entries: WarehouseEntry[]) {
  return entries.map((entry) => ({
    label: entry.name || entry.code,
    value: entry.code
  }));
}

export function toWarehouseFilterSelectOptions(entries: WarehouseEntry[]) {
  return [
    { label: ALL_WAREHOUSES_LABEL, value: ALL_WAREHOUSES_OPTION_VALUE },
    ...toWarehouseSelectOptions(entries)
  ];
}

export function getWarehouseDisplayLabel(entries: WarehouseEntry[], code: Warehouse | ''): string {
  const normalized = normalizeWarehouseCode(code);
  if (!normalized) {
    return ALL_WAREHOUSES_LABEL;
  }

  const match = entries.find((entry) => entry.code === normalized);
  return match?.name || normalized;
}

export function normalizeWarehouseCode(value: string | null | undefined): Warehouse | '' {
  if (!value) {
    return '';
  }

  const normalized = value.trim().toUpperCase();
  if (!normalized) {
    return '';
  }

  return isWarehouse(normalized) ? normalized : '';
}

export function getWarehousePrefix(
  entries: WarehouseEntry[],
  code: Warehouse | ''
): string {
  const normalized = normalizeWarehouseCode(code);
  if (!normalized) {
    return '';
  }

  const match = entries.find((entry) => entry.code === normalized);
  return String(match?.boxIdPrefix || '').trim().toUpperCase();
}
