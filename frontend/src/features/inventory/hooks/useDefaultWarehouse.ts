import type { Warehouse } from '../../../domain';
import { useAuth } from '../../auth/AuthContext';
import { useWarehouseRegistry } from './useWarehouseRegistry';
import {
  getSafeSpecificWarehouseValue,
  getWarehouseDisplayLabel,
  normalizeWarehouseCode
} from '../utils/warehouseOptions';

export function useDefaultWarehouse(): Warehouse | '' {
  const auth = useAuth();
  return normalizeWarehouseCode(auth.accessContext?.defaultWarehouse || '');
}

export function useDefaultWarehouseLabel(): string {
  const defaultWarehouse = useDefaultWarehouse();
  const warehouseRegistry = useWarehouseRegistry();
  return getWarehouseDisplayLabel(warehouseRegistry.entries, defaultWarehouse);
}

export function useDefaultSpecificWarehouse(): Warehouse | '' {
  const defaultWarehouse = useDefaultWarehouse();
  const warehouseRegistry = useWarehouseRegistry();
  const safeDefaultWarehouse = getSafeSpecificWarehouseValue(warehouseRegistry.entries, defaultWarehouse);
  if (safeDefaultWarehouse) {
    return safeDefaultWarehouse;
  }

  return warehouseRegistry.entries[0]?.code || '';
}
