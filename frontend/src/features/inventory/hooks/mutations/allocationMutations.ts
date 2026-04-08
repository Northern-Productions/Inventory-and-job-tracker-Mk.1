import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useOptimisticQueue } from '../../../../components/OptimisticQueue';
import {
  addCaulkJobAllocation,
  applyAllocationPlan,
  checkinCaulkJobAllocation,
  checkoutCaulkJobAllocation,
  removeCaulkJobAllocation,
  removeJobBoxAllocations,
  updateCaulkJobAllocation
} from '../../../../api/features/allocationsClient';
import type {
  AddCaulkJobAllocationPayload,
  AllocationJobDetail,
  ApplyAllocationPlanPayload,
  CaulkJobAllocationEntry,
  CaulkJobCheckoutEntry,
  CheckinCaulkJobAllocationPayload,
  CheckoutCaulkJobAllocationPayload,
  JobDetail,
  RemoveCaulkJobAllocationPayload,
  RemoveJobBoxAllocationsPayload,
  UpdateCaulkJobAllocationPayload
} from '../../../../domain';
import { inventoryKeys } from '../inventoryQueryKeys';
import {
  applyOptimisticAllocationAdditionToCaches,
  applyOptimisticAllocationRemovalToCaches,
  rollbackOptimisticAllocationRemovalInCaches,
  type OptimisticAllocationRemovalRollback
} from '../../cache/allocations';
import {
  updateCaulkCheckinCaches,
  updateCaulkCheckoutCaches
} from '../../cache/jobMaterialMutations';
import {
  beginDelayedOptimisticMutation,
  beginImmediateOptimisticMutation,
  restoreSnapshots
} from '../../cache/shared';
import {
  invalidateCaulkJobQueries,
  invalidateJobLifecycleQueries
} from '../inventoryInvalidation';
import { syncOfflineInventoryQueries } from '../useInventoryOfflineSync';

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
        queryClient.cancelQueries({ queryKey: inventoryKeys.searchRoot }),
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
        queryClient.invalidateQueries({ queryKey: inventoryKeys.searchRoot }),
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

      return beginImmediateOptimisticMutation(
        queryClient,
        [inventoryKeys.jobRoot, inventoryKeys.allocationJobRoot],
        () => {
          updateCaulkCheckoutCaches(queryClient, payload, {
            checkoutTubes: Math.max(sourceAllocation?.reservedTubesRemaining || 0, 1),
            sourceAllocation
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
