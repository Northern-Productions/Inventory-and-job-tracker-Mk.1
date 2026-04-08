import { useMutation, useQueryClient } from '@tanstack/react-query';
import { checkoutAllJobMaterials, setJobStagedForPickup } from '../../../../../api/features/jobsClient';
import type { SetJobStagedForPickupPayload } from '../../../../../domain';
import { inventoryKeys } from '../../inventoryQueryKeys';
import { applyCheckoutAllToCaches } from '../../../cache/jobMaterialMutations';
import { beginImmediateOptimisticMutation, restoreSnapshots } from '../../../cache/shared';
import { cancelJobMaterialQueries, syncAndInvalidateJobDetail } from './shared';

export function useSetJobStagedForPickup() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: SetJobStagedForPickupPayload) => setJobStagedForPickup(payload),
    onMutate: async (payload) => {
      await cancelJobMaterialQueries(queryClient, payload.jobNumber);

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
        }
      );
    },
    onError: (_error, _variables, context) => {
      restoreSnapshots(queryClient, context?.snapshots);
    },
    onSuccess: async ({ result }) => {
      await syncAndInvalidateJobDetail(queryClient, result);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: inventoryKeys.listRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.boxRoot })
      ]);
    }
  });
}

export function useCheckoutAllJobMaterials() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: { jobNumber: string }) => checkoutAllJobMaterials(payload),
    onMutate: async (payload) => {
      await cancelJobMaterialQueries(queryClient, payload.jobNumber);

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
      await syncAndInvalidateJobDetail(queryClient, result);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: inventoryKeys.listRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.boxRoot })
      ]);
    }
  });
}
