// Purpose: Mutation React Query hooks for inventory, jobs, film orders, and audit undo flows.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useOptimisticQueue } from '../../../components/OptimisticQueue';
import {
  addCaulkJobAllocation,
  applyAllocationPlan,
  checkinCaulkJobAllocation,
  checkoutCaulkJobAllocation,
  removeCaulkJobAllocation,
  updateCaulkJobAllocation,
  removeJobBoxAllocations
} from '../../../api/features/allocationsClient';
import { undoAudit } from '../../../api/features/auditClient';
import {
  cancelJob,
  createFilmOrder,
  deleteFilmOrder
} from '../../../api/features/filmOrdersClient';
import {
  addBox,
  deleteBox,
  setBoxStatus,
  updateBox
} from '../../../api/features/inventoryClient';
import {
  checkoutAllJobMaterials,
  completeJob,
  createJob,
  deleteJob,
  reopenJob,
  setJobStagedForPickup,
  updateJob
} from '../../../api/features/jobsClient';
import type {
  AllocationEntry,
  AllocationJobDetail,
  AllocationJobSummary,
  AddCaulkJobAllocationPayload,
  AddBoxPayload,
  ApplyAllocationPlanPayload,
  Box,
  CaulkJobAllocationEntry,
  CaulkJobCheckoutEntry,
  CaulkProductEntry,
  CheckinCaulkJobAllocationPayload,
  CheckoutCaulkJobAllocationPayload,
  CreateFilmOrderPayload,
  CreateJobPayload,
  DeleteJobPayload,
  DeleteBoxPayload,
  FilmOrderEntry,
  JobDetail,
  JobListEntry,
  SetJobStagedForPickupPayload,
  RemoveJobBoxAllocationsPayload,
  RemoveCaulkJobAllocationPayload,
  SetBoxStatusPayload,
  UndoAuditPayload,
  UpdateCaulkJobAllocationPayload,
  UpdateBoxPayload,
  UpdateJobPayload
} from '../../../domain';
import { WAREHOUSE_CODES } from '../../../domain';
import { todayDateString } from '../../../lib/date';
import { inventoryKeys } from './inventoryQueryKeys';
import {
  applyOptimisticAddBoxToCaches,
  applyOptimisticAllocationAdditionToCaches,
  applyOptimisticAllocationRemovalToCaches,
  applyOptimisticFilmOrderDeletionToCaches,
  applyOptimisticJobScheduleSyncToCaches,
  beginDelayedOptimisticMutation,
  beginImmediateOptimisticMutation,
  createOptimisticAllocationJobSummaryFromJobDetail,
  createOptimisticFilmOrderFromPayload,
  createOptimisticJobDetailFromCreatePayload,
  resolveOptimisticFilmOrderScheduleFromCaches,
  rollbackOptimisticAllocationRemovalInCaches,
  removeBoxCaches,
  removeJobPlanningCaches,
  replaceFilmOrderInCaches,
  restoreSnapshots,
  syncJobDetailCaches,
  upsertJobsCalendarCaches,
  upsertAllocationJobSummaryCaches,
  upsertFilmOrdersCache,
  upsertBoxInSearchCaches,
  upsertJobListCaches,
  updateBoxCaches,
  type OptimisticAllocationRemovalRollback
} from './inventoryMutationUtils';
import {
  invalidateCaulkJobQueries,
  invalidateGlobalPlanningQueries,
  invalidateJobAndFilmOrderQueries,
  invalidateJobLifecycleQueries
} from './inventoryInvalidation';
import {
  persistOfflineInventoryBox,
  refreshOfflineInventoryQueries,
  removeOfflineInventoryBox,
  syncOfflineInventoryQueries
} from './useInventoryOfflineSync';

function updateJobDetailQueries<T>(
  queryClient: ReturnType<typeof useQueryClient>,
  queryKey: readonly unknown[],
  updater: (current: T) => T
) {
  const queries = queryClient.getQueriesData<T>({ queryKey });
  for (let index = 0; index < queries.length; index += 1) {
    const [currentKey, current] = queries[index];
    if (!current) {
      continue;
    }

    queryClient.setQueryData<T>(currentKey, updater(current));
  }
}

function updateCheckedOutBoxCaches(
  queryClient: ReturnType<typeof useQueryClient>,
  boxId: string,
  status: 'CHECKED_OUT' | 'IN_STOCK'
) {
  updateJobDetailQueries<JobDetail>(queryClient, inventoryKeys.jobRoot, (current) => ({
    ...current,
    allocations: current.allocations.map((entry) =>
      entry.boxId === boxId
        ? {
            ...entry,
            boxStatus: status,
            checkedOutOnThisJob: status === 'CHECKED_OUT'
          }
        : entry
    )
  }));

  updateJobDetailQueries<AllocationJobDetail>(queryClient, inventoryKeys.allocationJobRoot, (current) => ({
    ...current,
    allocations: current.allocations.map((entry) =>
      entry.boxId === boxId
        ? {
            ...entry,
            boxStatus: status,
            checkedOutOnThisJob: status === 'CHECKED_OUT'
          }
        : entry
    )
  }));
}

