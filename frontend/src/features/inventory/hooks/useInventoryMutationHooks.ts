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
  completeJob,
  createJob,
  deleteJob,
  reopenJob,
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
  CheckinCaulkJobAllocationPayload,
  CheckoutCaulkJobAllocationPayload,
  CreateFilmOrderPayload,
  CreateJobPayload,
  DeleteJobPayload,
  DeleteBoxPayload,
  FilmOrderEntry,
  JobDetail,
  JobListEntry,
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
  beginDelayedOptimisticMutation,
  beginImmediateOptimisticMutation,
  createOptimisticBoxFromAddPayload,
  removeBoxCaches,
  restoreSnapshots,
  updateBoxCaches
} from './inventoryMutationUtils';
import {
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

export function useCreateFilmOrder() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: CreateFilmOrderPayload) => createFilmOrder(payload),
    onSuccess: async (_data, variables) => {
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
    onSuccess: async ({ result }) => {
      await invalidateJobAndFilmOrderQueries(queryClient, result.summary.jobNumber);
    }
  });
}

export function useUpdateJob() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: UpdateJobPayload) => updateJob(payload),
    onSuccess: async ({ result }) => {
      await invalidateJobAndFilmOrderQueries(queryClient, result.summary.jobNumber);
    }
  });
}

export function useAddBox() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: inventoryKeys.addBoxMutation,
    mutationFn: (payload: AddBoxPayload) => addBox(payload),
    onMutate: async (payload) => {
      await queryClient.cancelQueries({ queryKey: inventoryKeys.box(payload.boxId) });

      return beginImmediateOptimisticMutation(
        queryClient,
        [inventoryKeys.box(payload.boxId)],
        () => {
          queryClient.setQueryData(inventoryKeys.box(payload.boxId), createOptimisticBoxFromAddPayload(payload));
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
        queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJobs }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.filmOrders }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.filmCatalog })
      ]);
      queryClient.setQueryData(inventoryKeys.box(result.box.boxId), result.box);
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
        queryClient.cancelQueries({ queryKey: inventoryKeys.box(payload.boxId) }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.allocations(payload.boxId) }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJobs }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJob(payload.jobNumber) })
      ]);

      const sourceBox = queryClient.getQueryData<Box>(inventoryKeys.box(payload.boxId));
      const sourceAllocatedFeet =
        payload.crossWarehouse === true
          ? 0
          : sourceBox
            ? Math.min(sourceBox.feetAvailable, payload.requestedFeet)
            : payload.requestedFeet;
      const now = new Date().toISOString();
      const optimisticAllocation: AllocationEntry | null =
        sourceAllocatedFeet > 0
          ? {
              allocationId: `pending-${Date.now()}-${payload.boxId}`,
              boxId: payload.boxId,
              warehouse: sourceBox?.warehouse || payload.jobWarehouse || WAREHOUSE_CODES[0],
              jobNumber: payload.jobNumber,
              jobDate: payload.jobDate || '',
              crewLeader: payload.crewLeader || '',
              allocatedFeet: sourceAllocatedFeet,
              allocationKind: 'REQUIREMENT',
              status: 'ACTIVE',
              createdAt: now,
              createdBy: 'Pending...',
              resolvedAt: '',
              resolvedBy: '',
              filmOrderId: '',
              notes: 'Pending server confirmation'
            }
          : null;

      return beginDelayedOptimisticMutation(
        queryClient,
        optimisticQueue,
        `Allocating film for ${payload.jobNumber}`,
        [
          inventoryKeys.box(payload.boxId),
          inventoryKeys.listRoot,
          inventoryKeys.allocations(payload.boxId),
          inventoryKeys.jobs,
          inventoryKeys.job(payload.jobNumber),
          inventoryKeys.allocationJobs,
          inventoryKeys.allocationJob(payload.jobNumber)
        ],
        () => {
          if (sourceAllocatedFeet > 0) {
            updateBoxCaches(queryClient, payload.boxId, (box) => ({
              ...box,
              feetAvailable: Math.max(box.feetAvailable - sourceAllocatedFeet, 0)
            }));
          }

          if (optimisticAllocation) {
            queryClient.setQueryData<AllocationEntry[] | undefined>(
              inventoryKeys.allocations(payload.boxId),
              (current) => [...(current || []), optimisticAllocation]
            );
          }
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
    mutationFn: (payload: RemoveJobBoxAllocationsPayload) => removeJobBoxAllocations(payload),
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
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: inventoryKeys.job(result.jobNumber) }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJob(result.jobNumber) }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.jobs }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJobs }),
        queryClient.invalidateQueries({ queryKey: ['caulk'] })
      ]);
    }
  });
}

export function useUpdateCaulkJobAllocation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: UpdateCaulkJobAllocationPayload) => updateCaulkJobAllocation(payload),
    onSuccess: async ({ result }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: inventoryKeys.job(result.jobNumber) }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJob(result.jobNumber) }),
        queryClient.invalidateQueries({ queryKey: ['caulk'] })
      ]);
    }
  });
}

