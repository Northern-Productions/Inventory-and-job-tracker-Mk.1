import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useOptimisticQueue } from '../../../../components/OptimisticQueue';
import {
  cancelJob,
  createFilmOrder,
  deleteFilmOrder
} from '../../../../api/features/filmOrdersClient';
import {
  checkoutAllJobMaterials,
  completeJob,
  createJob,
  deleteJob,
  reopenJob,
  setJobStagedForPickup,
  updateJob
} from '../../../../api/features/jobsClient';
import type {
  AllocationJobDetail,
  CaulkProductEntry,
  CreateFilmOrderPayload,
  CreateJobPayload,
  DeleteJobPayload,
  JobDetail,
  SetJobStagedForPickupPayload,
  UpdateJobPayload
} from '../../../../domain';
import { inventoryKeys } from '../inventoryQueryKeys';
import {
  applyOptimisticFilmOrderDeletionToCaches,
  createOptimisticFilmOrderFromPayload,
  replaceFilmOrderInCaches,
  resolveOptimisticFilmOrderScheduleFromCaches,
  upsertFilmOrdersCache
} from '../../cache/filmOrders';
import {
  applyOptimisticJobScheduleSyncToCaches,
  createOptimisticAllocationJobSummaryFromJobDetail,
  createOptimisticJobDetailFromCreatePayload,
  removeJobPlanningCaches,
  syncJobDetailCaches,
  upsertAllocationJobSummaryCaches,
  upsertJobListCaches
} from '../../cache/jobs';
import { applyCheckoutAllToCaches } from '../../cache/jobMaterialMutations';
import {
  beginDelayedOptimisticMutation,
  beginImmediateOptimisticMutation,
  restoreSnapshots
} from '../../cache/shared';
import {
  invalidateGlobalPlanningQueries,
  invalidateJobAndFilmOrderQueries,
  invalidateJobLifecycleQueries
} from '../inventoryInvalidation';
import { syncOfflineInventoryQueries } from '../useInventoryOfflineSync';

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
        [inventoryKeys.jobs, inventoryKeys.job(payload.jobNumber), inventoryKeys.filmOrders],
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
        queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJob(variables.jobNumber) })
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
        queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJob(variables.jobNumber) })
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
      await Promise.all([invalidateGlobalPlanningQueries(queryClient)]);

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