function updateCaulkCheckoutCaches(
  queryClient: ReturnType<typeof useQueryClient>,
  payload: CheckoutCaulkJobAllocationPayload,
  options: {
    checkoutTubes: number;
    notes?: string;
    sourceAllocation?: CaulkJobAllocationEntry | null;
  } | null
) {
  const now = new Date().toISOString();
  const checkoutTubes = options?.checkoutTubes || 0;
  const sourceAllocation = options?.sourceAllocation || null;

  if (checkoutTubes <= 0) {
    return;
  }

  updateJobDetailQueries<JobDetail>(queryClient, inventoryKeys.jobRoot, (current) => ({
    ...current,
    caulkAllocations: current.caulkAllocations.map((entry) =>
      entry.caulkAllocationId === payload.caulkAllocationId
        ? {
            ...entry,
            reservedTubesRemaining: Math.max(entry.reservedTubesRemaining - checkoutTubes, 0),
            checkedOutTubesTotal: entry.checkedOutTubesTotal + checkoutTubes,
            outstandingCheckoutTubes: entry.outstandingCheckoutTubes + checkoutTubes,
            openCheckoutCount: entry.openCheckoutCount + 1
          }
        : entry
    ),
    caulkCheckouts: [
      {
        caulkCheckoutId: `pending-${payload.caulkAllocationId}-${Date.now()}`,
        caulkAllocationId: payload.caulkAllocationId,
        productId: sourceAllocation?.productId || '',
        manufacturerId: sourceAllocation?.manufacturerId || '',
        manufacturer: sourceAllocation?.manufacturer || '',
        productName: sourceAllocation?.productName || '',
        productCode: sourceAllocation?.productCode || '',
        tubesPerCase: sourceAllocation?.tubesPerCase || 0,
        warehouse: sourceAllocation?.warehouse || WAREHOUSE_CODES[0],
        checkoutTubes,
        overageTubes: 0,
        status: 'OPEN',
        checkedOutAt: now,
        checkedOutBy: 'Pending...',
        checkedInAt: '',
        checkedInBy: '',
        unusedTubes: 0,
        usedTubes: 0,
        notes: options?.notes || ''
      },
      ...current.caulkCheckouts
    ]
  }));

  updateJobDetailQueries<AllocationJobDetail>(queryClient, inventoryKeys.allocationJobRoot, (current) => ({
    ...current,
    caulkAllocations: current.caulkAllocations.map((entry) =>
      entry.caulkAllocationId === payload.caulkAllocationId
        ? {
            ...entry,
            reservedTubesRemaining: Math.max(entry.reservedTubesRemaining - checkoutTubes, 0),
            checkedOutTubesTotal: entry.checkedOutTubesTotal + checkoutTubes,
            outstandingCheckoutTubes: entry.outstandingCheckoutTubes + checkoutTubes,
            openCheckoutCount: entry.openCheckoutCount + 1
          }
        : entry
    ),
    caulkCheckouts: [
      {
        caulkCheckoutId: `pending-${payload.caulkAllocationId}-${Date.now()}`,
        caulkAllocationId: payload.caulkAllocationId,
        productId: sourceAllocation?.productId || '',
        manufacturerId: sourceAllocation?.manufacturerId || '',
        manufacturer: sourceAllocation?.manufacturer || '',
        productName: sourceAllocation?.productName || '',
        productCode: sourceAllocation?.productCode || '',
        tubesPerCase: sourceAllocation?.tubesPerCase || 0,
        warehouse: sourceAllocation?.warehouse || WAREHOUSE_CODES[0],
        checkoutTubes,
        overageTubes: 0,
        status: 'OPEN',
        checkedOutAt: now,
        checkedOutBy: 'Pending...',
        checkedInAt: '',
        checkedInBy: '',
        unusedTubes: 0,
        usedTubes: 0,
        notes: options?.notes || ''
      },
      ...current.caulkCheckouts
    ]
  }));
}

function updateCaulkCheckinCaches(
  queryClient: ReturnType<typeof useQueryClient>,
  caulkAllocationId: string,
  caulkCheckoutId: string,
  details: {
    checkoutTubes: number;
    unusedLooseTubes: number;
    unusedCases: number;
    notes?: string;
    sourceCheckout?: CaulkJobCheckoutEntry | null;
  }
) {
  const now = new Date().toISOString();
  const tubesPerCase = Math.max(details.sourceCheckout?.tubesPerCase || 0, 0);
  const returnedTubes = details.unusedLooseTubes + details.unusedCases * tubesPerCase;
  const usedTubes = Math.max(details.checkoutTubes - returnedTubes, 0);

  updateJobDetailQueries<JobDetail>(queryClient, inventoryKeys.jobRoot, (current) => ({
    ...current,
    caulkAllocations: current.caulkAllocations.map((entry) =>
      entry.caulkAllocationId === caulkAllocationId
        ? {
            ...entry,
            openCheckoutCount: Math.max(entry.openCheckoutCount - 1, 0),
            outstandingCheckoutTubes: Math.max(entry.outstandingCheckoutTubes - details.checkoutTubes, 0),
            returnedUnusedTubesTotal:
              entry.returnedUnusedTubesTotal + returnedTubes,
            usedTubesTotal: entry.usedTubesTotal + usedTubes
          }
        : entry
    ),
    caulkCheckouts: current.caulkCheckouts.map((entry) =>
      entry.caulkCheckoutId === caulkCheckoutId
        ? {
            ...entry,
            status: 'CLOSED',
            checkedInAt: now,
            checkedInBy: 'Pending...',
            unusedTubes: returnedTubes,
            usedTubes,
            notes: details.notes || entry.notes
          }
        : entry
    )
  }));

  updateJobDetailQueries<AllocationJobDetail>(queryClient, inventoryKeys.allocationJobRoot, (current) => ({
    ...current,
    caulkAllocations: current.caulkAllocations.map((entry) =>
      entry.caulkAllocationId === caulkAllocationId
        ? {
            ...entry,
            openCheckoutCount: Math.max(entry.openCheckoutCount - 1, 0),
            outstandingCheckoutTubes: Math.max(entry.outstandingCheckoutTubes - details.checkoutTubes, 0),
            returnedUnusedTubesTotal:
              entry.returnedUnusedTubesTotal + returnedTubes,
            usedTubesTotal: entry.usedTubesTotal + usedTubes
          }
        : entry
    ),
    caulkCheckouts: current.caulkCheckouts.map((entry) =>
      entry.caulkCheckoutId === caulkCheckoutId
        ? {
            ...entry,
            status: 'CLOSED',
            checkedInAt: now,
            checkedInBy: 'Pending...',
            unusedTubes: returnedTubes,
            usedTubes,
            notes: details.notes || entry.notes
          }
        : entry
    )
  }));
}

function buildPendingCaulkCheckoutFromAllocation(
  sourceAllocation: CaulkJobAllocationEntry,
  checkoutTubes: number,
  now: string
): CaulkJobCheckoutEntry {
  return {
    caulkCheckoutId: `pending-${sourceAllocation.caulkAllocationId}-${Date.now()}`,
    caulkAllocationId: sourceAllocation.caulkAllocationId,
    productId: sourceAllocation.productId,
    manufacturerId: sourceAllocation.manufacturerId,
    manufacturer: sourceAllocation.manufacturer,
    productName: sourceAllocation.productName,
    productCode: sourceAllocation.productCode,
    tubesPerCase: sourceAllocation.tubesPerCase,
    warehouse: sourceAllocation.warehouse,
    checkoutTubes,
    overageTubes: 0,
    status: 'OPEN',
    checkedOutAt: now,
    checkedOutBy: 'Pending...',
    checkedInAt: '',
    checkedInBy: '',
    unusedTubes: 0,
    usedTubes: 0,
    notes: 'Pending server confirmation'
  };
}

