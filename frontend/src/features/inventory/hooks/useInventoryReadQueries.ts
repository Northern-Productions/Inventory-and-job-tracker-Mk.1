// Purpose: Read-only React Query hooks for inventory, jobs, film orders, and reports.
import { useEffect, useMemo, useRef } from 'react';
import { useMutationState, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getAllocationsByBox,
  getAllocationJob,
  getAllocationJobs,
  previewAllocationPlan
} from '../../../api/features/allocationsClient';
import { getAuditByBox, getRollHistoryByBox, listAudit } from '../../../api/features/auditClient';
import { getFilmCatalog, getFilmOrders } from '../../../api/features/filmOrdersClient';
import { getBox, searchBoxes } from '../../../api/features/inventoryClient';
import {
  getJob,
  getJobsCalendarEntries,
  getJobsCalendarMonth,
  getJobs,
  searchJobsByNumber,
  type JobLifecycleFilter,
  type JobsCalendarView
} from '../../../api/features/jobsClient';
import {
  getOwnerAssetTotalCostReport,
  getReportsSummary
} from '../../../api/features/reportsClient';
import type {
  AddBoxPayload,
  AllocateBoxPayload,
  AuditListParams,
  FilmOrderEntry,
  JobDetail,
  RemoveJobBoxAllocationsPayload,
  ReportsSummaryFilters,
  SearchBoxesParams
} from '../../../domain';
import { syncJobSummaryCachesFromDetail } from './inventoryMutationUtils';
import { inventoryKeys } from './inventoryQueryKeys';

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

function useInventoryReadQuery<TData>(options: InventoryReadQueryOptions<TData>) {
  return useQuery({
    ...options,
    enabled: options.enabled ?? true
  });
}

function useCachedInventoryReadQuery<TData>(options: CachedInventoryReadQueryOptions<TData>) {
  return useQuery({
    ...options,
    enabled: options.enabled ?? true,
    staleTime: options.staleTime ?? DEFAULT_READ_STALE_TIME_MS,
    gcTime: options.gcTime ?? DEFAULT_READ_GC_TIME_MS,
    refetchOnWindowFocus: options.refetchOnWindowFocus ?? false
  });
}

export function useSearchBoxes(params: SearchBoxesParams) {
  return useSearchBoxesWithOptions(params, { enabled: true });
}

export function useSearchBoxesWithOptions(
  params: SearchBoxesParams,
  options: { enabled?: boolean } = {}
) {
  return useInventoryReadQuery({
    queryKey: inventoryKeys.list(params),
    queryFn: () => searchBoxes(params),
    enabled: options.enabled ?? true
  });
}

export function useBox(boxId: string) {
  return useInventoryReadQuery({
    queryKey: inventoryKeys.box(boxId),
    queryFn: () => getBox(boxId),
    enabled: Boolean(boxId)
  });
}

export function useBoxHistory(boxId: string) {
  return useInventoryReadQuery({
    queryKey: inventoryKeys.history(boxId),
    queryFn: () => getAuditByBox(boxId),
    enabled: Boolean(boxId)
  });
}

export function useBoxAllocations(boxId: string) {
  return useInventoryReadQuery({
    queryKey: inventoryKeys.allocations(boxId),
    queryFn: () => getAllocationsByBox(boxId),
    enabled: Boolean(boxId)
  });
}

export function useJobsList(
  limit = 25,
  options: {
    enabled?: boolean;
    refetchOnWindowFocus?: boolean;
    lifecycleStatus?: JobLifecycleFilter;
  } = {}
) {
  return useCachedInventoryReadQuery({
    queryKey: inventoryKeys.jobsList({
      limit,
      lifecycleStatus: options.lifecycleStatus
    }),
    queryFn: () => getJobs(limit, { lifecycleStatus: options.lifecycleStatus }),
    enabled: options.enabled ?? true,
    staleTime: 2 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
    refetchOnWindowFocus: options.refetchOnWindowFocus ?? false
  });
}

export function useJobsSearch(
  query: string,
  limit = 25,
  options: { enabled?: boolean; lifecycleStatus?: JobLifecycleFilter } = {}
) {
  return useCachedInventoryReadQuery({
    queryKey: inventoryKeys.jobsSearchResults({
      query,
      limit,
      lifecycleStatus: options.lifecycleStatus
    }),
    queryFn: () => searchJobsByNumber(query, limit, { lifecycleStatus: options.lifecycleStatus }),
    enabled: (options.enabled ?? true) && Boolean(query.trim()),
    staleTime: 2 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false
  });
}

export function useJobsCalendarMonth(
  month: string,
  options: { enabled?: boolean; lifecycleStatus?: JobLifecycleFilter } = {}
) {
  return useCachedInventoryReadQuery({
    queryKey: inventoryKeys.jobsCalendarMonth({
      month,
      lifecycleStatus: options.lifecycleStatus
    }),
    queryFn: () => getJobsCalendarMonth(month, { lifecycleStatus: options.lifecycleStatus }),
    enabled: (options.enabled ?? true) && Boolean(month.trim()),
    staleTime: 2 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false
  });
}

