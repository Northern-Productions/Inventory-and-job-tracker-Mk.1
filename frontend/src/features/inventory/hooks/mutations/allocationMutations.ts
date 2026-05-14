import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  addCaulkJobAllocation,
  applyAllocationPlan,
  checkinCaulkJobAllocation,
  clearAllocationPlannerSuppression,
  checkoutCaulkJobAllocation,
  removeCaulkJobAllocation,
  removeJobBoxAllocations,
  updateCaulkJobAllocation
} from '../../../../api/features/allocationsClient';
import type {
  AddCaulkJobAllocationPayload,
  AllocationJobDetail,
  ApplyAllocationPlanPayload,
  CancelCaulkTransferPayload,
  CaulkJobAllocationEntry,
  CaulkJobCheckoutEntry,
  CheckinCaulkJobAllocationPayload,
  ClearAllocationPlannerSuppressionPayload,
  CheckoutCaulkJobAllocationPayload,
  JobDetail,
  ReceiveCaulkTransferPayload,
  RemoveCaulkJobAllocationPayload,
  RemoveJobBoxAllocationsPayload,
  UpdateCaulkJobAllocationPayload
} from '../../../../domain';
import { cancelCaulkTransfer, receiveCaulkTransfer } from '../../../../api/features/caulkClient';
import { inventoryKeys } from '../inventoryQueryKeys';
import {
  applyOptimisticAllocationAdditionToCaches,
  applyOptimisticAllocationRemovalToCaches,
  rollbackOptimisticAllocationAdditionInCaches,
  rollbackOptimisticAllocationRemovalInCaches,
  type OptimisticAllocationRemovalRollback
} from '../../cache/allocations';
import { syncJobDetailCaches } from '../../cache/jobs';
import {
  applyOptimisticAddCaulkAllocationToCaches,
  applyOptimisticRemoveCaulkAllocationToCaches,
  applyOptimisticUpdateCaulkAllocationToCaches,
  replacePendingCaulkAllocationIdInCaches
} from '../../cache/caulkAllocations';
import {
  updateCaulkCheckinCaches,
  updateCaulkCheckoutCaches
} from '../../cache/jobMaterialMutations';
import {
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

  return useMutation({
    mutationFn: (payload: ApplyAllocationPlanPayload) => applyAllocationPlan(payload),
    onMutate: async (payload) => {
      const jobId = String(payload.jobId || '').trim();
      await Promise.all([
        queryClient.cancelQueries({ queryKey: inventoryKeys.boxRoot }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.allocationsRoot }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.listRoot }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.searchRoot }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.jobs }),
        ...(jobId
          ? [queryClient.cancelQueries({ queryKey: inventoryKeys.jobById(jobId) })]
          : [queryClient.cancelQueries({ queryKey: inventoryKeys.job(payload.jobNumber) })]),
        queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJobs }),
        ...(jobId ? [] : [queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJob(payload.jobNumber) })])
      ]);

      const optimisticResult = jobId
        ? { allocations: [], jobAllocations: [], allocatedFeetByBoxId: {} }
        : applyOptimisticAllocationAdditionToCaches(queryClient, payload);

      return {
        snapshots: [],
        optimisticAllocationJobNumber: payload.jobNumber,
        optimisticAllocationIds: optimisticResult.allocations.map((entry) => entry.allocationId)
      };
    },
    onError: (_error, _variables, context) => {
      if (context?.optimisticAllocationJobNumber && context.optimisticAllocationIds?.length) {
        rollbackOptimisticAllocationAdditionInCaches(
          queryClient,
          context.optimisticAllocationJobNumber,
          context.optimisticAllocationIds
        );
      }
    },
    onSuccess: async ({ result }, variables) => {
      const jobId = String(variables.jobId || '').trim();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: inventoryKeys.listRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.searchRoot }),
        invalidateJobLifecycleQueries(queryClient, jobId ? { jobId } : variables.jobNumber)
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
    }
  });
}