function applyCheckoutAllToJobDetail(detail: JobDetail): JobDetail {
  const now = new Date().toISOString();
  const nextCaulkCheckouts = [...detail.caulkCheckouts];

  return {
    ...detail,
    allocations: detail.allocations.map((entry) =>
      entry.status === 'ACTIVE' &&
      entry.boxStatus === 'IN_STOCK' &&
      !entry.checkedOutOnThisJob
        ? {
            ...entry,
            boxStatus: 'CHECKED_OUT' as const,
            checkedOutOnThisJob: true
          }
        : entry
    ),
    caulkAllocations: detail.caulkAllocations.map((entry) => {
      const checkoutTubes = Math.max(0, entry.reservedTubesRemaining);
      const shouldCheckout =
        entry.status === 'ACTIVE' && checkoutTubes > 0 && entry.openCheckoutCount <= 0;

      if (!shouldCheckout) {
        return entry;
      }

      nextCaulkCheckouts.unshift(buildPendingCaulkCheckoutFromAllocation(entry, checkoutTubes, now));
      return {
        ...entry,
        reservedTubesRemaining: 0,
        checkedOutTubesTotal: entry.checkedOutTubesTotal + checkoutTubes,
        outstandingCheckoutTubes: entry.outstandingCheckoutTubes + checkoutTubes,
        openCheckoutCount: entry.openCheckoutCount + 1
      };
    }),
    caulkCheckouts: nextCaulkCheckouts
  };
}

function applyCheckoutAllToAllocationJobDetail(detail: AllocationJobDetail): AllocationJobDetail {
  const now = new Date().toISOString();
  const nextCaulkCheckouts = [...detail.caulkCheckouts];

  return {
    ...detail,
    allocations: detail.allocations.map((entry) =>
      entry.status === 'ACTIVE' &&
      entry.boxStatus === 'IN_STOCK' &&
      !entry.checkedOutOnThisJob
        ? {
            ...entry,
            boxStatus: 'CHECKED_OUT' as const,
            checkedOutOnThisJob: true
          }
        : entry
    ),
    caulkAllocations: detail.caulkAllocations.map((entry) => {
      const checkoutTubes = Math.max(0, entry.reservedTubesRemaining);
      const shouldCheckout =
        entry.status === 'ACTIVE' && checkoutTubes > 0 && entry.openCheckoutCount <= 0;

      if (!shouldCheckout) {
        return entry;
      }

      nextCaulkCheckouts.unshift(buildPendingCaulkCheckoutFromAllocation(entry, checkoutTubes, now));
      return {
        ...entry,
        reservedTubesRemaining: 0,
        checkedOutTubesTotal: entry.checkedOutTubesTotal + checkoutTubes,
        outstandingCheckoutTubes: entry.outstandingCheckoutTubes + checkoutTubes,
        openCheckoutCount: entry.openCheckoutCount + 1
      };
    }),
    caulkCheckouts: nextCaulkCheckouts
  };
}

function applyCheckoutAllToCaches(
  queryClient: ReturnType<typeof useQueryClient>,
  jobNumber: string
) {
  const currentJob = queryClient.getQueryData<JobDetail>(inventoryKeys.job(jobNumber));
  const currentAllocationJob = queryClient.getQueryData<AllocationJobDetail>(
    inventoryKeys.allocationJob(jobNumber)
  );
  const touchedBoxIds = new Set<string>();
  const today = todayDateString();

  if (currentJob) {
    for (let index = 0; index < currentJob.allocations.length; index += 1) {
      const entry = currentJob.allocations[index];
      if (entry.status === 'ACTIVE' && entry.boxStatus === 'IN_STOCK' && !entry.checkedOutOnThisJob) {
        touchedBoxIds.add(entry.boxId);
      }
    }

    queryClient.setQueryData<JobDetail>(inventoryKeys.job(jobNumber), applyCheckoutAllToJobDetail(currentJob));
  }

  if (currentAllocationJob) {
    queryClient.setQueryData<AllocationJobDetail>(
      inventoryKeys.allocationJob(jobNumber),
      applyCheckoutAllToAllocationJobDetail(currentAllocationJob)
    );
  }

  touchedBoxIds.forEach((boxId) => {
    updateBoxCaches(queryClient, boxId, (box) => ({
      ...box,
      status: 'CHECKED_OUT',
      hasEverBeenCheckedOut: true,
      lastCheckoutJob: jobNumber,
      lastCheckoutDate: today,
      zeroedDate: '',
      zeroedReason: '',
      zeroedBy: ''
    }));
  });
}

