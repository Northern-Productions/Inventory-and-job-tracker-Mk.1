import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  checkoutAllJobMaterials,
  setJobStagedForPickup
} from '../../../../../api/features/jobsClient';
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
import { invalidateJobAndFilmOrderQueries } from '../../inventoryInvalidation';

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
