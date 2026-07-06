// Purpose: Shared offline inventory cache helpers used by inventory mutations.
import type { QueryClient } from '@tanstack/react-query';
import { syncAllOfflineInventorySnapshots } from '../../../api/features/inventoryClient';
import { getClientOfflineInventoryScope } from '../../../api/features/sharedClient';
import type { Box } from '../../../domain';
import { deleteOfflineInventoryBox, upsertOfflineInventoryBox } from '../../../lib/offlineInventory';

export async function refreshOfflineInventoryQueries(queryClient: QueryClient) {
  await queryClient.invalidateQueries({ queryKey: ['inventory', 'offline'] });
}

export async function syncOfflineInventoryQueries(queryClient: QueryClient) {
  try {
    await syncAllOfflineInventorySnapshots();
  } catch (_error) {
    // Keep the last good offline snapshot if the refresh fails.
  }

  await refreshOfflineInventoryQueries(queryClient);
}

export async function persistOfflineInventoryBox(queryClient: QueryClient, box: Box) {
  try {
    await upsertOfflineInventoryBox(getClientOfflineInventoryScope(), box);
  } catch (_error) {
    // The online mutation already succeeded. A local cache write failure should not block it.
  }

  await refreshOfflineInventoryQueries(queryClient);
}

export async function removeOfflineInventoryBox(
  queryClient: QueryClient,
  box: Pick<Box, 'boxId' | 'warehouse'>
) {
  try {
    await deleteOfflineInventoryBox(getClientOfflineInventoryScope(), box);
  } catch (_error) {
    // The online mutation already succeeded. A local cache write failure should not block it.
  }

  await refreshOfflineInventoryQueries(queryClient);
}
