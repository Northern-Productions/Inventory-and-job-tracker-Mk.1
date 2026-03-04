import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { syncAllOfflineInventorySnapshots } from '../../../api/client';
import type { SearchBoxesParams } from '../../../domain';
import { getOfflineInventorySyncMeta, searchOfflineBoxes } from '../../../lib/offlineInventory';

const offlineInventoryKeys = {
  root: ['inventory', 'offline'] as const,
  list: (params: SearchBoxesParams) => ['inventory', 'offline', 'list', params] as const,
  meta: (warehouse: SearchBoxesParams['warehouse']) => ['inventory', 'offline', 'meta', warehouse] as const
};

export function useOfflineInventorySearch(params: SearchBoxesParams) {
  const queryClient = useQueryClient();
  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine
  );
  const [syncError, setSyncError] = useState<Error | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const boxesQuery = useQuery({
    queryKey: offlineInventoryKeys.list(params),
    queryFn: () => searchOfflineBoxes(params)
  });
  const metaQuery = useQuery({
    queryKey: offlineInventoryKeys.meta(params.warehouse),
    queryFn: () => getOfflineInventorySyncMeta(params.warehouse)
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
