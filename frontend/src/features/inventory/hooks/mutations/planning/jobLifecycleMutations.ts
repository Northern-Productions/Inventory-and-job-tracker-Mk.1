import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useOptimisticQueue } from '../../../../../components/OptimisticQueue';
import { cancelJob } from '../../../../../api/features/filmOrdersClient';
import {
  completeJob,
  createJob,
  deleteJob,
  reopenJob,
  setJobPhaseState,
  setJobRequirementState,
  updateJob
} from '../../../../../api/features/jobsClient';
import type { CompleteJobPayload, ReopenJobPayload } from '../../../../../api/features/jobsClient';
import type {
  AllocationJobDetail,
  CancelJobPayload,
  CaulkProductEntry,
  CreateJobPayload,
  DeleteJobPayload,
  JobDetail,
  SetJobPhaseStatePayload,
  SetJobRequirementStatePayload,
  UpdateJobPayload
} from '../../../../../domain';
import { inventoryKeys } from '../../inventoryQueryKeys';
import {
  applyOptimisticJobUpdateToCaches,
  createOptimisticAllocationJobSummaryFromJobDetail,
  createOptimisticJobDetailFromCreatePayload,
  createOptimisticJobDetailAfterRequirementStateChange,
  removeJobPlanningCaches,
  syncJobDetailCaches,
  upsertAllocationJobSummaryCaches,
  upsertJobListCaches
} from '../../../cache/jobs';
import {
  beginDelayedOptimisticMutation,
  beginImmediateOptimisticMutation,
  restoreSnapshots
} from '../../../cache/shared';
import {
  invalidateCaulkJobQueries,
  invalidateGlobalPlanningQueries,
  invalidateJobAndFilmOrderQueries,
  invalidateJobLifecycleQueries
} from '../../inventoryInvalidation';
import { syncOfflineInventoryQueries } from '../../useInventoryOfflineSync';

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
        queryClient.getQueryData<CaulkProductEntry[]>(inventoryKeys.caulkProducts) || []
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
    mutationKey: inventoryKeys.updateJobMutation,
    mutationFn: (payload: UpdateJobPayload) => updateJob(payload),
    onMutate: async (payload) => {
      const isCanonicalJobIdMutation = Boolean(payload.jobId);
      await Promise.all([
        queryClient.cancelQueries({ queryKey: inventoryKeys.jobs }),
        ...(isCanonicalJobIdMutation
          ? [queryClient.cancelQueries({ queryKey: inventoryKeys.jobById(payload.jobId!) })]
          : [queryClient.cancelQueries({ queryKey: inventoryKeys.job(payload.jobNumber) })]),
        queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJobs }),
        ...(isCanonicalJobIdMutation
          ? []
          : [queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJob(payload.jobNumber) })]),
        queryClient.cancelQueries({ queryKey: inventoryKeys.filmOrders })
      ]);

      return beginImmediateOptimisticMutation(
        queryClient,
        [
          inventoryKeys.jobs,
          ...(isCanonicalJobIdMutation ? [inventoryKeys.jobById(payload.jobId!)] : [inventoryKeys.job(payload.jobNumber)]),
          inventoryKeys.allocationJobs,
          ...(isCanonicalJobIdMutation ? [] : [inventoryKeys.allocationJob(payload.jobNumber)]),
          inventoryKeys.filmOrders
        ],
        () => {
          applyOptimisticJobUpdateToCaches(queryClient, payload);
        }
      );
    },
    onError: (_error, _variables, context) => {
      restoreSnapshots(queryClient, context?.snapshots);
    },
    onSuccess: async ({ result }, variables) => {
      const isCanonicalJobIdMutation = Boolean(variables.jobId);
      syncJobDetailCaches(queryClient, result, {
        syncAllocationJobDetail: !isCanonicalJobIdMutation,
        syncLegacyJobDetail: !isCanonicalJobIdMutation
      });
      await invalidateJobAndFilmOrderQueries(queryClient, {
        jobId: variables.jobId,
        jobNumber: isCanonicalJobIdMutation ? '' : result.summary.jobNumber
      });
    }
  });
}

