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

export function getWarehouseEntry(
  entries: WarehouseEntry[],
  value: string | null | undefined
): WarehouseEntry | null {
  const normalized = normalizeWarehouseCode(value);
  if (!normalized) {
    return null;
  }

  return entries.find((entry) => normalizeWarehouseCode(entry.code) === normalized) || null;
}

export function isWarehouseInRegistry(
  entries: WarehouseEntry[],
  value: string | null | undefined
): value is Warehouse {
  return Boolean(getWarehouseEntry(entries, value));
}

export function getSafeWarehouseFilterValue(
  entries: WarehouseEntry[],
  value: string | null | undefined
): WarehouseFilterValue {
  const normalized = normalizeWarehouseCode(value);
  return normalized && isWarehouseInRegistry(entries, normalized) ? normalized : '';
}

export function getSafeSpecificWarehouseValue(
  entries: WarehouseEntry[],
  value: string | null | undefined
): WarehouseFilterValue {
  const normalized = normalizeWarehouseCode(value);
  return normalized && isWarehouseInRegistry(entries, normalized) ? normalized : '';
}

export function formatWarehouseDisplayLabel(entry: WarehouseEntry): string {
  const code = normalizeWarehouseCode(entry.code);
  const name = String(entry.name || '').trim();
  if (!code) {
    return name;
  }
  if (!name || name.toUpperCase() === code) {
    return code;
  }

  return `${name} (${code})`;
}

export function toWarehouseSelectOptions(entries: WarehouseEntry[]) {
  return entries.map((entry) => ({
    label: formatWarehouseDisplayLabel(entry),
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
  return match ? formatWarehouseDisplayLabel(match) : ALL_WAREHOUSES_LABEL;
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
