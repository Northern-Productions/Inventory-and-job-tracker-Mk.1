// Purpose: Read-only React Query hooks for inventory, jobs, film orders, and reports.
import { useMutationState, useQuery } from '@tanstack/react-query';
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
  getJobs,
  searchJobsByNumber,
  type JobLifecycleFilter
} from '../../../api/features/jobsClient';
import {
  getOwnerAssetTotalCostReport,
  getReportsSummary
} from '../../../api/features/reportsClient';
import type {
  AddBoxPayload,
  AllocateBoxPayload,
  AuditListParams,
  ReportsSummaryFilters,
  SearchBoxesParams
} from '../../../domain';
import { inventoryKeys } from './inventoryQueryKeys';

export function useSearchBoxes(params: SearchBoxesParams) {
  return useSearchBoxesWithOptions(params, { enabled: true });
}

export function useSearchBoxesWithOptions(
  params: SearchBoxesParams,
  options: { enabled?: boolean } = {}
) {
  return useQuery({
    queryKey: inventoryKeys.list(params),
    queryFn: () => searchBoxes(params),
    enabled: options.enabled ?? true
  });
}

export function useBox(boxId: string) {
  return useQuery({
    queryKey: inventoryKeys.box(boxId),
    queryFn: () => getBox(boxId),
    enabled: Boolean(boxId)
  });
}

export function useBoxHistory(boxId: string) {
  return useQuery({
    queryKey: inventoryKeys.history(boxId),
    queryFn: () => getAuditByBox(boxId),
    enabled: Boolean(boxId)
  });
}

export function useBoxAllocations(boxId: string) {
  return useQuery({
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
  return useQuery({
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
  return useQuery({
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

export function useJob(jobNumber: string) {
  return useQuery({
    queryKey: inventoryKeys.job(jobNumber),
    queryFn: () => getJob(jobNumber),
    enabled: Boolean(jobNumber),
    staleTime: 60 * 1000,
    gcTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false
  });
}

export function useAllocationJobs() {
  return useQuery({
    queryKey: inventoryKeys.allocationJobs,
    queryFn: () => getAllocationJobs(),
    staleTime: 2 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false
  });
}

export function useAllocationJob(jobNumber: string) {
  return useQuery({
    queryKey: inventoryKeys.allocationJob(jobNumber),
    queryFn: () => getAllocationJob(jobNumber),
    enabled: Boolean(jobNumber),
    staleTime: 60 * 1000,
    gcTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false
  });
}

export function useAllocationPreview(payload: AllocateBoxPayload | null) {
  return useQuery({
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

export function useFilmOrders() {
  return useQuery({
    queryKey: inventoryKeys.filmOrders,
    queryFn: () => getFilmOrders()
  });
}

export function useFilmCatalog() {
  return useQuery({
    queryKey: inventoryKeys.filmCatalog,
    queryFn: () => getFilmCatalog(),
    staleTime: 10 * 60 * 1000,
    gcTime: 60 * 60 * 1000
  });
}

export function useAuditList(params: AuditListParams) {
  return useQuery({
    queryKey: inventoryKeys.activity(params),
    queryFn: () => listAudit(params)
  });
}

export function useRollHistory(boxId: string) {
  return useQuery({
    queryKey: inventoryKeys.rollHistory(boxId),
    queryFn: () => getRollHistoryByBox(boxId),
    enabled: Boolean(boxId)
  });
}

export function useReportsSummary(filters: ReportsSummaryFilters) {
  return useQuery({
    queryKey: inventoryKeys.reports(filters),
    queryFn: () => getReportsSummary(filters)
  });
}

export function useOwnerAssetTotalCostReport(
  filters: Pick<ReportsSummaryFilters, 'warehouse'>,
  options: { enabled?: boolean } = {}
) {
  return useQuery({
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