export function useSetJobRequirementState() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: inventoryKeys.setJobRequirementStateMutation,
    mutationFn: (payload: SetJobRequirementStatePayload) => setJobRequirementState(payload),
    onMutate: async (payload) => {
      const jobId = String(payload.jobId || '').trim();
      const detailKey = jobId ? inventoryKeys.jobById(jobId) : inventoryKeys.job(payload.jobNumber);
      await Promise.all([
        queryClient.cancelQueries({ queryKey: inventoryKeys.jobs }),
        queryClient.cancelQueries({ queryKey: detailKey }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJobs }),
        ...(jobId ? [] : [queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJob(payload.jobNumber) })]),
        queryClient.cancelQueries({ queryKey: inventoryKeys.filmOrders })
      ]);

      return beginImmediateOptimisticMutation(
        queryClient,
        [
          inventoryKeys.jobs,
          detailKey,
          inventoryKeys.allocationJobs,
          ...(jobId ? [] : [inventoryKeys.allocationJob(payload.jobNumber)]),
          inventoryKeys.filmOrders
        ],
        () => {
          const currentDetail = queryClient.getQueryData<JobDetail>(detailKey);
          if (!currentDetail) {
            return;
          }
          const optimisticDetail = createOptimisticJobDetailAfterRequirementStateChange(currentDetail, payload);
          syncJobDetailCaches(queryClient, optimisticDetail, {
            syncAllocationJobDetail: !jobId,
            syncLegacyJobDetail: !jobId
          });
        }
      );
    },
    onError: (_error, _variables, context) => {
      restoreSnapshots(queryClient, context?.snapshots);
    },
    onSuccess: async ({ result }, variables) => {
      const jobId = String(variables.jobId || '').trim();
      syncJobDetailCaches(queryClient, result, {
        syncAllocationJobDetail: !jobId,
        syncLegacyJobDetail: !jobId
      });
      await Promise.all([
        invalidateGlobalPlanningQueries(queryClient),
        queryClient.invalidateQueries({
          queryKey: jobId ? inventoryKeys.jobById(jobId) : inventoryKeys.job(variables.jobNumber)
        }),
        ...(jobId ? [] : [queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJob(variables.jobNumber) })]),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.filmOrders })
      ]);
      void syncOfflineInventoryQueries(queryClient);
    }
  });
}

export function useSetJobPhaseState() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: inventoryKeys.setJobPhaseStateMutation,
    mutationFn: (payload: SetJobPhaseStatePayload) => setJobPhaseState(payload),
    onMutate: async (payload) => {
      const jobId = String(payload.jobId || '').trim();
      const detailKey = jobId ? inventoryKeys.jobById(jobId) : inventoryKeys.job(payload.jobNumber);
      await Promise.all([
        queryClient.cancelQueries({ queryKey: inventoryKeys.jobs }),
        queryClient.cancelQueries({ queryKey: detailKey }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJobs }),
        ...(jobId ? [] : [queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJob(payload.jobNumber) })]),
        queryClient.cancelQueries({ queryKey: inventoryKeys.filmOrders })
      ]);

      return beginImmediateOptimisticMutation(
        queryClient,
        [
          inventoryKeys.jobs,
          detailKey,
          inventoryKeys.allocationJobs,
          ...(jobId ? [] : [inventoryKeys.allocationJob(payload.jobNumber)]),
          inventoryKeys.filmOrders
        ],
        () => {}
      );
    },
    onError: (_error, _variables, context) => {
      restoreSnapshots(queryClient, context?.snapshots);
    },
    onSuccess: async ({ result }, variables) => {
      const jobId = String(variables.jobId || '').trim();
      syncJobDetailCaches(queryClient, result, {
        syncAllocationJobDetail: !jobId,
        syncLegacyJobDetail: !jobId
      });
      await Promise.all([
        invalidateGlobalPlanningQueries(queryClient),
        queryClient.invalidateQueries({
          queryKey: jobId ? inventoryKeys.jobById(jobId) : inventoryKeys.job(variables.jobNumber)
        }),
        ...(jobId ? [] : [queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJob(variables.jobNumber) })]),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.filmOrders })
      ]);
      void syncOfflineInventoryQueries(queryClient);
    }
  });
}

