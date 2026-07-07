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

  if (name.toUpperCase().endsWith(` ${code}`)) {
    return name;
  }

  return `${name} ${code}`;
}

export function normalizeWarehouseCity(value: string | null | undefined): string {
  return String(value || '').trim();
}

export function normalizeWarehouseStateCode(value: string | null | undefined): string {
  return String(value || '').trim().toUpperCase();
}

export function isValidWarehouseStateCode(value: string | null | undefined): boolean {
  return /^[A-Z]{2}$/.test(normalizeWarehouseStateCode(value));
}

export function getNextWarehouseCodeForState(
  entries: WarehouseEntry[],
  stateCode: string | null | undefined
): Warehouse | '' {
  const normalizedState = normalizeWarehouseStateCode(stateCode);
  if (!isValidWarehouseStateCode(normalizedState)) {
    return '';
  }

  const maxIndex = entries.reduce((max, entry) => {
    const code = normalizeWarehouseCode(entry.code);
    const match = code.match(/^([A-Z]{2})([1-9][0-9]{0,6})$/);
    if (!match || match[1] !== normalizedState) {
      return max;
    }
    const index = Number.parseInt(match[2], 10);
    return Number.isFinite(index) ? Math.max(max, index) : max;
  }, 0);

  return `${normalizedState}${maxIndex + 1}`;
}

export function buildWarehouseCreateDraft(
  entries: WarehouseEntry[],
  city: string | null | undefined,
  stateCode: string | null | undefined
): { city: string; stateCode: string; code: Warehouse | ''; name: string; boxIdPrefix: string; label: string } {
  const normalizedCity = normalizeWarehouseCity(city);
  const normalizedState = normalizeWarehouseStateCode(stateCode);
  const code = getNextWarehouseCodeForState(entries, normalizedState);
  const name = normalizedCity && code ? `${normalizedCity} ${code}` : '';

  return {
    city: normalizedCity,
    stateCode: normalizedState,
    code,
    name,
    boxIdPrefix: code,
    label: name
  };
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