export function useJobsCalendarEntries(
  anchorDate: string,
  options: {
    enabled?: boolean;
    lifecycleStatus?: JobLifecycleFilter;
    view: JobsCalendarView;
  }
) {
  return useCachedInventoryReadQuery({
    queryKey: inventoryKeys.jobsCalendarPeriod({
      view: options.view,
      anchorDate,
      lifecycleStatus: options.lifecycleStatus
    }),
    queryFn: () =>
      getJobsCalendarEntries({
        view: options.view,
        anchorDate,
        lifecycleStatus: options.lifecycleStatus
      }),
    enabled: (options.enabled ?? true) && Boolean(anchorDate.trim()),
    staleTime: 2 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false
  });
}

export function useJob(jobNumber: string) {
  const queryClient = useQueryClient();
  const lastSyncedKeyRef = useRef('');
  const query = useCachedInventoryReadQuery<JobDetail>({
    queryKey: inventoryKeys.job(jobNumber),
    queryFn: () => getJob(jobNumber),
    enabled: Boolean(jobNumber),
    staleTime: 60 * 1000,
    gcTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false
  });

  useEffect(() => {
    if (!jobNumber || !query.data || query.dataUpdatedAt <= 0) {
      return;
    }

    const syncKey = `${jobNumber}:${query.dataUpdatedAt}`;
    if (lastSyncedKeyRef.current === syncKey) {
      return;
    }

    lastSyncedKeyRef.current = syncKey;
    syncJobSummaryCachesFromDetail(queryClient, query.data, { syncAllocationJobDetail: true });
  }, [jobNumber, query.data, query.dataUpdatedAt, queryClient]);

  return query;
}

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

export function useAllocationPreview(payload: AllocateBoxPayload | null) {
  return useInventoryReadQuery({
    queryKey: inventoryKeys.allocationPreview(payload),
    queryFn: () => {
      if (!payload) {
        throw new Error('Allocation preview payload is required.');
      }

      return previewAllocationPlan(payload);
    },
    enabled: Boolean(payload)
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

export function useFilmCatalog() {
  return useCachedInventoryReadQuery({
    queryKey: inventoryKeys.filmCatalog,
    queryFn: () => getFilmCatalog(),
    staleTime: 10 * 60 * 1000,
    gcTime: 60 * 60 * 1000
  });
}

export function useAuditList(params: AuditListParams) {
  return useInventoryReadQuery({
    queryKey: inventoryKeys.activity(params),
    queryFn: () => listAudit(params)
  });
}

export function useRollHistory(boxId: string) {
  return useInventoryReadQuery({
    queryKey: inventoryKeys.rollHistory(boxId),
    queryFn: () => getRollHistoryByBox(boxId),
    enabled: Boolean(boxId)
  });
}

export function useReportsSummary(filters: ReportsSummaryFilters) {
  return useInventoryReadQuery({
    queryKey: inventoryKeys.reports(filters),
    queryFn: () => getReportsSummary(filters)
  });
}

export function useOwnerAssetTotalCostReport(
  filters: Pick<ReportsSummaryFilters, 'warehouse'>,
  options: { enabled?: boolean } = {}
) {
  return useInventoryReadQuery({
    queryKey: inventoryKeys.ownerAssetTotalCost(filters),
    queryFn: () => getOwnerAssetTotalCostReport(filters),
    enabled: options.enabled ?? true
  });
}

export function useIsAddBoxPending(boxId: string) {
  const pendingBoxIds = useMutationState({
    filters: {
      mutationKey: inventoryKeys.addBoxMutation,
      status: 'pending'
    },
    select: (mutation) => {
      const variables = mutation.state.variables as AddBoxPayload | undefined;
      return variables?.boxId || '';
    }
  });
  const normalizedBoxId = boxId.trim().toUpperCase();

  if (!normalizedBoxId) {
    return false;
  }

  return pendingBoxIds.some((pendingBoxId) => pendingBoxId.trim().toUpperCase() === normalizedBoxId);
}

export function usePendingRemoveJobBoxAllocationIds() {
  const pendingAllocationIds = useMutationState({
    filters: {
      mutationKey: inventoryKeys.removeJobBoxAllocationMutation,
      status: 'pending'
    },
    select: (mutation) => {
      const variables = mutation.state.variables as RemoveJobBoxAllocationsPayload | undefined;
      return String(variables?.allocationId || '').trim().toUpperCase();
    }
  });

  return useMemo(() => {
    const nextIds = new Set<string>();
    for (let index = 0; index < pendingAllocationIds.length; index += 1) {
      const allocationId = String(pendingAllocationIds[index] || '').trim().toUpperCase();
      if (allocationId) {
        nextIds.add(allocationId);
      }
    }

    return nextIds;
  }, [pendingAllocationIds]);
}

export function usePendingDeleteFilmOrderIds() {
  const pendingFilmOrderIds = useMutationState({
    filters: {
      mutationKey: inventoryKeys.deleteFilmOrderMutation,
      status: 'pending'
    },
    select: (mutation) => {
      const variables =
        mutation.state.variables as Pick<FilmOrderEntry, 'filmOrderId'> | { filmOrderId?: string } | undefined;
      return String(variables?.filmOrderId || '').trim().toUpperCase();
    }
  });

  return useMemo(() => {
    const nextIds = new Set<string>();
    for (let index = 0; index < pendingFilmOrderIds.length; index += 1) {
      const filmOrderId = String(pendingFilmOrderIds[index] || '').trim().toUpperCase();
      if (filmOrderId) {
        nextIds.add(filmOrderId);
      }
    }

    return nextIds;
  }, [pendingFilmOrderIds]);
}
