import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useOptimisticQueue } from '../../../../components/OptimisticQueue';
import {
  addBox,
  cancelBoxTransfer,
  deleteBox,
  receiveOrderedBox,
  receiveBoxTransfer,
  setBoxStatus,
  startBoxTransfer,
  upsertBoxDealer,
  updateBox
} from '../../../../api/features/inventoryClient';
import type {
  AddBoxPayload,
  Box,
  BoxDealerEntry,
  CancelBoxTransferPayload,
  DeleteBoxPayload,
  ReceiveOrderedBoxPayload,
  ReceiveBoxTransferPayload,
  SetBoxStatusPayload,
  StartBoxTransferPayload,
  UpsertBoxDealerPayload,
  UpdateBoxPayload
} from '../../../../domain';
import { todayDateString } from '../../../../lib/date';
import { inventoryKeys } from '../inventoryQueryKeys';
import {
  removeBoxCaches,
  updateBoxCaches,
  upsertBoxInSearchCaches
} from '../../cache/boxes';
import {
  applyOptimisticAddBoxToCaches,
  applyOptimisticOrderedBoxReceiptToCaches
} from '../../cache/filmOrders';
import { updateCheckedOutBoxCaches } from '../../cache/jobMaterialMutations';
import {
  beginDelayedOptimisticMutation,
  beginImmediateOptimisticMutation,
  restoreSnapshots
} from '../../cache/shared';
import { invalidateGlobalPlanningQueries } from '../inventoryInvalidation';
import {
  persistOfflineInventoryBox,
  refreshOfflineInventoryQueries,
  removeOfflineInventoryBox,
  syncOfflineInventoryQueries
} from '../useInventoryOfflineSync';
import { deriveCoreWeightLbs } from '../../utils/boxHelpers';

function getTouchedTransferBoxIds(result: {
  transfer: { sourceBoxId: string; destinationBoxId: string };
  box: { boxId: string };
}) {
  return Array.from(
    new Set([result.transfer.sourceBoxId, result.transfer.destinationBoxId, result.box.boxId].filter(Boolean))
  );
}

function upsertDealerEntry(
  current: BoxDealerEntry[] | undefined,
  nextEntry: BoxDealerEntry
) {
  const currentEntries = current || [];
  const nextEntries = currentEntries.some((entry) => entry.dealerId === nextEntry.dealerId)
    ? currentEntries.map((entry) => (entry.dealerId === nextEntry.dealerId ? nextEntry : entry))
    : [...currentEntries, nextEntry];

  return nextEntries
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function useUpsertBoxDealer() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: UpsertBoxDealerPayload) => upsertBoxDealer(payload),
    onSuccess: (result) => {
      queryClient.setQueryData<BoxDealerEntry[] | undefined>(inventoryKeys.boxDealers, (current) =>
        upsertDealerEntry(current, result)
      );
      void queryClient.invalidateQueries({ queryKey: inventoryKeys.boxDealers });
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
          if (payload.shipDirectToJobSite) {
            return;
          }
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
      if (_variables.shipDirectToJobSite) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: inventoryKeys.listRoot }),
          queryClient.invalidateQueries({ queryKey: inventoryKeys.jobs }),
          queryClient.invalidateQueries({ queryKey: inventoryKeys.jobRoot }),
          queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJobs }),
          queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationJobRoot }),
          queryClient.invalidateQueries({ queryKey: inventoryKeys.filmOrders }),
          queryClient.invalidateQueries({ queryKey: inventoryKeys.activityRoot }),
          queryClient.invalidateQueries({ queryKey: inventoryKeys.filmCatalog })
        ]);
        void persistOfflineInventoryBox(queryClient, result.box);
        return;
      }
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
          queryClient.invalidateQueries({ queryKey: inventoryKeys.filmCatalog }),
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
        queryClient.invalidateQueries({ queryKey: inventoryKeys.filmCatalog }),
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
    mutationKey: inventoryKeys.setBoxStatusMutation,
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

