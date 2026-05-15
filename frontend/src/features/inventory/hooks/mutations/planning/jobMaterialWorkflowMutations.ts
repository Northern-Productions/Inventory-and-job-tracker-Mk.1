import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  checkoutAllJobMaterials,
  setJobStagedForPickup
} from '../../../../../api/features/jobsClient';
import type { CheckoutAllJobMaterialsPayload } from '../../../../../api/features/jobsClient';
import type {
  JobDetail,
  SetJobStagedForPickupPayload
} from '../../../../../domain';
import { inventoryKeys } from '../../inventoryQueryKeys';
import { applyCheckoutAllToCaches } from '../../../cache/jobMaterialMutations';
import { syncJobDetailCaches } from '../../../cache/jobs';
import {
  beginImmediateOptimisticMutation,
  restoreSnapshots
} from '../../../cache/shared';
import {
  invalidateCaulkJobQueries,
  invalidateJobAndFilmOrderQueries
} from '../../inventoryInvalidation';

export function useSetJobStagedForPickup() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: SetJobStagedForPickupPayload) => setJobStagedForPickup(payload),
    onMutate: async (payload) => {
      const jobId = String(payload.jobId || '').trim();
      await Promise.all([
        queryClient.cancelQueries({ queryKey: inventoryKeys.jobs }),
        ...(jobId
          ? [queryClient.cancelQueries({ queryKey: inventoryKeys.jobById(jobId) })]
          : [queryClient.cancelQueries({ queryKey: inventoryKeys.job(payload.jobNumber) })]),
        queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJobs }),
        ...(jobId ? [] : [queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJob(payload.jobNumber) })]),
        queryClient.cancelQueries({ queryKey: inventoryKeys.listRoot }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.boxRoot })
      ]);

      return beginImmediateOptimisticMutation(
        queryClient,
        [
          inventoryKeys.jobs,
          ...(jobId ? [inventoryKeys.jobById(jobId)] : [inventoryKeys.job(payload.jobNumber)]),
          inventoryKeys.allocationJobs,
          ...(jobId ? [] : [inventoryKeys.allocationJob(payload.jobNumber)]),
          inventoryKeys.listRoot,
          inventoryKeys.boxRoot
        ],
        () => {
          if (payload.autoCheckoutRemaining && !jobId) {
            applyCheckoutAllToCaches(queryClient, payload.jobNumber);
          }

          const currentJob = queryClient.getQueryData<JobDetail>(
            jobId ? inventoryKeys.jobById(jobId) : inventoryKeys.job(payload.jobNumber)
          );
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
          syncJobDetailCaches(queryClient, nextJob, {
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
      const jobId = String(variables.jobId || result.summary.jobId || '').trim();
      const identity = jobId ? { jobId, jobNumber: '' } : result.summary.jobNumber;
      syncJobDetailCaches(queryClient, result, {
        syncAllocationJobDetail: !jobId,
        syncLegacyJobDetail: !jobId
      });
      await Promise.all([
        invalidateJobAndFilmOrderQueries(queryClient, identity),
        ...(jobId && variables.autoCheckoutRemaining
          ? [
              invalidateCaulkJobQueries(queryClient, identity, { includeJobCollections: true }),
              queryClient.invalidateQueries({ queryKey: inventoryKeys.listRoot }),
              queryClient.invalidateQueries({ queryKey: inventoryKeys.boxRoot })
            ]
          : [])
      ]);
    }
  });
}

export function useCheckoutAllJobMaterials() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: CheckoutAllJobMaterialsPayload) => checkoutAllJobMaterials(payload),
    onMutate: async (payload) => {
      const jobId = String(payload.jobId || '').trim();
      await Promise.all([
        queryClient.cancelQueries({ queryKey: inventoryKeys.jobs }),
        ...(jobId
          ? [queryClient.cancelQueries({ queryKey: inventoryKeys.jobById(jobId) })]
          : [queryClient.cancelQueries({ queryKey: inventoryKeys.job(payload.jobNumber) })]),
        queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJobs }),
        ...(jobId ? [] : [queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJob(payload.jobNumber) })]),
        queryClient.cancelQueries({ queryKey: inventoryKeys.listRoot }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.boxRoot })
      ]);

      return beginImmediateOptimisticMutation(
        queryClient,
        [
          inventoryKeys.jobs,
          ...(jobId ? [inventoryKeys.jobById(jobId)] : [inventoryKeys.job(payload.jobNumber)]),
          inventoryKeys.allocationJobs,
          ...(jobId ? [] : [inventoryKeys.allocationJob(payload.jobNumber)]),
          inventoryKeys.listRoot,
          inventoryKeys.boxRoot
        ],
        () => {
          if (!jobId) {
            applyCheckoutAllToCaches(queryClient, payload.jobNumber);
          }
        }
      );
    },
    onError: (_error, _variables, context) => {
      restoreSnapshots(queryClient, context?.snapshots);
    },
    onSuccess: async ({ result }, variables) => {
      const jobId = String(variables.jobId || result.summary.jobId || '').trim();
      syncJobDetailCaches(queryClient, result, {
        syncAllocationJobDetail: !jobId,
        syncLegacyJobDetail: !jobId
      });
      await Promise.all([
        invalidateJobAndFilmOrderQueries(
          queryClient,
          jobId ? { jobId, jobNumber: '' } : result.summary.jobNumber
        ),
        invalidateCaulkJobQueries(
          queryClient,
          jobId ? { jobId, jobNumber: '' } : result.summary.jobNumber,
          { includeJobCollections: true }
        ),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.listRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.boxRoot })
      ]);
    }
  });
}