export function useCancelJob() {
  const queryClient = useQueryClient();
  const optimisticQueue = useOptimisticQueue();

  return useMutation({
    mutationFn: (payload: CancelJobPayload) => cancelJob(payload),
    onMutate: async (payload) => {
      const jobId = String(payload.jobId || '').trim();
      await Promise.all([
        queryClient.cancelQueries({ queryKey: inventoryKeys.jobs }),
        ...(jobId
          ? [queryClient.cancelQueries({ queryKey: inventoryKeys.jobById(jobId) })]
          : [queryClient.cancelQueries({ queryKey: inventoryKeys.job(payload.jobNumber) })]),
        queryClient.cancelQueries({ queryKey: inventoryKeys.filmOrders }),
        ...(jobId
          ? [
              queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJobs }),
              queryClient.cancelQueries({ queryKey: inventoryKeys.boxRoot }),
              queryClient.cancelQueries({ queryKey: inventoryKeys.reportsRoot }),
              queryClient.cancelQueries({ queryKey: inventoryKeys.ownerReportsRoot })
            ]
          : [])
      ]);

      return beginDelayedOptimisticMutation(
        queryClient,
        optimisticQueue,
        `Cancelling ${payload.jobNumber}`,
        [
          inventoryKeys.jobs,
          ...(jobId ? [inventoryKeys.jobById(jobId)] : [inventoryKeys.job(payload.jobNumber)]),
          inventoryKeys.filmOrders,
          ...(jobId
            ? [
                inventoryKeys.allocationJobs,
                inventoryKeys.boxRoot,
                inventoryKeys.reportsRoot,
                inventoryKeys.ownerReportsRoot
              ]
            : [])
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
      const jobId = String(variables.jobId || '').trim();
      if (jobId) {
        await Promise.all([
          invalidateGlobalPlanningQueries(queryClient),
          queryClient.invalidateQueries({ queryKey: inventoryKeys.jobById(jobId) }),
          queryClient.invalidateQueries({ queryKey: inventoryKeys.ownerReportsRoot })
        ]);
      } else {
        await Promise.all([
          invalidateGlobalPlanningQueries(queryClient),
          queryClient.invalidateQueries({ queryKey: inventoryKeys.job(variables.jobNumber) }),
          queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJob(variables.jobNumber) })
        ]);
      }
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
    mutationFn: (payload: CompleteJobPayload) => completeJob(payload),
    onMutate: async (payload) => {
      const jobId = String(payload.jobId || '').trim();
      await Promise.all([
        queryClient.cancelQueries({ queryKey: inventoryKeys.jobs }),
        ...(jobId
          ? [queryClient.cancelQueries({ queryKey: inventoryKeys.jobById(jobId) })]
          : [queryClient.cancelQueries({ queryKey: inventoryKeys.job(payload.jobNumber) })]),
        queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJobs }),
        ...(jobId ? [] : [queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJob(payload.jobNumber) })]),
        queryClient.cancelQueries({ queryKey: inventoryKeys.filmOrders }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.boxRoot }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.caulkProducts }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.caulkTransfersRoot }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.reportsRoot }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.ownerReportsRoot })
      ]);

      return beginDelayedOptimisticMutation(
        queryClient,
        optimisticQueue,
        `Completing ${payload.jobNumber}`,
        [
          inventoryKeys.jobs,
          ...(jobId ? [inventoryKeys.jobById(jobId)] : [inventoryKeys.job(payload.jobNumber)]),
          inventoryKeys.allocationJobs,
          ...(jobId ? [] : [inventoryKeys.allocationJob(payload.jobNumber)]),
          inventoryKeys.filmOrders,
          inventoryKeys.boxRoot,
          inventoryKeys.caulkProducts,
          inventoryKeys.caulkTransfersRoot,
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
      const jobId = String(variables.jobId || '').trim();
      syncJobDetailCaches(queryClient, result, {
        syncAllocationJobDetail: !jobId,
        syncLegacyJobDetail: !jobId
      });
      await Promise.all([
        invalidateGlobalPlanningQueries(queryClient),
        queryClient.invalidateQueries({
          queryKey: jobId ? inventoryKeys.jobById(jobId) : inventoryKeys.job(variables.jobNumber)
        }),
        ...(jobId ? [] : [queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJob(variables.jobNumber) })]),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.filmOrders }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.boxRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.caulkProducts }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.caulkTransfersRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.reportsRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.ownerReportsRoot }),
        ...(jobId
          ? [
              invalidateCaulkJobQueries(queryClient, { jobId }, { includeJobCollections: true })
            ]
          : []),
        invalidateJobLifecycleQueries(queryClient, {
          jobId,
          jobNumber: jobId ? '' : variables.jobNumber
        })
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
    mutationFn: (payload: ReopenJobPayload) => reopenJob(payload),
    onSuccess: async ({ result }, variables) => {
      const isCanonicalJobIdMutation = Boolean(variables.jobId);
      if (isCanonicalJobIdMutation) {
        syncJobDetailCaches(queryClient, result, { syncLegacyJobDetail: false });
      }
      await invalidateJobLifecycleQueries(queryClient, {
        jobId: variables.jobId,
        jobNumber: isCanonicalJobIdMutation ? '' : variables.jobNumber || result.summary.jobNumber
      });
    }
  });
}

