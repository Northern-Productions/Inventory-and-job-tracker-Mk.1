import { getAppAttentionSummary } from '../../../../api/features/appClient';
import {
  getAllocationJob,
  getAllocationJobs
} from '../../../../api/features/allocationsClient';
import { listCaulkProducts } from '../../../../api/features/caulkClient';
import {
  getFilmCatalog,
  getFilmOrderDetail,
  getFilmOrders
} from '../../../../api/features/filmOrdersClient';
import { listBoxDealers } from '../../../../api/features/inventoryClient';
import type { AppAttentionSummary } from '../../../../domain';
import { inventoryKeys } from '../inventoryQueryKeys';
import { useCachedInventoryReadQuery } from './shared';

export function useAllocationJobs() {
  return useCachedInventoryReadQuery({
    queryKey: inventoryKeys.allocationJobs,
    queryFn: () => getAllocationJobs(),
    staleTime: 2 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false
  });
}

export function useAllocationJob(jobNumber: string) {
  return useCachedInventoryReadQuery({
    queryKey: inventoryKeys.allocationJob(jobNumber),
    queryFn: () => getAllocationJob(jobNumber),
    enabled: Boolean(jobNumber),
    staleTime: 60 * 1000,
    gcTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false
  });
}

export function useFilmOrders(options: { enabled?: boolean; refetchOnWindowFocus?: boolean } = {}) {
  return useCachedInventoryReadQuery({
    queryKey: inventoryKeys.filmOrders,
    queryFn: () => getFilmOrders(),
    enabled: options.enabled ?? true,
    refetchOnWindowFocus: options.refetchOnWindowFocus ?? false
  });
}

export function useFilmOrderDetail(
  filmOrderId: string,
  options: { enabled?: boolean; refetchOnWindowFocus?: boolean } = {}
) {
  const normalizedFilmOrderId = String(filmOrderId || '').trim();
  return useCachedInventoryReadQuery({
    queryKey: inventoryKeys.filmOrder(normalizedFilmOrderId),
    queryFn: () => getFilmOrderDetail(normalizedFilmOrderId),
    enabled: (options.enabled ?? true) && Boolean(normalizedFilmOrderId),
    staleTime: 30 * 1000,
    gcTime: 60 * 60 * 1000,
    refetchOnWindowFocus: options.refetchOnWindowFocus ?? true
  });
}

export function useAppAttentionSummary(options: { enabled?: boolean; refetchOnWindowFocus?: boolean } = {}) {
  return useCachedInventoryReadQuery<AppAttentionSummary>({
    queryKey: inventoryKeys.appAttentionSummary,
    queryFn: () => getAppAttentionSummary(),
    enabled: options.enabled ?? true,
    staleTime: 60 * 1000,
    gcTime: 60 * 60 * 1000,
    refetchOnWindowFocus: options.refetchOnWindowFocus ?? true
  });
}

export function useFilmCatalog(options: { enabled?: boolean } = {}) {
  return useCachedInventoryReadQuery({
    queryKey: inventoryKeys.filmCatalog,
    queryFn: () => getFilmCatalog(),
    enabled: options.enabled ?? true,
    staleTime: 10 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false
  });
}

export function useBoxDealers(options: { enabled?: boolean } = {}) {
  return useCachedInventoryReadQuery({
    queryKey: inventoryKeys.boxDealers,
    queryFn: () => listBoxDealers(),
    enabled: options.enabled ?? true,
    staleTime: 10 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false
  });
}

export function useCaulkProducts(options: { enabled?: boolean } = {}) {
  return useCachedInventoryReadQuery({
    queryKey: inventoryKeys.caulkProducts,
    queryFn: () => listCaulkProducts(),
    enabled: options.enabled ?? true,
    staleTime: 10 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false
  });
}