export function useCreateFilmOrder() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: CreateFilmOrderPayload) => createFilmOrder(payload),
    onMutate: async (payload) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: inventoryKeys.filmOrders }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.jobs }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.job(payload.jobNumber) }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJobs }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJob(payload.jobNumber) })
      ]);

      const optimisticFilmOrder = createOptimisticFilmOrderFromPayload(
        payload,
        resolveOptimisticFilmOrderScheduleFromCaches(queryClient, payload.jobNumber)
      );
      const context = beginImmediateOptimisticMutation(
        queryClient,
        [
          inventoryKeys.filmOrders,
          inventoryKeys.jobs,
          inventoryKeys.job(payload.jobNumber),
          inventoryKeys.allocationJobs,
          inventoryKeys.allocationJob(payload.jobNumber)
        ],
        () => {
          upsertFilmOrdersCache(queryClient, optimisticFilmOrder);

          upsertJobListCaches(queryClient, {
            ...(queryClient.getQueryData<JobDetail>(inventoryKeys.job(payload.jobNumber))?.summary || {
              jobNumber: payload.jobNumber,
              warehouse: payload.warehouse,
              sections: null,
              dueDate: '',
              crewLeader: '',
              status: 'ALLOCATE',
              lifecycleStatus: 'ACTIVE',
              isLaborOnly: false,
              isStagedForPickup: false,
              requiredFeet: 0,
              allocatedFeet: 0,
              remainingFeet: 0,
              requiredTubes: 0,
              allocatedTubes: 0,
              remainingTubes: 0,
              requirementCount: 0,
              allocationCount: 0,
              filmOrderCount: 0,
              createdAt: optimisticFilmOrder.createdAt,
              updatedAt: optimisticFilmOrder.createdAt,
              notes: ''
            }),
            status: 'FILM_ORDER',
            filmOrderCount:
              Number(
                queryClient.getQueryData<JobDetail>(inventoryKeys.job(payload.jobNumber))?.summary
                  .filmOrderCount || 0
              ) + 1,
            updatedAt: optimisticFilmOrder.createdAt
          });

          queryClient.setQueryData<JobDetail | undefined>(
            inventoryKeys.job(payload.jobNumber),
            (current) =>
              current
                ? {
                    ...current,
                    summary: {
                      ...current.summary,
                      status: 'FILM_ORDER',
                      filmOrderCount: current.summary.filmOrderCount + 1,
                      updatedAt: optimisticFilmOrder.createdAt
                    },
                    filmOrders: [optimisticFilmOrder, ...current.filmOrders]
                  }
                : current
          );

          upsertAllocationJobSummaryCaches(queryClient, {
            ...(queryClient.getQueryData<AllocationJobDetail>(inventoryKeys.allocationJob(payload.jobNumber))
              ?.summary || {
              jobNumber: payload.jobNumber,
              jobDate: '',
              crewLeader: '',
              status: 'ALLOCATE',
              activeAllocatedFeet: 0,
              fulfilledAllocatedFeet: 0,
              requiredTubes: 0,
              allocatedTubes: 0,
              remainingTubes: 0,
              openFilmOrderCount: 0,
              boxCount: 0
            }),
            status: 'FILM_ORDER',
            openFilmOrderCount:
              Number(
                queryClient.getQueryData<AllocationJobDetail>(inventoryKeys.allocationJob(payload.jobNumber))
                  ?.summary.openFilmOrderCount || 0
              ) + 1
          });

          queryClient.setQueryData<AllocationJobDetail | undefined>(
            inventoryKeys.allocationJob(payload.jobNumber),
            (current) =>
              current
                ? {
                    ...current,
                    summary: {
                      ...current.summary,
                      status: 'FILM_ORDER',
                      openFilmOrderCount: current.summary.openFilmOrderCount + 1
                    },
                    filmOrders: [optimisticFilmOrder, ...current.filmOrders]
                  }
                : current
          );
        }
      );

      return {
        ...context,
        pendingFilmOrderId: optimisticFilmOrder.filmOrderId
      };
    },
    onError: (_error, _variables, context) => {
      restoreSnapshots(queryClient, context?.snapshots);
    },
    onSuccess: async ({ result }, variables, context) => {
      if (context?.pendingFilmOrderId) {
        replaceFilmOrderInCaches(queryClient, context.pendingFilmOrderId, result);
        queryClient.setQueryData<JobDetail | undefined>(inventoryKeys.job(variables.jobNumber), (current) =>
          current
            ? {
                ...current,
                filmOrders: current.filmOrders.map((entry) =>
                  entry.filmOrderId === context.pendingFilmOrderId ? result : entry
                )
              }
            : current
        );
        queryClient.setQueryData<AllocationJobDetail | undefined>(
          inventoryKeys.allocationJob(variables.jobNumber),
          (current) =>
            current
              ? {
                  ...current,
                  filmOrders: current.filmOrders.map((entry) =>
                    entry.filmOrderId === context.pendingFilmOrderId ? result : entry
                  )
                }
              : current
        );
      }

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: inventoryKeys.filmOrders }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJobs }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJob(variables.jobNumber) })
      ]);
    }
  });
}

export function useCreateJob() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: CreateJobPayload) => createJob(payload),
    onMutate: async (payload) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: inventoryKeys.jobs }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.job(payload.jobNumber) }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJobs }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJob(payload.jobNumber) })
      ]);

      const optimisticDetail = createOptimisticJobDetailFromCreatePayload(
        payload,
        queryClient.getQueryData<CaulkProductEntry[]>(['caulk', 'products']) || []
      );

      return beginImmediateOptimisticMutation(
        queryClient,
        [
          inventoryKeys.jobs,
          inventoryKeys.job(payload.jobNumber),
          inventoryKeys.allocationJobs,
          inventoryKeys.allocationJob(payload.jobNumber)
        ],
        () => {
          queryClient.setQueryData(inventoryKeys.job(payload.jobNumber), optimisticDetail);
          queryClient.setQueryData<AllocationJobDetail>(inventoryKeys.allocationJob(payload.jobNumber), {
            summary: createOptimisticAllocationJobSummaryFromJobDetail(optimisticDetail),
            allocations: [],
            usage: [],
            usageTimeline: [],
            caulkRequirements: optimisticDetail.caulkRequirements,
            caulkAllocations: [],
            caulkCheckouts: [],
            filmOrders: []
          });
          upsertJobListCaches(queryClient, optimisticDetail.summary);
          upsertAllocationJobSummaryCaches(
            queryClient,
            createOptimisticAllocationJobSummaryFromJobDetail(optimisticDetail)
          );
        }
      );
    },
    onError: (_error, _variables, context) => {
      restoreSnapshots(queryClient, context?.snapshots);
    },
    onSuccess: async ({ result }) => {
      syncJobDetailCaches(queryClient, result, { syncAllocationJobDetail: true });
      await invalidateJobAndFilmOrderQueries(queryClient, result.summary.jobNumber);
    }
  });
}

export function useUpdateJob() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: UpdateJobPayload) => updateJob(payload),
    onMutate: async (payload) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: inventoryKeys.jobs }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.job(payload.jobNumber) }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJobs }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJob(payload.jobNumber) }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.filmOrders })
      ]);

      return beginImmediateOptimisticMutation(
        queryClient,
        [
          inventoryKeys.jobs,
          inventoryKeys.job(payload.jobNumber),
          inventoryKeys.allocationJobs,
          inventoryKeys.allocationJob(payload.jobNumber),
          inventoryKeys.filmOrders
        ],
        () => {
          applyOptimisticJobScheduleSyncToCaches(queryClient, payload);
        }
      );
    },
    onError: (_error, _variables, context) => {
      restoreSnapshots(queryClient, context?.snapshots);
    },
    onSuccess: async ({ result }) => {
      syncJobDetailCaches(queryClient, result, { syncAllocationJobDetail: true });
      await invalidateJobAndFilmOrderQueries(queryClient, result.summary.jobNumber);
    }
  });
}

