import { WAREHOUSE_CODE_PATTERN } from '../runtimeContract.mjs';

export const WAREHOUSE_CODES = ['IL1', 'MS1'] as const;
export type Warehouse = string;
export const WAREHOUSE_LABELS: Record<string, string> = {
  IL1: 'Wauconda IL1',
  MS1: 'Ridgeland MS1'
};

export function isWarehouse(value: string | null | undefined): value is Warehouse {
  if (!value) {
    return false;
  }

  return WAREHOUSE_CODE_PATTERN.test(value.toUpperCase());
}

export function parseWarehouse(
  value: string | null | undefined,
  fallback: Warehouse = ''
): Warehouse {
  if (!value) {
    return fallback;
  }

  const normalized = value.toUpperCase();
  return isWarehouse(normalized) ? normalized : fallback;
}

export function getWarehouseLabel(warehouse: Warehouse): string {
  return WAREHOUSE_LABELS[warehouse] || warehouse;
}

export interface WarehouseEntry {
  code: Warehouse;
  name: string;
  boxIdPrefix: string;
}

export interface AddWarehousePayload {
  code: string;
  name: string;
  boxIdPrefix: string;
}
