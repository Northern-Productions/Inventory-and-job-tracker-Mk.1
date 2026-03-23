import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { syncAllOfflineInventorySnapshots } from '../../../api/features/inventoryClient';
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
  const isSyncingRef = useRef(false);
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

  const syncNow = useCallback(async () => {
    const currentlyOnline = typeof navigator === 'undefined' ? true : navigator.onLine;

    if (isSyncingRef.current) {
      return;
    }

    if (!currentlyOnline) {
      setSyncError(null);
      await queryClient.invalidateQueries({ queryKey: offlineInventoryKeys.root });
      return;
    }

    isSyncingRef.current = true;
    setIsSyncing(true);
    setSyncError(null);

    try {
      await syncAllOfflineInventorySnapshots();
      await queryClient.invalidateQueries({ queryKey: offlineInventoryKeys.root });
    } catch (error) {
      setSyncError(error instanceof Error ? error : new Error('Unable to sync the offline inventory copy.'));
      await queryClient.invalidateQueries({ queryKey: offlineInventoryKeys.root });
    } finally {
      isSyncingRef.current = false;
      setIsSyncing(false);
    }
  }, [queryClient]);

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
  }, [isOnline, syncNow]);

  useEffect(() => {
    function handleWindowFocus() {
      if (typeof navigator !== 'undefined') {
        setIsOnline(navigator.onLine);
      }

      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        return;
      }

      void syncNow();
    }

    function handleVisibilityChange() {
      if (document.visibilityState !== 'visible') {
        return;
      }

      if (typeof navigator !== 'undefined') {
        setIsOnline(navigator.onLine);
      }

      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        return;
      }

      void syncNow();
    }

    window.addEventListener('focus', handleWindowFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('focus', handleWindowFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [syncNow]);

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