export function useSetJobStagedForPickup() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: SetJobStagedForPickupPayload) => setJobStagedForPickup(payload),
    onMutate: async (payload) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: inventoryKeys.jobs }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.job(payload.jobNumber) }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJobs }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJob(payload.jobNumber) }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.listRoot }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.boxRoot })
      ]);

      return beginImmediateOptimisticMutation(
        queryClient,
        [
          inventoryKeys.jobs,
          inventoryKeys.job(payload.jobNumber),
          inventoryKeys.allocationJobs,
          inventoryKeys.allocationJob(payload.jobNumber),
          inventoryKeys.listRoot,
          inventoryKeys.boxRoot
        ],
        () => {
          if (payload.autoCheckoutRemaining) {
            applyCheckoutAllToCaches(queryClient, payload.jobNumber);
          }

          const currentJob = queryClient.getQueryData<JobDetail>(inventoryKeys.job(payload.jobNumber));
          if (!currentJob) {
            return;
          }

          const nextJob = {
            ...currentJob,
            summary: {
              ...currentJob.summary,
              isStagedForPickup: payload.isStagedForPickup,
              status: payload.isStagedForPickup ? 'READY' : currentJob.summary.status
            }
          };
          syncJobDetailCaches(queryClient, nextJob, { syncAllocationJobDetail: true });
        }
      );
    },
    onError: (_error, _variables, context) => {
      restoreSnapshots(queryClient, context?.snapshots);
    },
    onSuccess: async ({ result }) => {
      syncJobDetailCaches(queryClient, result, { syncAllocationJobDetail: true });
      await invalidateJobAndFilmOrderQueries(queryClient, result.summary.jobNumber);
    }
  });
}

export function useCheckoutAllJobMaterials() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: { jobNumber: string }) => checkoutAllJobMaterials(payload),
    onMutate: async (payload) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: inventoryKeys.jobs }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.job(payload.jobNumber) }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJobs }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJob(payload.jobNumber) }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.listRoot }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.boxRoot })
      ]);

      return beginImmediateOptimisticMutation(
        queryClient,
        [
          inventoryKeys.jobs,
          inventoryKeys.job(payload.jobNumber),
          inventoryKeys.allocationJobs,
          inventoryKeys.allocationJob(payload.jobNumber),
          inventoryKeys.listRoot,
          inventoryKeys.boxRoot
        ],
        () => {
          applyCheckoutAllToCaches(queryClient, payload.jobNumber);
        }
      );
    },
    onError: (_error, _variables, context) => {
      restoreSnapshots(queryClient, context?.snapshots);
    },
    onSuccess: async ({ result }) => {
      syncJobDetailCaches(queryClient, result, { syncAllocationJobDetail: true });
      await Promise.all([
        invalidateJobAndFilmOrderQueries(queryClient, result.summary.jobNumber),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.listRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.boxRoot })
      ]);
    }
  });
}

export function useAddBox() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: inventoryKeys.addBoxMutation,
    mutationFn: (payload: AddBoxPayload) => addBox(payload),
    onMutate: async (payload) => {
      const snapshotKeys = [inventoryKeys.box(payload.boxId), inventoryKeys.listRoot] as const;
      const filmOrderSnapshotKeys = payload.filmOrderId
        ? [
            inventoryKeys.filmOrders,
            inventoryKeys.jobRoot,
            inventoryKeys.jobsListRoot,
            inventoryKeys.jobsCalendarRoot,
            inventoryKeys.allocationJobRoot,
            inventoryKeys.allocationJobs
          ]
        : [];

      await Promise.all(
        [...snapshotKeys, ...filmOrderSnapshotKeys].map((queryKey) =>
          queryClient.cancelQueries({ queryKey })
        )
      );

      return beginImmediateOptimisticMutation(
        queryClient,
        [...snapshotKeys, ...filmOrderSnapshotKeys],
        () => {
          applyOptimisticAddBoxToCaches(queryClient, payload);
        }
      );
    },
    onError: (_error, _variables, context) => {
      context?.operation?.cancel();
      restoreSnapshots(queryClient, context?.snapshots);
    },
    onSuccess: async ({ result }, _variables, context) => {
      await context?.operation?.waitForApply();
      queryClient.setQueryData(inventoryKeys.box(result.box.boxId), result.box);
      upsertBoxInSearchCaches(queryClient, result.box);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: inventoryKeys.listRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJobs }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.filmOrders }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.filmCatalog })
      ]);
      void persistOfflineInventoryBox(queryClient, result.box);
    },
    onSettled: (_data, _error, _variables, context) => {
      context?.operation?.finish();
    }
  });
}

export function useAllocateBox() {
  const queryClient = useQueryClient();
  const optimisticQueue = useOptimisticQueue();

  return useMutation({
    mutationFn: (payload: ApplyAllocationPlanPayload) => applyAllocationPlan(payload),
    onMutate: async (payload) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: inventoryKeys.boxRoot }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.allocationsRoot }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.listRoot }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.jobs }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.job(payload.jobNumber) }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJobs }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJob(payload.jobNumber) })
      ]);

      return beginDelayedOptimisticMutation(
        queryClient,
        optimisticQueue,
        `Allocating film for ${payload.jobNumber}`,
        [
          inventoryKeys.boxRoot,
          inventoryKeys.listRoot,
          inventoryKeys.allocationsRoot,
          inventoryKeys.jobs,
          inventoryKeys.job(payload.jobNumber),
          inventoryKeys.allocationJobs,
          inventoryKeys.allocationJob(payload.jobNumber)
        ],
        () => {
          applyOptimisticAllocationAdditionToCaches(queryClient, payload);
        }
      );
    },
    onError: (_error, _variables, context) => {
      context?.operation?.cancel();
      restoreSnapshots(queryClient, context?.snapshots);
    },
    onSuccess: async ({ result }, variables, context) => {
      await context?.operation?.waitForApply();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: inventoryKeys.listRoot }),
        invalidateJobLifecycleQueries(queryClient, variables.jobNumber)
      ]);

      const touchedBoxIds = Array.from(
        new Set(result.allocations.map((entry) => entry.boxId).filter(Boolean))
      );
      await Promise.all(
        touchedBoxIds.flatMap((boxId) => [
          queryClient.invalidateQueries({ queryKey: inventoryKeys.box(boxId) }),
          queryClient.invalidateQueries({ queryKey: inventoryKeys.allocations(boxId) })
        ])
      );

      void syncOfflineInventoryQueries(queryClient);
    },
    onSettled: (_data, _error, _variables, context) => {
      context?.operation?.finish();
    }
  });
}

