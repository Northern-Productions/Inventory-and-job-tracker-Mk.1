import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listWarehouses } from '../../../api/client';
import { WAREHOUSE_CODES, WAREHOUSE_LABELS, type WarehouseEntry } from '../../../domain';

export const warehouseRegistryQueryKey = ['warehouses'] as const;

function defaultEntries(): WarehouseEntry[] {
  return WAREHOUSE_CODES.map((code) => ({
    code,
    name: WAREHOUSE_LABELS[code] || code,
    boxIdPrefix: code
  }));
}

function normalizeEntry(entry: WarehouseEntry): WarehouseEntry {
  return {
    code: String(entry.code || '').trim().toUpperCase(),
    name: String(entry.name || '').trim(),
    boxIdPrefix: String(entry.boxIdPrefix || '').trim().toUpperCase()
  };
}

function entrySortOrder(entry: WarehouseEntry): number {
  if (entry.code === 'IL1') {
    return 0;
  }
  if (entry.code === 'MS1') {
    return 1;
  }
  return 2;
}

function mergeEntries(remote: WarehouseEntry[] | undefined): WarehouseEntry[] {
  const byCode = new Map<string, WarehouseEntry>();
  const addEntry = (candidate: WarehouseEntry) => {
    const normalized = normalizeEntry(candidate);
    if (!normalized.code) {
      return;
    }
    const existing = byCode.get(normalized.code);
    if (existing) {
      byCode.set(normalized.code, {
        ...existing,
        ...normalized,
        name: normalized.name || existing.name || normalized.code
      });
      return;
    }
    byCode.set(normalized.code, {
      ...normalized,
      name: normalized.name || normalized.code
    });
  };

  defaultEntries().forEach(addEntry);
  (remote || []).forEach(addEntry);

  return Array.from(byCode.values()).sort((left, right) => {
    const orderDelta = entrySortOrder(left) - entrySortOrder(right);
    if (orderDelta !== 0) {
      return orderDelta;
    }

    return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
  });
}

export function useWarehouseRegistry() {
  const query = useQuery({
    queryKey: warehouseRegistryQueryKey,
    queryFn: () => listWarehouses()
  });

  const entries = useMemo(() => mergeEntries(query.data), [query.data]);

  return {
    ...query,
    entries
  };
}

export function getDefaultWarehouseEntries(): WarehouseEntry[] {
  return defaultEntries();
}
