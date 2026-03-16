import type { QueryClient } from '@tanstack/react-query';
import type { OptimisticOperationController } from '../../../components/OptimisticQueue';
import type { AddBoxPayload, Box } from '../../../domain';
import { WAREHOUSE_CODES } from '../../../domain';
import { inventoryKeys } from './inventoryQueryKeys';

// Purpose: Shared optimistic mutation and cache helper utilities for inventory hooks.
export interface QuerySnapshot {
  queryKey: readonly unknown[];
  data: unknown;
}

export interface MutationOptimisticContext {
  operation?: OptimisticOperationController;
  snapshots: QuerySnapshot[];
  deletedBox?: Box;
}

export function captureSnapshots(queryClient: QueryClient, queryKey: readonly unknown[]) {
  return queryClient
    .getQueriesData({ queryKey })
    .map(([key, data]) => ({ queryKey: key, data }));
}

export function restoreSnapshots(
  queryClient: QueryClient,
  snapshots: QuerySnapshot[] | undefined
) {
  if (!snapshots) {
    return;
  }

  for (let index = 0; index < snapshots.length; index += 1) {
    queryClient.setQueryData(snapshots[index].queryKey, snapshots[index].data);
  }
}

export function updateBoxCaches(
  queryClient: QueryClient,
  boxId: string,
  updater: (box: Box) => Box
) {
  queryClient.setQueryData<Box | undefined>(inventoryKeys.box(boxId), (current) =>
    current ? updater(current) : current
  );

  const listQueries = queryClient.getQueriesData<Box[]>({ queryKey: inventoryKeys.listRoot });
  for (let index = 0; index < listQueries.length; index += 1) {
    const [queryKey, current] = listQueries[index];
    if (!current) {
      continue;
    }

    queryClient.setQueryData<Box[]>(
      queryKey,
      current.map((box) => (box.boxId === boxId ? updater(box) : box))
    );
  }
}

export function removeBoxCaches(queryClient: QueryClient, boxId: string) {
  queryClient.setQueryData<Box | undefined>(inventoryKeys.box(boxId), undefined);

  const listQueries = queryClient.getQueriesData<Box[]>({ queryKey: inventoryKeys.listRoot });
  for (let index = 0; index < listQueries.length; index += 1) {
    const [queryKey, current] = listQueries[index];
    if (!current) {
      continue;
    }

    queryClient.setQueryData<Box[]>(
      queryKey,
      current.filter((box) => box.boxId !== boxId)
    );
  }
}

export function beginDelayedOptimisticMutation(
  queryClient: QueryClient,
  optimisticQueue: { begin: (label: string, apply: () => void) => OptimisticOperationController },
  label: string,
  snapshotKeys: readonly (readonly unknown[])[],
  apply: () => void
): MutationOptimisticContext {
  const snapshots = snapshotKeys.flatMap((queryKey) => captureSnapshots(queryClient, queryKey));

  return {
    operation: optimisticQueue.begin(label, apply),
    snapshots
  };
}

export function beginImmediateOptimisticMutation(
  queryClient: QueryClient,
  snapshotKeys: readonly (readonly unknown[])[],
  apply: () => void
): MutationOptimisticContext {
  const snapshots = snapshotKeys.flatMap((queryKey) => captureSnapshots(queryClient, queryKey));
  apply();

  return {
    snapshots
  };
}

export function createOptimisticBoxFromAddPayload(payload: AddBoxPayload): Box {
  const isReceived = Boolean(payload.receivedDate);

  return {
    boxId: payload.boxId,
    warehouse: payload.warehouse || WAREHOUSE_CODES[0],
    manufacturer: payload.manufacturer,
    filmName: payload.filmName,
    widthIn: payload.widthIn,
    initialFeet: payload.initialFeet,
    feetAvailable: payload.feetAvailable,
    lotRun: payload.lotRun || '',
    status: isReceived ? 'IN_STOCK' : 'ORDERED',
    orderDate: payload.orderDate,
    receivedDate: payload.receivedDate,
    initialWeightLbs: payload.initialWeightLbs ?? null,
    lastRollWeightLbs: payload.lastRollWeightLbs ?? null,
    lastWeighedDate: payload.lastWeighedDate || '',
    filmKey: payload.filmKey || '',
    coreType: payload.coreType || '',
    coreWeightLbs: payload.coreWeightLbs ?? null,
    lfWeightLbsPerFt: payload.lfWeightLbsPerFt ?? null,
    purchaseCost: payload.purchaseCost ?? null,
    notes: payload.notes || '',
    hasEverBeenCheckedOut: false,
    lastCheckoutJob: '',
    lastCheckoutDate: '',
    zeroedDate: '',
    zeroedReason: '',
    zeroedBy: ''
  };
}