export function useRemoveJobBoxAllocations() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: inventoryKeys.removeJobBoxAllocationMutation,
    mutationFn: (payload: RemoveJobBoxAllocationsPayload) => removeJobBoxAllocations(payload),
    onMutate: async (payload) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: inventoryKeys.jobs }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.job(payload.jobNumber) }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJobs }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJob(payload.jobNumber) }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.listRoot }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.boxRoot }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.allocationsRoot })
      ]);

      const { rollback } = applyOptimisticAllocationRemovalToCaches(
        queryClient,
        payload.jobNumber,
        payload.allocationId
      );

      return {
        rollback: rollback as OptimisticAllocationRemovalRollback | null
      };
    },
    onError: (_error, _variables, context) => {
      rollbackOptimisticAllocationRemovalInCaches(queryClient, context?.rollback);
    },
    onSuccess: async ({ result }, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: inventoryKeys.listRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.box(result.boxId) }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.allocations(result.boxId) }),
        invalidateJobLifecycleQueries(queryClient, variables.jobNumber)
      ]);

      void syncOfflineInventoryQueries(queryClient);
    }
  });
}

export function useAddCaulkJobAllocation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: AddCaulkJobAllocationPayload) => addCaulkJobAllocation(payload),
    onSuccess: async ({ result }) => {
      await invalidateCaulkJobQueries(queryClient, result.jobNumber, { includeJobCollections: true });
    }
  });
}

export function useUpdateCaulkJobAllocation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: UpdateCaulkJobAllocationPayload) => updateCaulkJobAllocation(payload),
    onSuccess: async ({ result }) => {
      await invalidateCaulkJobQueries(queryClient, result.jobNumber);
    }
  });
}

export function useCheckoutCaulkJobAllocation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: CheckoutCaulkJobAllocationPayload) => checkoutCaulkJobAllocation(payload),
    onMutate: async (payload) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: inventoryKeys.jobRoot }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJobRoot })
      ]);

      let sourceAllocation: CaulkJobAllocationEntry | null = null;
      const jobQueries = queryClient.getQueriesData<JobDetail>({ queryKey: inventoryKeys.jobRoot });
      for (let index = 0; index < jobQueries.length && !sourceAllocation; index += 1) {
        const [, current] = jobQueries[index];
        sourceAllocation =
          current?.caulkAllocations.find(
            (entry) => entry.caulkAllocationId === payload.caulkAllocationId
          ) || null;
      }

      if (!sourceAllocation) {
        const allocationJobQueries = queryClient.getQueriesData<AllocationJobDetail>({
          queryKey: inventoryKeys.allocationJobRoot
        });
        for (let index = 0; index < allocationJobQueries.length && !sourceAllocation; index += 1) {
          const [, current] = allocationJobQueries[index];
          sourceAllocation =
            current?.caulkAllocations.find(
              (entry) => entry.caulkAllocationId === payload.caulkAllocationId
            ) || null;
        }
      }

      return beginImmediateOptimisticMutation(queryClient, [inventoryKeys.jobRoot, inventoryKeys.allocationJobRoot], () => {
        updateCaulkCheckoutCaches(queryClient, payload, {
          checkoutTubes: Math.max(sourceAllocation?.reservedTubesRemaining || 0, 1),
          sourceAllocation
        });
      });
    },
    onError: (_error, _variables, context) => {
      restoreSnapshots(queryClient, context?.snapshots);
    },
    onSuccess: async ({ result }) => {
      await invalidateCaulkJobQueries(queryClient, result.jobNumber);
    }
  });
}

export function useCheckinCaulkJobAllocation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: CheckinCaulkJobAllocationPayload) => checkinCaulkJobAllocation(payload),
    onMutate: async (payload) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: inventoryKeys.jobRoot }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJobRoot })
      ]);

      let sourceCheckout: CaulkJobCheckoutEntry | null = null;
      let sourceAllocationId = '';
      const jobQueries = queryClient.getQueriesData<JobDetail>({ queryKey: inventoryKeys.jobRoot });
      for (let index = 0; index < jobQueries.length && !sourceCheckout; index += 1) {
        const [, current] = jobQueries[index];
        sourceCheckout =
          current?.caulkCheckouts.find((entry) => entry.caulkCheckoutId === payload.caulkCheckoutId) ||
          null;
        sourceAllocationId = sourceCheckout?.caulkAllocationId || sourceAllocationId;
      }

      if (!sourceCheckout) {
        const allocationJobQueries = queryClient.getQueriesData<AllocationJobDetail>({
          queryKey: inventoryKeys.allocationJobRoot
        });
        for (let index = 0; index < allocationJobQueries.length && !sourceCheckout; index += 1) {
          const [, current] = allocationJobQueries[index];
          sourceCheckout =
            current?.caulkCheckouts.find((entry) => entry.caulkCheckoutId === payload.caulkCheckoutId) ||
            null;
          sourceAllocationId = sourceCheckout?.caulkAllocationId || sourceAllocationId;
        }
      }

      return beginImmediateOptimisticMutation(
        queryClient,
        [inventoryKeys.jobRoot, inventoryKeys.allocationJobRoot],
        () => {
          if (!sourceCheckout) {
            return;
          }

          updateCaulkCheckinCaches(queryClient, sourceAllocationId, payload.caulkCheckoutId, {
            checkoutTubes: sourceCheckout.checkoutTubes,
            unusedLooseTubes: payload.unusedLooseTubes || 0,
            unusedCases: payload.unusedCases || 0,
            sourceCheckout
          });
        }
      );
    },
    onError: (_error, _variables, context) => {
      restoreSnapshots(queryClient, context?.snapshots);
    },
    onSuccess: async ({ result }) => {
      await invalidateCaulkJobQueries(queryClient, result.jobNumber);
    }
  });
}

export function useRemoveCaulkJobAllocation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: RemoveCaulkJobAllocationPayload) => removeCaulkJobAllocation(payload),
    onSuccess: async ({ result }) => {
      await invalidateCaulkJobQueries(queryClient, result.jobNumber);
    }
  });
}

export function useCancelJob() {
  const queryClient = useQueryClient();
  const optimisticQueue = useOptimisticQueue();

  return useMutation({
    mutationFn: (payload: { jobNumber: string; reason?: string }) => cancelJob(payload),
    onMutate: async (payload) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: inventoryKeys.jobs }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.job(payload.jobNumber) }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.filmOrders })
      ]);

      return beginDelayedOptimisticMutation(
        queryClient,
        optimisticQueue,
        `Cancelling ${payload.jobNumber}`,
        [
          inventoryKeys.jobs,
          inventoryKeys.job(payload.jobNumber),
          inventoryKeys.filmOrders
        ],
        () => {}
      );
    },
    onError: (_error, _variables, context) => {
      context?.operation?.cancel();
      restoreSnapshots(queryClient, context?.snapshots);
    },
    onSuccess: async (_data, variables, context) => {
      await context?.operation?.waitForApply();
      await Promise.all([
        invalidateGlobalPlanningQueries(queryClient),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.job(variables.jobNumber) }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJob(variables.jobNumber) }),
      ]);
      void syncOfflineInventoryQueries(queryClient);
    },
    onSettled: (_data, _error, _variables, context) => {
      context?.operation?.finish();
    }
  });
}

