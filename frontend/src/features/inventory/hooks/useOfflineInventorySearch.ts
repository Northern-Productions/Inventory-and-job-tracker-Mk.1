import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { syncAllOfflineInventorySnapshots } from '../../../api/client';
import type { Warehouse } from '../../../domain';
import {
  getOfflineInventorySyncMeta,
  searchOfflineBoxes,
  type OfflineInventorySyncMeta,
  type OfflineSearchBoxesParams
} from '../../../lib/offlineInventory';
import { useWarehouseRegistry } from './useWarehouseRegistry';

const offlineInventoryKeys = {
  root: ['inventory', 'offline'] as const,
  list: (params: OfflineSearchBoxesParams) => ['inventory', 'offline', 'list', params] as const,
  meta: (warehouses: readonly Warehouse[]) => ['inventory', 'offline', 'meta', warehouses.join('|')] as const
};

function aggregateSyncMeta(entries: Array<OfflineInventorySyncMeta | null>) {
  let boxCount = 0;
  let lastSyncedAt = '';

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) {
      continue;
    }

    boxCount += entry.boxCount;
    if (!lastSyncedAt || entry.lastSyncedAt > lastSyncedAt) {
      lastSyncedAt = entry.lastSyncedAt;
    }
  }

  return {
    boxCount,
    lastSyncedAt
  };
}

export function useOfflineInventorySearch(params: OfflineSearchBoxesParams) {
  const queryClient = useQueryClient();
  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine
  );
  const [syncError, setSyncError] = useState<Error | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const warehouseRegistry = useWarehouseRegistry();
  const selectedWarehouses = useMemo<Warehouse[]>(
    () =>
      params.warehouse
        ? [params.warehouse]
        : warehouseRegistry.entries.map((entry) => entry.code),
    [params.warehouse, warehouseRegistry.entries]
  );
  const boxesQuery = useQuery({
    queryKey: offlineInventoryKeys.list(params),
    queryFn: () => searchOfflineBoxes(params)
  });
  const metaQuery = useQuery({
    queryKey: offlineInventoryKeys.meta(selectedWarehouses),
    queryFn: async () =>
      aggregateSyncMeta(await Promise.all(selectedWarehouses.map((warehouse) => getOfflineInventorySyncMeta(warehouse))))
  });
  const hasSnapshot = Boolean(metaQuery.data?.lastSyncedAt);
  const isInitialLoad =
    !hasSnapshot &&
    (boxesQuery.isLoading ||
      boxesQuery.isFetching ||
      metaQuery.isLoading ||
      metaQuery.isFetching ||
      isSyncing);

  useEffect(() => {
    function handleStatusChange() {
      setIsOnline(navigator.onLine);
    }

    window.addEventListener('online', handleStatusChange);
    window.addEventListener('offline', handleStatusChange);

    return () => {
      window.removeEventListener('online', handleStatusChange);
      window.removeEventListener('offline', handleStatusChange);
    };
  }, []);

  useEffect(() => {
    if (!isOnline) {
      return;
    }

    void syncNow();
  }, [isOnline]);

  async function syncNow() {
    if (isSyncing) {
      return;
    }

    if (!isOnline) {
      setSyncError(null);
      await Promise.all([boxesQuery.refetch(), metaQuery.refetch()]);
      return;
    }

    setIsSyncing(true);
    setSyncError(null);

    try {
      await syncAllOfflineInventorySnapshots();
      await queryClient.invalidateQueries({ queryKey: offlineInventoryKeys.root });
    } catch (error) {
      setSyncError(error instanceof Error ? error : new Error('Unable to sync the offline inventory copy.'));
      await queryClient.invalidateQueries({ queryKey: offlineInventoryKeys.root });
    } finally {
      setIsSyncing(false);
    }
  }

  return {
    data: boxesQuery.data || [],
    isError: boxesQuery.isError,
    error: boxesQuery.error,
    isLoading: isInitialLoad,
    isOffline: !isOnline,
    isSyncing,
    syncError,
    hasSnapshot,
    lastSyncedAt: metaQuery.data?.lastSyncedAt || '',
    syncNow,
    refetch: syncNow
  };
}