export function useRemoveJobBoxAllocations() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: inventoryKeys.removeJobBoxAllocationMutation,
    mutationFn: (payload: RemoveJobBoxAllocationsPayload) => removeJobBoxAllocations(payload),
    onMutate: async (payload) => {
      const jobId = String(payload.jobId || '').trim();
      const legacyJobNumber = String(payload.jobNumber || '').trim();
      await Promise.all([
        queryClient.cancelQueries({ queryKey: inventoryKeys.jobs }),
        ...(jobId ? [queryClient.cancelQueries({ queryKey: inventoryKeys.jobById(jobId) })] : []),
        ...(!jobId && legacyJobNumber
          ? [queryClient.cancelQueries({ queryKey: inventoryKeys.job(legacyJobNumber) })]
          : []),
        queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJobs }),
        ...(!jobId && legacyJobNumber
          ? [queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJob(legacyJobNumber) })]
          : []),
        queryClient.cancelQueries({ queryKey: inventoryKeys.listRoot }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.boxRoot }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.allocationsRoot })
      ]);

      const { rollback } = jobId
        ? { rollback: null }
        : applyOptimisticAllocationRemovalToCaches(
            queryClient,
            legacyJobNumber,
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
      const jobId = String(variables.jobId || result.jobId || '').trim();
      const legacyJobNumber = String(variables.jobNumber || result.jobNumber || '').trim();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: inventoryKeys.listRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.box(result.boxId) }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.allocations(result.boxId) }),
        invalidateJobLifecycleQueries(
          queryClient,
          jobId ? { jobId } : legacyJobNumber
        )
      ]);

      void syncOfflineInventoryQueries(queryClient);
    }
  });
}

export function useClearAllocationPlannerSuppression() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: inventoryKeys.clearAllocationPlannerSuppressionMutation,
    mutationFn: (payload: ClearAllocationPlannerSuppressionPayload) =>
      clearAllocationPlannerSuppression(payload),
    onMutate: async (payload) => {
      const jobId = String(payload.jobId || '').trim();
      const legacyJobNumber = String(payload.jobNumber || '').trim();
      await Promise.all([
        queryClient.cancelQueries({ queryKey: inventoryKeys.jobs }),
        ...(jobId ? [queryClient.cancelQueries({ queryKey: inventoryKeys.jobById(jobId) })] : []),
        ...(!jobId && legacyJobNumber
          ? [queryClient.cancelQueries({ queryKey: inventoryKeys.job(legacyJobNumber) })]
          : []),
        queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJobs }),
        ...(!jobId && legacyJobNumber
          ? [queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJob(legacyJobNumber) })]
          : [])
      ]);
    },
    onSuccess: async ({ result }, variables) => {
      const jobId = String(variables.jobId || result.summary.jobId || '').trim();
      const legacyJobNumber = String(variables.jobNumber || result.summary.jobNumber || '').trim();
      if (jobId) {
        syncJobDetailCaches(queryClient, result, {
          syncAllocationJobDetail: false,
          syncLegacyJobDetail: false
        });
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: inventoryKeys.listRoot }),
          queryClient.invalidateQueries({ queryKey: inventoryKeys.boxRoot }),
          queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationsRoot }),
          invalidateJobLifecycleQueries(queryClient, { jobId })
        ]);
      } else {
        syncJobDetailCaches(queryClient, result, {
          syncAllocationJobDetail: true
        });
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: inventoryKeys.listRoot }),
          invalidateJobLifecycleQueries(queryClient, legacyJobNumber)
        ]);
      }

      void syncOfflineInventoryQueries(queryClient);
    }
  });
}

export function useAddCaulkJobAllocation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: inventoryKeys.addCaulkAllocationMutation,
    mutationFn: (payload: AddCaulkJobAllocationPayload) => addCaulkJobAllocation(payload),
    onMutate: async (payload) => {
      const canonicalJobId = String(payload.jobId || '').trim();
      if (canonicalJobId) {
        await Promise.all([
          queryClient.cancelQueries({ queryKey: inventoryKeys.jobs }),
          queryClient.cancelQueries({ queryKey: inventoryKeys.jobById(canonicalJobId) }),
          queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJobs }),
          queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJobRoot })
        ]);

        return beginImmediateOptimisticMutation(
          queryClient,
          [
            inventoryKeys.jobs,
            inventoryKeys.jobById(canonicalJobId),
            inventoryKeys.allocationJobs,
            inventoryKeys.allocationJobRoot
          ],
          () => {}
        );
      }

      await Promise.all([
        queryClient.cancelQueries({ queryKey: inventoryKeys.jobs }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.job(payload.jobNumber) }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJobs }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJob(payload.jobNumber) })
      ]);

      let pendingCaulkAllocationId = '';
      const context = beginImmediateOptimisticMutation(
        queryClient,
        [
          inventoryKeys.jobs,
          inventoryKeys.job(payload.jobNumber),
          inventoryKeys.allocationJobs,
          inventoryKeys.allocationJob(payload.jobNumber)
        ],
        () => {
          pendingCaulkAllocationId = applyOptimisticAddCaulkAllocationToCaches(
            queryClient,
            payload
          ).pendingCaulkAllocationId;
        }
      );

      return {
        ...context,
        pendingCaulkAllocationId
      };
    },
    onError: (_error, _variables, context) => {
      restoreSnapshots(queryClient, context?.snapshots);
    },
    onSuccess: async ({ result }, variables, context) => {
      if (context?.pendingCaulkAllocationId) {
        replacePendingCaulkAllocationIdInCaches(
          queryClient,
          result.jobNumber,
          context.pendingCaulkAllocationId,
          result.caulkAllocationId
        );
      }

      const resultJobId = String(result.jobId || variables.jobId || '').trim();
      await invalidateCaulkJobQueries(
        queryClient,
        resultJobId ? { jobId: resultJobId, jobNumber: result.jobNumber } : result.jobNumber,
        { includeJobCollections: true }
      );
    }
  });
}