export function useCompleteJob() {
  const queryClient = useQueryClient();
  const optimisticQueue = useOptimisticQueue();

  return useMutation({
    mutationFn: (payload: { jobNumber: string; reason?: string }) => completeJob(payload),
    onMutate: async (payload) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: inventoryKeys.jobs }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.job(payload.jobNumber) }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.filmOrders }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.reportsRoot }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.ownerReportsRoot })
      ]);

      return beginDelayedOptimisticMutation(
        queryClient,
        optimisticQueue,
        `Completing ${payload.jobNumber}`,
        [
          inventoryKeys.jobs,
          inventoryKeys.job(payload.jobNumber),
          inventoryKeys.filmOrders,
          inventoryKeys.reportsRoot,
          inventoryKeys.ownerReportsRoot
        ],
        () => {}
      );
    },
    onError: (_error, _variables, context) => {
      context?.operation?.cancel();
      restoreSnapshots(queryClient, context?.snapshots);
    },
    onSuccess: async ({ result }, variables, context) => {
      await context?.operation?.waitForApply();
      syncJobDetailCaches(queryClient, result);
      await Promise.all([
        invalidateGlobalPlanningQueries(queryClient),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.job(variables.jobNumber) }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJob(variables.jobNumber) }),
      ]);
      void syncOfflineInventoryQueries(queryClient);
    },
    onSettled: (_data, _error, _variables, context) => {
      context?.operation?.finish();
    }
  });
}

export function useReopenJob() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: { jobNumber: string; reason?: string }) => reopenJob(payload),
    onSuccess: async (_data, variables) => {
      await invalidateJobLifecycleQueries(queryClient, variables.jobNumber);
    }
  });
}

export function useDeleteJob() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: DeleteJobPayload) => deleteJob(payload),
    onMutate: async (payload) => {
      const cancelPromise = Promise.all([
        queryClient.cancelQueries({ queryKey: inventoryKeys.jobs }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.job(payload.jobNumber) }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJobs }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJob(payload.jobNumber) }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.filmOrders })
      ]);

      const context = beginImmediateOptimisticMutation(
        queryClient,
        [
          inventoryKeys.jobs,
          inventoryKeys.job(payload.jobNumber),
          inventoryKeys.allocationJobs,
          inventoryKeys.allocationJob(payload.jobNumber),
          inventoryKeys.filmOrders
        ],
        () => removeJobPlanningCaches(queryClient, payload.jobNumber)
      );

      await cancelPromise;
      return context;
    },
    onError: (_error, _variables, context) => {
      restoreSnapshots(queryClient, context?.snapshots);
    },
    onSuccess: async ({ result }) => {
      await Promise.all([
        invalidateGlobalPlanningQueries(queryClient),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.ownerReportsRoot })
      ]);

      queryClient.removeQueries({ queryKey: inventoryKeys.job(result.jobNumber), exact: true });
      queryClient.removeQueries({
        queryKey: inventoryKeys.allocationJob(result.jobNumber),
        exact: true
      });

      void syncOfflineInventoryQueries(queryClient);
    }
  });
}

export function useDeleteFilmOrder() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: inventoryKeys.deleteFilmOrderMutation,
    mutationFn: (payload: { filmOrderId: string; reason?: string; jobNumber?: string }) =>
      deleteFilmOrder(payload),
    onMutate: async (payload) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: inventoryKeys.jobs }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.jobRoot }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.filmOrders }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJobs }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJobRoot }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.listRoot }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.boxRoot }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.allocationsRoot })
      ]);

      return beginImmediateOptimisticMutation(
        queryClient,
        [
          inventoryKeys.jobs,
          inventoryKeys.jobRoot,
          inventoryKeys.filmOrders,
          inventoryKeys.allocationJobs,
          inventoryKeys.allocationJobRoot,
          inventoryKeys.listRoot,
          inventoryKeys.boxRoot,
          inventoryKeys.allocationsRoot
        ],
        () => {
          applyOptimisticFilmOrderDeletionToCaches(queryClient, payload);
        }
      );
    },
    onError: (_error, _variables, context) => {
      restoreSnapshots(queryClient, context?.snapshots);
    },
    onSuccess: async (_data, variables, context) => {
      await context?.operation?.waitForApply();
      await Promise.all([
        invalidateGlobalPlanningQueries(queryClient)
      ]);

      if (variables.jobNumber) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: inventoryKeys.job(variables.jobNumber) }),
          queryClient.invalidateQueries({
            queryKey: inventoryKeys.allocationJob(variables.jobNumber)
          })
        ]);
      }

      void syncOfflineInventoryQueries(queryClient);
    },
    onSettled: (_data, _error, _variables, context) => {
      context?.operation?.finish();
    }
  });
}

