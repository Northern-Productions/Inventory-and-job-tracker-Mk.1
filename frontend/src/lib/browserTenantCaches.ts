import { clearOfflineInventoryDatabase } from './offlineInventory';

export const LEGACY_API_RUNTIME_CACHE_NAMES = ['api-cache'] as const;

export async function clearLegacyApiRuntimeCaches(): Promise<void> {
  if (typeof caches === 'undefined') {
    return;
  }

  await Promise.all(
    LEGACY_API_RUNTIME_CACHE_NAMES.map((cacheName) => caches.delete(cacheName))
  );
}

export async function clearTenantPersistentBrowserCaches(): Promise<void> {
  await Promise.allSettled([
    clearOfflineInventoryDatabase(),
    clearLegacyApiRuntimeCaches()
  ]);
}