export function useCheckoutCaulkJobAllocation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: CheckoutCaulkJobAllocationPayload) => checkoutCaulkJobAllocation(payload),
    onSuccess: async ({ result }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: inventoryKeys.job(result.jobNumber) }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJob(result.jobNumber) }),
        queryClient.invalidateQueries({ queryKey: ['caulk'] })
      ]);
    }
  });
}

export function useCheckinCaulkJobAllocation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: CheckinCaulkJobAllocationPayload) => checkinCaulkJobAllocation(payload),
    onSuccess: async ({ result }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: inventoryKeys.job(result.jobNumber) }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJob(result.jobNumber) }),
        queryClient.invalidateQueries({ queryKey: ['caulk'] })
      ]);
    }
  });
}

export function useRemoveCaulkJobAllocation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: RemoveCaulkJobAllocationPayload) => removeCaulkJobAllocation(payload),
    onSuccess: async ({ result }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: inventoryKeys.job(result.jobNumber) }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJob(result.jobNumber) }),
        queryClient.invalidateQueries({ queryKey: ['caulk'] })
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
  const optimisticQueue = useOptimisticQueue();

  return useMutation({
    mutationFn: (payload: { filmOrderId: string; reason?: string; jobNumber?: string }) =>
      deleteFilmOrder(payload),
    onMutate: async (payload) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: inventoryKeys.jobs }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.jobRoot }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.filmOrders }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJobs }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJobRoot }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.listRoot })
      ]);

      return beginDelayedOptimisticMutation(
        queryClient,
        optimisticQueue,
        `Deleting ${payload.filmOrderId}`,
        [
          inventoryKeys.jobs,
          inventoryKeys.jobRoot,
          inventoryKeys.filmOrders,
          inventoryKeys.allocationJobs,
          inventoryKeys.allocationJobRoot,
          inventoryKeys.listRoot
        ],
        () => {
          queryClient.setQueryData<FilmOrderEntry[] | undefined>(inventoryKeys.filmOrders, (current) =>
            current ? current.filter((entry) => entry.filmOrderId !== payload.filmOrderId) : current
          );

          const jobQueries = queryClient.getQueriesData<JobDetail>({ queryKey: inventoryKeys.jobRoot });
          for (let index = 0; index < jobQueries.length; index += 1) {
            const [queryKey, current] = jobQueries[index];
            if (!current) {
              continue;
            }

            const nextFilmOrders = current.filmOrders.filter(
              (entry) => entry.filmOrderId !== payload.filmOrderId
            );
            const removedCount = current.filmOrders.length - nextFilmOrders.length;
            if (!removedCount) {
              continue;
            }

            queryClient.setQueryData<JobDetail>(queryKey, {
              ...current,
              summary: {
                ...current.summary,
                filmOrderCount: Math.max(current.summary.filmOrderCount - removedCount, 0)
              },
              filmOrders: nextFilmOrders
            });
          }

          const allocationJobQueries = queryClient.getQueriesData<AllocationJobDetail>({
            queryKey: inventoryKeys.allocationJobRoot
          });
          for (let index = 0; index < allocationJobQueries.length; index += 1) {
            const [queryKey, current] = allocationJobQueries[index];
            if (!current) {
              continue;
            }

            const nextFilmOrders = current.filmOrders.filter(
              (entry) => entry.filmOrderId !== payload.filmOrderId
            );
            const removedCount = current.filmOrders.length - nextFilmOrders.length;
            if (!removedCount) {
              continue;
            }

            queryClient.setQueryData<AllocationJobDetail>(queryKey, {
              ...current,
              summary: {
                ...current.summary,
                openFilmOrderCount: Math.max(current.summary.openFilmOrderCount - removedCount, 0)
              },
              filmOrders: nextFilmOrders
            });
          }

          if (!payload.jobNumber) {
            return;
          }

          const jobsListQueries = queryClient.getQueriesData<JobListEntry[]>({
            queryKey: inventoryKeys.jobs
          });
          for (let index = 0; index < jobsListQueries.length; index += 1) {
            const [queryKey, current] = jobsListQueries[index];
            if (!current) {
              continue;
            }

            queryClient.setQueryData<JobListEntry[]>(
              queryKey,
              current.map((entry) =>
                entry.jobNumber === payload.jobNumber
                  ? { ...entry, filmOrderCount: Math.max(entry.filmOrderCount - 1, 0) }
                  : entry
              )
            );
          }

          queryClient.setQueryData<AllocationJobSummary[] | undefined>(
            inventoryKeys.allocationJobs,
            (current) =>
              current
                ? current.map((entry) =>
                    entry.jobNumber === payload.jobNumber
                      ? { ...entry, openFilmOrderCount: Math.max(entry.openFilmOrderCount - 1, 0) }
                      : entry
                  )
                : current
          );
        }
      );
    },
    onError: (_error, _variables, context) => {
      context?.operation?.cancel();
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
        queryClient.cancelQueries({ queryKey: inventoryKeys.listRoot })
      ]);

      const nextDate = todayDateString();

      return beginDelayedOptimisticMutation(
        queryClient,
        optimisticQueue,
        `${payload.status === 'CHECKED_OUT' ? 'Checking out' : 'Checking in'} ${payload.boxId}`,
        [inventoryKeys.box(payload.boxId), inventoryKeys.listRoot],
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