export function useUpdateCaulkJobAllocation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: inventoryKeys.updateCaulkAllocationMutation,
    mutationFn: (payload: UpdateCaulkJobAllocationPayload) => updateCaulkJobAllocation(payload),
    onMutate: async (payload) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: inventoryKeys.jobs }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.jobRoot }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.jobByIdRoot }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJobs }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJobRoot })
      ]);

      return beginImmediateOptimisticMutation(
        queryClient,
        [
          inventoryKeys.jobs,
          inventoryKeys.jobRoot,
          inventoryKeys.jobByIdRoot,
          inventoryKeys.allocationJobs,
          inventoryKeys.allocationJobRoot
        ],
        () => {
          applyOptimisticUpdateCaulkAllocationToCaches(queryClient, payload);
        }
      );
    },
    onError: (_error, _variables, context) => {
      restoreSnapshots(queryClient, context?.snapshots);
    },
    onSuccess: async ({ result }) => {
      await invalidateCaulkJobQueries(queryClient, {
        jobId: result.jobId,
        jobNumber: result.jobNumber
      });
    }
  });
}

export function useCheckoutCaulkJobAllocation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: inventoryKeys.checkoutCaulkAllocationMutation,
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
      await invalidateCaulkJobQueries(queryClient, { jobId: result.jobId, jobNumber: result.jobNumber });
    }
  });
}

export function useCheckinCaulkJobAllocation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: inventoryKeys.checkinCaulkAllocationMutation,
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
      await invalidateCaulkJobQueries(queryClient, { jobId: result.jobId, jobNumber: result.jobNumber });
    }
  });
}

export function useRemoveCaulkJobAllocation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: inventoryKeys.removeCaulkAllocationMutation,
    mutationFn: (payload: RemoveCaulkJobAllocationPayload) => removeCaulkJobAllocation(payload),
    onMutate: async (payload) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: inventoryKeys.jobs }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.jobRoot }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.jobByIdRoot }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJobs }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJobRoot })
      ]);

      return beginImmediateOptimisticMutation(
        queryClient,
        [
          inventoryKeys.jobs,
          inventoryKeys.jobRoot,
          inventoryKeys.jobByIdRoot,
          inventoryKeys.allocationJobs,
          inventoryKeys.allocationJobRoot
        ],
        () => {
          applyOptimisticRemoveCaulkAllocationToCaches(queryClient, payload.caulkAllocationId);
        }
      );
    },
    onError: (_error, _variables, context) => {
      restoreSnapshots(queryClient, context?.snapshots);
    },
    onSuccess: async ({ result }) => {
      await invalidateCaulkJobQueries(queryClient, { jobId: result.jobId, jobNumber: result.jobNumber });
    }
  });
}

export function useReceiveCaulkTransfer() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: inventoryKeys.receiveCaulkTransferMutation,
    mutationFn: (payload: ReceiveCaulkTransferPayload) => receiveCaulkTransfer(payload),
    onMutate: async () => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: inventoryKeys.jobRoot }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJobRoot }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.caulkTransfersRoot })
      ]);
    },
    onSuccess: async ({ result }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: inventoryKeys.jobRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJobRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.caulkTransfersRoot }),
        queryClient.invalidateQueries({ queryKey: ['caulk', 'stock'] }),
        queryClient.invalidateQueries({ queryKey: ['caulk', 'transactions'] })
      ]);
      if (result.jobNumber) {
        await invalidateCaulkJobQueries(queryClient, result.jobNumber);
      }
    }
  });
}

export function useCancelCaulkTransfer() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: inventoryKeys.cancelCaulkTransferMutation,
    mutationFn: (payload: CancelCaulkTransferPayload) => cancelCaulkTransfer(payload),
    onMutate: async () => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: inventoryKeys.jobRoot }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJobRoot }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.caulkTransfersRoot })
      ]);
    },
    onSuccess: async ({ result }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: inventoryKeys.jobRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJobRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.caulkTransfersRoot }),
        queryClient.invalidateQueries({ queryKey: ['caulk', 'stock'] }),
        queryClient.invalidateQueries({ queryKey: ['caulk', 'transactions'] })
      ]);
      if (result.jobNumber) {
        await invalidateCaulkJobQueries(queryClient, result.jobNumber);
      }
    }
  });
}