export function useUpdateBox() {
  const queryClient = useQueryClient();
  const optimisticQueue = useOptimisticQueue();

  return useMutation({
    mutationFn: (payload: UpdateBoxPayload) => updateBox(payload),
    onMutate: async (payload) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: inventoryKeys.box(payload.boxId) }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.listRoot })
      ]);

      return beginDelayedOptimisticMutation(
        queryClient,
        optimisticQueue,
        `Saving ${payload.boxId}`,
        [inventoryKeys.box(payload.boxId), inventoryKeys.listRoot],
        () => {
          updateBoxCaches(queryClient, payload.boxId, (box) => ({
            ...box,
            ...payload,
            status: payload.moveToZeroed ? 'ZEROED' : box.status
          }));
        }
      );
    },
    onError: (_error, _variables, context) => {
      context?.operation?.cancel();
      restoreSnapshots(queryClient, context?.snapshots);
    },
    onSuccess: async ({ result }, variables, context) => {
      await context?.operation?.waitForApply();
      if (!variables.moveToZeroed) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: inventoryKeys.listRoot }),
          queryClient.invalidateQueries({ queryKey: inventoryKeys.jobs }),
          queryClient.invalidateQueries({ queryKey: inventoryKeys.jobRoot }),
          queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJobs }),
          queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJobRoot }),
          queryClient.invalidateQueries({ queryKey: inventoryKeys.allocations(result.box.boxId) }),
          queryClient.invalidateQueries({ queryKey: inventoryKeys.filmOrders }),
          queryClient.invalidateQueries({ queryKey: inventoryKeys.reportsRoot }),
          queryClient.invalidateQueries({ queryKey: inventoryKeys.ownerReportsRoot })
        ]);
        queryClient.setQueryData(inventoryKeys.box(result.box.boxId), result.box);
        void persistOfflineInventoryBox(queryClient, result.box);
        return;
      }

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: inventoryKeys.listRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.jobs }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.jobRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJobs }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJobRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.history(result.box.boxId) }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.allocations(result.box.boxId) }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.filmOrders }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.activityRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.reportsRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.ownerReportsRoot })
      ]);
      void persistOfflineInventoryBox(queryClient, result.box);
    },
    onSettled: (_data, _error, _variables, context) => {
      context?.operation?.finish();
    }
  });
}

export function useDeleteBox() {
  const queryClient = useQueryClient();
  const optimisticQueue = useOptimisticQueue();

  return useMutation({
    mutationFn: (payload: DeleteBoxPayload) => deleteBox(payload),
    onMutate: async (payload) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: inventoryKeys.box(payload.boxId) }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.listRoot })
      ]);

      const deletedBox = queryClient.getQueryData<Box>(inventoryKeys.box(payload.boxId));
      const context = beginDelayedOptimisticMutation(
        queryClient,
        optimisticQueue,
        `Deleting ${payload.boxId}`,
        [inventoryKeys.box(payload.boxId), inventoryKeys.listRoot],
        () => {
          removeBoxCaches(queryClient, payload.boxId);
        }
      );

      return {
        ...context,
        deletedBox
      };
    },
    onError: (_error, _variables, context) => {
      context?.operation?.cancel();
      restoreSnapshots(queryClient, context?.snapshots);
    },
    onSuccess: async ({ result }, _variables, context) => {
      await context?.operation?.waitForApply();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: inventoryKeys.listRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.activityRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.reportsRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.ownerReportsRoot })
      ]);

      queryClient.removeQueries({ queryKey: inventoryKeys.box(result.boxId), exact: true });
      queryClient.removeQueries({ queryKey: inventoryKeys.history(result.boxId), exact: true });
      queryClient.removeQueries({ queryKey: inventoryKeys.allocations(result.boxId), exact: true });
      queryClient.removeQueries({ queryKey: inventoryKeys.rollHistory(result.boxId), exact: true });

      if (context?.deletedBox) {
        void removeOfflineInventoryBox(queryClient, context.deletedBox);
        return;
      }

      await refreshOfflineInventoryQueries(queryClient);
    },
    onSettled: (_data, _error, _variables, context) => {
      context?.operation?.finish();
    }
  });
}

export function useSetBoxStatus() {
  const queryClient = useQueryClient();
  const optimisticQueue = useOptimisticQueue();

  return useMutation({
    mutationFn: (payload: SetBoxStatusPayload) => setBoxStatus(payload),
    onMutate: async (payload) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: inventoryKeys.box(payload.boxId) }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.listRoot }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.jobRoot }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJobRoot })
      ]);

      const nextDate = todayDateString();

      return beginDelayedOptimisticMutation(
        queryClient,
        optimisticQueue,
        `${payload.status === 'CHECKED_OUT' ? 'Checking out' : 'Checking in'} ${payload.boxId}`,
        [
          inventoryKeys.box(payload.boxId),
          inventoryKeys.listRoot,
          inventoryKeys.jobRoot,
          inventoryKeys.allocationJobRoot
        ],
        () => {
          updateBoxCaches(queryClient, payload.boxId, (box) => ({
            ...box,
            status:
              payload.status === 'IN_STOCK' && payload.lastRollWeightLbs === 0 && box.receivedDate
                ? 'ZEROED'
                : payload.status,
            lastRollWeightLbs:
              payload.status === 'IN_STOCK' && payload.lastRollWeightLbs !== undefined
                ? payload.lastRollWeightLbs
                : box.lastRollWeightLbs,
            lastWeighedDate:
              payload.status === 'IN_STOCK' && payload.lastRollWeightLbs !== undefined
                ? nextDate
                : box.lastWeighedDate
          }));
          updateCheckedOutBoxCaches(queryClient, payload.boxId, payload.status);
        }
      );
    },
    onError: (_error, _variables, context) => {
      context?.operation?.cancel();
      restoreSnapshots(queryClient, context?.snapshots);
    },
    onSuccess: async ({ result }, _variables, context) => {
      await context?.operation?.waitForApply();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: inventoryKeys.listRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.jobs }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.jobRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJobs }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJobRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.history(result.box.boxId) }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.allocations(result.box.boxId) }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.filmOrders }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.activityRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.reportsRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.ownerReportsRoot })
      ]);
      queryClient.setQueryData(inventoryKeys.box(result.box.boxId), result.box);
      void persistOfflineInventoryBox(queryClient, result.box);
    },
    onSettled: (_data, _error, _variables, context) => {
      context?.operation?.finish();
    }
  });
}

export function useUndoAudit() {
  const queryClient = useQueryClient();
  const optimisticQueue = useOptimisticQueue();

  return useMutation({
    mutationFn: (payload: UndoAuditPayload) => undoAudit(payload),
    onMutate: async (payload) =>
      beginDelayedOptimisticMutation(
        queryClient,
        optimisticQueue,
        `Undoing ${payload.logId}`,
        [],
        () => {}
      ),
    onError: (_error, _variables, context) => {
      context?.operation?.cancel();
      restoreSnapshots(queryClient, context?.snapshots);
    },
    onSuccess: async ({ result }, _variables, context) => {
      await context?.operation?.waitForApply();
      await Promise.all([
        invalidateGlobalPlanningQueries(queryClient),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.historyRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.activityRoot })
      ]);

      if (result.box) {
        queryClient.setQueryData(inventoryKeys.box(result.box.boxId), result.box);
        void persistOfflineInventoryBox(queryClient, result.box);
        return;
      }

      void syncOfflineInventoryQueries(queryClient);
    },
    onSettled: (_data, _error, _variables, context) => {
      context?.operation?.finish();
    }
  });
}