export function useReceiveOrderedBox() {
  const queryClient = useQueryClient();
  const optimisticQueue = useOptimisticQueue();

  return useMutation({
    mutationKey: inventoryKeys.receiveOrderedBoxMutation,
    mutationFn: (payload: ReceiveOrderedBoxPayload) => receiveOrderedBox(payload),
    onMutate: async (payload) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: inventoryKeys.box(payload.boxId) }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.listRoot }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.filmOrders }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.jobs }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.jobRoot }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJobs }),
        queryClient.cancelQueries({ queryKey: inventoryKeys.allocationJobRoot })
      ]);

      const nextDate = todayDateString();

      return beginDelayedOptimisticMutation(
        queryClient,
        optimisticQueue,
        `Receiving ${payload.boxId}`,
        [
          inventoryKeys.box(payload.boxId),
          inventoryKeys.listRoot,
          inventoryKeys.filmOrders,
          inventoryKeys.jobs,
          inventoryKeys.jobRoot,
          inventoryKeys.allocationJobs,
          inventoryKeys.allocationJobRoot
        ],
        () => {
          updateBoxCaches(queryClient, payload.boxId, (box) => ({
            ...box,
            status: 'IN_STOCK',
            receivedDate: nextDate,
            feetAvailable: Math.max(
              box.initialFeet - Math.max(0, Number(box.allocatedWithInstallDateFeet || 0)),
              0
            ),
            lastRollWeightLbs:
              payload.receivedWeightLbs !== undefined ? payload.receivedWeightLbs : box.lastRollWeightLbs,
            initialWeightLbs:
              payload.receivedWeightLbs !== undefined ? payload.receivedWeightLbs : box.initialWeightLbs,
            lastWeighedDate:
              payload.receivedWeightLbs !== undefined ? nextDate : box.lastWeighedDate,
            lotRun: payload.lotRun !== undefined ? payload.lotRun : box.lotRun,
            coreType: payload.coreType || box.coreType,
            coreWeightLbs: payload.coreType
              ? deriveCoreWeightLbs(payload.coreType, box.widthIn)
              : box.coreWeightLbs
          }));
          applyOptimisticOrderedBoxReceiptToCaches(queryClient, payload.boxId);
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

export function useStartBoxTransfer() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: inventoryKeys.startBoxTransferMutation,
    mutationFn: (payload: StartBoxTransferPayload) => startBoxTransfer(payload),
    onSuccess: async ({ result }, variables) => {
      await Promise.all([
        invalidateGlobalPlanningQueries(queryClient),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.box(variables.boxId) }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.boxTransfer(variables.boxId) }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.boxTransferPlanRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.history(result.box.boxId) }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.activityRoot })
      ]);
      void syncOfflineInventoryQueries(queryClient);
    }
  });
}

export function useReceiveBoxTransfer() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: inventoryKeys.receiveBoxTransferMutation,
    mutationFn: (payload: ReceiveBoxTransferPayload) => receiveBoxTransfer(payload),
    onSuccess: async ({ result }) => {
      const boxIds = getTouchedTransferBoxIds(result);

      await Promise.all([
        invalidateGlobalPlanningQueries(queryClient),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.boxRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.boxTransferRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.boxTransferPlanRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.historyRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationsRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.activityRoot }),
        ...boxIds.map((boxId) =>
          queryClient.invalidateQueries({ queryKey: inventoryKeys.rollHistory(boxId) })
        )
      ]);
      void syncOfflineInventoryQueries(queryClient);
    }
  });
}

export function useCancelBoxTransfer() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: inventoryKeys.cancelBoxTransferMutation,
    mutationFn: (payload: CancelBoxTransferPayload) => cancelBoxTransfer(payload),
    onSuccess: async ({ result }) => {
      const boxIds = getTouchedTransferBoxIds(result);

      await Promise.all([
        invalidateGlobalPlanningQueries(queryClient),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.boxRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.boxTransferRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.boxTransferPlanRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.historyRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.allocationsRoot }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.activityRoot }),
        ...boxIds.map((boxId) =>
          queryClient.invalidateQueries({ queryKey: inventoryKeys.rollHistory(boxId) })
        )
      ]);
      void syncOfflineInventoryQueries(queryClient);
    }
  });
}
