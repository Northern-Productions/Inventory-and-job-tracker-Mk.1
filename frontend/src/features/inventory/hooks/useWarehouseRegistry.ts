import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listWarehouses } from '../../../api/features/warehouseClient';
import type { WarehouseEntry } from '../../../domain';
import { useAuth } from '../../auth/AuthContext';

export const warehouseRegistryQueryKey = ['warehouses'] as const;

interface WarehouseRegistryScope {
  userId: string;
  orgId: string;
}

export function warehouseRegistryScopedQueryKey(scope: WarehouseRegistryScope | null) {
  return [
    ...warehouseRegistryQueryKey,
    'scope',
    scope?.userId || 'NO_USER',
    scope?.orgId || 'NO_ORG'
  ] as const;
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
  const auth = useAuth();
  const userId = String(auth.session?.user?.sub || '').trim();
  const orgId = String(auth.accessContext?.orgId || '').trim();
  const scopeReady = auth.isAccessReady && auth.isApproved && Boolean(userId && orgId);
  const scope = scopeReady ? { userId, orgId } : null;
  const query = useQuery({
    queryKey: warehouseRegistryScopedQueryKey(scope),
    queryFn: () => listWarehouses(),
    enabled: scopeReady
  });

  const entries = useMemo(() => (scopeReady ? mergeEntries(query.data) : []), [query.data, scopeReady]);

  return {
    ...query,
    entries,
    scopeReady
  };
}

export function getDefaultWarehouseEntries(): WarehouseEntry[] {
  return [];
}
