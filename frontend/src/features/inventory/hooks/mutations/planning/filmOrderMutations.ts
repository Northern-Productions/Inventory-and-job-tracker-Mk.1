import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  createFilmOrder,
  deleteFilmOrder
} from '../../../../../api/features/filmOrdersClient';
import type {
  AllocationJobDetail,
  CreateFilmOrderPayload,
  JobDetail
} from '../../../../../domain';
import { inventoryKeys } from '../../inventoryQueryKeys';
import {
  applyOptimisticFilmOrderDeletionToCaches,
  createOptimisticFilmOrderFromPayload,
  replaceFilmOrderInCaches,
  resolveOptimisticFilmOrderScheduleFromCaches,
  upsertFilmOrdersCache
} from '../../../cache/filmOrders';
import {
  upsertAllocationJobSummaryCaches,
  upsertJobListCaches
} from '../../../cache/jobs';
import {
  beginImmediateOptimisticMutation,
  restoreSnapshots
} from '../../../cache/shared';
import { invalidateGlobalPlanningQueries } from '../../inventoryInvalidation';
import { syncOfflineInventoryQueries } from '../../useInventoryOfflineSync';

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
              installDate: '',
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
              hasOrderedAllocations: false,
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
              installDate: '',
              crewLeader: '',
              status: 'ALLOCATE',
              activeAllocatedFeet: 0,
              fulfilledAllocatedFeet: 0,
              requiredTubes: 0,
              allocatedTubes: 0,
              remainingTubes: 0,
              openFilmOrderCount: 0,
              boxCount: 0,
              hasOrderedAllocations: false
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