export function useDeleteJob() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: DeleteJobPayload) => deleteJob(payload),
    onMutate: async (payload) => {
      const jobId = String(payload.jobId || '').trim();
      const cancelPromise = Promise.all([
        queryClient.cancelQueries({ queryKey: inventoryKeys.jobs }),
        ...(jobId
          ? [queryClient.cancelQueries({ queryKey: inventoryKeys.jobById(jobId) })]
          : [queryClient.cancelQueries({ queryKey: inventoryKeys.job(payload.jobNumber) })]),
        queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJobs }),
        ...(jobId
          ? []
          : [queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJob(payload.jobNumber) })]),
        queryClient.cancelQueries({ queryKey: inventoryKeys.filmOrders })
      ]);

      const context = beginImmediateOptimisticMutation(
        queryClient,
        [
          inventoryKeys.jobs,
          ...(jobId ? [inventoryKeys.jobById(jobId)] : [inventoryKeys.job(payload.jobNumber)]),
          inventoryKeys.allocationJobs,
          ...(jobId ? [] : [inventoryKeys.allocationJob(payload.jobNumber)]),
          inventoryKeys.filmOrders
        ],
        () => {
          if (jobId) {
            queryClient.removeQueries({ queryKey: inventoryKeys.jobById(jobId), exact: true });
            return;
          }
          removeJobPlanningCaches(queryClient, payload.jobNumber);
        }
      );

      await cancelPromise;
      return context;
    },
    onError: (_error, _variables, context) => {
      restoreSnapshots(queryClient, context?.snapshots);
    },
    onSuccess: async ({ result }, variables) => {
      const jobId = String(variables.jobId || result.jobId || '').trim();
      await Promise.all([
        invalidateGlobalPlanningQueries(queryClient),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.ownerReportsRoot }),
        ...(jobId
          ? [
              invalidateCaulkJobQueries(queryClient, { jobId }, { includeJobCollections: true }),
              queryClient.invalidateQueries({ queryKey: inventoryKeys.jobById(jobId) })
            ]
          : [
              invalidateCaulkJobQueries(
                queryClient,
                result.jobNumber || variables.jobNumber,
                { includeJobCollections: true }
              ),
              queryClient.invalidateQueries({
                queryKey: inventoryKeys.job(result.jobNumber || variables.jobNumber)
              }),
              queryClient.invalidateQueries({
                queryKey: inventoryKeys.allocationJob(result.jobNumber || variables.jobNumber)
              })
            ])
      ]);

      if (jobId) {
        queryClient.removeQueries({ queryKey: inventoryKeys.jobById(jobId), exact: true });
      } else {
        queryClient.removeQueries({ queryKey: inventoryKeys.job(result.jobNumber), exact: true });
        queryClient.removeQueries({
          queryKey: inventoryKeys.allocationJob(result.jobNumber),
          exact: true
        });
      }

      void syncOfflineInventoryQueries(queryClient);
    }
  });
}
