import { useQuery } from '@tanstack/react-query';

const DEFAULT_READ_STALE_TIME_MS = 2 * 60 * 1000;
const DEFAULT_READ_GC_TIME_MS = 60 * 60 * 1000;

interface InventoryReadQueryOptions<TData> {
  queryKey: readonly unknown[];
  queryFn: () => Promise<TData>;
  enabled?: boolean;
}

interface CachedInventoryReadQueryOptions<TData> extends InventoryReadQueryOptions<TData> {
  staleTime?: number;
  gcTime?: number;
  refetchOnWindowFocus?: boolean;
}

export function useInventoryReadQuery<TData>(options: InventoryReadQueryOptions<TData>) {
  return useQuery({
    ...options,
    enabled: options.enabled ?? true
  });
}

export function useCachedInventoryReadQuery<TData>(options: CachedInventoryReadQueryOptions<TData>) {
  return useQuery({
    ...options,
    enabled: options.enabled ?? true,
    staleTime: options.staleTime ?? DEFAULT_READ_STALE_TIME_MS,
    gcTime: options.gcTime ?? DEFAULT_READ_GC_TIME_MS,
    refetchOnWindowFocus: options.refetchOnWindowFocus ?? false
  });
}
